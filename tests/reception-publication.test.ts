import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import {
  ensureReceptionPublicationReady,
  getPublishedReceptionBuild,
  publishReceptionProjection,
  runReceptionPublicationBatch,
} from "../src/lib/reception-publication";

const AT = "2026-09-08T00:00:00.000Z";
const LATER = "2026-09-08T00:15:00.000Z";

// Real SQLite statements and transactions, including rollback on a failed chunk.
function fixture() {
  const native = new Database(":memory:");
  applyMigrations(native);
  native.exec("PRAGMA foreign_keys = ON");
  const db: AppDatabase = {
    prepare(sql) {
      let values: SQLQueryBindings[] = [];
      const statement: AppPreparedStatement = {
        bind(...next) { values = next as SQLQueryBindings[]; return statement; },
        async first<T>(column?: string) {
          const row = native.query(sql).get(...values) as Record<string, unknown> | null;
          return (row ? column ? row[column] : row : null) as T | null;
        },
        async all<T>() { return { success: true, results: native.query(sql).all(...values) as T[], meta: { changes: 0, duration: 0 } }; },
        async raw<T>() { return native.query(sql).values(...values) as T[]; },
        async run() {
          const result = native.query(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes), duration: 0 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      native.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        native.exec("COMMIT");
        return results;
      } catch (error) { native.exec("ROLLBACK"); throw error; }
    },
    async exec(sql) { native.exec(sql); return { count: 0, duration: 0 }; },
  };
  native.query(`INSERT INTO review_sources
    (id, endpoint, request_filter, language, purchase_type, filter_offtopic_activity, population, interpretation_version, identity_key)
    VALUES ('summary', 'appreviews', 'filter=all', 'all', 'all', 1, 'summary', 'test', 'summary'),
      ('histogram', 'appreviewhistogram', 'none', NULL, NULL, NULL, 'filtered_reviews', 'test', 'histogram')`).run();
  function app(appid: number, evidence = true, total = 300) {
    native.query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, `Game ${appid}`, `game-${appid}`);
    if (evidence) native.query(`INSERT INTO review_summary_snapshots
      (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count)
      VALUES (?, 'summary', '2026-08-01T00:00:00.000Z', ?, ?)`)
      .run(appid, Math.floor(total * 0.8), total);
  }
  function rows() {
    return native.query(`SELECT c.* FROM reception_publication_current c JOIN reception_publication_state s
      ON s.published_build_id = c.build_id ORDER BY c.appid, c.type`).all() as Record<string, unknown>[];
  }
  function sources() {
    return JSON.stringify([
      native.query("SELECT * FROM review_summary_snapshots ORDER BY appid, observed_at").all(),
      native.query("SELECT * FROM review_buckets ORDER BY appid, period_start").all(),
      native.query("SELECT * FROM player_score_history ORDER BY id").all(),
      native.query("SELECT * FROM steam_events ORDER BY appid, event_id").all(),
    ]);
  }
  return { native, db, app, rows, sources };
}

