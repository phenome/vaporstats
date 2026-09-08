import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { REVIEW_CHECKPOINT_PREFIX, runReviewCollection } from "../workers/review-collector";

interface BatchStatement extends AppPreparedStatement {
  _query: string;
  _values: () => SQLQueryBindings[];
}

function isBatchStatement(value: AppPreparedStatement): value is BatchStatement {
  return "_query" in value && "_values" in value && typeof value._values === "function";
}

class CollectorDb implements AppDatabase {
  readonly native = new Database(":memory:");

  constructor() {
    this.native.exec(`
      CREATE TABLE apps (appid INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL);
      CREATE TABLE checkpoints (key TEXT PRIMARY KEY, value TEXT NOT NULL, cursor INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE tracked_games (appid INTEGER PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'daily', slot INTEGER NOT NULL DEFAULT 0, next_due_at TEXT NOT NULL, last_attempted_at TEXT, last_successful_at TEXT, latest_players INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE review_sources (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, request_filter TEXT NOT NULL, language TEXT, purchase_type TEXT, day_range INTEGER, filter_offtopic_activity INTEGER, population TEXT NOT NULL, population_flags TEXT NOT NULL, interpretation_version TEXT NOT NULL, identity_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE review_buckets (appid INTEGER NOT NULL, source_id TEXT NOT NULL, granularity TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, positive_count INTEGER NOT NULL, negative_count INTEGER NOT NULL, observed_at TEXT NOT NULL, provenance TEXT NOT NULL, PRIMARY KEY (appid, source_id, granularity, period_start, period_end));
      CREATE TABLE review_summary_snapshots (appid INTEGER NOT NULL, source_id TEXT NOT NULL, observed_at TEXT NOT NULL, lifetime_positive_count INTEGER NOT NULL, lifetime_total_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (appid, source_id, observed_at));
      CREATE TABLE steam_events (event_id TEXT PRIMARY KEY, appid INTEGER NOT NULL, category TEXT, title TEXT, url TEXT, start_at TEXT, publication_at TEXT, observed_at TEXT NOT NULL, source TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE player_score_history (id INTEGER PRIMARY KEY AUTOINCREMENT, appid INTEGER NOT NULL, observed_at TEXT NOT NULL, score REAL NOT NULL, formula_version TEXT NOT NULL, current_positive_count INTEGER NOT NULL, current_total_count INTEGER NOT NULL, historical_positive_count INTEGER NOT NULL, historical_total_count INTEGER NOT NULL, current_window_start TEXT NOT NULL, current_window_end TEXT NOT NULL, historical_window_start TEXT NOT NULL, historical_window_end TEXT NOT NULL, current_evidence_intervals TEXT NOT NULL, historical_evidence_intervals TEXT NOT NULL, current_source_id TEXT, historical_source_id TEXT, current_evidence_observed_at TEXT, historical_evidence_observed_at TEXT, anchor_event_id TEXT, anchor_at TEXT, provenance TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE player_score_state (appid INTEGER PRIMARY KEY, latest_score_history_id INTEGER, historical_positive_count INTEGER, historical_total_count INTEGER, historical_source_id TEXT, historical_window_start TEXT, historical_window_end TEXT, historical_evidence_intervals TEXT NOT NULL DEFAULT '[]', historical_baseline_observed_at TEXT, eligibility_review_count INTEGER, eligibility_source_id TEXT, eligibility_window_start TEXT, eligibility_window_end TEXT, eligibility_evidence_start TEXT, eligibility_evidence_end TEXT, eligibility_evidence_intervals TEXT NOT NULL DEFAULT '[]', eligibility_observed_at TEXT, eligibility_provenance TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
  }

  prepare(query: string): AppPreparedStatement {
    const state = { values: [] as SQLQueryBindings[] };
    const statement: BatchStatement = {
      bind: (...next: unknown[]) => { state.values = next as SQLQueryBindings[]; return statement; },
      first: async <T>() => (this.native.query(query).get(...state.values) as T | null) ?? null,
      all: async <T>() => ({ success: true, results: this.native.query(query).all(...state.values) as T[], meta: { changes: 0, duration: 0 } }),
      raw: async <T>() => this.native.query(query).raw(...state.values) as T[],
      run: async () => { this.native.query(query).run(...state.values); return { success: true, meta: { changes: 1, duration: 0 } }; },
      _query: query,
      _values: () => state.values,
    };
    return statement;
  }

  async batch<T = unknown>(statements: AppPreparedStatement[]): Promise<{ success: boolean; results?: T[] }[]> {
    const transaction = this.native.transaction(() => statements.map((rawStatement) => {
      const statement = isBatchStatement(rawStatement) ? rawStatement : (() => { throw new Error("test statement adapter mismatch"); })();
      this.native.query(statement._query).run(...statement._values());
      return { success: true };
    }));
    return transaction();
  }

  async exec(query: string) { this.native.exec(query); return { count: 0, duration: 0 }; }
  close() { this.native.close(true); }
}

const ANCHOR = new Date("2026-09-07T12:00:00.000Z");

function summaryBody() {
  return {
    success: 1,
    query_summary: {
      total_positive: 90,
      total_negative: 10,
      total_reviews: 100,
      num_reviews: 2,
      review_score: 9,
      review_score_desc: "Very Positive",
    },
  };
}

function histogramBody() {
  return { success: 1, results: { rollup_type: "day", recent: [], weeks: [], start_date: null, end_date: null } };
}

function responder(mode: "success" | "histogram429" | "summary429", calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("appreviews")) {
      return mode === "summary429" ? new Response("rate limited", { status: 429 }) : Response.json(summaryBody());
    }
    if (url.includes("appreviewhistogram")) {
      return mode === "histogram429" ? new Response("rate limited", { status: 429 }) : Response.json(histogramBody());
    }
    return new Response("not a news hub payload", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("review collection", () => {
  let db: CollectorDb;
  beforeEach(() => { db = new CollectorDb(); });
  afterEach(() => db.close());

  test("bounds initial unobserved collection and leaves player cadence fields untouched", async () => {
    for (let appid = 1; appid <= 20; appid++) {
      db.native.query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, `Game ${appid}`, `game-${appid}`);
      db.native.query("INSERT INTO tracked_games (appid, slot, next_due_at, latest_players, consecutive_failures) VALUES (?, ?, ?, ?, ?)").run(appid, appid % 96, "2099-01-01T00:00:00.000Z", 123, 4);
    }
    const before = db.native.query("SELECT next_due_at, latest_players, consecutive_failures FROM tracked_games WHERE appid = 1").get();
    const calls: string[] = [];
    const result = await runReviewCollection(db, { anchorTime: ANCHOR, customFetch: responder("success", calls) });
    expect(result.selectedGames).toBe(11);
    expect(result.attemptedGames).toBe(11);
    expect(result.reviewRequests).toBe(22);
    expect(result.newsHubRequests).toBe(11);
    expect(calls).toHaveLength(33);
    expect(db.native.query("SELECT COUNT(*) AS count FROM checkpoints WHERE key LIKE ?").get(`${REVIEW_CHECKPOINT_PREFIX}%`)).toEqual({ count: 11 });
    expect(db.native.query("SELECT next_due_at, latest_players, consecutive_failures FROM tracked_games WHERE appid = 1").get()).toEqual(before);
    const next = db.native.query("SELECT value FROM checkpoints WHERE key = ?").get(`${REVIEW_CHECKPOINT_PREFIX}1`) as { value: string };
    expect(Date.parse(next.value)).toBeGreaterThan(ANCHOR.getTime());
  });

  test("does not repeat a successful bootstrap observation at a later slot on the same day", async () => {
    db.native.query("INSERT INTO apps (appid, name, slug) VALUES (50, 'Daily Game', 'daily-game')").run();
    db.native.query("INSERT INTO tracked_games (appid, slot, next_due_at) VALUES (50, 50, '2099-01-01T00:00:00.000Z')").run();
    const customFetch = responder("success", []);
    await runReviewCollection(db, { anchorTime: ANCHOR, customFetch });
    const sameDay = await runReviewCollection(db, { anchorTime: new Date("2026-09-07T12:30:00.000Z"), customFetch });
    expect(sameDay.attemptedGames).toBe(0);
    const nextDay = await runReviewCollection(db, { anchorTime: new Date("2026-09-08T12:30:00.000Z"), customFetch });
    expect(nextDay.attemptedGames).toBe(1);
  });

  test("stops on the first 429, persists last-good components, and defers remaining games", async () => {
    for (let appid = 1; appid <= 3; appid++) {
      db.native.query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, `Game ${appid}`, `game-${appid}`);
      db.native.query("INSERT INTO tracked_games (appid, slot, next_due_at) VALUES (?, ?, ?)").run(appid, appid, "2099-01-01T00:00:00.000Z");
    }
    const calls: string[] = [];
    const result = await runReviewCollection(db, { anchorTime: ANCHOR, customFetch: responder("histogram429", calls) });
    expect(result.rateLimited).toBe(true);
    expect(result.attemptedGames).toBe(1);
    expect(result.reviewRequests).toBe(2);
    expect(result.newsHubRequests).toBe(0);
    expect(calls).toHaveLength(2);
    expect(db.native.query("SELECT COUNT(*) AS count FROM review_summary_snapshots").get()).toEqual({ count: 1 });
    expect(db.native.query("SELECT COUNT(*) AS count FROM checkpoints").get()).toEqual({ count: 1 });
    expect(db.native.query("SELECT COUNT(*) AS count FROM checkpoints WHERE key = ?").get(`${REVIEW_CHECKPOINT_PREFIX}2`)).toEqual({ count: 0 });
  });

  test("does not issue histogram or news requests after a summary 429", async () => {
    db.native.query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(1, "Game", "game");
    db.native.query("INSERT INTO tracked_games (appid, slot, next_due_at) VALUES (?, ?, ?)").run(1, 1, "2099-01-01T00:00:00.000Z");
    const calls: string[] = [];
    const result = await runReviewCollection(db, { anchorTime: ANCHOR, customFetch: responder("summary429", calls) });
    expect(result.rateLimited).toBe(true);
    expect(result.reviewRequests).toBe(1);
    expect(result.newsHubRequests).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
