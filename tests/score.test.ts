import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import { getGameScoreHistory, getGameScoreSummary } from "../src/lib/score";

const DAY = 24 * 60 * 60 * 1000;
const AT = "2026-09-08T12:00:00.000Z";
const HIST = "histogram-test";
const SUMMARY = "summary-test";

function appDatabase(native: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T = unknown>() {
          const row = native.prepare(query).get(...(values as SQLQueryBindings[]));
          return (row as T | null) ?? null;
        },
        async run() {
          const result = native.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: Number(result.changes), duration: 0 } };
        },
        async all<T = unknown>() {
          return { success: true, results: native.prepare(query).all(...(values as SQLQueryBindings[])) as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T = unknown>() {
          return native.prepare(query).values(...(values as SQLQueryBindings[])) as T[];
        },
      };
      return statement;
    },
    async batch(statements) {
      native.run("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push({ success: (await statement.run()).success });
        native.run("COMMIT");
        return result;
      } catch (error) {
        native.run("ROLLBACK");
        throw error;
      }
    },
    async exec(query) {
      native.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

function freshDb(): { db: AppDatabase; native: Database } {
  const native = new Database(":memory:");
  applyMigrations(native);
  native.query("INSERT INTO apps (appid, name, slug) VALUES (10, 'Test Game', 'test-game')").run();
  native.query(`INSERT INTO review_sources
    (id, endpoint, request_filter, language, purchase_type, filter_offtopic_activity, population, interpretation_version, identity_key)
    VALUES (?, 'appreviewhistogram', 'none', NULL, NULL, NULL, 'histogram:all', 'test', ?),
           (?, 'appreviews', 'filter=all&language=all&purchase_type=all&filter_offtopic_activity=1', 'all', 'all', 1, 'summary:all', 'test', ?)`)
    .run(HIST, HIST, SUMMARY, SUMMARY);
  return { db: appDatabase(native), native };
}

function addDay(
  native: Database,
  start: string,
  positive: number,
  negative: number,
  source = HIST,
  observedAt = AT,
): void {
  const from = Date.parse(start);
  native.query(`INSERT INTO review_buckets
    (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
    VALUES (10, ?, 'daily', ?, ?, ?, ?, ?, 'test')`)
    .run(source, new Date(from).toISOString(), new Date(from + DAY).toISOString(), positive, negative, observedAt);
}

function addScore(
  native: Database,
  value = 81.25,
  observedAt = "2026-09-08T00:00:00.000Z",
  anchorEventId: string | null = null,
  anchorAt: string | null = null,
  provenance = "{}",
): void {
  native.query(`INSERT INTO player_score_history
    (appid, observed_at, score, formula_version, current_positive_count, current_total_count,
     historical_positive_count, historical_total_count, current_window_start, current_window_end,
     historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
     current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at,
     anchor_event_id, anchor_at, provenance)
    VALUES (10, ?, ?, 'test', 8, 10, 60, 100, '2026-06-10T00:00:00.000Z', ?,
      '2026-01-01T00:00:00.000Z', '2026-06-10T00:00:00.000Z',
      '[{"start":"2026-06-10T00:00:00.000Z","end":"2026-06-11T00:00:00.000Z","granularity":"day"}]',
      '[{"start":"2026-01-01T00:00:00.000Z","end":"2026-01-02T00:00:00.000Z","granularity":"day"}]',
      ?, ?, ?, ?, ?, ?, ?)`)
    .run(observedAt, value, observedAt, HIST, SUMMARY, observedAt, observedAt, anchorEventId, anchorAt, provenance);
}

describe("game score payload", () => {
  test("uses immutable recorded score inputs rather than corrected buckets", async () => {
    const { db, native } = freshDb();
    addScore(native);
    addDay(native, "2026-09-07T00:00:00Z", 10, 0);
    const before = await getGameScoreSummary(db, 10, { now: new Date(AT) });
    native.query("UPDATE review_buckets SET positive_count = 0, negative_count = 100 WHERE appid = 10 AND source_id = ?").run(HIST);
    const after = await getGameScoreSummary(db, 10, { now: new Date(AT) });
    expect(before.data?.score).toMatchObject({
      value: 81.25,
      current_positive_reviews: 8,
      current_total_reviews: 10,
      current_reviews: 10,
      current_evidence_intervals: [{ start: "2026-06-10T00:00:00.000Z", end: "2026-06-11T00:00:00.000Z", granularity: "day" }],
      historical_evidence_intervals: [{ start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z", granularity: "day" }],
      historical_evidence_window: { start: "2026-01-01T00:00:00.000Z", end: "2026-06-10T00:00:00.000Z" },
      provenance: {},
    });
    expect(after.data?.score).toMatchObject({ value: 81.25, current_reviews: 10 });
    expect(after.data?.score?.historical_support).toEqual({
      actual_reviews: 100,
      effective_reviews: 20,
      positive_reviews: 60,
      total_reviews: 100,
    });
    native.close(true);
  });

  test("retains an anchor source identity from immutable provenance", async () => {
    const { db, native } = freshDb();
    addScore(native, 81.25, "2026-09-08T00:00:00.000Z", "major-update", "2026-09-01T00:00:00.000Z", JSON.stringify({ anchor: { sourceId: "steam-news" } }));
    addDay(native, "2026-09-07T00:00:00Z", 10, 0);
    const result = await getGameScoreSummary(db, 10, { now: new Date(AT) });
    expect(result.data?.score?.anchor).toMatchObject({
      category: 14,
      start: "2026-09-01T00:00:00.000Z",
      event_id: "major-update",
      source_id: "steam-news",
    });
    native.close(true);
  });

  test("supports single-event ALL history without inventing a time span or source URL", async () => {
    const { db, native } = freshDb();
    const eventTime = "2026-09-07T15:30:45.123Z";
    native.query(`INSERT INTO steam_events
      (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('unknown-news', 10, 'unknown', 'News item', NULL, ?, NULL, ?, 'steam', '{}')`)
      .run(eventTime, AT);
    const result = await getGameScoreHistory(db, 10, "all", { now: new Date(AT) });
    expect(result.data?.milestones[0]).toMatchObject({
      event_id: "unknown-news",
      event_time: eventTime,
      date_basis: "start_at",
      source_url: null,
      kind: "unknown",
    });
    expect(result.data?.range_start).toBe(eventTime);
    expect(result.data?.range_end).toBe(eventTime);
    expect(result.data?.metrics).toEqual({ latest_approval: null, reviews_in_period: null });
    native.close(true);
  });

  test("keeps intersecting display buckets separate from fully contained period metrics and spans ALL", async () => {
    const { db, native } = freshDb();
    addDay(native, "2026-09-07T00:00:00Z", 10, 0);
    const fixed = await getGameScoreHistory(db, 10, "24h", { now: new Date(AT) });
    expect(fixed.data?.range_start).toBe("2026-09-07T12:00:00.000Z");
    expect(fixed.data?.approval_buckets).toHaveLength(1);
    expect(fixed.data?.metrics.reviews_in_period).toBeNull();
    const all = await getGameScoreHistory(db, 10, "all", { now: new Date(AT) });
    expect(all.data?.range_start).toBe("2026-09-07T00:00:00.000Z");
    expect(all.data?.range_end).toBe("2026-09-08T00:00:00.000Z");
    native.close(true);
  });

  test("uses the latest selected bucket for approval and an integer for period reviews", async () => {
    const { db, native } = freshDb();
    addDay(native, "2026-09-02T00:00:00Z", 9, 1);
    addDay(native, "2026-09-03T00:00:00Z", 8, 2);
    addDay(native, "2026-09-04T00:00:00Z", 7, 3);
    addDay(native, "2026-09-05T00:00:00Z", 6, 4);
    addDay(native, "2026-09-06T00:00:00Z", 5, 5);
    addDay(native, "2026-09-07T00:00:00Z", 1, 9);
    const result = await getGameScoreHistory(db, 10, "7d", { now: new Date(AT) });
    expect(result.data?.metrics.latest_approval).toMatchObject({
      value: 10,
      positive_reviews: 1,
      total_reviews: 10,
      included_start: "2026-09-07T00:00:00.000Z",
      included_end: "2026-09-08T00:00:00.000Z",
      observed_at: AT,
    });
    expect(result.data?.metrics.reviews_in_period).toMatchObject({
      value: 60,
      positive_reviews: 36,
      total_reviews: 60,
      included_start: "2026-09-02T00:00:00.000Z",
      included_end: "2026-09-08T00:00:00.000Z",
    });
    native.close(true);
  });

  test("evaluates now and lifetime eligibility independently of a retained score", async () => {
    const { db, native } = freshDb();
    addScore(native);
    addDay(native, "2026-09-07T00:00:00Z", 1, 0);
    native.query("INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (10, ?, ?, 300, 300)").run(SUMMARY, AT);
    const result = await getGameScoreSummary(db, 10, { now: new Date(AT) });
    expect(result.data?.score?.value).toBe(81.25);
    expect(result.data?.eligibility.now.global.eligible).toBe(false);
    expect(result.data?.eligibility.now.global.reasons).toContain("below_review_threshold");
    expect(result.data?.eligibility.all_time.global.eligible).toBe(true);
    native.close(true);
  });

  test("returns summary-only Recent reception with fixed UTC windows and snake-case delta", async () => {
    const { db, native } = freshDb();
    const cutoff = Date.parse("2026-09-08T00:00:00Z");
    for (let index = 1; index <= 84; index += 1) {
      const positive = index <= 28 ? 95 : 50;
      addDay(native, new Date(cutoff - index * DAY).toISOString(), positive, 100 - positive, HIST, "2026-09-07T23:00:00.000Z");
    }
    const result = await getGameScoreSummary(db, 10, { now: new Date(AT) });
    expect(result.data?.recent_reception.recent.start).toBe("2026-08-11T00:00:00.000Z");
    expect(result.data?.recent_reception.previous.end).toBe("2026-08-11T00:00:00.000Z");
    expect(result.data?.recent_reception.delta_pp).toBe(45);
    expect(result.data?.recent_reception.state).toBe("more_positive");
    native.close(true);
  });
  test("excludes future scores, incomplete buckets, and scheduled events from ALL bounds", async () => {
    const { db, native } = freshDb();
    addDay(native, "2026-09-07T00:00:00Z", 10, 0);
    addDay(native, "2026-09-09T00:00:00Z", 20, 0);
    addScore(native, 90, "2026-09-09T00:00:00.000Z");
    native.query(`INSERT INTO steam_events
      (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('future-patch', 10, 'patch', 'Future patch', NULL, '2026-09-12', '2026-09-12', ?, 'steam', '{}')`)
      .run(AT);
    native.query(`INSERT INTO steam_events
      (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('past-patch-publication', 10, 'patch', 'Published patch', NULL, NULL, '2026-09-07T00:00:00.000Z', ?, 'steam', '{}')`)
      .run(AT);
    const result = await getGameScoreHistory(db, 10, "all", { now: new Date(AT) });
    expect(result.data?.range_start).toBe("2026-09-07T00:00:00.000Z");
    expect(result.data?.range_end).toBe("2026-09-08T00:00:00.000Z");
    expect(result.data?.recorded_scores).toHaveLength(0);
    expect(result.data?.approval_buckets).toHaveLength(1);
    expect(result.data?.milestones).toHaveLength(1);
    expect(result.data?.milestones[0]?.date_basis).toBe("publication_at");
    native.close(true);
  });
  test("retains a critic record but leaves alignment unavailable when PC identity is not proven", async () => {
    const { db, native } = freshDb();
    addScore(native);
    native.query(`INSERT INTO critic_records
      (appid, source, matched_identity, platform_scope, edition, native_score, score_scale, source_url,
       review_count, review_period_start, review_period_end, collection_basis, observed_at, provenance, basis)
      VALUES (10, 'opencritic', ?, 'mixed', 'base', 80, 100, 'https://example.test/critic', 50,
       '2026-08-01', '2026-08-31', 'public_page', ?, ?, 'public aggregate page')`)
      .run(JSON.stringify({ steamAppId: 10, platformScope: "mixed", edition: "base", evidence: "aggregate" }), AT,
        JSON.stringify({ sourceId: "critic-test", title: "Test Game", slug: "test-game", platforms: ["PC", "Console"], identityVerified: true, cadence: "monthly" }));
    const result = await getGameScoreSummary(db, 10, { now: new Date(AT) });
    expect(result.data?.critics).toHaveLength(1);
    expect(result.data?.critics[0]?.platform_scope).toBe("mixed");
    expect(result.data?.alignment[0]?.state).toBe("unavailable");
    expect(result.data?.alignment[0]?.reasons).toContain("platform_not_pc");
    native.close(true);
  });
});
