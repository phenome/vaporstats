import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import React from "react";
import { renderToString } from "react-dom/server";
import { type AppDatabase, type AppPreparedStatement } from "../src/lib/db";
import {
  type PlayerHistoryResult,
  formatRelativeAge,
  formatExactUtc,
  computeDailyRollups,
  cleanExpiredRawObservations,
  getPlayerHistory,
  getMostPlayedRankings,
  getPeakRankings,
  getTrendingGames,
} from "../src/lib/player-history";
import { runDailyRollupJob } from "../workers/player-rollups";
import { handlePlayerHistoryRequest } from "../src/routes/api.players.history";
import { handleRankingsRequest } from "../src/routes/api.rankings";
import {
  PlayerHistoryChart,
  type PlayerHistoryChartProps,
} from "../src/components/player-history";
import { TrendingBlock } from "../src/components/trending";
import { RankingsPageView } from "../src/components/rankings-page";
import { handleRankingsHttpRequest } from "../src/routes/rankings.index";
import { PeakRankingsPageView } from "../src/components/peak-rankings-page";
import { handlePeakRankingsHttpRequest } from "../src/routes/rankings.peak";
import { CACHE_POLICIES } from "../src/lib/cache";
import { HomeComponent, type HomeComponentProps } from "../src/components/home-page";
import { GamePageView, type GamePageProps } from "../src/components/game-page";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { applyMigrations } from "../src/lib/migrations";
import { CADENCE_MS } from "../src/lib/player";
function createSqliteAppAdapter(db: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let boundValues: unknown[] = [];

      const statement = {
        bind(...values: unknown[]): AppPreparedStatement {
          boundValues = values;
          return statement;
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          const stmt = db.prepare(query);
          const row = stmt.get(...(boundValues as SQLQueryBindings[])) as Record<string, unknown> | null;
          if (!row) return null;
          if (colName) {
            return (row[colName] as T) ?? null;
          }
          return row as T;
        },
        async run<T = unknown>() {
          const stmt = db.prepare(query);
          const info = stmt.run(...(boundValues as SQLQueryBindings[]));
          return {
            success: true,
            meta: {
              changes: info.changes,
              duration: 0,
            },
          };
        },
        async all<T = unknown>() {
          const stmt = db.prepare(query);
          const results = stmt.all(...(boundValues as SQLQueryBindings[])) as T[];
          return {
            success: true,
            results,
            meta: {
              changes: 0,
              duration: 0,
            },
          };
        },
        async raw<T = unknown>() {
          const stmt = db.prepare(query);
          const results = stmt.values(...(boundValues as SQLQueryBindings[])) as T[];
          return results;
        },
      };

      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]) {
      const results: { success: boolean; results?: T[] }[] = [];
      db.run("BEGIN TRANSACTION;");
      try {
        for (const s of statements) {
          const res = await s.all<T>();
          results.push({ success: res.success, results: res.results });
        }
        db.run("COMMIT;");
      } catch (err) {
        db.run("ROLLBACK;");
        throw err;
      }
      return results;
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

async function createFreshDb(): Promise<AppDatabase> {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  const db = createSqliteAppAdapter(sqlite);
  return db;
}

describe("Player History and Rankings", () => {
  afterAll(() => {
    console.log("player history suite complete");
  });

  // G1: raw successful player observations remain queryable through the 30-day inclusive boundary.
  test("raw retention", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    await db
      .prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Counter-Strike', 'counter-strike')")
      .run();

    const t29d = new Date(anchor.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString();
    const t30d = new Date(anchor.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const t31d = new Date(anchor.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const t32d = new Date(anchor.getTime() - 32 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 100, ?)").bind(t29d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 200, ?)").bind(t30d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 300, ?)").bind(t31d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 400, ?)").bind(t32d).run();

    const beforeCount = await db.prepare("SELECT COUNT(*) as count FROM observations").first<number>("count");
    expect(beforeCount).toBe(4);

    const cleaned = await cleanExpiredRawObservations(db, anchor);
    expect(cleaned).toBe(2);

    const remaining = await db.prepare("SELECT current_players, observed_at FROM observations ORDER BY observed_at ASC").all<{ current_players: number; observed_at: string }>();
    expect(remaining.results.map((row) => row.current_players)).toEqual([200, 100]);

    // The scheduled worker uses the same 30-day inclusive raw window.
    const workerDb = await createFreshDb();
    await workerDb.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Worker Game', 'worker-game')").run();
    await workerDb.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 100, ?)").bind(t29d).run();
    await workerDb.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 200, ?)").bind(t30d).run();
    await workerDb.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 300, ?)").bind(t31d).run();
    const jobRes = await runDailyRollupJob(workerDb, {
      anchorTime: anchor,
      snapshot: async () => "test-snapshot.sqlite",
    });
    expect(jobRes.cleanedObservationsCount).toBe(1);
    const workerRemaining = await workerDb.prepare("SELECT current_players FROM observations ORDER BY observed_at ASC").all<{ current_players: number }>();
    expect(workerRemaining.results.map((row) => row.current_players)).toEqual([200, 100]);
  });

  // G2: UTC daily rollups retain minimum, maximum, average, close, and sample count
  test("daily rollup continuity", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Counter-Strike', 'counter-strike')").run();

    // Insert observations on 2026-09-01 UTC:
    // 01:00 UTC -> 100
    // 12:00 UTC -> 500 (peak)
    // 18:00 UTC -> 200
    // 23:30 UTC -> 300 (close)
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 100, '2026-09-01T01:00:00.000Z')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 500, '2026-09-01T12:00:00.000Z')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 200, '2026-09-01T18:00:00.000Z')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 300, '2026-09-01T23:30:00.000Z')").run();

    // Run daily rollups
    const rollupRes = await computeDailyRollups(db, { targetDate: "2026-09-01" });
    expect(rollupRes.rolledUpCount).toBe(1);

    const record = rollupRes.records[0];
    expect(record.appid).toBe(10);
    expect(record.date).toBe("2026-09-01");
    expect(record.min_players).toBe(100);
    expect(record.max_players).toBe(500);
    expect(record.avg_players).toBe(275); // (100 + 500 + 200 + 300) / 4 = 275
    expect(record.close_players).toBe(300); // latest in day
    expect(record.sample_count).toBe(4);

    // Idempotency: insert another point for 2026-09-01 and re-run
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 50, '2026-09-01T00:30:00.000Z')").run();
    const rerun = await computeDailyRollups(db, { targetDate: "2026-09-01" });
    expect(rerun.rolledUpCount).toBe(1);
    expect(rerun.records[0].min_players).toBe(50);
    expect(rerun.records[0].sample_count).toBe(5);
    // The scheduled default targets only the previous completed UTC day.
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 700, '2026-09-03T23:30:00.000Z')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 999, '2026-09-04T10:00:00.000Z')").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (11, '2026-09-01', 1, 2, 1.5, 2, 1)").run();

    const bounded = await computeDailyRollups(db, { anchorTime: anchor });
    expect(bounded.records.map((record) => record.date)).toEqual(["2026-09-03"]);

    const todayRollup = await db.prepare("SELECT * FROM player_rollups WHERE date = '2026-09-04'").first();
    expect(todayRollup).toBeNull(); // Current partial day is not rolled up

    // Test worker coordinator helper (runs rollups before raw cleanup)
    const jobRes = await runDailyRollupJob(db, {
      anchorTime: anchor,
      snapshot: async () => "test-snapshot.sqlite",
    });
    expect(jobRes.rolledUpCount).toBe(1);
    console.log("daily rollup continuity");
  });

  // G3: resolution-aware history aggregates retained raw observations, not stale daily rows.
  test("hourly and six-hour history preserve raw buckets", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Game 10', 'game-10')").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, '2026-09-01', 10, 900, 400, 700, 4)").run();

    const observations = [
      [100, "2026-09-01T01:05:00.000Z"],
      [200, "2026-09-01T01:55:00.000Z"],
      [300, "2026-09-01T02:02:00.000Z"],
      [350, "2026-09-01T02:02:00.000Z"],
      [400, "2026-09-01T06:10:00.000Z"],
      [600, "2026-09-01T06:59:00.000Z"],
      [800, "2026-09-01T12:01:00.000Z"],
      [0, "2026-09-01T18:01:00.000Z"],
    ] as const;
    for (const [players, timestamp] of observations) {
      await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, ?, ?)").bind(players, timestamp).run();
    }

    const hourlyResult = await getPlayerHistory(db, 10, "7d", anchor);
    const hourly = hourlyResult.points.filter((point) => !point.is_gap);
    expect(hourly.map((point) => point.timestamp)).toEqual([
      "2026-09-01T01:55:00.000Z",
      "2026-09-01T02:02:00.000Z",
      "2026-09-01T06:59:00.000Z",
      "2026-09-01T12:01:00.000Z",
      "2026-09-01T18:01:00.000Z",
    ]);
    expect(hourlyResult.source_timestamp).toBe("2026-09-01T18:01:00.000Z");
    expect(hourly[0]).toMatchObject({ players: 200, min: 100, max: 200, avg: 150, close: 200, sample_count: 2 });
    expect(hourly[1]).toMatchObject({ players: 350, min: 300, max: 350, avg: 325, close: 350, sample_count: 2 });
    expect(hourly[2]).toMatchObject({ players: 600, min: 400, max: 600, avg: 500, close: 600, sample_count: 2 });
    expect(hourly[4]).toMatchObject({ players: 0, min: 0, max: 0, avg: 0, close: 0, sample_count: 1 });
    expect(hourly.some((point) => point.timestamp === "2026-09-01T00:00:00.000Z")).toBe(false);

    const sixHourResult = await getPlayerHistory(db, 10, "30d", anchor);
    const sixHour = sixHourResult.points.filter((point) => !point.is_gap);
    expect(sixHour.map((point) => point.timestamp)).toEqual([
      "2026-09-01T02:02:00.000Z",
      "2026-09-01T06:59:00.000Z",
      "2026-09-01T12:01:00.000Z",
      "2026-09-01T18:01:00.000Z",
    ]);
    expect(sixHourResult.source_timestamp).toBe("2026-09-01T18:01:00.000Z");
    expect(sixHour[0]).toMatchObject({ players: 350, min: 100, max: 350, avg: 237.5, close: 350, sample_count: 4 });
    expect(sixHour[1]).toMatchObject({ players: 600, min: 400, max: 600, avg: 500, close: 600, sample_count: 2 });
    expect(sixHour[3].players).toBe(0);
  });
  // A previous 30d builder merged a midnight daily rollup with later raw rows,
  // producing an isolated dot and a false gap before the current six-hour pair.
  test("30d history does not merge daily rollups into raw six-hour buckets", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-06T01:30:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Game 10', 'game-10')").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, '2026-09-04', 100, 200, 150, 180, 4)").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 300, '2026-09-05T23:50:00.001Z')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 400, '2026-09-06T01:10:00.003Z')").run();

    const history = await getPlayerHistory(db, 10, "30d", anchor);
    expect(history.points).toEqual([
      expect.objectContaining({
        timestamp: "2026-09-05T23:50:00.001Z",
        players: 300,
        is_rollup: false,
      }),
      expect.objectContaining({
        timestamp: "2026-09-06T01:10:00.003Z",
        players: 400,
        is_rollup: false,
      }),
    ]);
  });

  // G4: 90d and All expose one daily point per occupied UTC day, including today.
  test("daily history merges rollups and raw-only current day", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Game 10', 'game-10')").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, '2026-09-01', 10, 900, 400, 700, 4)").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, '2026-09-04', 900, 9999, 5000, 9999, 99)").run();
    const observations = [
      [22, "2026-09-01T02:00:00.000Z"],
      [50, "2026-09-03T03:00:00.000Z"],
      [70, "2026-09-03T23:00:00.000Z"],
      [100, "2026-09-04T01:00:00.000Z"],
      [0, "2026-09-04T10:00:00.000Z"],
    ] as const;
    for (const [players, timestamp] of observations) {
      await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, ?, ?)").bind(players, timestamp).run();
    }

    const daily90 = (await getPlayerHistory(db, 10, "90d", anchor)).points.filter((point) => !point.is_gap);
    expect(daily90).toHaveLength(3);
    expect(daily90.map((point) => point.timestamp.slice(0, 10))).toEqual(["2026-09-01", "2026-09-03", "2026-09-04"]);
    expect(daily90[0]).toMatchObject({ timestamp: "2026-09-01T02:00:00.000Z", players: 700, min: 10, max: 900, avg: 400, close: 700, sample_count: 4 });
    expect(daily90[1]).toMatchObject({ timestamp: "2026-09-03T23:00:00.000Z", players: 70, min: 50, max: 70, avg: 60, close: 70, sample_count: 2 });
    expect(daily90[2]).toMatchObject({ timestamp: "2026-09-04T10:00:00.000Z", players: 0, min: 0, max: 100, avg: 50, close: 0, sample_count: 2 });

    const all = await getPlayerHistory(db, 10, "all", anchor);
    expect(all.range_start).toBe("2026-09-01T02:00:00.000Z");
    expect(all.range_end).toBe("2026-09-04T10:00:00.000Z");
    expect(all.source_timestamp).toBe("2026-09-04T10:00:00.000Z");
    expect(all.points.filter((point) => !point.is_gap)).toHaveLength(3);
    expect(all.points.some((point) => point.timestamp === "2026-09-04T00:00:00.000Z")).toBe(false);
  });

  // G4b: a midnight cutoff includes the complete boundary rollup; a partial day uses raw only.
  test("daily cutoff boundary semantics", async () => {
    const db = await createFreshDb();
    const exactMidnight = new Date("2026-09-04T00:00:00.000Z");
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (40, 'Cutoff Game', 'cutoff-game')").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (40, '2026-06-06', 10, 20, 15, 20, 2)").run();

    const midnightHistory = await getPlayerHistory(db, 40, "90d", exactMidnight);
    const midnightBoundary = midnightHistory.points.find((point) => !point.is_gap && point.timestamp.startsWith("2026-06-06"));
    expect(midnightBoundary).toMatchObject({ timestamp: "2026-06-06T00:00:00.000Z", players: 20, min: 10, max: 20, avg: 15, close: 20, sample_count: 2 });

    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (40, 999, '2026-06-06T11:59:00.000Z')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (40, 200, '2026-06-06T12:01:00.000Z')").run();
    const partialHistory = await getPlayerHistory(db, 40, "90d", new Date("2026-09-04T12:00:00.000Z"));
    const partialBoundary = partialHistory.points.find((point) => !point.is_gap && point.timestamp.startsWith("2026-06-06"));
    expect(partialBoundary).toMatchObject({ timestamp: "2026-06-06T12:01:00.000Z", players: 200, min: 200, max: 200, avg: 200, close: 200, sample_count: 1 });
    expect(partialHistory.points.some((point) => point.players === 999)).toBe(false);
  });

  // G5: fixed windows exclude outside observations; bucket-key gaps differ from raw outages.
  test("window cutoffs and bucket gaps are observable", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (20, 'Boundary Game', 'boundary-game')").run();
    const boundaryObservations = [
      [999, "2026-08-28T11:59:00.000Z"],
      [100, "2026-08-28T12:00:00.000Z"],
      [200, "2026-08-28T12:05:00.000Z"],
      [300, "2026-08-28T13:59:00.000Z"],
      [400, "2026-08-28T15:01:00.000Z"],
    ] as const;
    for (const [players, timestamp] of boundaryObservations) {
      await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (20, ?, ?)").bind(players, timestamp).run();
    }

    const bounded = await getPlayerHistory(db, 20, "7d", anchor);
    expect(bounded.range_start).toBe("2026-08-28T12:00:00.000Z");
    expect(bounded.range_end).toBe(anchor.toISOString());
    expect(bounded.points.some((point) => point.players === 999)).toBe(false);
    expect(bounded.points[0]?.is_gap).not.toBe(true);
    const valid = bounded.points.filter((point) => !point.is_gap);
    expect(valid.map((point) => point.players)).toEqual([200, 300, 400]);
    expect(bounded.points.some((point) => point.players === 0)).toBe(false);
    const adjacentFirst = bounded.points.findIndex((point) => point.timestamp === "2026-08-28T12:05:00.000Z");
    const adjacentSecond = bounded.points.findIndex((point) => point.timestamp === "2026-08-28T13:59:00.000Z");
    expect(adjacentSecond - adjacentFirst).toBe(1);
    const afterAdjacentBuckets = bounded.points.findIndex((point) => point.timestamp === "2026-08-28T13:59:00.000Z");
    expect(afterAdjacentBuckets).toBeGreaterThanOrEqual(0);
    expect(bounded.points[afterAdjacentBuckets + 1]?.is_gap).toBe(true);
    expect(bounded.points[afterAdjacentBuckets + 1]?.players).toBeNull();

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (30, 'Outage Game', 'outage-game')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (30, 500, '2026-09-04T10:00:00.000Z')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (30, 0, '2026-09-04T11:01:00.000Z')").run();
    const outage = await getPlayerHistory(db, 30, "24h", anchor);
    expect(outage.points.some((point) => point.is_gap && point.players === null)).toBe(true);
    expect(outage.points.some((point) => point.players === 0)).toBe(true);
    expect(outage.points.some((point) => point.players === null && !point.is_gap)).toBe(false);
  });
  test("24h gaps follow tracked cadence without fabricating points", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-05T00:00:00.000Z");
    const minute = 60 * 1000;
    const at = (offsetMs: number) => new Date(anchor.getTime() + offsetMs).toISOString();

    for (const [appid, name] of [
      [101, "Hourly Game"],
      [102, "Fast Game"],
      [103, "Daily Game"],
      [104, "Unknown Tier Game"],
      [105, "Untracked Game"],
      [106, "Untracked Hourly Game"],
    ] as const) {
      await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").bind(appid, name, name.toLowerCase().replaceAll(" ", "-")).run();
    }
    for (const [appid, tier] of [[101, "hourly"], [102, "fast"], [103, "daily"], [104, "mystery"]] as const) {
      await db.prepare("INSERT INTO tracked_games (appid, tier, next_due_at) VALUES (?, ?, ?)").bind(appid, tier, anchor.toISOString()).run();
    }

    const hourly = CADENCE_MS.hourly;
    const fast = CADENCE_MS.fast;
    const observations = [
      [101, 100, at(-6 * hourly)],
      [101, 0, at(-6 * hourly + 250)],
      [101, 200, at(-5 * hourly + 251)],
      [101, 300, at(-4 * hourly + 252)],
      [101, 400, at(-2 * hourly + 252)],
      [102, 7, at(-6 * hourly)],
      [102, 0, at(-6 * hourly + fast + 1)],
      [102, 9, at(-6 * hourly + 2 * fast + 2)],
      [102, 11, at(-6 * hourly + 2 * fast + 41 * minute + 2)],
      [102, 13, at(-6 * hourly + 2 * fast + 41 * minute + fast + 3)],
      [103, 42, at(-CADENCE_MS.daily)],
      [103, 43, at(0)],
      [104, 5, at(-90 * minute)],
      [104, 6, at(-59 * minute)],
      [105, 8, at(-120 * minute)],
      [105, 9, at(-80 * minute)],
      [106, 50, at(-4 * hourly)],
      [106, 51, at(-3 * hourly)],
      [106, 52, at(-2 * hourly)],
      [106, 53, at(-1 * hourly)],
    ] as const;
    for (const [appid, players, observedAt] of observations) {
      await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)").bind(appid, players, observedAt).run();
    }

    const hourlyHistory = await getPlayerHistory(db, 101, "24h", anchor);
    expect(hourlyHistory.points.map((point) => point.players)).toEqual([100, 0, 200, 300, null, 400]);
    expect(hourlyHistory.points.filter((point) => point.is_gap)).toHaveLength(1);

    const fastHistory = await getPlayerHistory(db, 102, "24h", anchor);
    expect(fastHistory.points.map((point) => point.players)).toEqual([7, 0, 9, null, 11, 13]);
    expect(fastHistory.points.filter((point) => point.is_gap)).toHaveLength(1);

    const dailyHistory = await getPlayerHistory(db, 103, "24h", anchor);
    expect(dailyHistory.points.map((point) => point.players)).toEqual([42, 43]);
    expect(dailyHistory.points.some((point) => point.is_gap)).toBe(false);

    const unknownTierHistory = await getPlayerHistory(db, 104, "24h", anchor);
    expect(unknownTierHistory.points.map((point) => point.players)).toEqual([5, null, 6]);

    // No tracked row is conservative too; the hourly row must not affect this appid.
    const untrackedHistory = await getPlayerHistory(db, 105, "24h", anchor);
    expect(untrackedHistory.points.map((point) => point.players)).toEqual([8, null, 9]);

    // Untracked game with recurring hourly cadence does not inject false gaps between regular samples
    const untrackedHourlyHistory = await getPlayerHistory(db, 106, "24h", anchor);
    expect(untrackedHourlyHistory.points.map((point) => point.players)).toEqual([50, 51, 52, 53]);
    expect(untrackedHourlyHistory.points.some((point) => point.is_gap)).toBe(false);
  });

  // G4: player charts expose labels, values, gaps, and a numeric time domain
  test("accessible gap-preserving chart", async () => {
    // 1. Render chart with valid points and an explicit gap
    const mockResult: PlayerHistoryResult = {
      appid: 10,
      range: "30d",
      earliest_observation: "2026-08-01T00:00:00.000Z",
      range_start: "2026-08-05T12:00:00.000Z",
      range_end: "2026-09-04T12:00:00.000Z",
      points: [
        { timestamp: "2026-08-10T12:00:00.000Z", players: 1500 },
        { timestamp: "2026-08-15T12:00:00.000Z", players: null, is_gap: true }, // Gap
        { timestamp: "2026-08-20T12:00:00.000Z", players: 2500 },
      ],
      source_timestamp: "2026-08-20T12:00:00.000Z",
    };

    const html = renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 10,
        initialRange: "30d",
        initialData: mockResult,
      })
    );

    // Accessible attributes
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label=");
    expect(html).toContain("<title>");
    expect(html).toContain("<desc>");

    // Metrics visible
    expect(html).toContain("1,500");
    expect(html).toContain("2,500");

    // Missing sample is NEVER converted to zero or bridged by the fallback SVG.
    expect(html).not.toContain(">0</text>");
    expect(html).toContain("1,500");

    // The sparse observations retain their positions across the complete fixed window.
    expect(html).toContain('cx="180"');
    expect(html).toContain('cx="420"');
    expect(html.match(/<circle\b/g)).toHaveLength(2); // Both isolated observations remain visible.
    expect(html).toContain(">Aug 5</text>");
    expect(html).toContain(">Sep 4</text>");

    // No secondary text view is rendered alongside the chart.
    expect(html).not.toContain("<table");
    expect(html).not.toContain("data table equivalent");

    // Range buttons present with aria-pressed
    expect(html).toContain("24h");
    expect(html).toContain("7d");
    expect(html).toContain("30d");
    expect(html).toContain("90d");
    expect(html).toContain("All");

    // Empty state test
    const emptyResult: PlayerHistoryResult = {
      appid: 20,
      range: "30d",
      earliest_observation: null,
      range_start: "2026-08-05T12:00:00.000Z",
      range_end: "2026-09-04T12:00:00.000Z",
      points: [],
      source_timestamp: null,
    };
    const emptyHtml = renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 20,
        initialRange: "30d",
        initialData: emptyResult,
      })
    );
    expect(emptyHtml).toContain("No data yet");
    expect(emptyHtml).toContain("Awaiting first scheduled observation probe");

    // Constant-value history renders chart marks and labels
    const constResult: PlayerHistoryResult = {
      appid: 30,
      range: "30d",
      earliest_observation: "2026-08-01T00:00:00.000Z",
      range_start: "2026-08-05T12:00:00.000Z",
      range_end: "2026-09-04T12:00:00.000Z",
      points: [
        { timestamp: "2026-08-10T12:00:00.000Z", players: 500 },
        { timestamp: "2026-08-15T12:00:00.000Z", players: 500 },
        { timestamp: "2026-08-20T12:00:00.000Z", players: 500 },
      ],
      source_timestamp: "2026-08-20T12:00:00.000Z",
    };
    const constHtml = renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 30,
        initialRange: "30d",
        initialData: constResult,
      })
    );
    expect(constHtml).toContain("500");
    expect(constHtml).toContain("<path");
    expect(constHtml).not.toContain("<circle"); // Connected observations have no persistent markers.


    // Aggregated buckets expose extrema and a sample-weighted average, not an average of closes.
    const aggregateHtml = renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 31,
        initialRange: "30d",
        initialData: {
          appid: 31,
          range: "30d",
          earliest_observation: "2026-08-01T00:00:00.000Z",
          range_start: "2026-08-05T12:00:00.000Z",
          range_end: "2026-09-04T12:00:00.000Z",
          points: [
            { timestamp: "2026-08-10T12:00:00.000Z", players: 100, min: 50, max: 300, avg: 100, close: 100, sample_count: 1 },
            { timestamp: "2026-08-15T12:00:00.000Z", players: 900, min: 200, max: 900, avg: 700, close: 900, sample_count: 9 },
            { timestamp: "2026-08-20T12:00:00.000Z", players: 400, min: 100, max: 500, avg: 300, close: 400, sample_count: 2 },
          ],
          source_timestamp: "2026-08-20T12:00:00.000Z",
        },
      })
    );
    expect(aggregateHtml).toContain("50");
    expect(aggregateHtml).toContain("900");
    expect(aggregateHtml).toContain("30D Low");
    expect(aggregateHtml).toContain("30D Peak");

    // On 'all' range, slot 3 renders the sample-weighted average
    const aggregateAllHtml = renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 31,
        initialRange: "all",
        initialData: {
          appid: 31,
          range: "all",
          earliest_observation: "2026-08-01T00:00:00.000Z",
          range_start: "2026-08-05T12:00:00.000Z",
          range_end: "2026-09-04T12:00:00.000Z",
          points: [
            { timestamp: "2026-08-10T12:00:00.000Z", players: 100, min: 50, max: 300, avg: 100, close: 100, sample_count: 1 },
            { timestamp: "2026-08-15T12:00:00.000Z", players: 900, min: 200, max: 900, avg: 700, close: 900, sample_count: 9 },
            { timestamp: "2026-08-20T12:00:00.000Z", players: 400, min: 100, max: 500, avg: 300, close: 400, sample_count: 2 },
          ],
          source_timestamp: "2026-08-20T12:00:00.000Z",
        },
      })
    );
    expect(aggregateAllHtml).toContain("All-Time Avg");
    expect(aggregateAllHtml).toContain("583");
    // Ensure render does not trigger infinite loops or unexpected side-effects
    let fetchCount = 0;
    const trackingFetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ status: "data", data: mockResult }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 10,
        initialRange: "30d",
        initialData: mockResult,
        customFetch: trackingFetch,
      })
    );
    expect(fetchCount).toBe(0); // SSR render does not invoke fetch loop
    console.log("accessible gap-preserving chart");
  });

  test("player history chart retains summary bar during period revalidation", async () => {
    const initialData: PlayerHistoryResult = {
      appid: 42,
      range: "30d",
      earliest_observation: "2026-08-01T00:00:00.000Z",
      range_start: "2026-08-05T12:00:00.000Z",
      range_end: "2026-09-04T12:00:00.000Z",
      points: [
        { timestamp: "2026-08-10T12:00:00.000Z", players: 1200 },
        { timestamp: "2026-08-20T12:00:00.000Z", players: 3400 },
      ],
      source_timestamp: "2026-08-20T12:00:00.000Z",
      all_time_peak: 5000,
    };

    const html = renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 42,
        initialRange: "30d",
        initialData,
      })
    );

    // Summary bar must be present with period-adapted labels and all-time peak
    expect(html).toContain("Current");
    expect(html).toContain("30D Low");
    expect(html).toContain("30D Peak");
    expect(html).toContain("All-Time Peak");
    expect(html).toContain("1,200");
    expect(html).toContain("3,400");
    expect(html).toContain("5,000");

    // Verify the summary bar is not replaced with a bare loading placeholder
    expect(html).not.toContain("Loading player history...");
  });
  // G5: Most Played orders latest observations with relative and exact UTC age
  test("most played ordering", async () => {
    const db = await createFreshDb();
    const now = new Date("2026-09-04T12:00:00.000Z");
    const obsHigh = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5m ago
    const obsMid = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const obsLow = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(); // 1d ago

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Game Low', 'game-low')").run();
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (20, 'Game High', 'game-high')").run();
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (30, 'Game Mid', 'game-mid')").run();
    // Untracked game 40 has observations in observations table, but is NOT in tracked_games
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (40, 'Untracked Game', 'untracked-game')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (40, 99999, ?)").bind(obsHigh).run();

    // Tracked game 50 has null latest_players
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (50, 'Null Players Game', 'null-game')").run();
    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (50, NULL, NULL, '2026-09-04T13:00:00Z')").run();

    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (10, 100, ?, '2026-09-04T13:00:00Z')").bind(obsLow).run();
    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (20, 5000, ?, '2026-09-04T13:00:00Z')").bind(obsHigh).run();
    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (30, 2500, ?, '2026-09-04T13:00:00Z')").bind(obsMid).run();
    // Tracked game 60 has no successful timestamp; rankings use tracked state without an observation fallback.
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (60, 'Fallback Game', 'fallback-game')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (60, 1500, ?)").bind(obsMid).run();
    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (60, 1500, NULL, '2026-09-04T13:00:00Z')").run();


    const rankings = await getMostPlayedRankings(db, { now });
    expect(rankings.length).toBe(4);

    // Order check: High (5000) -> Mid (2500) -> Low (100)
    expect(rankings[0].appid).toBe(20);
    expect(rankings[0].rank).toBe(1);
    expect(rankings[0].current_players).toBe(5000);
    expect(rankings[0].relative_age).toBe("5m ago");
    expect(rankings[0].exact_utc).toBe(formatExactUtc(obsHigh));

    expect(rankings[1].appid).toBe(30);
    expect(rankings[1].rank).toBe(2);
    expect(rankings[1].current_players).toBe(2500);
    expect(rankings[1].relative_age).toBe("2h ago");

    expect(rankings[2].appid).toBe(60);
    expect(rankings[2].rank).toBe(3);
    expect(rankings[2].current_players).toBe(1500);
    expect(rankings[2].relative_age).toBe("No data yet");
    expect(rankings[2].exact_utc).toBe("No data yet");

    expect(rankings[3].appid).toBe(10);
    expect(rankings[3].rank).toBe(4);
    expect(rankings[3].current_players).toBe(100);
    expect(rankings[3].relative_age).toBe("1d ago");

    // Page view rendering check
    const pageHtml = renderToString(React.createElement(RankingsPageView, { games: rankings }));
    expect(pageHtml).toContain("Game High");
    expect(pageHtml).toContain("5,000");
    expect(pageHtml).toContain("5m ago");
    expect(pageHtml).toContain(formatExactUtc(obsHigh));
    // Exact UTC is kept visible at narrow widths without responsive column hiding
    expect(pageHtml).not.toContain("hidden sm:table-cell");

    // Verify untracked game 40 and null-player game 50 are strictly excluded
    expect(rankings.some((g) => g.appid === 40)).toBe(false);
    expect(rankings.some((g) => g.appid === 50)).toBe(false);
    // HTTP handler check
    const req = new Request("https://vaporstats.com/rankings");
    const res = await handleRankingsHttpRequest(req, db);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);

    console.log("most played ordering");
  });

  // G6: observed-peak periods derive from retained raw data and rollups
  test("observed peak periods", async () => {
    const db = await createFreshDb();
    const now = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Game Alpha', 'game-alpha')").run();
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (20, 'Game Beta', 'game-beta')").run();

    // Game Alpha: recent raw peak 600 (within 24h)
    const tRecent = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 600, ?)").bind(tRecent).run();

    // Game Beta: current raw 200, but historical daily rollup peak was 3500 40 days ago
    const tBetaRecent = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (20, 200, ?)").bind(tBetaRecent).run();

    const t40d = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (20, ?, 1000, 3500, 2000, 1500, 20)").bind(t40d).run();

    // Peak 24h: Alpha is #1 (600 vs 200)
    const peaks24h = await getPeakRankings(db, "24h", { anchorTime: now });
    expect(peaks24h[0].appid).toBe(10);
    expect(peaks24h[0].peak_players).toBe(600);
    expect(peaks24h[1].appid).toBe(20);
    expect(peaks24h[1].peak_players).toBe(200);

    // Peak All: Beta is #1 with 3500 from rollups
    const peaksAll = await getPeakRankings(db, "all", { anchorTime: now });
    expect(peaksAll[0].appid).toBe(20);
    expect(peaksAll[0].peak_players).toBe(3500);
    // Peak 24h does NOT pull in older whole-day rollups from cutoff date
    // Insert a high rollup on yesterday's date (2026-09-03)
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (20, '2026-09-03', 500, 9999, 5000, 4000, 50)").run();
    // Game Alpha remains #1 in 24h (600) because 24h uses raw observations only (Beta's raw was 200)
    const peaks24hStrict = await getPeakRankings(db, "24h", { anchorTime: now });
    expect(peaks24hStrict[0].appid).toBe(10);
    expect(peaks24hStrict[0].peak_players).toBe(600);

    // Page view rendering check
    const pageHtml = renderToString(React.createElement(PeakRankingsPageView, { peaks: peaksAll, period: "all" }));
    expect(pageHtml).toContain("Highest Observed Peak");
    expect(pageHtml).toContain("3,500");

    // HTTP handler check
    const req = new Request("https://vaporstats.com/rankings/peak?period=all");
    const res = await handlePeakRankingsHttpRequest(req, db);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);

    console.log("observed peak periods");
  });

  // G7: the home Trending block contains the top ten and links to Most Played
  test("home trending contract", async () => {
    const db = await createFreshDb();
    const now = new Date("2026-09-04T12:00:00.000Z");

    // Seed 15 games with descending counts
    for (let i = 1; i <= 15; i++) {
      const appid = 100 + i;
      await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").bind(appid, `Game ${i}`, `game-${i}`).run();
      const players = (20 - i) * 100; // 1900 down to 500
      await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (?, ?, ?, '2026-09-04T13:00:00Z')").bind(appid, players, now.toISOString()).run();
    }

    const trending = await getTrendingGames(db, { now });
    // Must contain exactly top 10
    expect(trending.length).toBe(10);
    expect(trending[0].appid).toBe(101); // 1900
    expect(trending[9].appid).toBe(110); // 1000

    // Render component
    const html = renderToString(React.createElement(TrendingBlock, { initialGames: trending }));
    expect(html).toContain("Trending");
    expect(html).toContain('href="/rankings"');
    expect(html).toContain("View Full Rankings");
    expect(html).toContain("Game 1");
    expect(html).toContain("Game 10");
    // Game 11 (rank 11) should NOT be in Trending
    expect(html).not.toContain("Game 11");
    // Home route component integration: renders exactly one Trending block linked to /rankings
    const homeHtml = renderToString(React.createElement<HomeComponentProps>(HomeComponent, { initialTrending: trending }));
    expect(homeHtml).toContain("Trending");
    expect(homeHtml).toContain('href="/rankings"');
    expect(homeHtml).toContain("View Full Rankings");
    const trendingMatches = homeHtml.match(/data-testid="trending-block"/g);
    expect(trendingMatches?.length).toBe(1);

    console.log("home trending contract");
  });


  // G9: history and ranking responses expose source times and live caching
  test("history api contract", async () => {
    const db = await createFreshDb();
    const now = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Game 10', 'game-10')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 500, ?)").bind(now.toISOString()).run();
    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (10, 500, ?, '2026-09-04T13:00:00Z')").bind(now.toISOString()).run();

    // 1. Successful history request
    const histReq = new Request("https://vaporstats.com/api/players/history?appid=10&range=30d");
    const histRes = await handlePlayerHistoryRequest(histReq, db);
    expect(histRes.status).toBe(200);
    expect(histRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const histJson = (await histRes.json()) as {
      status: string;
      data: { appid: number; range_start: string; range_end: string; all_time_peak?: number };
      source_timestamp: string;
    };
    expect(histJson.status).toBe("data");
    expect(histJson.data.appid).toBe(10);
    expect(histJson.data.all_time_peak).toBe(500);
    expect(typeof histJson.data.range_start).toBe("string");
    expect(typeof histJson.data.range_end).toBe("string");
    expect(typeof histJson.source_timestamp).toBe("string");

    // 2. Bad request on invalid appid (never cached as successful data)
    const badHistReq = new Request("https://vaporstats.com/api/players/history?appid=invalid");
    const badHistRes = await handlePlayerHistoryRequest(badHistReq, db);
    expect(badHistRes.status).toBe(400);
    expect(badHistRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    // 3. Not found on non-existent appid (never cached as successful data)
    const nfHistReq = new Request("https://vaporstats.com/api/players/history?appid=999999");
    const nfHistRes = await handlePlayerHistoryRequest(nfHistReq, db);
    expect(nfHistRes.status).toBe(404);
    expect(nfHistRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    // 4. Successful rankings requests
    const mpReq = new Request("https://vaporstats.com/api/rankings?type=most_played");
    const mpRes = await handleRankingsRequest(mpReq, db);
    expect(mpRes.status).toBe(200);
    expect(mpRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const mpJson = (await mpRes.json()) as { status: string; source_timestamp: string };
    expect(mpJson.status).toBe("data");
    expect(typeof mpJson.source_timestamp).toBe("string");

    const peakReq = new Request("https://vaporstats.com/api/rankings?type=peak&period=all");
    const peakRes = await handleRankingsRequest(peakReq, db);
    expect(peakRes.status).toBe(200);
    expect(peakRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);

    const trendReq = new Request("https://vaporstats.com/api/rankings?type=trending");
    const trendRes = await handleRankingsRequest(trendReq, db);
    expect(trendRes.status).toBe(200);
    expect(trendRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);

    // 5. Invalid ranking type (error never cached)
    const badRankReq = new Request("https://vaporstats.com/api/rankings?type=unsupported_type");
    const badRankRes = await handleRankingsRequest(badRankReq, db);
    expect(badRankRes.status).toBe(400);
    expect(badRankRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    // 6. Server failure returns 500 with generic error (does not leak internal details)
    const failingDb = {
      prepare() {
        throw new Error("SQLite internal query engine failure");
      },
    } as unknown as AppDatabase;

    const failHistReq = new Request("https://vaporstats.com/api/players/history?appid=10");
    const failHistRes = await handlePlayerHistoryRequest(failHistReq, failingDb);
    expect(failHistRes.status).toBe(500);
    expect(failHistRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);
    const failHistJson = (await failHistRes.json()) as { status: string; error: string };
    expect(failHistJson.status).toBe("error");
    expect(failHistJson.error).toBe("Live data unavailable");
    expect(failHistJson.error).not.toContain("SQLite internal");

    const failRankReq = new Request("https://vaporstats.com/api/rankings?type=most_played");
    const failRankRes = await handleRankingsRequest(failRankReq, failingDb);
    expect(failRankRes.status).toBe(500);
    const failRankJson = (await failRankRes.json()) as { status: string; error: string };
    expect(failRankJson.status).toBe("error");
    expect(failRankJson.error).toBe("Live data unavailable");
    expect(failRankJson.error).not.toContain("SQLite internal");
    console.log("history api contract");
  });
  // G11: chart, rankings, and Trending pass desktop and narrow browser review without page overflow
  test("responsive layout and overflow prevention", () => {
    const sampleGames = [
      {
        rank: 1,
        appid: 10,
        name: "Super Long Title That Might Cause Overflow on Narrow Mobile Displays If Not Handled",
        slug: "super-long-title",
        current_players: 123456,
        last_observed_at: "2026-09-04T12:00:00.000Z",
        relative_age: "5m ago",
        exact_utc: "2026-09-04 12:00:00 UTC",
      },
    ];

    // 1. Rankings Page responsiveness
    const rankingsHtml = renderToString(React.createElement(RankingsPageView, { games: sampleGames }));
    expect(rankingsHtml).toContain("overflow-x-auto");
    expect(rankingsHtml).toContain("max-w-7xl");
    expect(rankingsHtml).toContain("whitespace-nowrap");

    // 2. Peak Rankings Page responsiveness
    const peakHtml = renderToString(
      React.createElement(PeakRankingsPageView, {
        peaks: [{ rank: 1, appid: 10, name: "Long Game Title", slug: "long-game", peak_players: 500000, period: "all" }],
        period: "all",
      })
    );
    expect(peakHtml).toContain("overflow-x-auto");
    expect(peakHtml).toContain("max-w-7xl");

    // 3. Trending Block responsiveness
    const trendingHtml = renderToString(React.createElement(TrendingBlock, { initialGames: sampleGames }));
    expect(trendingHtml).toContain("overflow-x-auto");
    expect(trendingHtml).toContain("min-w-0");
    expect(trendingHtml).toContain("truncate");

    // 4. Player History Chart responsiveness
    const chartHtml = renderToString(
      React.createElement(PlayerHistoryChart, {
        appid: 10,
        initialRange: "30d",
        initialData: {
          appid: 10,
          range: "30d",
          earliest_observation: "2026-08-01T00:00:00.000Z",
          range_start: "2026-08-05T12:00:00.000Z",
          range_end: "2026-09-04T12:00:00.000Z",
          points: [{ timestamp: "2026-08-10T00:00:00.000Z", players: 100 }],
          source_timestamp: "2026-08-10T00:00:00.000Z",
        },
      })
    );
    expect(chartHtml).toContain("w-full");
    expect(chartHtml).toContain("viewBox=");
    expect(chartHtml).toContain("overflow-hidden");
  });

  // Integration: Canonical game loader and page with PlayerHistoryChart, PlayerPanel, RelatedApps
  test("game page player history integration", async () => {
    const db = await createFreshDb();
    const now = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Portal 2', 'portal-2')").run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 850, ?)").bind(now.toISOString()).run();
    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (10, 850, ?, '2026-09-04T13:00:00Z')").bind(now.toISOString()).run();

    const game = {
      appid: 10,
      name: "Portal 2",
      slug: "portal-2",
      type: "game",
      is_eligible: true,
      is_playable: true,
      parent_appid: null,
      release_date: "2011-04-19",
      steam_release_date: null,
      original_release_date: null,
      original_steam_release_date: null,
      release_from_early_access_date: null,
      release_date_source: null,
      is_early_access: null,
      has_left_early_access: null,
      release_status: "released" as const,
      description: "Test description",
      header_image: "",
      developer: "Valve",
      publisher: "Valve",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      latest_players: 850,
      peak_players: 850,
      last_observed_at: now.toISOString(),
    };

    const history = await getPlayerHistory(db, 10, "30d", now);
    const html = renderToString(
      React.createElement<GamePageProps>(GamePageView, {
        game,
        playerHistory: history,
        related: {
          parent_appid: 10,
          expansions: [],
          dlc: [],
          soundtracks: [],
          servers: [],
          tools: [],
          demos: [],
          tests: [],
          other: [],
          total_count: 0,
        },
      })
    );
    // Preserves PlayerPanel
    expect(html).toContain("Current Players");
    expect(html).toContain("850");

    // Preserves RelatedApps structure
    expect(html).toContain("Portal 2");

    // Integrates default 30d PlayerHistoryChart
    expect(html).toContain("Player Count History");
    expect(html).toContain("30d");
    expect(html).toContain('role="img"');

    // HTTP handler integration check
    const req = new Request("https://vaporstats.com/games/10-portal-2");
    const res = await handleGameHttpRequest(req, db);
    expect(res.status).toBe(200);
    const pageHtml = await res.text();
    expect(pageHtml).toContain("Player Count History");
    expect(pageHtml).toContain("Portal 2");
  });
});