describe("durable reception publication", () => {
  test("publishes an empty initial source-only generation, and metadata reads never build", async () => {
    const f = fixture();
    try {
      f.app(99, false);
      expect(await getPublishedReceptionBuild(f.db)).toBeNull();
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_builds").get()).toEqual({ n: 0 });
      const result = await ensureReceptionPublicationReady(f.db, { evaluatedAt: AT });
      expect(result).toMatchObject({ status: "published", maxAppid: 0, cursorAppid: 0, inspected: 0, evaluated: 0 });
      expect(f.rows()).toEqual([]);
      expect((await getPublishedReceptionBuild(f.db))?.evaluated_at).toBe(AT);
    } finally { f.native.close(); }
  });

  test("bounds chunks to 32 source-bearing apps and resumes a durable cursor", async () => {
    const f = fixture();
    try {
      for (let id = 1; id <= 70; id++) f.app(id);
      f.app(100000, false);
      const first = await runReceptionPublicationBatch(f.db, { evaluatedAt: AT });
      expect(first).toMatchObject({ status: "building", cursorAppid: 32, maxAppid: 70, inspected: 32, evaluated: 32 });
      expect(await getPublishedReceptionBuild(f.db)).toBeNull();
      // No in-memory continuation token is needed, and the frozen clock survives restart.
      const second = await runReceptionPublicationBatch(f.db, { evaluatedAt: LATER });
      expect(second).toMatchObject({ buildId: first.buildId, cursorAppid: 64, evaluatedAt: AT, inspected: 32 });
      const third = await runReceptionPublicationBatch(f.db, { evaluatedAt: LATER });
      expect(third).toMatchObject({ status: "published", buildId: first.buildId, cursorAppid: 70, inspected: 6 });
      expect(f.rows()).toHaveLength(140);
      await expect(runReceptionPublicationBatch(f.db, { batchSize: 33 })).rejects.toThrow(RangeError);
      await expect(runReceptionPublicationBatch(f.db, { batchSize: 0 })).rejects.toThrow(RangeError);
    } finally { f.native.close(); }
  });

  test("keeps the last complete generation visible until every replacement app is committed", async () => {
    const f = fixture();
    try {
      f.app(1); f.app(2); f.app(3);
      const original = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      const visible = f.rows();
      f.native.query("UPDATE review_summary_snapshots SET lifetime_positive_count = 299 WHERE appid = 1").run();
      const partial = await runReceptionPublicationBatch(f.db, { evaluatedAt: AT, batchSize: 1 });
      expect(partial.status).toBe("building");
      expect(partial.publishedBuildId).toBe(original.buildId);
      expect(f.rows()).toEqual(visible);
      const completed = await publishReceptionProjection(f.db, { evaluatedAt: AT, batchSize: 1 });
      expect(completed.status).toBe("published");
      expect(completed.buildId).not.toBe(original.buildId);
      expect(f.rows().find((r) => r.appid === 1 && r.type === "top_rated_all_time")!.metric_value)
        .not.toEqual(visible.find((r) => r.appid === 1 && r.type === "top_rated_all_time")!.metric_value);
    } finally { f.native.close(); }
  });

  test("unchanged publication is idempotent and retains low-volume source timestamps", async () => {
    const f = fixture();
    try {
      f.app(1, true, 1);
      const before = f.sources();
      const first = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      const rows = f.rows();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.type === "top_rated_all_time")).toMatchObject({ qualifying_reviews: 1, source_timestamp: "2026-08-01T00:00:00.000Z" });
      const second = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      expect(second).toMatchObject({ status: "unchanged", buildId: first.buildId, inspected: 0, evaluated: 0, reused: 0 });
      expect(f.rows()).toEqual(rows);
      expect(f.sources()).toBe(before);
    } finally { f.native.close(); }
  });

  test("reuses unexpired current values, and reuses immutable history through clock refresh and cleanup", async () => {
    const f = fixture();
    try {
      f.app(1); f.app(2);
      await publishReceptionProjection(f.db, { evaluatedAt: AT });
      const oldKey = f.rows().find((r) => r.appid === 1)!.history_key;
      const oldMonths = f.native.query("SELECT * FROM reception_publication_months WHERE appid = 1 ORDER BY cutoff, type").all();
      expect(oldMonths.length).toBeGreaterThan(0);
      f.native.query("UPDATE review_summary_snapshots SET lifetime_positive_count = 299 WHERE appid = 2").run();
      const incremental = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      expect(incremental).toMatchObject({ evaluated: 1, reused: 1 });
      expect(f.rows().find((r) => r.appid === 1)!.history_key).toBe(oldKey);
      const aged = await publishReceptionProjection(f.db, { evaluatedAt: LATER });
      expect(aged).toMatchObject({ status: "published", evaluated: 2, reused: 0 });
      expect(f.rows().find((r) => r.appid === 1)!.history_key).toBe(oldKey);
      expect(f.native.query("SELECT * FROM reception_publication_months WHERE appid = 1 ORDER BY cutoff, type").all()).toEqual(oldMonths);
      expect(f.native.query(`SELECT count(*) AS n FROM reception_publication_months m WHERE NOT EXISTS
        (SELECT 1 FROM reception_publication_current c WHERE c.history_key = m.history_key AND c.appid = m.appid AND c.type = m.type)`).get()).toEqual({ n: 0 });
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_builds").get()).toEqual({ n: 1 });
    } finally { f.native.close(); }
  });

  test("source corrections invalidate history without overwriting the visible history key", async () => {
    const f = fixture();
    try {
      f.app(1); f.app(2);
      await publishReceptionProjection(f.db, { evaluatedAt: AT });
      const old = f.native.query("SELECT * FROM reception_publication_months ORDER BY appid, cutoff, type").all() as { value: number; history_key: string }[];
      f.native.query("UPDATE review_summary_snapshots SET lifetime_positive_count = 299 WHERE appid = 1").run();
      await runReceptionPublicationBatch(f.db, { evaluatedAt: AT, batchSize: 1 });
      const stillOld = f.native.query(`SELECT m.* FROM reception_publication_months m WHERE EXISTS
        (SELECT 1 FROM reception_publication_current c JOIN reception_publication_state s ON s.published_build_id = c.build_id
         WHERE c.history_key = m.history_key AND c.appid = m.appid AND c.type = m.type) ORDER BY appid, cutoff, type`).all();
      expect(stillOld).toEqual(old);
      await publishReceptionProjection(f.db, { evaluatedAt: AT, batchSize: 1 });
      expect(f.native.query("SELECT value FROM reception_publication_months WHERE appid = 1").get()).not.toEqual({ value: old[0]!.value });
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_months WHERE history_key = ?").get(old[0]!.history_key)).toEqual({ n: 0 });
    } finally { f.native.close(); }
  });

  test("deleting all source evidence and deleting apps remove stale current and month rows", async () => {
    const f = fixture();
    try {
      f.app(1); f.app(2);
      await publishReceptionProjection(f.db, { evaluatedAt: AT });
      f.native.query("DELETE FROM review_summary_snapshots WHERE appid = 1").run();
      f.native.query("DELETE FROM apps WHERE appid = 2").run();
      const empty = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      expect(empty).toMatchObject({ status: "published", maxAppid: 0, inspected: 0 });
      expect(f.rows()).toEqual([]);
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_months").get()).toEqual({ n: 0 });
    } finally { f.native.close(); }
  });

  test("source mutation during staging restarts at a fresh clock and does not lose earlier app changes", async () => {
    const f = fixture();
    try {
      f.app(1); f.app(2); f.app(3);
      const first = await runReceptionPublicationBatch(f.db, { evaluatedAt: AT, batchSize: 1 });
      f.native.query("UPDATE review_summary_snapshots SET lifetime_positive_count = 299 WHERE appid = 1").run();
      const restart = await runReceptionPublicationBatch(f.db, { evaluatedAt: LATER, batchSize: 1 });
      expect(restart).toMatchObject({ status: "building", restarted: true, cursorAppid: 1, evaluatedAt: LATER });
      expect(restart.buildId).not.toBe(first.buildId);
      await publishReceptionProjection(f.db, { evaluatedAt: LATER });
      const metric = JSON.parse(f.rows().find((r) => r.appid === 1 && r.type === "top_rated_all_time")!.metric_json as string);
      expect(metric.lifetime_approval).toBeCloseTo(100 * 299 / 300);
      expect(f.native.query("SELECT DISTINCT evaluated_at FROM reception_publication_builds").all()).toEqual([{ evaluated_at: LATER }]);
    } finally { f.native.close(); }
  });

  test("a mutation between evaluation and chunk commit cannot publish mixed evidence", async () => {
    const f = fixture();
    try {
      f.app(1);
      const originalBatch = f.db.batch.bind(f.db);
      let mutate = true;
      f.db.batch = async (statements) => {
        if (mutate) {
          mutate = false;
          f.native.query("UPDATE review_summary_snapshots SET lifetime_positive_count = 299 WHERE appid = 1").run();
        }
        return originalBatch(statements);
      };
      const rejected = await runReceptionPublicationBatch(f.db, { evaluatedAt: AT });
      expect(rejected).toMatchObject({ status: "building", restarted: true, publishedBuildId: null, cursorAppid: 0 });
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_current").get()).toEqual({ n: 0 });
      await publishReceptionProjection(f.db, { evaluatedAt: LATER });
      expect(JSON.parse(f.rows().find((r) => r.type === "top_rated_all_time")!.metric_json as string).lifetime_approval).toBeCloseTo(100 * 299 / 300);
    } finally { f.native.close(); }
  });

  test("failed chunk transactions leave neither months nor current rows nor advanced cursor", async () => {
    const f = fixture();
    try {
      f.app(1);
      f.native.exec(`CREATE TRIGGER reject_publication BEFORE UPDATE OF cursor_appid ON reception_publication_builds
        BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
      await expect(runReceptionPublicationBatch(f.db, { evaluatedAt: AT })).rejects.toThrow("interrupted");
      expect(f.native.query("SELECT cursor_appid FROM reception_publication_builds").get()).toEqual({ cursor_appid: 0 });
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_current").get()).toEqual({ n: 0 });
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_months").get()).toEqual({ n: 0 });
      f.native.exec("DROP TRIGGER reject_publication");
      expect((await publishReceptionProjection(f.db, { evaluatedAt: AT })).status).toBe("published");
    } finally { f.native.close(); }
  });

  test("clock-only whole-window expiry updates qualification without writing evidence or scores", async () => {
    const f = fixture();
    try {
      f.app(1);
      f.native.query(`INSERT INTO review_buckets
        (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
        VALUES (1, 'histogram', 'daily', '2026-06-10T00:00:00.000Z', '2026-06-11T00:00:00.000Z', 250, 0, '2026-09-07T00:00:00.000Z', 'test')`).run();
      f.native.query(`INSERT INTO player_score_history
        (appid, observed_at, score, formula_version, current_positive_count, current_total_count,
         historical_positive_count, historical_total_count, current_window_start, current_window_end,
         historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
         current_source_id, current_evidence_observed_at, provenance)
        VALUES (1, '2026-09-07T00:00:00.000Z', 75, 'test', 250, 250, 0, 0,
         '2026-06-10T00:00:00.000Z', '2026-09-07T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z', '2026-06-10T00:00:00.000Z', '[]', '[]', 'histogram', '2026-09-07T00:00:00.000Z', '{}')`).run();
      const before = f.sources();
      await publishReceptionProjection(f.db, { evaluatedAt: AT });
      expect(f.rows().find((r) => r.type === "top_rated_now")!.qualifying_reviews).toBe(250);
      await publishReceptionProjection(f.db, { evaluatedAt: "2026-09-08T00:00:00.001Z" });
      expect(f.rows().find((r) => r.type === "top_rated_now")!.qualifying_reviews).toBeNull();
      expect(f.rows().find((r) => r.type === "top_rated_now")!.metric_value).toBe(75);
      expect(f.sources()).toBe(before);
    } finally { f.native.close(); }
  });

  test("the final pointer swap rechecks revisions atomically", async () => {
    const f = fixture();
    try {
      f.app(1);
      await publishReceptionProjection(f.db, { evaluatedAt: AT });
      const original = await getPublishedReceptionBuild(f.db);
      f.native.query("UPDATE review_summary_snapshots SET lifetime_positive_count = 290 WHERE appid = 1").run();
      const originalBatch = f.db.batch.bind(f.db);
      let chunks = 0;
      f.db.batch = async (statements) => {
        if (++chunks === 2) f.native.query("UPDATE review_summary_snapshots SET lifetime_positive_count = 299 WHERE appid = 1").run();
        return originalBatch(statements);
      };
      const raced = await runReceptionPublicationBatch(f.db, { evaluatedAt: AT });
      expect(raced).toMatchObject({ status: "building", restarted: true, publishedBuildId: original!.id });
      expect((await getPublishedReceptionBuild(f.db))!.id).toBe(original!.id);
      await publishReceptionProjection(f.db, { evaluatedAt: LATER });
      expect(JSON.parse(f.rows().find((r) => r.type === "top_rated_all_time")!.metric_json as string).lifetime_approval).toBeCloseTo(100 * 299 / 300);
    } finally { f.native.close(); }
  });

  test("future-observed older-period evidence invalidates history when it becomes visible", async () => {
    const f = fixture();
    try {
      f.app(1);
      f.native.query(`INSERT INTO review_buckets
        (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
        VALUES (1, 'histogram', 'daily', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
          300, 0, '2026-09-08T00:01:00.000Z', 'test')`).run();
      await publishReceptionProjection(f.db, { evaluatedAt: AT });
      const oldKey = f.rows()[0]!.history_key;
      expect(f.native.query("SELECT count(*) AS n FROM reception_publication_months WHERE type = 'top_rated_now'").get()).toEqual({ n: 0 });
      const visible = await publishReceptionProjection(f.db, { evaluatedAt: "2026-09-08T00:01:00.000Z" });
      expect(visible).toMatchObject({ status: "published", evaluated: 1, reused: 0 });
      expect(f.rows()[0]!.history_key).not.toBe(oldKey);
      expect(f.rows().find((r) => r.type === "top_rated_now")!.qualifying_reviews).toBe(300);
      const months = f.native.query("SELECT count(*) AS n FROM reception_publication_months WHERE type = 'top_rated_now'").get() as { n: number };
      expect(months.n).toBeGreaterThan(0);
    } finally { f.native.close(); }
  });

  test("clock-only event visibility refreshes reconstructed history while recorded scores still win", async () => {
    const f = fixture();
    try {
      const visibleAt = "2026-09-08T00:01:00.000Z";
      const cutoff = "2026-09-01T00:00:00.000Z";
      for (const appid of [1, 2]) {
        f.app(appid);
        f.native.query(`INSERT INTO review_buckets
          (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
          VALUES (?, 'histogram', 'daily', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
            0, 100, '2026-09-07T00:00:00.000Z', 'test'),
            (?, 'histogram', 'daily', '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
            10, 0, '2026-09-07T00:00:00.000Z', 'test')`).run(appid, appid);
        f.native.query(`INSERT INTO steam_events
          (event_id, appid, category, start_at, observed_at, source, provenance)
          VALUES (?, ?, 'major_update', '2026-08-15T00:00:00.000Z', ?, 'steam_news_hub', '{"rawCategory":14}')`)
          .run(`major-${appid}`, appid, visibleAt);
      }
      f.app(3);
      f.native.query(`INSERT INTO player_score_history
        (appid, observed_at, score, formula_version, current_positive_count, current_total_count,
         historical_positive_count, historical_total_count, current_window_start, current_window_end,
         historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
         current_source_id, current_evidence_observed_at, provenance)
        VALUES (2, '2026-08-31T00:00:00.000Z', 77, 'test', 10, 10, 0, 100,
         '2026-08-15T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
         '2026-05-17T00:00:00.000Z', '2026-08-15T00:00:00.000Z', '[]', '[]',
         'histogram', '2026-08-31T00:00:00.000Z', '{}')`).run();
      const month = (appid: number) => f.native.query(`SELECT m.* FROM reception_publication_months m
        JOIN reception_publication_current c
          ON c.history_key = m.history_key AND c.appid = m.appid AND c.type = m.type
        JOIN reception_publication_state s ON s.published_build_id = c.build_id
        WHERE m.appid = ? AND m.type = 'top_rated_now' AND m.cutoff = ?`)
        .get(appid, cutoff) as Record<string, unknown>;
      const beforeSources = f.sources();
      const beforeRevision = f.native.query("SELECT source_revision FROM reception_publication_state").get();
      const first = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      const missingRecorded = month(1);
      const recorded = month(2);
      expect(missingRecorded).toMatchObject({
        provenance: "reconstructed", score_history_id: null,
        observed_at: "2026-09-07T00:00:00.000Z", source_observed_at: "2026-09-07T00:00:00.000Z",
      });
      expect(missingRecorded.value as number).toBeCloseTo(100 / 11, 12);
      expect(recorded).toMatchObject({ value: 77, provenance: "recorded", observed_at: "2026-08-31T00:00:00.000Z" });
      expect(recorded.score_history_id).not.toBeNull();
      expect(await publishReceptionProjection(f.db, { evaluatedAt: "2026-09-08T00:00:30.000Z" }))
        .toMatchObject({ status: "unchanged", buildId: first.buildId, evaluated: 0 });
      const refreshed = await publishReceptionProjection(f.db, { evaluatedAt: visibleAt });
      expect(refreshed).toMatchObject({ status: "published", evaluated: 2, reused: 1, evaluatedAt: visibleAt });
      expect(refreshed.buildId).not.toBe(first.buildId);
      const reconstructed = month(1);
      expect(reconstructed.history_key).not.toBe(missingRecorded.history_key);
      expect(reconstructed.value as number).toBeCloseTo(100 / 3, 12);
      expect(reconstructed).toMatchObject({
        provenance: "reconstructed", score_history_id: null,
        observed_at: missingRecorded.observed_at, source_observed_at: missingRecorded.source_observed_at,
        formula_version: missingRecorded.formula_version, score_window_end: missingRecorded.score_window_end,
      });
      expect(month(2)).toMatchObject({
        value: recorded.value, provenance: "recorded", score_history_id: recorded.score_history_id,
        observed_at: recorded.observed_at, source_observed_at: recorded.source_observed_at,
      });
      expect(await publishReceptionProjection(f.db, { evaluatedAt: "2026-09-08T00:02:00.000Z" }))
        .toMatchObject({ status: "unchanged", buildId: refreshed.buildId, evaluated: 0 });
      expect(f.sources()).toBe(beforeSources);
      expect(f.native.query("SELECT source_revision FROM reception_publication_state").get()).toEqual(beforeRevision);
    } finally { f.native.close(); }
  });

  test("initial readiness refreshes an interrupted generation's expired evaluation clock", async () => {
    const f = fixture();
    try {
      f.app(1); f.app(2);
      await runReceptionPublicationBatch(f.db, { evaluatedAt: AT, batchSize: 1 });
      const ready = await ensureReceptionPublicationReady(f.db, { evaluatedAt: LATER, batchSize: 1 });
      expect(ready.evaluatedAt).toBe(LATER);
      expect((await getPublishedReceptionBuild(f.db))!.evaluated_at).toBe(LATER);
      expect(f.rows()).toHaveLength(4);
    } finally { f.native.close(); }
  });

  test("the full driver yields between bounded chunks", async () => {
    const f = fixture();
    try {
      f.app(1); f.app(2); f.app(3);
      let timerRan = false;
      // Exercise the real event loop: fake timers would not prove that SQLite work releases it.
      setTimeout(() => { timerRan = true; }, 0);
      const result = await publishReceptionProjection(f.db, { evaluatedAt: AT, batchSize: 1 });
      expect(result).toMatchObject({ status: "published", inspected: 3, evaluated: 3 });
      expect(timerRan).toBe(true);
    } finally { f.native.close(); }
  });

  test("catalog, facet and projection identity changes invalidate derived values", async () => {
    const f = fixture();
    try {
      f.app(1);
      const first = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      f.native.query("UPDATE apps SET is_early_access = 1 WHERE appid = 1").run();
      const catalog = await publishReceptionProjection(f.db, { evaluatedAt: AT });
      expect(catalog).toMatchObject({ status: "published", evaluated: 1 });
      expect(catalog.buildId).not.toBe(first.buildId);
      f.native.query("INSERT INTO app_facets (facet_group, source_id, name) VALUES ('genre', 'rpg', 'RPG')").run();
      f.native.query("INSERT INTO app_facet_memberships (appid, facet_group, source_id, source_order) VALUES (1, 'genre', 'rpg', 0)").run();
      expect((await publishReceptionProjection(f.db, { evaluatedAt: AT })).evaluated).toBe(1);
      f.native.query("UPDATE app_facets SET name = 'Role-playing' WHERE source_id = 'rpg'").run();
      expect((await publishReceptionProjection(f.db, { evaluatedAt: AT })).evaluated).toBe(1);
      // Projection identity changes force a new derivation even without source changes.
      f.native.query("UPDATE reception_publication_builds SET history_key = 'previous-formula' WHERE status = 'published'").run();
      expect((await publishReceptionProjection(f.db, { evaluatedAt: AT })).evaluated).toBe(1);
      f.native.query("UPDATE reception_publication_builds SET projection_version = 999 WHERE status = 'published'").run();
      expect((await ensureReceptionPublicationReady(f.db, { evaluatedAt: AT })).status).toBe("published");
    } finally { f.native.close(); }
  });
});
