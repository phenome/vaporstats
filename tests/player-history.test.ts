import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { type AppDatabase, type AppPreparedStatement } from "../src/lib/db";
import * as playerHistoryModule from "../src/lib/player-history";
import {
  type HistoryRange,
  type PlayerHistoryResult,
  type RollupRecord,
  parseHistoryRange,
  formatRelativeAge,
  formatExactUtc,
  getEarliestObservationDate,
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
import * as rollupsWorkerModule from "../workers/player-rollups";
import { applyMigrations } from "../src/lib/migrations";

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

  // G1: raw successful player observations remain queryable for seven days
  test("raw retention", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    await db
      .prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Counter-Strike', 'counter-strike')")
      .run();

    // Keep observations inside the seven-day window and at its inclusive boundary.
    const t6d = new Date(anchor.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const t7d = new Date(anchor.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const t8d = new Date(anchor.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const t10d = new Date(anchor.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 100, ?)").bind(t6d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 200, ?)").bind(t7d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 300, ?)").bind(t8d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 400, ?)").bind(t10d).run();

    const beforeCount = await db.prepare("SELECT COUNT(*) as count FROM observations").first<number>("count");
    expect(beforeCount).toBe(4);

    const cleaned = await cleanExpiredRawObservations(db, anchor);
    expect(cleaned).toBe(2);

    const remaining = await db.prepare("SELECT current_players, observed_at FROM observations ORDER BY observed_at ASC").all<{ current_players: number; observed_at: string }>();
    expect(remaining.results.length).toBe(2);
    expect(remaining.results[0].current_players).toBe(200); // exactly seven days old
    expect(remaining.results[1].current_players).toBe(100); // six days old

    console.log("raw retention");
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

    const tracedQueries: string[] = [];
    const tracedDb: AppDatabase = {
      prepare(query) {
        tracedQueries.push(query);
        return db.prepare(query);
      },
      batch(statements) {
        return db.batch(statements);
      },
      exec(query) {
        return db.exec(query);
      },
    };
    const bounded = await computeDailyRollups(tracedDb, { anchorTime: anchor });
    expect(bounded.records.map((record) => record.date)).toEqual(["2026-09-03"]);
    expect(tracedQueries.some((query) => query.includes("observed_at >= ? AND observed_at < ?"))).toBe(true);
    expect(tracedQueries.some((query) => query.includes("substr(observed_at"))).toBe(false);
    expect(tracedQueries.some((query) => query.includes("FROM player_rollups") && query.includes("WHERE date = ?"))).toBe(true);

    const todayRollup = await db.prepare("SELECT * FROM player_rollups WHERE date = '2026-09-04'").first();
    expect(todayRollup).toBeNull(); // Current partial day is not rolled up

    // Test worker coordinator helper (runs rollups before raw cleanup)
    const jobRes = await runDailyRollupJob(db, {
      anchorTime: anchor,
      retentionDays: 90,
      snapshot: async () => "test-snapshot.sqlite",
    });
    expect(jobRes.rolledUpCount).toBe(1);
    console.log("daily rollup continuity");
  });

  // G3: player ranges enforce boundaries and All begins at first observation
  test("player history ranges", async () => {
    const db = await createFreshDb();
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Game 10', 'game-10')").run();

    // First successful observation: 2025-01-01 (All begins here)
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, '2025-01-01', 50, 100, 75, 90, 10)").run();

    // Points inside various ranges:
    // 2 hours ago (inside 24h, 7d, 30d, 90d)
    const t2h = new Date(anchor.getTime() - 2 * 60 * 60 * 1000).toISOString();
    // 3 days ago (inside 7d, 30d, 90d; outside 24h)
    const t3d = new Date(anchor.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    // 15 days ago (inside 30d, 90d; outside 7d)
    const t15d = new Date(anchor.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
    // 45 days ago (inside 90d; outside 30d)
    const t45d = new Date(anchor.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 1000, ?)").bind(t2h).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 800, ?)").bind(t3d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 600, ?)").bind(t15d).run();
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 400, ?)").bind(t45d).run();
    const t15dDate = t15d.substring(0, 10);
    const t45dDate = t45d.substring(0, 10);
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, ?, 600, 600, 600, 600, 1)").bind(t15dDate).run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, ?, 400, 400, 400, 400, 1)").bind(t45dDate).run();

    // 24h range: only 2h observation
    const res24h = await getPlayerHistory(db, 10, "24h", anchor);
    expect(res24h.range).toBe("24h");
    expect(res24h.range_start).toBe(new Date(anchor.getTime() - 24 * 60 * 60 * 1000).toISOString());
    expect(res24h.range_end).toBe(anchor.toISOString());
    expect(res24h.points.filter((p) => !p.is_gap).length).toBe(1);
    expect(res24h.points.find((p) => !p.is_gap)?.players).toBe(1000);

    // 7d range: 2h and 3d
    const res7d = await getPlayerHistory(db, 10, "7d", anchor);
    expect(res7d.range).toBe("7d");
    expect(res7d.range_start).toBe(new Date(anchor.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
    expect(res7d.range_end).toBe(anchor.toISOString());
    expect(res7d.points.filter((p) => !p.is_gap).length).toBe(2);

    // 30d range (default): 2h, 3d, 15d
    const res30d = await getPlayerHistory(db, 10, "30d", anchor);
    expect(res30d.range).toBe("30d");
    expect(res30d.range_start).toBe(new Date(anchor.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
    expect(res30d.range_end).toBe(anchor.toISOString());
    expect(res30d.points.filter((p) => !p.is_gap).length).toBe(3);

    // Default range when omitted or invalid
    const resDefault = await getPlayerHistory(db, 10, "invalid_range_string", anchor);
    expect(resDefault.range).toBe("30d");

    // 90d range: 2h, 3d, 15d, 45d
    const res90d = await getPlayerHistory(db, 10, "90d", anchor);
    expect(res90d.range).toBe("90d");
    expect(res90d.range_start).toBe(new Date(anchor.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString());
    expect(res90d.range_end).toBe(anchor.toISOString());
    expect(res90d.points.filter((p) => !p.is_gap).length).toBe(4);
    const cleanedHistory = await cleanExpiredRawObservations(db, anchor);
    expect(cleanedHistory).toBe(2);
    const retained30d = await getPlayerHistory(db, 10, "30d", anchor);
    const retained90d = await getPlayerHistory(db, 10, "90d", anchor);
    expect(retained30d.points.filter((p) => !p.is_gap).length).toBe(3);
    expect(retained90d.points.filter((p) => !p.is_gap).length).toBe(4);

    // Future observations/rollups after anchorTime must be bounded out
    await db.prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (10, 9999, '2026-09-05T00:00:00.000Z')").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (10, '2026-09-06', 9999, 9999, 9999, 9999, 1)").run();

    // App-scoped earliest observation begins at this game's earliest, not another game's earlier observation
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (99, 'Earlier Game', 'earlier-game')").run();
    await db.prepare("INSERT INTO player_rollups (appid, date, min_players, max_players, avg_players, close_players, sample_count) VALUES (99, '2024-01-01', 1, 2, 1, 2, 1)").run();

    const earliestGlobal = await getEarliestObservationDate(db);
    expect(earliestGlobal).toContain("2024-01-01");
    const earliestGame10 = await getEarliestObservationDate(db, 10);
    expect(earliestGame10).toContain("2025-01-01"); // Game 10's own earliest
    expect(earliestGame10).not.toContain("2024-01-01");

    // All range starts at this game's first record and ends at its latest record.
    const resAll = await getPlayerHistory(db, 10, "all", anchor);
    expect(resAll.range).toBe("all");
    expect(resAll.earliest_observation).toContain("2025-01-01");
    expect(resAll.range_start).toBe("2025-01-01T00:00:00.000Z");
    expect(resAll.points.some((p) => p.is_rollup)).toBe(true);
    // Future observation after anchorTime is bounded out
    expect(resAll.points.some((p) => p.players === 9999)).toBe(false);
    // source_timestamp and the All-domain end reflect the latest real record.
    expect(resAll.source_timestamp).toBe(t2h);
    expect(resAll.range_end).toBe(t2h);
    console.log("player history ranges");
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

  // G8: no momentum score, duplicate Most Played block, or trending route exists
  test("forbidden ranking surfaces", async () => {
    // 1. Confirm /rankings/trending route file does NOT exist
    const forbiddenRoute = resolve(import.meta.dir, "../src/routes/rankings.trending.tsx");
    expect(existsSync(forbiddenRoute)).toBe(false);

    // 2. Confirm no momentum score or velocity is exported or calculated
    const phModule = playerHistoryModule;
    expect((phModule as Record<string, unknown>).calculateMomentum).toBeUndefined();
    expect((phModule as Record<string, unknown>).getMomentumRankings).toBeUndefined();

    // 3. Confirm trending has no minimum-player floor
    const db = await createFreshDb();
    const now = new Date("2026-09-04T12:00:00.000Z");
    await db.prepare("INSERT INTO apps (appid, name, slug) VALUES (999, 'Small Indie', 'small-indie')").run();
    await db.prepare("INSERT INTO tracked_games (appid, latest_players, last_successful_at, next_due_at) VALUES (999, 1, ?, '2026-09-04T13:00:00Z')").bind(now.toISOString()).run();

    const lowCountTrending = await getTrendingGames(db, { now });
    // 1 player is eligible, not filtered out by an arbitrary floor like 100 players
    expect(lowCountTrending.some((g) => g.appid === 999 && g.current_players === 1)).toBe(true);

    // 4. Confirm workers/player-rollups does not export an unauthenticated worker fetch surface
    expect((rollupsWorkerModule as Record<string, unknown>).default).toBeUndefined();

    console.log("forbidden ranking surfaces");
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
      data: { appid: number; range_start: string; range_end: string };
      source_timestamp: string;
    };
    expect(histJson.status).toBe("data");
    expect(histJson.data.appid).toBe(10);
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
