import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import { PLAYER_SCORE_FORMULA_VERSION } from "../src/lib/player-score";
import { ensureReceptionPublicationReady } from "../src/lib/reception-publication";
import {
  runIngestionTick,
  startIngestionScheduler,
  type IngestionCron,
  type IngestionTickResult,
} from "../workers/ingestion";

function fixture() {
  const native = new Database(":memory:");
  applyMigrations(native);
  const db: AppDatabase = {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next: unknown[]) { values = next; return statement; },
        async first<T = unknown>(column?: string) {
          const row = native.query(query).get(...values as SQLQueryBindings[]) as Record<string, unknown> | null;
          return row ? (column ? row[column] : row) as T : null;
        },
        async all<T = unknown>() {
          return { success: true, results: native.query(query).all(...values as SQLQueryBindings[]) as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T = unknown>() {
          return native.query(query).values(...values as SQLQueryBindings[]) as T[];
        },
        async run() {
          const result = native.query(query).run(...values as SQLQueryBindings[]);
          return { success: true, meta: { changes: Number(result.changes), duration: 0 } };
        },
      };
      Object.defineProperty(statement, "readOnly", { value: /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(query.trim()) });
      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]) {
      native.exec("BEGIN");
      try {
        const results: { success: boolean; results?: T[] }[] = [];
        for (const statement of statements) {
          if ((statement as AppPreparedStatement & { readOnly?: boolean }).readOnly) {
            results.push(await statement.all<T>());
          } else {
            results.push(await statement.run());
          }
        }
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query) { native.exec(query); return { count: 1, duration: 0 }; },
  };
  // This title still has reception evidence, but is not selected for fresh review/critic collection.
  native.query("INSERT INTO apps (appid, name, slug, release_status, is_eligible, is_playable) VALUES (730, 'Aging game', 'aging-game', 'released', 0, 0)").run();
  native.query("INSERT INTO tracked_games (appid, tier, slot, next_due_at) VALUES (730, 'fast', 0, '2026-09-08T00:00:00.000Z')").run();
  native.query("INSERT INTO checkpoints (key, value) VALUES ('ingestion:last-daily-cycle', '2026-09-07')").run();
  native.query(`INSERT INTO review_sources
    (id, endpoint, request_filter, population, interpretation_version, identity_key)
    VALUES ('lifecycle-histogram', 'appreviewhistogram', 'none', 'filtered_reviews', 'test', 'lifecycle-histogram')`).run();
  native.query(`INSERT INTO review_buckets
    (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
    VALUES (730, 'lifecycle-histogram', 'daily', '2026-06-10T00:00:00.000Z', '2026-06-11T00:00:00.000Z', 250, 0, '2026-09-07T00:00:00.000Z', 'test')`).run();
  native.query(`INSERT INTO player_score_history
    (appid, observed_at, score, formula_version, current_positive_count, current_total_count,
     historical_positive_count, historical_total_count, current_window_start, current_window_end,
     historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
     current_source_id, current_evidence_observed_at, provenance)
    VALUES (730, '2026-09-07T00:00:00.000Z', 95, ?, 250, 250, 0, 0,
      '2026-06-10T00:00:00.000Z', '2026-09-07T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z', '2026-06-10T00:00:00.000Z', '[]', '[]',
      'lifecycle-histogram', '2026-09-07T00:00:00.000Z', '{}')`).run(PLAYER_SCORE_FORMULA_VERSION);
  return { db, native };
}

function evidence(native: Database): string {
  return JSON.stringify([
    native.query("SELECT * FROM review_sources ORDER BY id").all(),
    native.query("SELECT * FROM review_buckets ORDER BY appid, source_id, period_start").all(),
    native.query("SELECT * FROM review_summary_snapshots ORDER BY appid, source_id, observed_at").all(),
    native.query("SELECT * FROM player_score_history ORDER BY id").all(),
    native.query("SELECT * FROM observations ORDER BY appid, observed_at").all(),
  ]);
}

function publication(native: Database) {
  return native.query(`SELECT b.id, b.evaluated_at, c.qualifying_reviews, c.source_timestamp
    FROM reception_publication_state s
    JOIN reception_publication_builds b ON b.id = s.published_build_id
    JOIN reception_publication_current c ON c.build_id = b.id
    WHERE c.appid = 730 AND c.type = 'top_rated_now'`).get() as {
      id: number; evaluated_at: string; qualifying_reviews: number | null; source_timestamp: string | null;
    };
}

const unavailableFetch = Object.assign(async () => new Response(null, { status: 503 }), { preconnect: fetch.preconnect });

describe("reception publication ingestion lifecycle", () => {
  test("scheduled clock-only aging publishes without successful source responses or new observations", async () => {
    const { db, native } = fixture();
    try {
      await ensureReceptionPublicationReady(db, { evaluatedAt: "2026-09-08T00:00:00.000Z" });
      const before = publication(native);
      expect(before.qualifying_reviews).toBe(250);
      const originalEvidence = evidence(native);
      let scheduled: (() => unknown) | undefined;
      const cron: IngestionCron = (_expression, handler) => { scheduled = handler; };
      startIngestionScheduler({ db, cron, anchorTime: new Date("2026-09-08T00:15:00.000Z"), customFetch: unavailableFetch });
      expect(scheduled).toBeDefined();
      const result = await scheduled!() as IngestionTickResult;
      expect(result.status).toBe("completed");
      expect(result.tick?.succeeded).toBe(0);
      expect(result.receptionPublication?.status).toBe("published");
      const after = publication(native);
      expect(after.id).not.toBe(before.id);
      expect(after.evaluated_at).toBe("2026-09-08T00:15:00.000Z");
      expect(after.qualifying_reviews).toBeNull();
      expect(after.source_timestamp).toBe(before.source_timestamp);
      expect(evidence(native)).toBe(originalEvidence);
    } finally { native.close(true); }
  });

  test("an overlapping tick cannot publish while the active source cycle is unfinished", async () => {
    const { db, native } = fixture();
    const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: signal } = Promise.withResolvers<void>();
    let active: Promise<IngestionTickResult> | undefined;
    try {
      await ensureReceptionPublicationReady(db, { evaluatedAt: "2026-09-08T00:00:00.000Z" });
      const before = publication(native);
      const originalEvidence = evidence(native);
      active = runIngestionTick({
        db,
        anchorTime: new Date("2026-09-08T00:15:00.000Z"),
        customFetch: Object.assign(async () => { signal(); await blocked; return new Response(null, { status: 503 }); }, { preconnect: fetch.preconnect }),
      });
      await started;
      const overlapping = await runIngestionTick({ db, anchorTime: new Date("2026-09-08T00:30:00.000Z"), customFetch: unavailableFetch });
      expect(overlapping).toMatchObject({ status: "skipped", reason: "run_in_progress" });
      expect(publication(native)).toEqual(before);
      release();
      const completed = await active;
      expect(completed.status).toBe("completed");
      expect(completed.receptionPublication?.status).toBe("published");
      expect(publication(native).evaluated_at).toBe("2026-09-08T00:15:00.000Z");
      expect(publication(native).qualifying_reviews).toBeNull();
      expect(evidence(native)).toBe(originalEvidence);
    } finally {
      release();
      await active;
      native.close(true);
    }
  });
});
