import { afterAll, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import { runIngestionTick, startIngestionScheduler, type IngestionCron } from "../workers/ingestion";
import { runDailyRollupJob } from "../workers/player-rollups";
import { runPlayerCollectionTick } from "../workers/player-collector";
import {
  calculateDeterministicSlot,
  calculateNextDueAt,
  CADENCE_MINUTES,
  reRankTrackedTiers,
  TIER_FAST_MAX,
  TIER_HOURLY_MAX,
  TIER_DAILY_MAX,
  DAILY_REQUEST_CAP,
  TICK_REQUEST_CAP,
} from "../src/lib/player";
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

  test("registers the UTC fifteen-minute schedule through the injected cron seam", () => {
    const calls: Array<{ expression: string; options: { tz: string } }> = [];
    const cron: IngestionCron = (expression, _handler, options) => {
      calls.push({ expression, options });
    };

    startIngestionScheduler({ db: createAppDatabase(), cron, runImmediately: false });

    expect(calls).toEqual([{ expression: "*/15 * * * *", options: { tz: "UTC" } }]);
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

  test("initializes tag names after the daily cycle and avoids same-day refetches", async () => {
    const db = createAppDatabase();
    await setDailyCheckpoint(db, "2026-09-04");
    let dictionaryRequests = 0;
    const customFetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("GetTagList")) {
        dictionaryRequests++;
        return Response.json({ response: { tags: [{ tagid: 19, name: "Action" }] } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await runIngestionTick({ db, anchorTime: new Date("2026-09-05T03:10:00.000Z"), customFetch });
    expect(await db.prepare("SELECT name FROM app_facets WHERE facet_group = ? AND source_id = ?")
      .bind("community_tag", "19").first<string>("name")).toBe("Action");

    await runIngestionTick({ db, anchorTime: new Date("2026-09-05T03:25:00.000Z"), customFetch });
    expect(dictionaryRequests).toBe(1);
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
  test("rejects an explicit zero after a positive player observation", async () => {
    const db = createAppDatabase();
    const appid = 730;
    const anchorTime = new Date("2026-09-05T03:10:00.000Z");
    const priorObservedAt = "2026-09-05T03:00:00.000Z";
    await seedDueGame(db, appid, anchorTime.toISOString());
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)")
      .bind(appid, 42, priorObservedAt)
      .run();
    await db
      .prepare("UPDATE tracked_games SET latest_players = ?, last_successful_at = ? WHERE appid = ?")
      .bind(42, priorObservedAt, appid)
      .run();

    const customFetch = (async () => Response.json({ response: { result: 1, player_count: 0 } })) as unknown as typeof fetch;
    const result = await runPlayerCollectionTick(db, { anchorTime, customFetch });

    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM observations WHERE appid = ?").bind(appid).first<number>("count")).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT latest_players, consecutive_failures, last_attempted_at, last_successful_at, next_due_at FROM tracked_games WHERE appid = ?"
        )
        .bind(appid)
        .first<{
          latest_players: number | null;
          consecutive_failures: number;
          last_attempted_at: string | null;
          last_successful_at: string | null;
          next_due_at: string;
        }>(),
    ).toEqual({
      latest_players: 42,
      consecutive_failures: 1,
      last_attempted_at: anchorTime.toISOString(),
      last_successful_at: priorObservedAt,
      next_due_at: calculateNextDueAt(anchorTime, "fast", appid).toISOString(),
    });
  });

  test("accepts an initial explicit zero player observation", async () => {
    const db = createAppDatabase();
    const appid = 731;
    const anchorTime = new Date("2026-09-05T03:10:00.000Z");
    await seedDueGame(db, appid, anchorTime.toISOString());

    const customFetch = (async () => Response.json({ response: { result: 1, player_count: 0 } })) as unknown as typeof fetch;
    const result = await runPlayerCollectionTick(db, { anchorTime, customFetch });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(
      await db.prepare("SELECT current_players, observed_at FROM observations WHERE appid = ?").bind(appid).first<{
        current_players: number;
        observed_at: string;
      }>(),
    ).toEqual({ current_players: 0, observed_at: anchorTime.toISOString() });
    expect(
      await db
        .prepare(
          "SELECT latest_players, consecutive_failures, last_attempted_at, last_successful_at, next_due_at FROM tracked_games WHERE appid = ?"
        )
        .bind(appid)
        .first<{
          latest_players: number | null;
          consecutive_failures: number;
          last_attempted_at: string | null;
          last_successful_at: string | null;
          next_due_at: string;
        }>(),
    ).toEqual({
      latest_players: 0,
      consecutive_failures: 0,
      last_attempted_at: anchorTime.toISOString(),
      last_successful_at: anchorTime.toISOString(),
      next_due_at: calculateNextDueAt(anchorTime, "fast", appid).toISOString(),
    });
  });
  test("collects reception without rescheduling the player cadence", async () => {
    const db = createAppDatabase();
    const anchorTime = new Date("2026-09-05T03:10:00.000Z");
    await setDailyCheckpoint(db, "2026-09-04");
    await db
      .prepare("INSERT INTO apps (appid, name, slug, is_eligible, is_playable) VALUES (?, ?, ?, 0, 0)")
      .bind(730, "Counter-Strike 2", "counter-strike-2")
      .run();
    await seedDueGame(db, 730, anchorTime.toISOString());

    const customFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetNumberOfCurrentPlayers")) return successfulSteamResponse();
      if (url.includes("appreviews")) {
        return Response.json({
          success: 1,
          query_summary: {
            total_positive: 9,
            total_negative: 1,
            total_reviews: 10,
            num_reviews: 0,
            review_score: 8,
            review_score_desc: "Very Positive",
          },
        });
      }
      if (url.includes("appreviewhistogram")) {
        return Response.json({ success: 1, results: { rollup_type: "day", recent: [], weeks: [], start_date: null, end_date: null } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await runIngestionTick({ db, anchorTime, customFetch });

    expect(result.status).toBe("completed");
    expect(result.tick?.attempted).toBe(1);
    expect(result.reviewCollection?.attemptedGames).toBe(1);
    expect(result.reviewCollection?.reviewRequests).toBe(2);
    expect(result.reviewCollection?.newsHubRequests).toBe(1);
    expect(result.criticCollection?.games).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM review_summary_snapshots").first<number>("count")).toBe(1);
    expect(await db.prepare("SELECT next_due_at FROM tracked_games WHERE appid = 730").first<string>("next_due_at")).toBe(
      calculateNextDueAt(anchorTime, "fast", 730).toISOString(),
    );
  });
  test("rolls up only the prior UTC day, then retains thirty days before snapshot", async () => {
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
      .bind(1, 50, "2026-08-05T23:59:59.999Z")
      .run();
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)")
      .bind(1, 75, "2026-08-06T00:05:00.000Z")
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
      "2026-08-06T00:05:00.000Z",
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

  test("calculates deterministic 15-minute slot and next due times for fast tier", () => {
    expect(CADENCE_MINUTES.fast).toBe(15);
    expect(calculateDeterministicSlot(1245620, "fast")).toBe(0);

    const anchor = new Date("2026-09-06T12:00:00.000Z");
    const nextDue = calculateNextDueAt(anchor, "fast", 1245620);
    expect(nextDue.toISOString()).toBe("2026-09-06T12:15:00.000Z");

    const nextDue2 = calculateNextDueAt(new Date("2026-09-06T12:01:23.000Z"), "fast", 1245620);
    expect(nextDue2.toISOString()).toBe("2026-09-06T12:15:00.000Z");

    const nextDue3 = calculateNextDueAt(new Date("2026-09-06T12:15:00.000Z"), "fast", 1245620);
    expect(nextDue3.toISOString()).toBe("2026-09-06T12:30:00.000Z");
  });

  test("re-ranks top 50 to fast tier, next 200 to hourly tier, and remaining to daily", async () => {
    const db = createAppDatabase();
    const anchor = new Date("2026-09-07T00:00:00.000Z");
    expect(TIER_FAST_MAX).toBe(50);
    expect(TIER_HOURLY_MAX).toBe(200);
    expect(TIER_DAILY_MAX).toBe(750);
    expect(DAILY_REQUEST_CAP).toBe(80000);
    expect(TICK_REQUEST_CAP).toBe(150);

    // Seed 260 games with descending player counts
    const stmts: AppPreparedStatement[] = [];
    for (let i = 1; i <= 260; i++) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players) VALUES (?, 'daily', 0, ?, ?)"
          )
          .bind(i, anchor.toISOString(), 100000 - i * 100)
      );
    }
    await db.batch(stmts);

    const result = await reRankTrackedTiers(db, anchor);
    expect(result.fastCount).toBe(50);
    expect(result.hourlyCount).toBe(200);
    expect(result.dailyCount).toBe(10);

    const fastGame = await db.prepare("SELECT tier FROM tracked_games WHERE appid = 50").first<{ tier: string }>();
    expect(fastGame?.tier).toBe("fast");

    const hourlyGame = await db.prepare("SELECT tier FROM tracked_games WHERE appid = 51").first<{ tier: string }>();
    expect(hourlyGame?.tier).toBe("hourly");

    const hourlyGameLast = await db.prepare("SELECT tier FROM tracked_games WHERE appid = 250").first<{ tier: string }>();
    expect(hourlyGameLast?.tier).toBe("hourly");

    const dailyGame = await db.prepare("SELECT tier FROM tracked_games WHERE appid = 251").first<{ tier: string }>();
    expect(dailyGame?.tier).toBe("daily");
  });

  test("advances overdue games to next deterministic slot when daily cap is reached", async () => {
    const db = createAppDatabase();
    const anchor = new Date("2026-09-07T12:00:00.000Z");
    await db
      .prepare(
        "INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players) VALUES (1172470, 'fast', 0, '2026-09-07T11:45:00.000Z', 60000)"
      )
      .run();

    const tickRes = await runPlayerCollectionTick(db, {
      anchorTime: anchor,
      dailyCap: 0,
    });

    expect(tickRes.reason).toBe("daily_cap_reached");
    expect(tickRes.attempted).toBe(0);

    const updated = await db
      .prepare("SELECT next_due_at FROM tracked_games WHERE appid = 1172470")
      .first<{ next_due_at: string }>();
    expect(new Date(updated!.next_due_at).getTime()).toBeGreaterThan(anchor.getTime());
    expect(updated?.next_due_at).toBe("2026-09-07T12:15:00.000Z");
  });
});
