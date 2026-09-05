import { afterAll, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import { runIngestionTick, startIngestionScheduler, type IngestionCron } from "../workers/ingestion";
import { runDailyRollupJob } from "../workers/player-rollups";

function createAppDatabase(): AppDatabase {
  const native = new Database(":memory:");
  applyMigrations(native);

  const database: AppDatabase = {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const readOnly = /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(query.trim());
      const statement: AppPreparedStatement = {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return statement;
        },
        async first<T = unknown>(column?: string): Promise<T | null> {
          const row = native.prepare(query).get(...(values as SQLQueryBindings[])) as Record<string, unknown> | null;
          if (!row) return null;
          return (column ? row[column] : row) as T;
        },
        async run<T = unknown>() {
          const result = native.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: Number(result.changes), duration: 0 } };
        },
        async all<T = unknown>() {
          const results = native.prepare(query).all(...(values as SQLQueryBindings[])) as T[];
          return { success: true, results, meta: { changes: 0, duration: 0 } };
        },
        async raw<T = unknown>() {
          return native.prepare(query).values(...(values as SQLQueryBindings[])) as T[];
        },
      };
      Object.defineProperty(statement, "__readOnly", { value: readOnly });
      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]) {
      native.exec("BEGIN");
      try {
        const results: { success: boolean; results?: T[] }[] = [];
        for (const statement of statements) {
          if ((statement as AppPreparedStatement & { __readOnly?: boolean }).__readOnly) {
            results.push({ success: true, results: (await statement.all<T>()).results });
          } else {
            results.push({ success: (await statement.run()).success });
          }
        }
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string) {
      native.exec(query);
      return { count: 1, duration: 0 };
    },
  };
  return database;
}

const successfulSteamResponse = () =>
  new Response(JSON.stringify({ response: { result: 1, player_count: 1234 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function seedDueGame(db: AppDatabase, appid: number, dueAt: string): Promise<void> {
  return db
    .prepare("INSERT INTO tracked_games (appid, tier, slot, next_due_at) VALUES (?, 'fast', 0, ?)")
    .bind(appid, dueAt)
    .run()
    .then(() => undefined);
}

function setDailyCheckpoint(db: AppDatabase, date: string): Promise<void> {
  return db
    .prepare(
      "INSERT INTO checkpoints (key, value, cursor) VALUES (?, ?, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind("ingestion:last-daily-cycle", date)
    .run()
    .then(() => undefined);
}

describe("Bun ingestion scheduling and player rollups", () => {
  afterAll(() => console.log("player activity suite complete"));

  test("registers the UTC ten-minute schedule through the injected cron seam", () => {
    const calls: Array<{ expression: string; options: { tz: string } }> = [];
    const cron: IngestionCron = (expression, _handler, options) => {
      calls.push({ expression, options });
    };

    startIngestionScheduler({ db: createAppDatabase(), cron, runImmediately: false });

    expect(calls).toEqual([{ expression: "*/10 * * * *", options: { tz: "UTC" } }]);
  });
  test("bootstraps player tracking after an empty daily discovery", async () => {
    const db = createAppDatabase();
    const anchorTime = new Date("2026-09-05T03:10:00.000Z");
    await setDailyCheckpoint(db, "2026-09-04");
    await db
      .prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
      .bind(730, "Counter-Strike 2", "counter-strike-2")
      .run();

    const customFetch = (async () => successfulSteamResponse()) as unknown as typeof fetch;
    const result = await runIngestionTick({ db, anchorTime, customFetch });

    expect(result.discovery?.initialObservations).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM tracked_games").first<number>("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM observations").first<number>("count")).toBe(1);
  });

  test("skips overlapping ticks, including a blocked startup run", async () => {
    const db = createAppDatabase();
    const anchorTime = new Date("2026-09-05T03:10:00.000Z");
    await setDailyCheckpoint(db, "2026-09-04");
    await seedDueGame(db, 730, anchorTime.toISOString());

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const startedSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    const customFetch = (async () => {
      started?.();
      await blocked;
      return successfulSteamResponse();
    }) as unknown as typeof fetch;

    startIngestionScheduler({
      db,
      anchorTime,
      customFetch,
      runImmediately: true,
      cron: () => undefined,
    });
    await startedSignal;
    const second = await runIngestionTick({ db, anchorTime, customFetch });
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("run_in_progress");

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const observation = await db
      .prepare("SELECT current_players FROM observations WHERE appid = ?")
      .bind(730)
      .first<{ current_players: number }>();
    expect(observation?.current_players).toBe(1234);
  });

  test("rolls up only the prior UTC day, then retains seven days before snapshot", async () => {
    const db = createAppDatabase();
    const anchorTime = new Date("2026-09-05T00:05:00.000Z");
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)")
      .bind(1, 100, "2026-09-04T12:00:00.000Z")
      .run();
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)")
      .bind(1, 200, "2026-09-04T18:00:00.000Z")
      .run();
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)")
      .bind(1, 50, "2026-08-28T23:59:59.999Z")
      .run();
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)")
      .bind(1, 75, "2026-08-29T00:05:00.000Z")
      .run();

    const order: string[] = [];
    const result = await runDailyRollupJob(db, {
      anchorTime,
      snapshot: async (_db, date) => {
        order.push("snapshot");
        const rollup = await db
          .prepare("SELECT date FROM player_rollups WHERE appid = 1")
          .all<{ date: string }>();
        expect(rollup.results[0]?.date).toBe("2026-09-04");
        return "/tmp/vaporstats-" + date + ".sqlite";
      },
    });

    expect(result.targetDate).toBe("2026-09-04");
    expect(result.rolledUpCount).toBe(1);
    expect(order).toEqual(["snapshot"]);
    const retained = await db
      .prepare("SELECT observed_at FROM observations ORDER BY observed_at")
      .all<{ observed_at: string }>();
    expect(retained.results.map((row) => row.observed_at)).toEqual([
      "2026-08-29T00:05:00.000Z",
      "2026-09-04T12:00:00.000Z",
      "2026-09-04T18:00:00.000Z",
    ]);
  });

  test("recovers after a failed tick without losing the persisted due checkpoint", async () => {
    const base = createAppDatabase();
    const anchorTime = new Date("2026-09-05T03:20:00.000Z");
    await setDailyCheckpoint(base, "2026-09-04");
    await seedDueGame(base, 570, anchorTime.toISOString());
    let failBatch = true;
    const db: AppDatabase = {
      ...base,
      async batch(statements) {
        if (failBatch) {
          failBatch = false;
          throw new Error("temporary database failure");
        }
        return base.batch(statements);
      },
    };
    const customFetch = (async () => successfulSteamResponse()) as unknown as typeof fetch;

    expect((await runIngestionTick({ db, anchorTime, customFetch })).status).toBe("error");
    expect((await runIngestionTick({ db, anchorTime, customFetch })).status).toBe("completed");
    const observation = await db
      .prepare("SELECT current_players FROM observations WHERE appid = ?")
      .bind(570)
      .first<{ current_players: number }>();
    expect(observation?.current_players).toBe(1234);
  });
});
