import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  getGameReceptionEligibility,
  getReceptionComparison,
  getReceptionRankings,
} from "../src/lib/rankings";
import { normalizeReceptionFilters } from "../src/lib/reception-filters";

const EVALUATED_AT = "2026-09-08T00:00:00.000Z";
const HISTOGRAM_SOURCE = "histogram-filtered";
const SUMMARY_SOURCE = "summary-filtered";
const DAY = 24 * 60 * 60 * 1000;

function appDatabase(native: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T = unknown>(column?: string) {
          const row = native.prepare(query).get(...(values as SQLQueryBindings[])) as Record<string, unknown> | null;
          return row ? (column ? ((row[column] as T) ?? null) : (row as T)) : null;
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
  const db = appDatabase(native);
  native.query(
    `INSERT INTO review_sources
      (id, endpoint, request_filter, language, purchase_type, filter_offtopic_activity, population, interpretation_version, identity_key)
    VALUES (?, 'appreviewhistogram', 'none', NULL, NULL, NULL, 'filtered_reviews', 'test', ?),
           (?, 'appreviews', 'filter=all', 'all', 'all', 1, 'summary:all:all:all:1', 'test', ?)`
  ).run(HISTOGRAM_SOURCE, HISTOGRAM_SOURCE, SUMMARY_SOURCE, SUMMARY_SOURCE);
  return { db, native };
}

function addApp(native: Database, appid: number, name = `Game ${appid}`): void {
  native.query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, name, name.toLowerCase().replaceAll(" ", "-"));
}

function addScore(
  native: Database,
  appid: number,
  value: number,
  observedAt = "2026-09-07T00:00:00.000Z",
  anchorEventId: string | null = null,
  anchorAt: string | null = null,
): void {
  const currentWindowStart = anchorAt ?? "2026-06-10T00:00:00.000Z";
  const currentEvidenceIntervals = anchorAt
    ? JSON.stringify([{ start: anchorAt, end: observedAt, granularity: "day" }])
    : "[]";
  native.query(`
    INSERT INTO player_score_history
      (appid, observed_at, score, formula_version,
       current_positive_count, current_total_count, historical_positive_count, historical_total_count,
       current_window_start, current_window_end, historical_window_start, historical_window_end,
       current_evidence_intervals, historical_evidence_intervals,
       current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at,
       anchor_event_id, anchor_at, provenance)
    VALUES (?, ?, ?, 'test', 1, 1, 0, 0, ?, ?,
            '2026-01-01T00:00:00.000Z', '2026-06-10T00:00:00.000Z', ?, '[]', ?, NULL, ?, NULL, ?, ?, '{}')
  `).run(appid, observedAt, value, currentWindowStart, observedAt, currentEvidenceIntervals, HISTOGRAM_SOURCE, observedAt, anchorEventId, anchorAt);
}


function addBuckets(native: Database, appid: number, total: number, start = "2026-06-10T00:00:00.000Z"): void {
  const perDay = Math.floor(total / 90);
  let remainder = total - perDay * 90;
  const startMs = Date.parse(start);
  const insert = native.query(`
    INSERT INTO review_buckets
      (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
    VALUES (?, ?, 'daily', ?, ?, ?, 0, '2026-09-07T00:00:00.000Z', 'test')
  `);
  for (let day = 0; day < 90; day += 1) {
    const count = perDay + (remainder-- > 0 ? 1 : 0);
    const from = new Date(startMs + day * DAY).toISOString();
    const to = new Date(startMs + (day + 1) * DAY).toISOString();
    insert.run(appid, HISTOGRAM_SOURCE, from, to, count);
  }
}



function addBucketsForDays(native: Database, appid: number, total: number, days: number, start: string, observedAt = "2026-09-07T00:00:00.000Z"): void {
  const perDay = Math.floor(total / days);
  let remainder = total - perDay * days;
  const startMs = Date.parse(start);
  const insert = native.query(`
    INSERT INTO review_buckets
      (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
    VALUES (?, ?, 'daily', ?, ?, ?, 0, ?, 'test')
  `);
  for (let day = 0; day < days; day += 1) {
    const count = perDay + (remainder-- > 0 ? 1 : 0);
    const from = new Date(startMs + day * DAY).toISOString();
    const to = new Date(startMs + (day + 1) * DAY).toISOString();
    insert.run(appid, HISTOGRAM_SOURCE, from, to, count, observedAt);
  }
}

