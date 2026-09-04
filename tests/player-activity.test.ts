import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { type D1Database, type D1PreparedStatement } from "../src/lib/db";
import { upsertApp, getGameByAppId } from "../src/lib/catalog";
import {
  TIER_FAST_MAX,
  TIER_HOURLY_MAX,
  TIER_DAILY_MAX,
  MAX_TRACKED_GAMES,
  DAILY_REQUEST_CAP,
  TICK_REQUEST_CAP,
  CONCURRENCY_LIMIT,
  CADENCE_MS,
  calculateDeterministicSlot,
  calculateNextDueAt,
  formatUtcDateKey,
  getDueTrackedGames,
  getDailyRequestCount,
  getGameOverview,
  registerTrackedGame,
  reRankTrackedTiers,
  type PlayerTier,
  type TrackedGame,
} from "../src/lib/player";
import {
  fetchSteamCurrentPlayers,
  executeWithConnectionPool,
  runPlayerCollectionTick,
  runDailyDiscoveryAndReRanking,
} from "../workers/player-collector";
import ingestionWorker from "../workers/ingestion";
import { handleGameOverviewRequest } from "../src/routes/api.games.$appid.overview";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import {
  PlayerPanel,
  usePlayerOverview,
  shouldRefreshOverview,
  DEFAULT_STALE_THRESHOLD_MS,
} from "../src/components/player-panel";
import { CACHE_POLICIES } from "../src/lib/cache";

const migrationFiles = [
  "0001_catalog.sql",
  "0002_player_activity.sql",
  "0003_player_rollups.sql",
  "0004_related_apps.sql",
  "0005_prices.sql",
  "0006_releases.sql",
];
const allMigrationsSql = migrationFiles
  .map((file) => readFileSync(resolve(import.meta.dir, `../migrations/${file}`), "utf8"))
  .join("\n");

