import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  REVIEW_CHECKPOINT_PREFIX,
  listReceptionCandidates,
  runReviewCollection,
} from "../workers/review-collector";

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
      CREATE TABLE apps (appid INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'game', is_eligible INTEGER NOT NULL DEFAULT 1, is_playable INTEGER NOT NULL DEFAULT 1, parent_appid INTEGER, release_date TEXT, release_status TEXT NOT NULL DEFAULT 'released', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE checkpoints (key TEXT PRIMARY KEY, value TEXT NOT NULL, cursor INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE tracked_games (appid INTEGER PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'daily', slot INTEGER NOT NULL DEFAULT 0, next_due_at TEXT NOT NULL, last_attempted_at TEXT, last_successful_at TEXT, latest_players INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, appid INTEGER NOT NULL, observed_at TEXT NOT NULL);
      CREATE TABLE app_release_events (appid INTEGER NOT NULL, event_type TEXT NOT NULL, event_date TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE reception_collection_failures (appid INTEGER PRIMARY KEY, first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL, failure_count INTEGER NOT NULL DEFAULT 1, failure_category TEXT NOT NULL);
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

function summaryBody(totalReviews = 100) {
  return {
    success: 1,
    query_summary: {
      total_positive: Math.floor(totalReviews * 0.9),
      total_negative: totalReviews - Math.floor(totalReviews * 0.9),
      total_reviews: totalReviews,
      num_reviews: Math.min(2, totalReviews),
      review_score: 9,
      review_score_desc: "Very Positive",
    },
  };
}

function responder(
  mode: "success" | "summary429" | "summary500" | "histogram500",
  calls: string[],
  totalReviews = 100,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("appreviews")) {
      if (mode === "summary429") return new Response("rate limited", { status: 429 });
      if (mode === "summary500") return new Response("failed", { status: 500 });
      return Response.json(summaryBody(totalReviews));
    }
    if (url.includes("appreviewhistogram")) {
      if (mode === "histogram500") return new Response("failed", { status: 500 });
      return Response.json({ success: 1, results: { rollup_type: "day", recent: [], weeks: [], start_date: null, end_date: null } });
    }
    const appid = url.match(/\/app\/(\d+)/)?.[1] ?? "0";
    const payload = JSON.stringify({
      events: [{
        gid: `event-${appid}`,
        appid: Number(appid),
        event_type: 13,
        rtime32_start_time: Math.floor(ANCHOR.getTime() / 1000),
      }],
    }).replaceAll('"', "&quot;");
    return new Response(`<div data-initialevents="${payload}"></div>`, { status: 200 });
  }) as unknown as typeof fetch;
}