function addGenre(native: Database, appid: number, id: number): void {
  native.query("INSERT OR IGNORE INTO app_facets (facet_group, source_id, name) VALUES ('genre', ?, ?)").run(String(id), `Genre ${id}`);
  native.query(`
    INSERT INTO app_facet_memberships (appid, facet_group, source_id, source_order)
    VALUES (?, 'genre', ?, 0)
  `).run(appid, String(id));
}

describe("reception ranking query domain", () => {
  test("normalizes sorted, deduplicated facet arrays", () => {
    expect(normalizeReceptionFilters({ genres: [3, 1, 3, 0], features: [2, 1], tags: [] })).toEqual({
      genres: [1, 3], features: [1, 2], tags: [],
    });
  });

  test("applies actual volume gates, precision ties, and facet AND/OR semantics", async () => {
    const { db, native } = freshDb();
    addApp(native, 1); addApp(native, 2); addApp(native, 3);
    addScore(native, 1, 88.123456); addScore(native, 2, 88.123456); addScore(native, 3, 99);
    addBuckets(native, 1, 260); addBuckets(native, 2, 250); addBuckets(native, 3, 50);
    addGenre(native, 3, 7);

    const global = await getReceptionRankings(db, { evaluatedAt: EVALUATED_AT, limit: 10 });
    expect(global.data.items.map((item) => [item.rank, item.game.appid])).toEqual([[1, 1], [2, 2]]);
    expect(global.data.eligible_total).toBe(2);

    const filtered = await getReceptionRankings(db, {
      evaluatedAt: EVALUATED_AT,
      filters: { genres: [7], features: [], tags: [] },
      limit: 10,
    });
    expect(filtered.data.items.map((item) => item.game.appid)).toEqual([3]);
        expect((await getReceptionRankings(db, { evaluatedAt: EVALUATED_AT, filters: { genres: [999], features: [], tags: [] } })).data.items).toEqual([]);
        const outside = await getReceptionComparison(db, { appid: 3, evaluatedAt: EVALUATED_AT, type: "top_rated_now" });
        expect(outside.data?.in_current_group).toBe(false);
        expect(outside.data?.points).toEqual([]);
        expect((await getReceptionComparison(db, { appid: 9999, evaluatedAt: EVALUATED_AT })).data).toBeNull();
    native.close(true);
  });

  test("re-evaluates the clock and keeps the exclusive cutoff boundary", async () => {
    const { db, native } = freshDb();
    addApp(native, 10); addScore(native, 10, 75, "2026-09-01T00:00:00.000Z"); addBuckets(native, 10, 250);
    const atEvaluation = await getGameReceptionEligibility(db, 10, EVALUATED_AT);
    expect(atEvaluation?.now.qualifying_reviews).toBe(250);
    expect(atEvaluation?.now.global.eligible).toBe(true);

    const comparison = await getReceptionComparison(db, {
      appid: 10,
      evaluatedAt: EVALUATED_AT,
      type: "top_rated_now",
    });
    const september = comparison.data?.points.find((point) => point.cutoff === "2026-09-01T00:00:00.000Z");
    expect(september).toMatchObject({
      provenance: "reconstructed",
      observed_at: "2026-09-07T00:00:00.000Z",
      score_window_end: "2026-09-01T00:00:00.000Z",
    });
    expect(september?.value).toBeGreaterThan(99);
    native.close(true);

    const laterFixture = freshDb();
    addApp(laterFixture.native, 11);
    addScore(laterFixture.native, 11, 75, "2026-09-01T00:00:00.000Z");
    addBuckets(laterFixture.native, 11, 250, "2026-07-10T00:00:00.000Z");
    const later = await getReceptionComparison(laterFixture.db, {
      appid: 11,
      evaluatedAt: "2026-10-08T00:00:00.000Z",
      type: "top_rated_now",
    });
    expect(later.data?.points.find((point) => point.observed_at === "2026-09-01T00:00:00.000Z")?.cutoff).toBe("2026-10-01T00:00:00.000Z");
    laterFixture.native.close(true);
  });

  test("keeps the twelve-month grid, omits missing history, and compares beyond the global cap", async () => {
    const { db, native } = freshDb();
    for (let appid = 1; appid <= 101; appid += 1) {
      addApp(native, appid);
      addScore(native, appid, 100 - appid / 1000);
      addBuckets(native, appid, 250);
    }
    const list = await getReceptionRankings(db, { evaluatedAt: EVALUATED_AT, limit: 100 });
    expect(list.data.total).toBe(100);
    expect(list.data.eligible_total).toBe(101);

    const comparison = await getReceptionComparison(db, {
      appid: 101,
      evaluatedAt: EVALUATED_AT,
      type: "top_rated_now",
    });
    expect(comparison.data?.in_current_group).toBe(true);
    expect(comparison.data?.cutoffs).toHaveLength(12);
    expect(comparison.data?.points.map((point) => point.cutoff)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    expect(comparison.data?.points.every((point) => point.provenance === "reconstructed")).toBe(true);
    expect(comparison.data?.points.every((point) => point.compared_count === 101)).toBe(true);
    expect(comparison.data?.points.every((point) => point.comparison_rank > 100)).toBe(true);
    native.close(true);
  });

  test("uses compatible lifetime summaries independently of histogram and current score", async () => {
    const { db, native } = freshDb();
    addApp(native, 20); addGenre(native, 20, 8); addBuckets(native, 20, 250);
    native.query("INSERT INTO review_sources (id, endpoint, request_filter, population, interpretation_version, identity_key) VALUES (?, 'appreviews', 'other', 'all_reviews', 'test', ?)").run("summary-incompatible", "summary-incompatible");
    native.query("INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (?, ?, ?, ?, ?)").run(20, "summary-incompatible", "2026-09-07T00:00:00.000Z", 100, 100);
    native.query("INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (?, ?, ?, ?, ?)").run(20, SUMMARY_SOURCE, "2026-08-01T00:00:00.000Z", 40, 100);
    native.query("INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (?, ?, ?, ?, ?)").run(20, SUMMARY_SOURCE, "2026-09-07T00:00:00.000Z", 60, 100);
    const ranking = await getReceptionRankings(db, { type: "top_rated_all_time", filters: { genres: [8], features: [], tags: [] }, evaluatedAt: EVALUATED_AT });
    expect(ranking.data.items[0]?.metric).toMatchObject({ kind: "lifetime_approval", value: 60 });
    expect(ranking.data.items[0]?.eligibility.qualifying_reviews).toBe(100);
    const comparison = await getReceptionComparison(db, { type: "top_rated_all_time", appid: 20, filters: { genres: [8], features: [], tags: [] }, evaluatedAt: EVALUATED_AT });
    const august = comparison.data?.points.find((point) => point.cutoff === "2026-09-01T00:00:00.000Z");
    expect(august?.value).toBe(40);
    native.close(true);
  });

  test("uses stored score interval bounds and preserves unknown histogram metadata", async () => {
    const { db, native } = freshDb();
    addApp(native, 21);
    addScore(native, 21, 77);
    native.query("UPDATE player_score_history SET current_evidence_intervals = ? WHERE appid = ?").run(
      JSON.stringify([
        { start: "2026-07-01T00:00:00.000Z", end: "2026-07-15T00:00:00.000Z" },
        { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" },
      ]),
      21,
    );
    addBuckets(native, 21, 250);
    const ranking = await getReceptionRankings(db, { evaluatedAt: EVALUATED_AT });
    expect(ranking.data.items[0]?.metric).toMatchObject({
      evidence_start: "2026-07-01T00:00:00.000Z",
      evidence_end: "2026-08-10T00:00:00.000Z",
    });
    expect(ranking.data.items[0]?.eligibility.population_ref).toMatchObject({
      endpoint: "appreviewhistogram",
      population: "filtered_reviews",
      language: null,
      purchase_type: null,
      filter_offtopic_activity: null,
    });
    native.close(true);
  });
  test("keeps anchored Now eligibility on rolling evidence until reviews age out", async () => {
    const { db, native } = freshDb();
    const appid = 30;
    addApp(native, appid, "Anchored Game");
    addGenre(native, appid, 9);
    addBuckets(native, appid, 250);
    addScore(native, appid, 78, "2026-08-31T00:00:00.000Z");
    addScore(native, appid, 12, "2026-09-02T00:00:00.000Z", "major-update", "2026-09-01T00:00:00.000Z");
    native.query(
      "INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (?, ?, ?, ?, ?)",
    ).run(appid, SUMMARY_SOURCE, "2026-09-07T00:00:00.000Z", 300, 500);

    const afterPostpatchReview = await getGameReceptionEligibility(db, appid, EVALUATED_AT);
    expect(afterPostpatchReview?.now.qualifying_reviews).toBe(250);
    expect(afterPostpatchReview?.now.global).toEqual({ minimum_reviews: 250, eligible: true, reasons: [] });
    expect(afterPostpatchReview?.now.filtered).toEqual({ minimum_reviews: 50, eligible: true, reasons: [] });
    expect(afterPostpatchReview?.all_time.global).toEqual({ minimum_reviews: 250, eligible: true, reasons: [] });
    expect(afterPostpatchReview?.all_time.filtered).toEqual({ minimum_reviews: 50, eligible: true, reasons: [] });

    const now = await getReceptionRankings(db, { type: "top_rated_now", evaluatedAt: EVALUATED_AT });
    expect(now.data.minimum_reviews).toBe(250);
    expect(now.data.items.map((item) => item.game.appid)).toEqual([appid]);
    expect(now.data.items[0]?.metric).toMatchObject({ kind: "current_player_score", value: 12, observed_at: "2026-09-02T00:00:00.000Z" });
    expect(now.data.items[0]?.eligibility.qualifying_reviews).toBe(250);

    const agedAt = "2026-12-08T00:00:00.000Z";
    const afterReviewsAgeOut = await getGameReceptionEligibility(db, appid, agedAt);
    expect(afterReviewsAgeOut?.now.qualifying_reviews).toBeNull();
    expect(afterReviewsAgeOut?.now.global).toMatchObject({ minimum_reviews: 250, eligible: false });
    expect(afterReviewsAgeOut?.now.filtered).toMatchObject({ minimum_reviews: 50, eligible: false });
    expect(afterReviewsAgeOut?.all_time.global).toEqual({ minimum_reviews: 250, eligible: true, reasons: [] });
    expect(afterReviewsAgeOut?.all_time.filtered).toEqual({ minimum_reviews: 50, eligible: true, reasons: [] });

    const nowAfterReviewsAgeOut = await getReceptionRankings(db, { type: "top_rated_now", evaluatedAt: agedAt });
    expect(nowAfterReviewsAgeOut.data.minimum_reviews).toBe(250);
    expect(nowAfterReviewsAgeOut.data.items).toEqual([]);
    const allTimeAfterReviewsAgeOut = await getReceptionRankings(db, { type: "top_rated_all_time", evaluatedAt: agedAt });
    expect(allTimeAfterReviewsAgeOut.data.minimum_reviews).toBe(250);
    expect(allTimeAfterReviewsAgeOut.data.items.map((item) => item.game.appid)).toEqual([appid]);
    expect(allTimeAfterReviewsAgeOut.data.items[0]?.eligibility.qualifying_reviews).toBe(500);
    native.close(true);
  });
  test("reconstructs missing Now cutoffs without mixing All Time evidence", async () => {
    const { db, native } = freshDb();
    addApp(native, 40, "Reconstructed Game");
    addApp(native, 41, "Recorded Game");
    addApp(native, 42, "No Evidence Game");
    addApp(native, 43, "Histogram Only Game");
    addScore(native, 40, 70);
    addScore(native, 41, 71, "2026-08-15T00:00:00.000Z");
    addScore(native, 41, 72);
    addScore(native, 42, 73);
    addScore(native, 43, 74);
    addBucketsForDays(native, 40, 300, 99, "2026-06-01T00:00:00.000Z");
    addBucketsForDays(native, 41, 300, 99, "2026-06-01T00:00:00.000Z");
    addBucketsForDays(native, 43, 300, 99, "2026-06-01T00:00:00.000Z");
    native.query(
      "INSERT INTO steam_events (event_id, appid, category, start_at, observed_at, source, provenance) VALUES (?, ?, 'major_update', ?, ?, ?, '{}')",
    ).run("major-40", 40, "2026-08-01T00:00:00.000Z", "2026-09-07T00:00:00.000Z", "steam_news_hub");

    const now = await getReceptionComparison(db, { type: "top_rated_now", appid: 40, evaluatedAt: EVALUATED_AT });
    const september = now.data?.points.find((point) => point.cutoff === "2026-09-01T00:00:00.000Z");
    expect(september?.provenance).toBe("reconstructed");
    expect(september?.observed_at).toBe("2026-09-07T00:00:00.000Z");
    expect(september?.score_window_end).toBe("2026-09-01T00:00:00.000Z");
    expect(now.data?.reconstructed_members).toBeGreaterThan(0);

    const recorded = await getReceptionComparison(db, { type: "top_rated_now", appid: 41, evaluatedAt: EVALUATED_AT });
    expect(recorded.data?.points.find((point) => point.cutoff === "2026-09-01T00:00:00.000Z")?.provenance).toBe("recorded");

    const noEvidence = await getReceptionComparison(db, { type: "top_rated_now", appid: 42, evaluatedAt: EVALUATED_AT });
    expect(noEvidence.data?.in_current_group).toBe(false);
    expect(noEvidence.data?.points).toEqual([]);
    const allTime = await getReceptionComparison(db, { type: "top_rated_all_time", appid: 43, evaluatedAt: EVALUATED_AT });
    expect(allTime.data?.in_current_group).toBe(false);
    expect(allTime.data?.points).toEqual([]);
    native.close(true);
  });
});