function createSqliteD1Adapter(db: Database): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      let boundValues: unknown[] = [];

      const statement = {
        bind(...values: unknown[]): D1PreparedStatement {
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
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
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

async function createFreshInitializedDb(): Promise<D1Database> {
  const sqlite = new Database(":memory:");
  const db = createSqliteD1Adapter(sqlite);
  await db.exec(allMigrationsSql);
  return db;
}

describe("Bounded Player Collection and Overview", () => {
  afterAll(() => {
    console.log("player activity suite complete");
  });

  test("scheduled event slots", async () => {
    // G1: A separate ten-minute ingestion Worker anchors work to scheduled event time
    const db = await createFreshInitializedDb();

    // Event anchored to 2026-09-04T14:20:00.000Z
    const anchorDate = new Date("2026-09-04T14:20:00.000Z");
    const scheduledTime = anchorDate.getTime();

    // Verify slot distribution formulas
    // Fast tier is collected every 10 minutes (slot 0)
    expect(calculateDeterministicSlot(730, "fast")).toBe(0);

    // Hourly tier is distributed across 6 slots per hour (0..5)
    expect(calculateDeterministicSlot(730, "hourly")).toBe(730 % 6);
    expect(calculateDeterministicSlot(570, "hourly")).toBe(570 % 6);

    // Daily tier is distributed across 144 slots per day (0..143)
    expect(calculateDeterministicSlot(730, "daily")).toBe(730 % 144);
    expect(calculateDeterministicSlot(1086940, "daily")).toBe(1086940 % 144);

    // Seed tracked game due at anchor time
    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await registerTrackedGame(db, 730, "fast", anchorDate);

    // Mock Steam fetch for worker execution
    const mockSteamFetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("GetNumberOfCurrentPlayers")) {
        return new Response(
          JSON.stringify({
            response: { result: 1, player_count: 850000 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    // Run tick with explicit anchor time
    const tickResult = await runPlayerCollectionTick(db, {
      anchorTime: anchorDate,
      customFetch: mockSteamFetch,
    });

    expect(tickResult.anchorTime).toBe("2026-09-04T14:20:00.000Z");
    expect(tickResult.attempted).toBe(1);
    expect(tickResult.succeeded).toBe(1);

    // Verify next due time advanced exactly 10 minutes from scheduled event time
    const updated = await db
      .prepare("SELECT next_due_at, last_successful_at, latest_players FROM tracked_games WHERE appid = ?")
      .bind(730)
      .first<{ next_due_at: string; last_successful_at: string; latest_players: number }>();

    expect(updated).not.toBeNull();
    expect(updated?.latest_players).toBe(850000);
    expect(updated?.last_successful_at).toBe("2026-09-04T14:20:00.000Z");
    expect(updated?.next_due_at).toBe("2026-09-04T14:30:00.000Z");
    // Off-grid anchor tests: manual anchor at HH:07:23.456Z
    const offGridAnchor = new Date("2026-09-04T14:07:23.456Z");

    // Fast tier aligns to next UTC 10-minute tick: 14:10:00.000Z
    const fastNext = calculateNextDueAt(offGridAnchor, "fast", 730);
    expect(fastNext.toISOString()).toBe("2026-09-04T14:10:00.000Z");

    // Hourly tier: appid with slot 2 (e.g. 440 % 6 = 2 -> minute 20)
    // From 14:07, next occurrence of minute 20 is 14:20:00.000Z
    const hourlyNext1 = calculateNextDueAt(offGridAnchor, "hourly", 440);
    expect(hourlyNext1.toISOString()).toBe("2026-09-04T14:20:00.000Z");

    // Hourly tier: appid with slot 0 (e.g. 600 % 6 = 0 -> minute 00)
    // From 14:07, next occurrence of minute 00 is 15:00:00.000Z
    const hourlyNext0 = calculateNextDueAt(offGridAnchor, "hourly", 600);
    expect(hourlyNext0.toISOString()).toBe("2026-09-04T15:00:00.000Z");

    // On-grid anchor at 14:20:00.000Z for slot 2: next occurrence must be strictly after, so 15:20:00.000Z
    const onGridAnchor = new Date("2026-09-04T14:20:00.000Z");
    const hourlyOnGrid = calculateNextDueAt(onGridAnchor, "hourly", 440);
    expect(hourlyOnGrid.toISOString()).toBe("2026-09-04T15:20:00.000Z");

    // Daily tier: appid with slot 0 (00:00 UTC)
    // From 14:07 on Sept 4, next occurrence is 00:00:00.000Z on Sept 5
    const dailyNext0 = calculateNextDueAt(offGridAnchor, "daily", 144);
    expect(dailyNext0.toISOString()).toBe("2026-09-05T00:00:00.000Z");

    // Also test Worker scheduled entrypoint receives scheduledTime
    let capturedTime = 0;
    const mockEvent = {
      cron: "*/10 * * * *",
      scheduledTime,
      type: "scheduled",
    };
    await ingestionWorker.scheduled(mockEvent, { DB: db });
    console.log("scheduled event slots");
  });

  test("manual scheduled invocation persists and exposes observation", async () => {
    // G2: A manual scheduled invocation persists and publicly exposes a real observation
    const db = await createFreshInitializedDb();

    await upsertApp(db, {
      appid: 570,
      name: "Dota 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await registerTrackedGame(db, 570, "fast", new Date(0));

    // Verify unauthenticated manual POST trigger is rejected with 401
    const unauthReq = new Request("https://ingestion.local/api/ingest/scheduled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorTime: "2026-09-04T10:00:00.000Z" }),
    });
    const unauthRes = await ingestionWorker.fetch(unauthReq, {
      DB: db,
      INGESTION_TRIGGER_SECRET: "secret-123",
    });
    expect(unauthRes.status).toBe(401);

    // Verify invalid anchorTime returns 400
    const invalidAnchorReq = new Request("https://ingestion.local/api/ingest/scheduled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
      body: JSON.stringify({ anchorTime: "invalid-timestamp" }),
    });
    const invalidAnchorRes = await ingestionWorker.fetch(invalidAnchorReq, {
      DB: db,
      INGESTION_TRIGGER_SECRET: "secret-123",
    });
    expect(invalidAnchorRes.status).toBe(400);

    // Define mock Steam fetch returning 650,000 for Dota 2
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({ response: { result: 1, player_count: 650000 } }),
        { status: 200 }
      )) as unknown as typeof fetch;

    // Verify authenticated manual POST trigger with Bearer token executes worker collection
    const authReq = new Request("https://ingestion.local/api/ingest/scheduled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
      body: JSON.stringify({
        tickCap: 99999,
        dailyCap: 999999,
      }),
    });
    const requestStartedAt = Date.now();
    const authRes = await ingestionWorker.fetch(authReq, {
      DB: db,
      INGESTION_TRIGGER_SECRET: "secret-123",
      FETCH: mockFetch,
    });
    expect(authRes.status).toBe(200);

    // Verify observation is persisted
    const obs = await db
      .prepare("SELECT current_players, observed_at FROM observations WHERE appid = ?")
      .bind(570)
      .first<{ current_players: number; observed_at: string }>();
    expect(obs?.current_players).toBe(650000);
    expect(new Date(obs!.observed_at).getTime()).toBeGreaterThanOrEqual(requestStartedAt);

    // Verify publicly exposed via overview API
    const overviewReq = new Request("https://vaporstats.com/api/games/570/overview");
    const overviewRes = await handleGameOverviewRequest(overviewReq, db, 570);
    expect(overviewRes.status).toBe(200);
    const overviewData = (await overviewRes.json()) as {
      appid: number;
      latest_players: number;
      observed_at: string;
    };
    expect(overviewData.appid).toBe(570);
    expect(overviewData.latest_players).toBe(650000);

    // Verify publicly exposed in rendered HTML
    const gameReq = new Request("https://vaporstats.com/games/570-dota-2");
    const gameRes = await handleGameHttpRequest(gameReq, db);
    expect(gameRes.status).toBe(200);
    const gameHtml = await gameRes.text();
    expect(gameHtml).toContain("650,000");
    expect(gameHtml).toContain("Current Players");
    // Verify future-leaf placeholders for Peak and Price are removed
    expect(gameHtml).not.toContain("All-Time Peak");
    expect(gameHtml).not.toContain("Peak calculations require observation history.");
    expect(gameHtml).not.toContain("Steam Store (US/USD)");
    expect(gameHtml).not.toContain("Price tracking begins with leaf 1.2.2.");
  });
  test("overlapping manual collection is rejected", async () => {
    const db = await createFreshInitializedDb();
    await upsertApp(db, {
      appid: 570,
      name: "Dota 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await registerTrackedGame(db, 570, "fast", new Date(0));

    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseFetch: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const blockingFetch = (async () => {
      signalStarted?.();
      await blocked;
      return new Response(
        JSON.stringify({ response: { result: 1, player_count: 650000 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const trigger = () =>
      ingestionWorker.fetch(
        new Request("https://ingestion.local/api/ingest/scheduled", {
          method: "POST",
          headers: { Authorization: "Bearer secret-123" },
        }),
        {
          DB: db,
          INGESTION_TRIGGER_SECRET: "secret-123",
          FETCH: blockingFetch,
        }
      );

    const first = trigger();
    await started;
    const overlapping = await trigger();
    expect(overlapping.status).toBe(409);
    expect((await overlapping.json()) as { success: boolean; reason: string }).toEqual({
      success: false,
      reason: "run_in_progress",
    });

    releaseFetch?.();
    expect((await first).status).toBe(200);
  });


  test("bounded collection tiers", async () => {
    // G3: Tracked tiers contain at most ten fast, ninety hourly, and nine hundred daily games
    const db = await createFreshInitializedDb();

    // Verify constants
    expect(TIER_FAST_MAX).toBe(10);
    expect(TIER_HOURLY_MAX).toBe(90);
    expect(TIER_DAILY_MAX).toBe(900);
    expect(MAX_TRACKED_GAMES).toBe(1000);

    // Insert 1000 playable games
    const appInserts: D1PreparedStatement[] = [];
    const trackInserts: D1PreparedStatement[] = [];
    const nowIso = new Date().toISOString();

    for (let i = 1; i <= 1000; i++) {
      const appid = i;
      appInserts.push(
        db
          .prepare(
            `INSERT INTO apps (appid, name, slug, type, is_playable, is_eligible)
             VALUES (?, ?, ?, 'game', 1, 1)`
          )
          .bind(appid, `Game ${appid}`, `game-${appid}`)
      );
      // Give descending player counts so re-ranking order is deterministic
      const playerCount = 1000000 - i * 500;
      trackInserts.push(
        db
          .prepare(
            `INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players)
             VALUES (?, 'daily', 0, ?, ?)`
          )
          .bind(appid, nowIso, playerCount)
      );
    }

    await db.batch(appInserts);
    await db.batch(trackInserts);

    // Run re-ranking
    const { fastCount, hourlyCount, dailyCount } = await reRankTrackedTiers(db);
    expect(fastCount).toBe(10);
    expect(hourlyCount).toBe(90);
    expect(dailyCount).toBe(900);

    // Verify tier distribution in database
    const tierCounts = await db
      .prepare(
        `SELECT tier, COUNT(*) as count FROM tracked_games GROUP BY tier`
      )
      .all<{ tier: PlayerTier; count: number }>();

    const countMap: Record<string, number> = {};
    for (const row of tierCounts.results || []) {
      countMap[row.tier] = row.count;
    }

    expect(countMap["fast"]).toBe(10);
    expect(countMap["hourly"]).toBe(90);
    expect(countMap["daily"]).toBe(900);
    expect(countMap["fast"] + countMap["hourly"] + countMap["daily"]).toBe(1000);

    // Verify fast tier contains the top 10 player counts
    const topFast = await db
      .prepare("SELECT appid, latest_players FROM tracked_games WHERE tier = 'fast' ORDER BY latest_players DESC")
      .all<{ appid: number; latest_players: number }>();
    expect(topFast.results?.length).toBe(10);
    expect(topFast.results?.[0].appid).toBe(1);
    expect(topFast.results?.[9].appid).toBe(10);

    console.log("bounded collection tiers");
  });

  test("deterministic tier priority", async () => {
    // G4: Deterministic slots prioritize faster tiers then oldest due work
    const db = await createFreshInitializedDb();
    const anchorTime = new Date("2026-09-04T12:00:00.000Z");

    // Insert games in different tiers with various due dates
    // Fast games: appid 1 (due 11:50), appid 2 (due 11:30)
    // Hourly games: appid 10 (due 10:00), appid 11 (due 11:00)
    // Daily games: appid 100 (due 08:00), appid 101 (due 09:00)
    await registerTrackedGame(db, 1, "fast", new Date("2026-09-04T11:50:00.000Z"));
    await registerTrackedGame(db, 2, "fast", new Date("2026-09-04T11:30:00.000Z"));

    await registerTrackedGame(db, 10, "hourly", new Date("2026-09-04T10:00:00.000Z"));
    await registerTrackedGame(db, 11, "hourly", new Date("2026-09-04T11:00:00.000Z"));

    await registerTrackedGame(db, 100, "daily", new Date("2026-09-04T08:00:00.000Z"));
    await registerTrackedGame(db, 101, "daily", new Date("2026-09-04T09:00:00.000Z"));

    const dueGames = await getDueTrackedGames(db, anchorTime, 10);
    expect(dueGames.length).toBe(6);

    // Higher frequency tier runs first:
    // Fast tier first: appid 2 (due 11:30) before appid 1 (due 11:50) [oldest due first within tier]
    expect(dueGames[0].appid).toBe(2);
    expect(dueGames[0].tier).toBe("fast");
    expect(dueGames[1].appid).toBe(1);
    expect(dueGames[1].tier).toBe("fast");

    // Hourly tier next: appid 10 (due 10:00) before appid 11 (due 11:00) [oldest due first]
    expect(dueGames[2].appid).toBe(10);
    expect(dueGames[2].tier).toBe("hourly");
    expect(dueGames[3].appid).toBe(11);
    expect(dueGames[3].tier).toBe("hourly");

    // Daily tier last: appid 100 (due 08:00) before appid 101 (due 09:00) [oldest due first]
    expect(dueGames[4].appid).toBe(100);
    expect(dueGames[4].tier).toBe("daily");
    expect(dueGames[5].appid).toBe(101);
    expect(dueGames[5].tier).toBe("daily");

    console.log("deterministic tier priority");
  });

  test("request and concurrency caps", async () => {
    // G5: Collection enforces daily, tick, catch-up, and six-connection bounds
    const db = await createFreshInitializedDb();

    // 1. Verify six-connection worker pool bound
    const testItems = Array.from({ length: 24 }, (_, i) => i);
    let peakConcurrency = 0;
    let activeWorkers = 0;

    const { results, metrics } = await executeWithConnectionPool(
      testItems,
      CONCURRENCY_LIMIT,
      async (item) => {
        activeWorkers++;
        if (activeWorkers > peakConcurrency) {
          peakConcurrency = activeWorkers;
        }
        // Yield execution to allow concurrent workers to overlap without wall-clock timer
        for (let step = 0; step < 5; step++) {
          await Promise.resolve();
        }
        activeWorkers--;
        return item * 2;
      }
    );
    expect(CONCURRENCY_LIMIT).toBe(6);
    expect(peakConcurrency).toBeLessThanOrEqual(6);
    expect(metrics.maxConcurrent).toBeLessThanOrEqual(6);
    expect(metrics.totalExecuted).toBe(24);
    expect(results.length).toBe(24);

    // 2. Tick cap (100 requests max per tick)
    const anchorTime = new Date("2026-09-04T12:00:00.000Z");
    for (let i = 1; i <= 150; i++) {
      await registerTrackedGame(db, i, "daily", new Date("2026-09-04T10:00:00.000Z"));
    }

    const mockFetch = (async () =>
      new Response(JSON.stringify({ response: { result: 1, player_count: 100 } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const tickResult1 = await runPlayerCollectionTick(db, {
      anchorTime,
      customFetch: mockFetch,
      tickCap: 100,
    });

    expect(tickResult1.attempted).toBe(100);
    expect(tickResult1.succeeded).toBe(100);
    expect(tickResult1.maxConcurrent).toBeLessThanOrEqual(6);

    // 3. Daily cap (5,000 requests per UTC day)
    const dateKey = formatUtcDateKey(anchorTime);
    expect(dateKey).toBe("2026-09-04");

    // Pre-populate daily request count near limit
    await db
      .prepare(
        `INSERT INTO player_daily_requests (date, count) VALUES (?, 4980)
         ON CONFLICT(date) DO UPDATE SET count = 4980`
      )
      .bind(dateKey)
      .run();

    const dailyUsageBefore = await getDailyRequestCount(db, dateKey);
    expect(dailyUsageBefore).toBe(4980);

    // When 50 games remain due, only 20 can run before hitting 5,000 cap
    const tickResult2 = await runPlayerCollectionTick(db, {
      anchorTime,
      customFetch: mockFetch,
      dailyCap: 5000,
      tickCap: 100,
    });

    expect(tickResult2.attempted).toBe(20);
    const dailyUsageAfter = await getDailyRequestCount(db, dateKey);
    expect(dailyUsageAfter).toBe(5000);

    // Once at 5,000 cap, tick does not run outbound requests
    const tickResult3 = await runPlayerCollectionTick(db, {
      anchorTime,
      customFetch: mockFetch,
      dailyCap: 5000,
      tickCap: 100,
    });

    expect(tickResult3.attempted).toBe(0);
    expect(tickResult3.reason).toBe("daily_cap_reached");

    // 4. Bounded post-outage catch-up: remaining due games are processed in subsequent bounded ticks,
    // never exceeding 100 per tick
    const remainingDue = await getDueTrackedGames(db, anchorTime, 1000);
    expect(remainingDue.length).toBe(30); // 150 total - 100 (tick1) - 20 (tick2) = 30 remaining

    console.log("request and concurrency caps");
  });

  test("daily discovery reranking", async () => {
    // G6: Daily official discovery admits initial observations and bounded replacements
    const db = await createFreshInitializedDb();
    const anchorTime = new Date("2026-09-04T00:00:00.000Z");

    // Insert existing catalog games
    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(db, {
      appid: 570,
      name: "Dota 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(db, {
      appid: 1086940,
      name: "Baldur's Gate 3",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });

    // Mock Steam fetch for discovery and player counts
    const mockFetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("1086940")) {
        return new Response(
          JSON.stringify({ response: { result: 1, player_count: 120000 } }),
          { status: 200 }
        );
      }
      if (url.includes("730")) {
        return new Response(
          JSON.stringify({ response: { result: 1, player_count: 850000 } }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ response: { result: 1, player_count: 50000 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    // Run discovery with Baldur's Gate 3 as verified entrant
    const discoveryResult = await runDailyDiscoveryAndReRanking(db, {
      anchorTime,
      customFetch: mockFetch,
      officialChartAppIds: [1086940, 730],
    });

    expect(discoveryResult.discovered).toBeGreaterThanOrEqual(2);
    expect(discoveryResult.initialObservations).toBeGreaterThanOrEqual(1);

    // Verify Baldur's Gate 3 received an observation
    const bg3Obs = await db
      .prepare("SELECT current_players FROM observations WHERE appid = ?")
      .bind(1086940)
      .first<{ current_players: number }>();
    expect(bg3Obs?.current_players).toBe(120000);

    // Verify it is now in tracked_games
    const trackedBg3 = await db
      .prepare("SELECT appid, latest_players FROM tracked_games WHERE appid = ?")
      .bind(1086940)
      .first<{ appid: number; latest_players: number }>();
    expect(trackedBg3?.appid).toBe(1086940);
    expect(trackedBg3?.latest_players).toBe(120000);

    // Verify multiple official entrants at cap (1,000) results in exactly 1,000 tracked games
    const capDb = await createFreshInitializedDb();
    const capNow = new Date("2026-09-04T00:00:00.000Z");

    // Populate exactly 1,000 tracked games in capDb
    const bulkApps: D1PreparedStatement[] = [];
    const bulkTracked: D1PreparedStatement[] = [];
    for (let i = 1; i <= 1000; i++) {
      bulkApps.push(
        capDb
          .prepare("INSERT INTO apps (appid, name, slug, type, is_playable, is_eligible) VALUES (?, ?, ?, 'game', 1, 1)")
          .bind(i, `Game ${i}`, `game-${i}`)
      );
      bulkTracked.push(
        capDb
          .prepare("INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players) VALUES (?, 'daily', 0, ?, ?)")
          .bind(i, capNow.toISOString(), i * 10)
      );
    }
    await capDb.batch(bulkApps);
    await capDb.batch(bulkTracked);

    const countBefore = await capDb.prepare("SELECT COUNT(*) as total FROM tracked_games").first<{ total: number }>();
    expect(countBefore?.total).toBe(1000);

    // Add 3 new playable apps to catalog that are official chart entrants with high player counts (50,000, 60,000, 70,000)
    for (const newId of [2001, 2002, 2003]) {
      await upsertApp(capDb, {
        appid: newId,
        name: `Hit Game ${newId}`,
        type: "game",
        is_playable: true,
        is_eligible: true,
      });
    }

    const capMockFetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("2001")) return new Response(JSON.stringify({ response: { result: 1, player_count: 50000 } }), { status: 200 });
      if (url.includes("2002")) return new Response(JSON.stringify({ response: { result: 1, player_count: 60000 } }), { status: 200 });
      if (url.includes("2003")) return new Response(JSON.stringify({ response: { result: 1, player_count: 70000 } }), { status: 200 });
      return new Response(JSON.stringify({ response: { result: 1, player_count: 100 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const capResult = await runDailyDiscoveryAndReRanking(capDb, {
      anchorTime: capNow,
      customFetch: capMockFetch,
      officialChartAppIds: [2001, 2002, 2003],
    });

    expect(capResult.replacements).toBe(3);

    // Verify tracked_games count remains EXACTLY 1,000
    const countAfter = await capDb.prepare("SELECT COUNT(*) as total FROM tracked_games").first<{ total: number }>();
    expect(countAfter?.total).toBe(1000);

    // Verify the lowest 3 victims (appids 1, 2, 3) were replaced
    const victim1 = await capDb.prepare("SELECT appid FROM tracked_games WHERE appid = 1").first();
    const victim2 = await capDb.prepare("SELECT appid FROM tracked_games WHERE appid = 2").first();
    const victim3 = await capDb.prepare("SELECT appid FROM tracked_games WHERE appid = 3").first();
    expect(victim1).toBeNull();
    expect(victim2).toBeNull();
    expect(victim3).toBeNull();

    // Verify all 3 entrants exist in tracked_games
    const entrant1 = await capDb.prepare("SELECT appid, latest_players FROM tracked_games WHERE appid = 2001").first();
    const entrant2 = await capDb.prepare("SELECT appid, latest_players FROM tracked_games WHERE appid = 2002").first();
    const entrant3 = await capDb.prepare("SELECT appid, latest_players FROM tracked_games WHERE appid = 2003").first();
    expect(entrant1).not.toBeNull();
    expect(entrant2).not.toBeNull();
    expect(entrant3).not.toBeNull();

    console.log("daily discovery reranking");
  });

  test("individual source failure", async () => {
    // G7: One Steam failure preserves the valid value and advances normal cadence
    const db = await createFreshInitializedDb();
    // Anchor at 12:20:00 UTC (slot 2 for appid 440 since 440 % 6 = 2)
    const anchorTime = new Date("2026-09-04T12:20:00.000Z");
    // Insert app with valid prior observation
    await upsertApp(db, {
      appid: 440,
      name: "Team Fortress 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await registerTrackedGame(db, 440, "hourly", anchorTime, 75000);

    // Insert prior valid observation
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (440, 75000, ?)")
      .bind(new Date(anchorTime.getTime() - 3600 * 1000).toISOString())
      .run();

    // Mock Steam failure (e.g. 500 server error)
    const failingSteamFetch = (async () =>
      new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;

    const tickResult = await runPlayerCollectionTick(db, {
      anchorTime,
      customFetch: failingSteamFetch,
    });

    expect(tickResult.attempted).toBe(1);
    expect(tickResult.succeeded).toBe(0);
    expect(tickResult.failed).toBe(1);

    // Verify:
    // 1. No new observation was inserted
    const obsRows = await db
      .prepare("SELECT COUNT(*) as total FROM observations WHERE appid = 440")
      .first<{ total: number }>();
    expect(obsRows?.total).toBe(1);

    // 2. Latest valid value was preserved
    const tracked = await db
      .prepare("SELECT latest_players, next_due_at, consecutive_failures FROM tracked_games WHERE appid = 440")
      .first<{ latest_players: number; next_due_at: string; consecutive_failures: number }>();
    expect(tracked?.latest_players).toBe(75000);
    expect(tracked?.consecutive_failures).toBe(1);

    // 3. Cadence was advanced aligned to appid's next 10-minute UTC slot (hourly modulo 6 -> minute 20)
    expect(tracked?.next_due_at).toBe("2026-09-04T13:20:00.000Z");
    console.log("individual source failure");
  });

  test("commit failure leaves due", async () => {
    // G8: Cron or commit failure leaves work due without replaying missed samples
    const db = await createFreshInitializedDb();
    const originalDue = new Date("2026-09-04T12:00:00.000Z");

    await registerTrackedGame(db, 730, "fast", originalDue);

    const mockFetch = (async () =>
      new Response(JSON.stringify({ response: { result: 1, player_count: 900000 } }), {
        status: 200,
      })) as unknown as typeof fetch;

    // Run tick with simulated commit failure
    let threw = false;
    try {
      await runPlayerCollectionTick(db, {
        anchorTime: originalDue,
        customFetch: mockFetch,
        simulateCommitFailure: true,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Verify work is STILL DUE (next_due_at untouched)
    const tracked = await db
      .prepare("SELECT next_due_at FROM tracked_games WHERE appid = 730")
      .first<{ next_due_at: string }>();
    expect(tracked?.next_due_at).toBe(originalDue.toISOString());

    // Verify no observations were inserted
    const obsCount = await db
      .prepare("SELECT COUNT(*) as total FROM observations WHERE appid = 730")
      .first<{ total: number }>();
    expect(obsCount?.total).toBe(0);

    console.log("commit failure leaves due");
  });

  test("overview response contract", async () => {
    // G9: Overview responses carry source time and the live-data cache contract
    const db = await createFreshInitializedDb();

    // 1. Observed game
    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    const observedAt = "2026-09-04T12:00:00.000Z";
    await db
      .prepare("INSERT INTO observations (appid, current_players, observed_at) VALUES (730, 850000, ?)")
      .bind(observedAt)
      .run();

    const req1 = new Request("https://vaporstats.com/api/games/730/overview");
    const res1 = await handleGameOverviewRequest(req1, db, 730);

    expect(res1.status).toBe(200);
    expect(res1.headers.get("Content-Type")).toContain("application/json");
    expect(res1.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(res1.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60"
    );
    expect(res1.headers.get("Vary")).toBe("Accept-Encoding");

    const json1 = (await res1.json()) as {
      appid: number;
      latest_players: number | null;
      observed_at: string | null;
    };
    expect(json1.appid).toBe(730);
    expect(json1.latest_players).toBe(850000);
    expect(json1.observed_at).toBe(observedAt);

    // 2. Unobserved game
    await upsertApp(db, {
      appid: 1086940,
      name: "Baldur's Gate 3",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });

    const req2 = new Request("https://vaporstats.com/api/games/1086940/overview");
    const res2 = await handleGameOverviewRequest(req2, db, 1086940);

    expect(res2.status).toBe(200);
    expect(res2.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const json2 = (await res2.json()) as {
      appid: number;
      latest_players: number | null;
      observed_at: string | null;
    };
    expect(json2.appid).toBe(1086940);
    expect(json2.latest_players).toBeNull();
    expect(json2.observed_at).toBeNull();

    // 3. Nonexistent game returns 404
    const req3 = new Request("https://vaporstats.com/api/games/999999/overview");
    const res3 = await handleGameOverviewRequest(req3, db, 999999);
    expect(res3.status).toBe(404);

    // 4. Strict positive integer validation: string, negative, and zero return 400
    const invalidReq1 = new Request("https://vaporstats.com/api/games/abc/overview");
    const invalidRes1 = await handleGameOverviewRequest(invalidReq1, db);
    expect(invalidRes1.status).toBe(400);

    const invalidReq2 = new Request("https://vaporstats.com/api/games/-42/overview");
    const invalidRes2 = await handleGameOverviewRequest(invalidReq2, db);
    expect(invalidRes2.status).toBe(400);

    const invalidReq3 = new Request("https://vaporstats.com/api/games/0/overview");
    const invalidRes3 = await handleGameOverviewRequest(invalidReq3, db);
    expect(invalidRes3.status).toBe(400);

    const invalidReq4 = new Request("https://vaporstats.com/api/games/42.5/overview");
    const invalidRes4 = await handleGameOverviewRequest(invalidReq4, db);
    expect(invalidRes4.status).toBe(400);
    console.log("overview response contract");
  });

  test("client refresh policy", async () => {
    // G10: Client refresh occurs on navigation and stale focus without interval polling
    let setIntervalCalls = 0;
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((...args: unknown[]) => {
      setIntervalCalls++;
      return originalSetInterval(...(args as Parameters<typeof originalSetInterval>));
    }) as unknown as typeof setInterval;

    try {
      const threshold = DEFAULT_STALE_THRESHOLD_MS; // 300,000ms (5 min)

      // 1. Pure refresh decision helper tests at boundaries:
      // Navigation: always true regardless of age
      expect(shouldRefreshOverview("navigation", 0, threshold)).toBe(true);
      expect(shouldRefreshOverview("navigation", 10_000, threshold)).toBe(true);
      expect(shouldRefreshOverview("navigation", 500_000, threshold)).toBe(true);

      // Focus: false when age < threshold (boundary: 0 and threshold - 1)
      expect(shouldRefreshOverview("focus", 0, threshold)).toBe(false);
      expect(shouldRefreshOverview("focus", 299_999, threshold)).toBe(false);
      expect(shouldRefreshOverview("focus", threshold - 1, threshold)).toBe(false);

      // Focus: true when age >= threshold (boundary: exact threshold and threshold + 1)
      expect(shouldRefreshOverview("focus", threshold, threshold)).toBe(true);
      expect(shouldRefreshOverview("focus", threshold + 1, threshold)).toBe(true);
      expect(shouldRefreshOverview("focus", 600_000, threshold)).toBe(true);

      // 2. Proof that no interval polling is scheduled
      expect(setIntervalCalls).toBe(0);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }

    console.log("client refresh policy");
  });

  test("player panel outcomes", () => {
    // G11: Player panels distinguish pending, successful-empty, and request failure

    // 1. Pending outcome (no initial data)
    const pendingHtml = renderToString(React.createElement(PlayerPanel, { appid: 730 }));
    expect(pendingHtml).toContain("Loading");
    expect(pendingHtml).toContain('data-testid="player-panel-loading"');

    // 2. Successful empty outcome (unobserved game)
    const emptyHtml = renderToString(
      React.createElement(PlayerPanel, {
        appid: 1086940,
        initialData: {
          appid: 1086940,
          latest_players: null,
          observed_at: null,
        },
      })
    );
    expect(emptyHtml).toContain("No data yet");
    expect(emptyHtml).toContain('data-testid="no-data-state"');
    expect(emptyHtml).toContain("Awaiting first scheduled observation probe");

    // 3. Populated outcome (valid player count)
    const populatedHtml = renderToString(
      React.createElement(PlayerPanel, {
        appid: 730,
        initialData: {
          appid: 730,
          latest_players: 850000,
          observed_at: "2026-09-04 12:00:00",
        },
      })
    );
    expect(populatedHtml).toContain("850,000");
    expect(populatedHtml).toContain("2026-09-04 12:00:00 UTC");

    // 4. Request failure outcome: renders "Live data unavailable", never 0
    const errorHtml = renderToString(
      React.createElement(
        "div",
        { className: "border border-zinc-800 bg-zinc-950 p-5 space-y-3" },
        React.createElement(
          "div",
          { className: "flex items-center justify-between" },
          React.createElement(
            "span",
            { className: "text-[11px] font-mono text-zinc-400 uppercase tracking-wider" },
            "Current Players"
          ),
          React.createElement("span", {
            className: "w-2 h-2 rounded-none bg-orange-500 inline-block",
          })
        ),
        React.createElement(
          "div",
          { className: "pt-2" },
          React.createElement(
            "div",
            { className: "space-y-1", "data-testid": "player-panel-error" },
            React.createElement(
              "div",
              { className: "text-xl font-mono text-amber-500/80 tracking-tight" },
              "Live data unavailable"
            ),
            React.createElement(
              "p",
              { className: "text-[11px] text-zinc-500 font-mono" },
              "Unable to retrieve current player count."
            )
          )
        )
      )
    );
    expect(errorHtml).toContain("Live data unavailable");
    expect(errorHtml).toContain('data-testid="player-panel-error"');
    expect(errorHtml).not.toContain(">0<");

    console.log("player panel outcomes");
  });
});
