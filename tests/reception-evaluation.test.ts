import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { evaluateReceptionProjectionBatch, evaluateLiveGameReceptionEligibility, getReceptionMonthCutoffs } from "../src/lib/reception-evaluation";
import { wilson95 } from "../src/lib/recent-reception";
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

describe("bounded reception evaluation", () => {
  test("limits batches, returns only existing requested games, and keeps history optional", async () => {
    const { db, native } = freshDb();
    try {
      for (let appid = 1; appid <= 40; appid++) { addApp(native, appid); addScore(native, appid, appid); }
      await expect(evaluateReceptionProjectionBatch(db, Array.from({ length: 33 }, (_, i) => i + 1), EVALUATED_AT)).rejects.toThrow(RangeError);
      await expect(evaluateReceptionProjectionBatch(db, [0], EVALUATED_AT)).rejects.toThrow(RangeError);
      const batch = await evaluateReceptionProjectionBatch(db, [3, 1, 3, 999], EVALUATED_AT, { includeHistory: false });
      expect(batch.map((item) => item.current.appid)).toEqual([1, 3]);
      expect(batch.map((item) => item.current.now.metric?.value)).toEqual([1, 3]);
      expect(batch.every((item) => item.months.length === 0)).toBe(true);
      expect(await evaluateReceptionProjectionBatch(db, [], EVALUATED_AT)).toEqual([]);
      expect(await evaluateLiveGameReceptionEligibility(db, 999, EVALUATED_AT)).toBeNull();
      expect(native.query("SELECT count(*) AS n FROM player_score_history").get()).toEqual({ n: 40 });
    } finally { native.close(true); }
  });

  test("preserves rolling whole-bucket counts and inclusive expiry without a new collection", async () => {
    const { db, native } = freshDb();
    try {
      addApp(native, 1); addScore(native, 1, 75); addBuckets(native, 1, 250);
      const [first] = await evaluateReceptionProjectionBatch(db, [1], EVALUATED_AT, { includeHistory: false });
      expect(first!.current.now.qualifyingReviews).toBe(250);
      // The first bucket starts exactly 90 days before evaluation and remains included at equality.
      expect(first!.current.nextEvaluationAt).toBe("2026-09-08T00:00:00.001Z");
      const aged = await evaluateLiveGameReceptionEligibility(db, 1, first!.current.nextEvaluationAt!);
      expect(aged?.now.qualifying_reviews).toBe(247);
      expect(aged?.now.global.eligible).toBe(false);
      expect(aged?.now.filtered.eligible).toBe(true);
      const empty = await evaluateLiveGameReceptionEligibility(db, 1, "2026-12-08T00:00:00.000Z");
      expect(empty?.now.qualifying_reviews).toBeNull();
      expect(empty?.now.global.reasons).toEqual(["unknown_evidence"]);
      expect(native.query("SELECT count(*) AS n FROM player_score_history").get()).toEqual({ n: 1 });
    } finally { native.close(true); }
  });

  test("preserves unknown populations, gaps, source compatibility, and missing measurements", async () => {
    const { db, native } = freshDb();
    try {
      addApp(native, 1); addApp(native, 2); addApp(native, 3);
      addScore(native, 1, 80);
      addBucketsForDays(native, 1, 300, 1, "2026-09-01T00:00:00.000Z");
      native.query("INSERT INTO review_sources (id, endpoint, request_filter, population, interpretation_version, identity_key) VALUES ('other', 'appreviews', 'filter=recent', 'unknown', 'test', 'other')").run();
      native.query("INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (1, 'other', ?, 1000, 1000)").run(EVALUATED_AT);
      addSummary(native, 1, 80, 100);
      addBucketsForDays(native, 3, 300, 1, "2026-09-01T00:00:00.000Z");
      native.query("INSERT INTO review_sources (id, endpoint, request_filter, population, interpretation_version, identity_key) VALUES ('histogram-tied', 'appreviewhistogram', 'none', 'unknown', 'test', 'histogram-tied')").run();
      native.query(`INSERT INTO review_buckets
        (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
        SELECT appid, 'histogram-tied', granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance
        FROM review_buckets WHERE appid = 3`).run();
      const batch = await evaluateReceptionProjectionBatch(db, [1, 2, 3], EVALUATED_AT);
      expect(batch[0]!.current.now.qualifyingReviews).toBe(300); // Gaps are not invented zero buckets.
      expect(batch[0]!.current.now.populationRef).toMatchObject({ population: "filtered_reviews", language: null, purchase_type: null });
      expect(batch[0]!.current.allTime.qualifyingReviews).toBe(100);
      expect(batch[0]!.current.allTime.metric?.value).toBe(wilson95(80, 100)!.lower);
      expect(batch[0]!.current.allTime.metric?.lifetime_approval).toBe(80);
      for (const absent of batch.slice(1)) {
        expect(absent.current.now.metric).toBeNull();
        expect(absent.current.now.qualifyingReviews).toBeNull();
        expect(absent.current.now.populationRef).toBeNull();
        expect(absent.current.allTime.populationRef).toBeNull();
        expect(absent.months).toEqual([]);
      }
      expect(await evaluateLiveGameReceptionEligibility(db, 2, EVALUATED_AT)).toMatchObject({
        now: { global: { eligible: false, reasons: ["missing_metric", "unknown_evidence"] } },
      });
    } finally { native.close(true); }
  });

  test("keeps the exact month grid, strict recorded cutoff, and recorded preference", async () => {
    const { db, native } = freshDb();
    try {
      addApp(native, 1); addScore(native, 1, 75, "2026-09-01T00:00:00.000Z"); addBuckets(native, 1, 250);
      addSummary(native, 1, 30, 50, "2026-08-31T00:00:00.000Z");
      addSummary(native, 1, 240, 300, "2026-09-01T00:00:00.000Z");
      const cutoffs = getReceptionMonthCutoffs(EVALUATED_AT);
      expect(cutoffs).toHaveLength(12);
      expect(cutoffs[0]).toBe("2025-10-01T00:00:00.000Z");
      expect(cutoffs[11]).toBe("2026-09-01T00:00:00.000Z");
      const [result] = await evaluateReceptionProjectionBatch(db, [1], EVALUATED_AT);
      const september = result!.months.find((point) => point.type === "top_rated_now" && point.cutoff === cutoffs[11]);
      expect(september).toMatchObject({ provenance: "reconstructed", score_history_id: null, observed_at: "2026-09-07T00:00:00.000Z", score_window_end: cutoffs[11] });
      expect(september!.value).toBeGreaterThan(99);
      const lifetime = result!.months.find((point) => point.type === "top_rated_all_time" && point.cutoff === cutoffs[11]);
      expect(lifetime).toMatchObject({ lifetime_reviews: 50, lifetime_approval: 60, observed_at: "2026-08-31T00:00:00.000Z" });
      expect(lifetime!.value).toBe(wilson95(30, 50)!.lower);
      expect(result!.months.some((point) => point.cutoff === cutoffs[0])).toBe(false);
      addScore(native, 1, 61, "2026-08-31T23:59:59.999Z");
      const [recorded] = await evaluateReceptionProjectionBatch(db, [1], EVALUATED_AT);
      expect(recorded!.months.find((point) => point.type === "top_rated_now" && point.cutoff === cutoffs[11])).toMatchObject({ provenance: "recorded", value: 61 });
      expect(recorded!.current.now.metric?.value).toBe(75);
      // A current observation is inclusive even though monthly history is strict.
      expect((await evaluateReceptionProjectionBatch(db, [1], cutoffs[11]!, { includeHistory: false }))[0]!.current.now.metric?.value).toBe(75);
    } finally { native.close(true); }
  });

  test("carries formula provenance while freshness stays at actual source evidence time", async () => {
    const { db, native } = freshDb();
    try {
      addApp(native, 1); addBucketsForDays(native, 1, 300, 30, "2026-08-01T00:00:00.000Z");
      addScore(native, 1, 80, "2026-08-31T00:00:00.000Z");
      const previous = native.query<{ id: number }, []>("SELECT id FROM player_score_history WHERE appid = 1").get()!;
      addScore(native, 1, 90, "2026-09-15T00:00:00.000Z");
      const recalculation = { previous_observation_id: previous.id, previous_formula_version: "test", calculated_at: "2026-09-15T00:00:00.000Z" };
      native.query(`UPDATE player_score_history SET formula_version = 'steam-player-v2', current_evidence_observed_at = '2026-08-31T00:00:00.000Z', provenance = ? WHERE observed_at = ?`).run(JSON.stringify({ recalculation }), recalculation.calculated_at);
      const [result] = await evaluateReceptionProjectionBatch(db, [1], "2026-10-02T00:00:00.000Z");
      expect(result!.current.now.metric).toMatchObject({ value: 90, formula_version: "steam-player-v2", recalculation, observed_at: recalculation.calculated_at, source_observed_at: "2026-08-31T00:00:00.000Z" });
      expect(result!.current.now.sourceTimestamp).toBe("2026-09-07T00:00:00.000Z");
      expect(result!.months.find((point) => point.type === "top_rated_now" && point.cutoff === "2026-10-01T00:00:00.000Z")).toMatchObject({ value: 90, provenance: "recorded", recalculation, source_observed_at: "2026-08-31T00:00:00.000Z" });
      expect(result!.months.find((point) => point.type === "top_rated_now" && point.cutoff === "2026-09-01T00:00:00.000Z")).toMatchObject({ value: 80, provenance: "recorded" });
    } finally { native.close(true); }
  });
});