function addGame(db: CollectorDb, appid: number, releaseDate: string | null = null): void {
  db.native.query("INSERT INTO apps (appid, name, slug, release_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(appid, `Game ${appid}`, `game-${appid}`, releaseDate, "2026-01-01 00:00:00", "2026-01-01 00:00:00");
}

describe("review collection", () => {
  let db: CollectorDb;
  beforeEach(() => { db = new CollectorDb(); });
  afterEach(() => db.close());

  test("collects bounded catalog games without requiring or mutating player tracking", async () => {
    for (let appid = 1; appid <= 20; appid++) addGame(db, appid);
    db.native.query("INSERT INTO tracked_games (appid, slot, next_due_at, latest_players, consecutive_failures) VALUES (1, 1, '2099-01-01T00:00:00.000Z', 123, 4)").run();
    const before = db.native.query("SELECT next_due_at, latest_players, consecutive_failures FROM tracked_games WHERE appid = 1").get();
    const result = await runReviewCollection(db, {
      anchorTime: ANCHOR,
      customFetch: responder("success", []),
      artifactDirectory: null,
    });
    expect(result.selectedGames).toBe(11);
    expect(result.attemptedGames).toBe(11);
    expect(result.reviewRequests).toBe(22);
    expect(result.newsHubRequests).toBe(11);
    expect(db.native.query("SELECT COUNT(*) AS count FROM checkpoints WHERE key LIKE ?").get(`${REVIEW_CHECKPOINT_PREFIX}%`)).toEqual({ count: 11 });
    expect(db.native.query("SELECT next_due_at, latest_players, consecutive_failures FROM tracked_games WHERE appid = 1").get()).toEqual(before);
  });

  test("treats a valid sub-threshold population as successful insufficient evidence", async () => {
    addGame(db, 1527950);
    const directory = mkdtempSync(join(tmpdir(), "vaporstats-reception-"));
    try {
      const calls: string[] = [];
      const result = await runReviewCollection(db, {
        anchorTime: ANCHOR,
        customFetch: responder("success", calls, 49),
        artifactDirectory: directory,
      });
      expect(result.insufficientEvidence).toBe(1);
      expect(result.ordinaryFailures).toBe(0);
      expect(calls).toHaveLength(1);
      expect(db.native.query("SELECT COUNT(*) AS count FROM reception_collection_failures").get()).toEqual({ count: 0 });
      expect(await listReceptionCandidates(db, ANCHOR)).toEqual([]);
      db.native.query("UPDATE apps SET updated_at = ? WHERE appid = ?")
        .run("2026-09-08 00:00:00", 1527950);
      db.native.query("INSERT INTO price_history (appid, observed_at) VALUES (?, ?)")
        .run(1527950, "2026-09-08T00:00:00.000Z");
      expect(await listReceptionCandidates(db, ANCHOR)).toEqual([]);
      db.native.query(
        "INSERT INTO app_release_events (appid, event_type, event_date, updated_at) VALUES (?, ?, ?, ?)",
      ).run(1527950, "full_release", "2026-09-01", "2026-09-08T00:00:00.000Z");
      expect(await listReceptionCandidates(db, new Date("2026-09-09T00:00:00.000Z"))).toEqual([
        expect.objectContaining({ appid: 1527950, active: true, reason: "catalog_signal" }),
      ]);
      expect(readFileSync(join(directory, "reception-queue.md"), "utf8")).toContain("Due: 0");
      expect(readFileSync(join(directory, "reception-failures.md"), "utf8")).toContain("Reception failures");
      expect(readFileSync(join(directory, "reception-history.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("moves a failed title behind a clean peer and clears its streak after success", async () => {
    addGame(db, 1);
    addGame(db, 2);
    const failed = await runReviewCollection(db, {
      anchorTime: ANCHOR,
      maxGames: 1,
      customFetch: responder("summary500", []),
      artifactDirectory: null,
    });
    expect(failed.ordinaryFailures).toBe(1);
    expect((await listReceptionCandidates(db, ANCHOR)).map((candidate) => candidate.appid)).toEqual([2, 1]);
    const succeeded = await runReviewCollection(db, {
      anchorTime: ANCHOR,
      maxGames: 2,
      customFetch: responder("success", []),
      artifactDirectory: null,
    });
    expect(succeeded.persistedGames).toBe(2);
    expect(db.native.query("SELECT COUNT(*) AS count FROM reception_collection_failures").get()).toEqual({ count: 0 });
  });

  test("keeps an activity signal eligible after a partial collection failure", async () => {
    addGame(db, 10);
    await runReviewCollection(db, {
      anchorTime: ANCHOR,
      customFetch: responder("success", []),
      artifactDirectory: null,
    });
    db.native.query(
      "INSERT INTO app_release_events (appid, event_type, event_date, updated_at) VALUES (?, ?, ?, ?)",
    ).run(10, "full_release", "2026-09-01", "2026-09-08T00:00:00.000Z");
    const retryTime = new Date("2026-09-09T00:00:00.000Z");
    const failed = await runReviewCollection(db, {
      anchorTime: retryTime,
      customFetch: responder("histogram500", []),
      artifactDirectory: null,
    });
    expect(failed.ordinaryFailures).toBe(1);
    expect(await listReceptionCandidates(db, retryTime)).toEqual([
      expect.objectContaining({ appid: 10, active: true, reason: "catalog_signal" }),
    ]);
  });

  test("bounds operator snapshots while retaining backlog totals", async () => {
    for (let appid = 1; appid <= 501; appid++) addGame(db, appid);
    const directory = mkdtempSync(join(tmpdir(), "vaporstats-reception-bound-"));
    try {
      await runReviewCollection(db, {
        anchorTime: ANCHOR,
        maxGames: 0,
        customFetch: responder("success", []),
        artifactDirectory: directory,
      });
      const queue = readFileSync(join(directory, "reception-queue.md"), "utf8");
      expect(queue).toContain("Due: 501");
      expect(queue).toContain("1 additional candidates omitted.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("stops on a rate limit without recording a title failure", async () => {
    addGame(db, 1);
    addGame(db, 2);
    const calls: string[] = [];
    const result = await runReviewCollection(db, {
      anchorTime: ANCHOR,
      customFetch: responder("summary429", calls),
      artifactDirectory: null,
    });
    expect(result.rateLimited).toBe(true);
    expect(result.attemptedGames).toBe(1);
    expect(result.deferredGames).toBe(1);
    expect(calls).toHaveLength(1);
    expect(db.native.query("SELECT COUNT(*) AS count FROM reception_collection_failures").get()).toEqual({ count: 0 });
  });
});
