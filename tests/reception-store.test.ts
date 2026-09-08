import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  compactReviewEvidence,
  getPlayerScoreHistory,
  getReviewBuckets,
  getReviewSummarySnapshots,
  persistReceptionObservation,
} from "../src/lib/reception-store";
import type { ReviewSourceProvenance, SteamReviewHistogram, SteamReviewSummary } from "../workers/review-source";
import type { SteamEventRecord } from "../workers/steam-events";

const HIST_SOURCE = "histogram|population=all_reviews|flags=%7B%22count_all_reviews%22%3Atrue%7D|interpretation=steam-review-source-v1";
const SUMMARY_SOURCE = "appreviews|filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=1&num_per_page=0|population=summary:all:all:all:1|flags=%7B%22day_range%22%3A30%7D|interpretation=steam-review-source-v1";
const OBSERVED = "2026-09-01T00:00:00.000Z";

type BatchStatement = AppPreparedStatement & { _query: string; _values: () => SQLQueryBindings[] };

function isBatchStatement(value: AppPreparedStatement): value is BatchStatement {
  return "_query" in value && "_values" in value && typeof value._values === "function";
}
class MemoryDb implements AppDatabase {
  readonly native = new Database(":memory:");
  failAt: number | null = null;

  constructor() {
    this.native.exec(`
      PRAGMA foreign_keys = ON;
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
    let index = 0;
    const transaction = this.native.transaction(() => statements.map((rawStatement) => {
      const statement = isBatchStatement(rawStatement) ? rawStatement : (() => { throw new Error("test statement adapter mismatch"); })();
      index++;
      if (this.failAt !== null && index === this.failAt) throw new Error("test transaction failure");
      this.native.query(statement._query).run(...statement._values());
      return { success: true };
    }));
    return transaction();
  }

  async exec(query: string) { this.native.exec(query); return { count: 0, duration: 0 }; }
  close() { this.native.close(true); }
}

function provenance(endpoint: "appreviews" | "appreviewhistogram", identityKey: string, population: string): ReviewSourceProvenance {
  const populationFlags: ReviewSourceProvenance["populationFlags"] = endpoint === "appreviews" ? { day_range: 30 } : { count_all_reviews: true };
  return {
    endpoint,
    requestFilter: endpoint === "appreviews" ? "filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=1&num_per_page=0" : "none",
    language: endpoint === "appreviews" ? "all" : null,
    purchaseType: endpoint === "appreviews" ? "all" : null,
    dayRange: endpoint === "appreviews" ? 30 : null,
    filterOfftopicActivity: endpoint === "appreviews" ? 1 : null,
    population,
    populationFlags,
    interpretationVersion: "steam-review-source-v1",
    identityKey,
  };
}

function histogram(appid: number, observedAt: string, positive: number, negative: number, sourceId = HIST_SOURCE): SteamReviewHistogram {
  const start = "2026-08-31T00:00:00.000Z";
  const end = "2026-09-01T00:00:00.000Z";
  return {
    appid,
    observedAt,
    sourceId,
    sourceWindow: { startEpochSeconds: null, endEpochSeconds: null, startAt: null, endAt: null },
    rollupType: "day",
    buckets: [{ appid, sourceId, granularity: "day", periodStart: start, periodEnd: end, positiveCount: positive, negativeCount: negative, observedAt, provenance: "steam.appreviewhistogram" }],
    openBuckets: [],
    events: [],
    provenance: provenance("appreviewhistogram", sourceId, "all_reviews"),
    unknownFlags: {},
    unknownBuckets: [],
  };
}

function summary(appid: number, observedAt: string): SteamReviewSummary {
  return {
    appid,
    numReviews: 1,
    lifetimePositiveCount: 80,
    lifetimeNegativeCount: 20,
    lifetimeTotalCount: 100,
    reviewScore: 8,
    reviewScoreDesc: "Very Positive",
    observedAt,
    sourceId: SUMMARY_SOURCE,
    provenance: provenance("appreviews", SUMMARY_SOURCE, "summary:all:all:all:1"),
  };
}

function majorEvent(observedAt: string): SteamEventRecord {
  return {
    eventId: "event-major",
    announcementId: "announcement-major",
    appid: 1,
    category: "major_update",
    rawCategory: 14,
    title: "Major update",
    url: "https://store.steampowered.com/news/app/1/view/event-major",
    startAt: "2026-08-30T00:00:00.000Z",
    publicationAt: "2026-08-29T00:00:00.000Z",
    endAt: null,
    visibilityStartAt: null,
    visibilityEndAt: null,
    lastModifiedAt: null,
    buildId: null,
    observedAt,
    source: "steam.news_hub",
    provenance: "steam-news-hub-v1",
  };
}

describe("reception persistence", () => {
  let db: MemoryDb;
  beforeEach(() => { db = new MemoryDb(); db.native.query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(1, "Test", "test"); });
  afterEach(() => db.close());

  test("keeps unchanged, clock-only, and anchor-only observations out of immutable score history", async () => {
    await persistReceptionObservation(db, { appid: 1, histogram: histogram(1, OBSERVED, 10, 2), observedAt: OBSERVED });
    await persistReceptionObservation(db, { appid: 1, histogram: histogram(1, "2026-09-02T00:00:00.000Z", 10, 2), observedAt: "2026-09-02T00:00:00.000Z" });
    await persistReceptionObservation(db, { appid: 1, histogram: histogram(1, "2026-09-03T00:00:00.000Z", 10, 2), events: [majorEvent("2026-09-03T00:00:00.000Z")], observedAt: "2026-09-03T00:00:00.000Z" });
    expect((await getPlayerScoreHistory(db, 1))).toHaveLength(1);
  });

  test("uses resolved major-event metadata in the same supported score observation", async () => {
    await persistReceptionObservation(db, {
      appid: 1, histogram: histogram(1, OBSERVED, 10, 2), observedAt: OBSERVED,
      events: [{ ...majorEvent(OBSERVED), category: "unknown", rawCategory: null, startAt: null }],
    });
    const original = (await getPlayerScoreHistory(db, 1))[0];
    const nextTime = "2026-09-02T00:00:00.000Z";
    await persistReceptionObservation(db, {
      appid: 1, histogram: histogram(1, nextTime, 11, 2), observedAt: nextTime,
      events: [majorEvent(nextTime)],
    });
    const history = await getPlayerScoreHistory(db, 1);
    expect(history[0]).toEqual(original);
    expect(history.at(-1)?.anchor_event_id).toBe("event-major");
    expect(history.at(-1)?.anchor_at).toBe("2026-08-30T00:00:00.000Z");
  });

  test("appends corrected evidence without overwriting old inputs and keeps summary populations separate", async () => {
    await persistReceptionObservation(db, { appid: 1, histogram: histogram(1, OBSERVED, 10, 2), observedAt: OBSERVED });
    await persistReceptionObservation(db, { appid: 1, histogram: histogram(1, "2026-09-02T00:00:00.000Z", 11, 2), summary: summary(1, "2026-09-02T00:00:00.000Z"), observedAt: "2026-09-02T00:00:00.000Z" });
    const history = await getPlayerScoreHistory(db, 1);
    expect(history).toHaveLength(2);
    expect(history[0]?.current_positive_count).toBe(10);
    expect(history[1]?.current_positive_count).toBe(11);
    expect(await getReviewSummarySnapshots(db, 1)).toHaveLength(1);
    expect((await getReviewBuckets(db, 1))[0]?.source_id).toBe(HIST_SOURCE);
  });

  test("does not mix source populations when a newer source appears", async () => {
    const otherSource = "histogram|population=filtered_reviews|flags=%7B%22count_all_reviews%22%3Afalse%7D|interpretation=steam-review-source-v1";
    await persistReceptionObservation(db, { appid: 1, histogram: histogram(1, OBSERVED, 10, 2), observedAt: OBSERVED });
    await persistReceptionObservation(db, { appid: 1, histogram: histogram(1, "2026-09-04T00:00:00.000Z", 100, 0, otherSource), observedAt: "2026-09-04T00:00:00.000Z" });
    const history = await getPlayerScoreHistory(db, 1);
    expect(history.at(-1)?.current_total_count).toBe(100);
    expect(history.at(-1)?.current_source_id).toBe(otherSource);
  });

  test("rolls back all source, event, state, and score writes as one transaction", async () => {
    db.failAt = 3;
    await expect(persistReceptionObservation(db, { appid: 1, histogram: histogram(1, OBSERVED, 10, 2), events: [majorEvent(OBSERVED)], observedAt: OBSERVED })).rejects.toThrow("test transaction failure");
    expect((await getReviewBuckets(db, 1))).toHaveLength(0);
    expect((await getPlayerScoreHistory(db, 1))).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM review_sources").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM steam_events").first<{ count: number }>()).toEqual({ count: 0 });
  });

  test("compacts complete old months, retains partial months, and preserves source observation time", async () => {
    const source = HIST_SOURCE;
    await db.prepare("INSERT INTO review_sources (id, endpoint, request_filter, population, population_flags, interpretation_version, identity_key) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(source, "appreviewhistogram", "none", "all_reviews", "{}", "steam-review-source-v1", source).run();
    const statements: AppPreparedStatement[] = [];
    for (let day = 0; day < 31; day++) {
      const start = new Date(Date.UTC(2025, 7, day + 1)).toISOString();
      const end = new Date(Date.UTC(2025, 7, day + 2)).toISOString();
      statements.push(db.prepare("INSERT INTO review_buckets (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance) VALUES (?, ?, 'daily', ?, ?, 1, 2, ?, 'test')").bind(1, source, start, end, "2025-09-01T00:00:00.000Z"));
    }
    for (let day = 0; day < 3; day++) {
      const start = new Date(Date.UTC(2025, 6, day + 1)).toISOString();
      const end = new Date(Date.UTC(2025, 6, day + 2)).toISOString();
      statements.push(db.prepare("INSERT INTO review_buckets (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance) VALUES (?, ?, 'daily', ?, ?, 1, 2, ?, 'test')").bind(1, source, start, end, "2025-08-01T00:00:00.000Z"));
    }
    await db.batch(statements);
    db.failAt = 1;
    await expect(compactReviewEvidence(db, "2026-09-01T00:00:00.000Z")).rejects.toThrow("test transaction failure");
    expect((await getReviewBuckets(db, 1, source)).filter((row) => row.granularity === "monthly")).toHaveLength(0);
    db.failAt = null;
    const result = await compactReviewEvidence(db, "2026-09-01T00:00:00.000Z");
    expect(result.monthsCompacted).toBe(1);
    expect((await getReviewBuckets(db, 1, source)).filter((row) => row.granularity === "monthly")).toHaveLength(1);
    expect((await getReviewBuckets(db, 1, source)).filter((row) => row.period_start.startsWith("2025-07"))).toHaveLength(3);
    expect((await getReviewBuckets(db, 1, source)).find((row) => row.granularity === "monthly")?.observed_at).toBe("2025-09-01T00:00:00.000Z");
  });
});
