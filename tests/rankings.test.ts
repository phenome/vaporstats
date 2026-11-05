import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  getGameReceptionEligibility,
  getReceptionComparison,
  getReceptionRankings,
  ReceptionPublicationUnavailableError,
} from "../src/lib/rankings";
import { normalizeReceptionFilters } from "../src/lib/reception-filters";
import { buildReceptionComparisonChartData } from "../src/components/rankings-page";
import { publishReceptionProjection } from "../src/lib/reception-publication";

const EVALUATED_AT = "2026-09-08T00:00:00.000Z";
const HISTOGRAM_SOURCE = "histogram-filtered";
const SUMMARY_SOURCE = "summary-filtered";
const DAY = 24 * 60 * 60 * 1000;

function appDatabase(native: Database, onRead?: (query: string, rows: unknown[]) => void): AppDatabase {
  const executions = new WeakMap<AppPreparedStatement, () => { success: boolean; results?: unknown[] }>();
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const read = () => {
        const rows = native.prepare(query).all(...(values as SQLQueryBindings[]));
        onRead?.(query, rows);
        return rows;
      };
      const statement: AppPreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T = unknown>(column?: string) {
          const row = read()[0] as Record<string, unknown> | undefined;
          return row ? (column ? ((row[column] as T) ?? null) : (row as T)) : null;
        },
        async run() {
          const result = native.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: Number(result.changes), duration: 0 } };
        },
        async all<T = unknown>() {
          return { success: true, results: read() as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T = unknown>() {
          return native.prepare(query).values(...(values as SQLQueryBindings[])) as T[];
        },
      };
      executions.set(statement, () => {
        if (/^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(query.trim())) {
          return { success: true, results: read() };
        }
        native.prepare(query).run(...(values as SQLQueryBindings[]));
        return { success: true };
      });
      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]) {
      return native.transaction(() => statements.map((statement) => {
        const execute = executions.get(statement);
        if (!execute) throw new Error("Statement belongs to a different database");
        return execute() as { success: boolean; results?: T[] };
      }))();
    },
    async exec(query) {
      native.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

function freshDb(path = ":memory:"): { db: AppDatabase; native: Database } {
  const native = new Database(path);
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

function addSummary(
  native: Database,
  appid: number,
  positive: number,
  total: number,
  observedAt = "2026-09-07T00:00:00.000Z",
): void {
  native.query(
    "INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (?, ?, ?, ?, ?)",
  ).run(appid, SUMMARY_SOURCE, observedAt, positive, total);
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

    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
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

    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
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
    await publishReceptionProjection(laterFixture.db, { evaluatedAt: "2026-10-08T00:00:00.000Z" });
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
    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
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
    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
    const ranking = await getReceptionRankings(db, { type: "top_rated_all_time", filters: { genres: [8], features: [], tags: [] }, evaluatedAt: EVALUATED_AT });
    expect(ranking.data.items[0]?.metric).toMatchObject({ kind: "lifetime_confidence", lifetime_approval: 60 });
    expect(ranking.data.items[0]?.metric.value).toBeCloseTo(50.2, 2);
    expect(ranking.data.items[0]?.eligibility.qualifying_reviews).toBe(100);
    const comparison = await getReceptionComparison(db, { type: "top_rated_all_time", appid: 20, filters: { genres: [8], features: [], tags: [] }, evaluatedAt: EVALUATED_AT });
    const august = comparison.data?.points.find((point) => point.cutoff === "2026-09-01T00:00:00.000Z");
    expect(august).toMatchObject({ metric_kind: "lifetime_confidence", lifetime_approval: 40, lifetime_reviews: 100 });
    expect(august?.value).toBeCloseTo(30.94, 2);
    native.close(true);
  });

  test("ranks lifetime confidence rather than raw approval with deterministic current and historical ties", async () => {
    const { db, native } = freshDb();
    for (const [appid, positive, total, nowScore] of [
      [63, 9900, 10000, 41],
      [62, 252, 252, 100],
      [61, 9900, 10000, 40],
    ]) {
      addApp(native, appid);
      addSummary(native, appid, positive, total, "2026-08-31T00:00:00.000Z");
      addBuckets(native, appid, 250);
      addScore(native, appid, nowScore);
    }

    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
    const ranking = await getReceptionRankings(db, { type: "top_rated_all_time", evaluatedAt: EVALUATED_AT });
    expect(ranking.data.items.map((item) => item.game.appid)).toEqual([61, 63, 62]);
    expect(ranking.data.items.map((item) => item.metric.lifetime_approval)).toEqual([99, 99, 100]);
    expect(ranking.data.items[0]?.metric.value).toBeCloseTo(98.785, 3);
    expect(ranking.data.items[2]?.metric.value).toBeCloseTo(98.50, 2);
    for (const item of ranking.data.items) {
      const comparison = await getReceptionComparison(db, { type: "top_rated_all_time", appid: item.game.appid, evaluatedAt: EVALUATED_AT });
      const point = comparison.data?.points.find((value) => value.cutoff === "2026-09-01T00:00:00.000Z");
      expect(point).toMatchObject({
        metric_kind: "lifetime_confidence",
        lifetime_approval: item.metric.lifetime_approval,
        lifetime_reviews: item.eligibility.qualifying_reviews,
        comparison_rank: item.rank,
        compared_count: 3,
      });
      expect(point?.value).toBe(item.metric.value);
    }

    const now = await getReceptionRankings(db, { type: "top_rated_now", evaluatedAt: EVALUATED_AT });
    expect(now.data.items.map((item) => [item.game.appid, item.metric.value])).toEqual([[62, 100], [63, 41], [61, 40]]);
    native.close(true);
  });

  test("keeps lifetime volume boundaries, facet scope, and full-release eligibility", async () => {
    const { db, native } = freshDb();
    for (const [appid, total] of [[70, 250], [71, 249], [72, 50], [73, 49], [74, 1000], [75, 1000], [76, 1000]]) {
      addApp(native, appid);
      addSummary(native, appid, total, total);
      addGenre(native, appid, appid === 76 ? 8 : 7);
    }
    addApp(native, 77);
    addGenre(native, 77, 7);
    native.query("UPDATE apps SET is_early_access = 1 WHERE appid = 74").run();
    native.query("UPDATE apps SET release_status = 'upcoming' WHERE appid = 75").run();

    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
    const global = await getReceptionRankings(db, { type: "top_rated_all_time", evaluatedAt: EVALUATED_AT });
    expect(global.data.minimum_reviews).toBe(250);
    expect(global.data.items.map((item) => item.game.appid)).toEqual([76, 70]);
    const filtered = await getReceptionRankings(db, { type: "top_rated_all_time", evaluatedAt: EVALUATED_AT, filters: { genres: [7] } });
    expect(filtered.data.minimum_reviews).toBe(50);
    expect(filtered.data.items.map((item) => item.game.appid)).toEqual([70, 71, 72]);
    const eitherGenre = await getReceptionRankings(db, { type: "top_rated_all_time", evaluatedAt: EVALUATED_AT, filters: { genres: [7, 8] } });
    expect(eitherGenre.data.items.map((item) => item.game.appid)).toEqual([76, 70, 71, 72]);

    const belowGlobal = await getGameReceptionEligibility(db, 71, EVALUATED_AT);
    expect(belowGlobal?.all_time.global.reasons).toEqual(["below_review_threshold"]);
    expect(belowGlobal?.all_time.filtered.eligible).toBe(true);
    const earlyAccess = await getGameReceptionEligibility(db, 74, EVALUATED_AT);
    expect(earlyAccess?.all_time.global.reasons).toEqual(["early_access"]);
    const upcoming = await getGameReceptionEligibility(db, 75, EVALUATED_AT);
    expect(upcoming?.all_time.global.reasons).toEqual(["not_full_release"]);
    native.close(true);
  });

  test("counts weekly evidence as whole weeks and excludes a week crossing the rolling boundary", async () => {
    const { db, native } = freshDb();
    addApp(native, 80);
    addScore(native, 80, 88);
    native.query(`
      INSERT INTO review_buckets
        (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
      VALUES (?, ?, 'weekly', '2026-08-25T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 250, 0, '2026-09-07T00:00:00.000Z', 'test')
    `).run(80, HISTOGRAM_SOURCE);
    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });

    const ranking = await getReceptionRankings(db, { type: "top_rated_now", evaluatedAt: EVALUATED_AT });
    expect(ranking.data.items.map((item) => item.game.appid)).toEqual([80]);
    expect(ranking.data.items[0]?.eligibility.qualifying_reviews).toBe(250);
    expect(ranking.data.items[0]?.metric.value).toBe(88);
    const crossingBoundary = await getGameReceptionEligibility(db, 80, "2026-11-25T00:00:00.000Z");
    expect(crossingBoundary?.now.qualifying_reviews).toBeNull();
    expect(crossingBoundary?.now.global.eligible).toBe(false);
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
    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
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

    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
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

    await publishReceptionProjection(db, { evaluatedAt: agedAt });
    const nowAfterReviewsAgeOut = await getReceptionRankings(db, { type: "top_rated_now", evaluatedAt: agedAt });
    expect(nowAfterReviewsAgeOut.data.minimum_reviews).toBe(250);
    expect(nowAfterReviewsAgeOut.data.items).toEqual([]);
    const allTimeAfterReviewsAgeOut = await getReceptionRankings(db, { type: "top_rated_all_time", evaluatedAt: agedAt });
    expect(allTimeAfterReviewsAgeOut.data.minimum_reviews).toBe(250);
    expect(allTimeAfterReviewsAgeOut.data.items.map((item) => item.game.appid)).toEqual([appid]);
    expect(allTimeAfterReviewsAgeOut.data.items[0]?.eligibility.qualifying_reviews).toBe(500);
    native.close(true);
  });
  test("keeps recalculation time out of ranking freshness and preserves monthly formula provenance", async () => {
    const { db, native } = freshDb();
    try {
      addApp(native, 90, "Formula Cutover Game");
      addBucketsForDays(native, 90, 300, 30, "2026-08-01T00:00:00.000Z");
      addScore(native, 90, (100 * 250.5) / 251, "2026-08-31T00:00:00.000Z");
      native.query("UPDATE player_score_history SET formula_version = 'steam-player-v1' WHERE appid = 90").run();
      const previous = native.query<{ id: number }, []>("SELECT id FROM player_score_history WHERE appid = 90").get()!;
      addScore(native, 90, 100, "2026-09-15T00:00:00.000Z");
      native.query(`UPDATE player_score_history
        SET current_positive_count = 250, current_total_count = 250,
            current_window_start = '2026-08-01T00:00:00.000Z',
            current_window_end = '2026-08-31T00:00:00.000Z',
            current_evidence_observed_at = '2026-08-31T00:00:00.000Z'
        WHERE appid = 90`).run();
      const recalculation = {
        previous_observation_id: previous.id,
        previous_formula_version: "steam-player-v1",
        calculated_at: "2026-09-15T00:00:00.000Z",
      };
      native.query(`UPDATE player_score_history
        SET formula_version = 'steam-player-v2',
            current_window_end = '2026-08-31T00:00:00.000Z',
            current_evidence_observed_at = '2026-08-31T00:00:00.000Z',
            provenance = ?
        WHERE appid = 90 AND observed_at = '2026-09-15T00:00:00.000Z'`).run(JSON.stringify({ recalculation }));

      const evaluatedAt = "2026-10-02T00:00:00.000Z";
      await publishReceptionProjection(db, { evaluatedAt });
      const ranking = await getReceptionRankings(db, { type: "top_rated_now", evaluatedAt });
      expect(ranking.data.items[0]?.metric.value).toBe(100);
      expect(ranking.sourceTimestamp).toBe("2026-09-07T00:00:00.000Z");
      expect(ranking.data.items[0]?.metric).toMatchObject({
        observed_at: recalculation.calculated_at,
        source_observed_at: "2026-08-31T00:00:00.000Z",
        formula_version: "steam-player-v2",
        recalculation,
      });
      const comparison = await getReceptionComparison(db, { type: "top_rated_now", appid: 90, evaluatedAt });
      expect(comparison.sourceTimestamp).toBe("2026-09-07T00:00:00.000Z");
      expect(comparison.data?.points.find((point) => point.cutoff === "2026-09-01T00:00:00.000Z")).toMatchObject({
        formula_version: "steam-player-v1",
        value: (100 * 250.5) / 251,
      });
      expect(comparison.data?.points.find((point) => point.cutoff === "2026-10-01T00:00:00.000Z")).toMatchObject({
        formula_version: "steam-player-v2",
        value: 100,
        source_observed_at: "2026-08-31T00:00:00.000Z",
        recalculation,
      });
      const chart = buildReceptionComparisonChartData(comparison.data!);
      const before = chart.points.find((point) => point.cutoff === "2026-09-01T00:00:00.000Z")!;
      const after = chart.points.find((point) => point.cutoff === "2026-10-01T00:00:00.000Z")!;
      expect(before.series_values.filter((value) => value !== null)).toEqual([(100 * 250.5) / 251]);
      expect(after.series_values.filter((value) => value !== null)).toEqual([100]);
      expect(before.series_values.some((value, index) => value !== null && after.series_values[index] !== null)).toBe(false);
      expect(before.isolated).toBe(true);
      expect(after.isolated).toBe(true);
      expect(chart.points.filter((point) => point.value === null).every((point) => point.series_values.every((value) => value === null))).toBe(true);
    } finally {
      native.close(true);
    }
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

    await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
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

  test("requires a compatible publication and reports its evaluation rather than the request clock", async () => {
    const { db, native } = freshDb();
    try {
      addApp(native, 1);
      addScore(native, 1, 88);
      addBuckets(native, 1, 250);
      await expect(getReceptionRankings(db)).rejects.toBeInstanceOf(ReceptionPublicationUnavailableError);
      await expect(getReceptionComparison(db, { appid: 1 })).rejects.toBeInstanceOf(ReceptionPublicationUnavailableError);
      await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
      const list = await getReceptionRankings(db, { evaluatedAt: "2027-01-01T00:00:00.000Z" });
      const comparison = await getReceptionComparison(db, { appid: 1 });
      expect(list.data.evaluated_at).toBe(EVALUATED_AT);
      expect(list.data.items).toHaveLength(1);
      expect(comparison.data?.evaluated_at).toBe(EVALUATED_AT);
      native.query("UPDATE reception_publication_builds SET projection_version = projection_version + 1").run();
      await expect(getReceptionRankings(db)).rejects.toBeInstanceOf(ReceptionPublicationUnavailableError);
    } finally {
      native.close(true);
    }
  });

  test("hydrates only the selected cards and twelve target months with no raw evidence reads", async () => {
    const { db, native } = freshDb();
    try {
      for (let appid = 1; appid <= 125; appid += 1) {
        addApp(native, appid);
        addGenre(native, appid, 7);
        addScore(native, appid, 100 - appid / 1000, "2026-08-15T00:00:00.000Z");
        addBuckets(native, appid, 250);
        addSummary(native, appid, 250, 250, "2026-08-15T00:00:00.000Z");
      }
      // A nonqualifying source-bearing game is still part of scope freshness.
      addApp(native, 126);
      addGenre(native, 126, 7);
      addScore(native, 126, 1, "2026-09-07T23:00:00.000Z");
      await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
      const reads: { query: string; rows: unknown[] }[] = [];
      const reader = appDatabase(native, (query, rows) => reads.push({ query, rows }));
      const list = await getReceptionRankings(reader, {
        limit: 3, offset: 100, filters: { genres: [7] },
      });
      expect(list.data.items.map((item) => [item.rank, item.game.appid])).toEqual([[101, 101], [102, 102], [103, 103]]);
      expect(list.data.total).toBe(125);
      expect(list.sourceTimestamp).toBe("2026-09-07T23:00:00.000Z");
      const global = await getReceptionRankings(reader, { limit: 3, offset: 100 });
      expect(global.data.items).toEqual([]);
      expect(global.data.total).toBe(100);
      expect(global.data.eligible_total).toBe(125);
      const comparison = await getReceptionComparison(reader, { appid: 125 });
      expect(comparison.data?.points.length).toBeGreaterThan(0);
      expect(comparison.data?.points.every((point) => point.compared_count === 125)).toBe(true);
      expect(comparison.sourceTimestamp).toBe(list.sourceTimestamp);
      const returned = reads.flatMap((read) => read.rows) as Record<string, unknown>[];
      expect(returned.filter((row) => "description" in row)).toHaveLength(3);
      expect(returned.filter((row) => "comparison_rank" in row).length).toBeLessThanOrEqual(12);
      expect(returned.length).toBeLessThanOrEqual(21);
      // These are executed real SQLite statements, not implementation source.
      expect(reads.filter(({ query }) => /\b(?:review_buckets|steam_events|player_score_history|review_summary_snapshots)\b/i.test(query))).toEqual([]);
    } finally {
      native.close(true);
    }
  });

  test.each(["list", "comparison"] as const)("keeps the %s response in one SQLite snapshot during publication swap and cleanup", async (view) => {
    const directory = mkdtempSync(join(tmpdir(), "reception-read-snapshot-"));
    const path = join(directory, "catalog.sqlite");
    const { db, native } = freshDb(path);
    native.exec("PRAGMA journal_mode = WAL");
    const writer = new Database(path);
    writer.exec("PRAGMA foreign_keys = ON");
    try {
      addApp(native, 1);
      addScore(native, 1, 88);
      addBuckets(native, 1, 250);
      await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
      const expected = view === "list"
        ? await getReceptionRankings(db)
        : await getReceptionComparison(db, { appid: 1 });
      const previous = native.query<{ published_build_id: number }, []>(
        "SELECT published_build_id FROM reception_publication_state WHERE id = 1",
      ).get()!.published_build_id;
      const nextAt = "2026-09-09T00:00:00.000Z";
      const candidate = Number(native.query(`INSERT INTO reception_publication_builds
        (status, projection_version, history_key, evaluated_at, source_revision, cursor_appid, max_appid, completed_at)
        SELECT 'published', projection_version, history_key, ?, source_revision, cursor_appid, max_appid, completed_at
        FROM reception_publication_builds WHERE id = ?`).run(nextAt, previous).lastInsertRowid);
      native.query(`INSERT INTO reception_publication_current
        (build_id, appid, type, input_revision, history_key, metric_value, qualifying_reviews,
         score_history_id, metric_json, population_json, source_timestamp, next_evaluation_at)
        SELECT ?, appid, type, input_revision, history_key, 1, 0,
          score_history_id, json_set(metric_json, '$.value', 1), population_json, source_timestamp, next_evaluation_at
        FROM reception_publication_current WHERE build_id = ?`).run(candidate, previous);
      let swapped = false;
      const reader = appDatabase(native, () => {
        if (swapped) return;
        swapped = true;
        writer.transaction(() => {
          writer.query("UPDATE reception_publication_state SET published_build_id = ? WHERE id = 1").run(candidate);
          writer.query("DELETE FROM reception_publication_builds WHERE id = ?").run(previous);
        })();
      });
      const before = view === "list"
        ? await getReceptionRankings(reader)
        : await getReceptionComparison(reader, { appid: 1 });
      expect(swapped).toBe(true);
      expect(before).toEqual(expected);
      const after = view === "list"
        ? await getReceptionRankings(db)
        : await getReceptionComparison(db, { appid: 1 });
      expect(after.data?.evaluated_at).toBe(nextAt);
      expect(after.data?.eligible_total).toBe(0);
    } finally {
      writer.close(true);
      native.close(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses current qualifying counts for Now ties but historical sample counts for All Time ties", async () => {
    const { db, native } = freshDb();
    try {
      for (const appid of [1, 2]) {
        addApp(native, appid);
        addScore(native, appid, 88, "2026-08-15T00:00:00.000Z");
        addBuckets(native, appid, appid === 1 ? 250 : 300);
        addSummary(native, appid, 0, appid === 1 ? 2048 : 128, "2026-08-15T00:00:00.000Z");
        addSummary(native, appid, 0, appid === 1 ? 256 : 512);
      }
      await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
      const now = await getReceptionComparison(db, { appid: 1 });
      const allTime = await getReceptionComparison(db, { appid: 1, type: "top_rated_all_time" });
      const september = "2026-09-01T00:00:00.000Z";
      expect(now.data?.points.find((point) => point.cutoff === september)).toMatchObject({
        provenance: "recorded", comparison_rank: 2, compared_count: 2,
      });
      expect(allTime.data?.points.find((point) => point.cutoff === september)).toMatchObject({
        comparison_rank: 1, compared_count: 2, lifetime_reviews: 2048,
      });
      expect((await getReceptionRankings(db, { type: "top_rated_all_time" })).data.items.map((item) => item.game.appid)).toEqual([2, 1]);
    } finally {
      native.close(true);
    }
  });

  test("applies cross-group facet intersections before paging and keeps losing source freshness", async () => {
    const { db, native } = freshDb();
    try {
      for (const appid of [1, 2, 3, 4]) {
        addApp(native, appid);
        addGenre(native, appid, appid === 4 ? 8 : 7);
        addSummary(native, appid, 500, 500, "2026-09-06T00:00:00.000Z");
      }
      native.exec(`INSERT INTO app_facets (facet_group, source_id, name)
        VALUES ('feature', '7', 'Feature 7'), ('community_tag', '7', 'Tag 7');
        INSERT INTO app_facet_memberships (appid, facet_group, source_id, source_order)
        VALUES (1, 'feature', '7', 0), (1, 'community_tag', '7', 0),
               (2, 'feature', '7', 0), (3, 'community_tag', '7', 0),
               (4, 'feature', '7', 0), (4, 'community_tag', '7', 0);`);
      addApp(native, 5);
      addGenre(native, 5, 7);
      addSummary(native, 5, 1, 1, "2026-09-07T23:00:00.000Z");
      native.exec(`INSERT INTO app_facet_memberships (appid, facet_group, source_id, source_order)
        VALUES (5, 'feature', '7', 0), (5, 'community_tag', '7', 0);`);
      await publishReceptionProjection(db, { evaluatedAt: EVALUATED_AT });
      const filters = { genres: [7], features: [7], tags: [7] };
      const list = await getReceptionRankings(db, { type: "top_rated_all_time", filters, limit: 1 });
      expect(list.data.items.map((item) => item.game.appid)).toEqual([1]);
      expect(list.data.eligible_total).toBe(1);
      expect(list.sourceTimestamp).toBe("2026-09-07T23:00:00.000Z");
      const comparison = await getReceptionComparison(db, { type: "top_rated_all_time", filters, appid: 1 });
      expect(comparison.data?.eligible_total).toBe(1);
      expect(comparison.sourceTimestamp).toBe(list.sourceTimestamp);
      const eitherGenre = await getReceptionRankings(db, {
        type: "top_rated_all_time", filters: { ...filters, genres: [7, 8] }, offset: 1, limit: 1,
      });
      expect(eitherGenre.data.items.map((item) => [item.rank, item.game.appid])).toEqual([[2, 4]]);
      expect(eitherGenre.data.eligible_total).toBe(2);
    } finally {
      native.close(true);
    }
  });
});
