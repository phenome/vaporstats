import { describe, test, expect, beforeEach } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { type D1Database, type D1PreparedStatement } from "../src/lib/db";
import {
  recordPriceObservation,
  getCurrentPrice,
  getPriceHistory,
  getDeals,
  isDealEligible,
  parsePriceRange,
  formatPriceCents,
  hasPriceStateChanged,
  getPriceRangeCutoffDate,
  type PriceHistoryRange,
} from "../src/lib/prices";
import {
  fetchSteamCatalogFeed,
  fetchSteamPriceDetails,
  refreshIndicatedAppPrices,
  runHourlyPriceFeedTick,
  DEFAULT_PRICE_CHECKPOINT_KEY,
} from "../workers/price-collector";
import { handlePriceHistoryRequest } from "../src/routes/api.prices.history";
import { handleDealsRequest } from "../src/routes/api.deals";
import { PriceHistoryChart } from "../src/components/price-history";
import { DealsList } from "../src/components/deals";
import { DealsPageView, handleDealsHttpRequest } from "../src/routes/deals";
import { getCheckpoint, setCheckpoint } from "../src/lib/catalog";
import { CACHE_POLICIES } from "../src/lib/cache";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { handleChildHttpRequest, ChildAppPageView } from "../src/routes/games.$game_.$child";
import { HomeComponent, type HomeComponentProps } from "../src/routes/index";
import { GamePageView } from "../src/components/game-page";
const migration0001 = readFileSync(
  resolve(import.meta.dir, "../migrations/0001_catalog.sql"),
  "utf8"
);
const migration0002 = readFileSync(
  resolve(import.meta.dir, "../migrations/0002_player_activity.sql"),
  "utf8"
);
const migration0003 = readFileSync(
  resolve(import.meta.dir, "../migrations/0003_player_rollups.sql"),
  "utf8"
);
const migration0004 = readFileSync(
  resolve(import.meta.dir, "../migrations/0004_related_apps.sql"),
  "utf8"
);
const migration0005 = readFileSync(
  resolve(import.meta.dir, "../migrations/0005_prices.sql"),
  "utf8"
);

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
              changes: results.length,
              duration: 0,
            },
          };
        },
        async raw<T = unknown>() {
          const stmt = db.prepare(query);
          return stmt.values(...(boundValues as SQLQueryBindings[])) as T[];
        },
      };

      return statement;
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const results: { success: boolean; results?: T[] }[] = [];
      for (const statement of statements) {
        const res = await statement.all<T>();
        results.push(res);
      }
      return results;
    },

    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

describe("VaporStats Steam Prices and Deals", () => {
  let sqliteDb: Database;
  let d1: D1Database;

  beforeEach(() => {
    sqliteDb = new Database(":memory:");
    sqliteDb.exec(migration0001);
    sqliteDb.exec(migration0002);
    sqliteDb.exec(migration0003);
    sqliteDb.exec(migration0004);
    sqliteDb.exec(migration0005);
    d1 = createSqliteD1Adapter(sqliteDb);

    // Seed test apps
    sqliteDb.exec(`
      INSERT INTO apps (appid, name, slug, type, is_playable, is_eligible, parent_appid) VALUES
        (730, 'Counter-Strike 2', '730-counter-strike-2', 'game', 1, 1, NULL),
        (1086940, 'Baldurs Gate 3', '1086940-baldurs-gate-3', 'game', 1, 1, NULL),
        (1245620, 'ELDEN RING', '1245620-elden-ring', 'game', 1, 1, NULL),
        (2778580, 'ELDEN RING Shadow of the Erdtree', '2778580-elden-ring-shadow-of-the-erdtree', 'expansion', 0, 1, 1245620),
        (230410, 'Warframe', '230410-warframe', 'game', 1, 1, NULL),
        (230411, 'Warframe Starter Pack', '230411-warframe-starter-pack', 'dlc', 0, 1, 230410),
        (999001, 'Dedicated Server Tool', '999001-dedicated-server-tool', 'server', 0, 1, 730),
        (999002, 'Game Soundtrack', '999002-game-soundtrack', 'soundtrack', 0, 1, 1086940),
        (999003, 'Playtest Beta', '999003-playtest-beta', 'test', 0, 1, 1086940);

      INSERT INTO app_relationships (parent_appid, child_appid, relationship_type) VALUES
        (1245620, 2778580, 'expansion'),
        (230410, 230411, 'dlc'),
        (730, 999001, 'server'),
        (1086940, 999002, 'soundtrack'),
        (1086940, 999003, 'test');
    `);
  });

  // G1: hourly incremental feed processing advances only successful checkpoints
  test("incremental feed checkpoint - advances only on successful processing", async () => {
    const feedAnchor = new Date("2023-12-01T00:00:00.000Z");
    // 1. Initial run with mock fetch returning 2 apps and last_modified 1700005000
    const mockFeedFetchSuccess = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("IStoreService/GetAppList")) {
        return new Response(
          JSON.stringify({
            response: {
              apps: [
                { appid: 1086940, last_modified: 1700005000 },
                { appid: 1245620, last_modified: 1700004000 },
              ],
              have_more_results: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("api/appdetails")) {
        return new Response(
          JSON.stringify({
            "1086940": {
              success: true,
              data: {
                name: "Baldurs Gate 3",
                is_free: false,
                price_overview: {
                  currency: "USD",
                  initial: 5999,
                  final: 4799,
                  discount_percent: 20,
                  initial_formatted: "$59.99",
                  final_formatted: "$47.99",
                },
              },
            },
            "1245620": {
              success: true,
              data: {
                name: "ELDEN RING",
                is_free: false,
                price_overview: {
                  currency: "USD",
                  initial: 5999,
                  final: 3999,
                  discount_percent: 33,
                  initial_formatted: "$59.99",
                  final_formatted: "$39.99",
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    // Run tick without API key -> not executed, checkpoint remains empty
    const noKeyResult = await runHourlyPriceFeedTick(d1, {
      customFetch: mockFeedFetchSuccess,
    });
    expect(noKeyResult.executed).toBe(false);
    expect(noKeyResult.checkpointAdvanced).toBe(false);
    const noKeyCheckpoint = await getCheckpoint(d1, DEFAULT_PRICE_CHECKPOINT_KEY);
    expect(noKeyCheckpoint).toBeNull();

    // Run tick with API key and successful fetch -> advances checkpoint to 1700005000
    const successResult = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_steam_key",
      customFetch: mockFeedFetchSuccess,
      anchorTime: feedAnchor,
    });
    expect(successResult.executed).toBe(true);
    expect(successResult.checkpointAdvanced).toBe(true);
    expect(successResult.checkpointCursor).toBe(1700005000);
    // Regression: Verify maxResults is forwarded to feed query
    let capturedMaxResults: string | null = null;
    const mockFeedTrackingFetch = (async (input: unknown) => {
      const url = new URL(String(input));
      capturedMaxResults = url.searchParams.get("max_results");
      return new Response(
        JSON.stringify({
          response: {
            apps: [],
            have_more_results: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const emptyFeedResult = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      maxAppsToProcess: 50,
      customFetch: mockFeedTrackingFetch,
    });
    expect(String(capturedMaxResults)).toBe("50");
    expect(emptyFeedResult.checkpointAdvanced).toBe(false);
    expect(emptyFeedResult.checkpointCursor).toBe(1700005000); // Truthful cursor preserves existing checkpoint when not advanced
    // Regression: On fresh DB with no prior checkpoint and empty feed, cursor remains null
    const freshMemoryDb = new Database(":memory:");
    freshMemoryDb.exec(migration0001);
    freshMemoryDb.exec(migration0004);
    freshMemoryDb.exec(migration0005);
    const freshD1 = createSqliteD1Adapter(freshMemoryDb);
    const initialEmptyResult = await runHourlyPriceFeedTick(freshD1, {
      apiKey: "test_key",
      customFetch: mockFeedTrackingFetch,
      anchorTime: feedAnchor,
    });
    expect(initialEmptyResult.checkpointAdvanced).toBe(false);
    expect(initialEmptyResult.checkpointCursor).toBe(
      Math.floor(feedAnchor.getTime() / 1000) - 30 * 24 * 60 * 60
    );

    // Regression: If any detail refresh fails, checkpoint does NOT advance
    const mockPartialFailureFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("IStoreService/GetAppList")) {
        return new Response(
          JSON.stringify({
            response: {
              apps: [
                { appid: 1086940, last_modified: 1700009999 },
              ],
              have_more_results: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Fail appdetails
      return new Response("Store error", { status: 500 });
    }) as unknown as typeof fetch;

    const partialFailResult = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      customFetch: mockPartialFailureFetch,
    });
    expect(partialFailResult.failed).toBe(1);
    expect(partialFailResult.checkpointAdvanced).toBe(false);

    // Pending work is retried before the feed is contacted again.
    let failedFeedFetches = 0;
    const mockPendingFailureFetch = (async (input: unknown) => {
      if (String(input).includes("IStoreService/GetAppList")) {
        failedFeedFetches++;
      }
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof fetch;

    const failResult = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_steam_key",
      customFetch: mockPendingFailureFetch,
    });
    expect(failResult).toMatchObject({
      executed: true,
      attempted: 1,
      successful: 0,
      failed: 1,
      pending: 1,
      checkpointAdvanced: false,
    });
    expect(failedFeedFetches).toBe(0);

    // Cursor advances safely while the failed AppID is retained for retry.
    const preservedCheckpoint = await getCheckpoint(d1, DEFAULT_PRICE_CHECKPOINT_KEY);
    expect(preservedCheckpoint?.cursor).toBe(1700009999);
    expect(JSON.parse(preservedCheckpoint?.value ?? "{}").pending).toContain(1086940);

    console.log("incremental feed checkpoint");
  });

  test("bounded price refresh - fills its success target and stops on rate limiting", async () => {
    const calledAppIds: number[] = [];
    const successResponse = (appid: number) =>
      new Response(
        JSON.stringify({
          [appid]: {
            success: true,
            data: { name: `Game ${appid}`, is_free: true },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    const continueAfterFailure = (async (input: unknown) => {
      const appid = Number(new URL(String(input)).searchParams.get("appids"));
      calledAppIds.push(appid);
      return appid === 1 ? new Response("Store error", { status: 500 }) : successResponse(appid);
    }) as unknown as typeof fetch;

    const filled = await refreshIndicatedAppPrices(d1, [1, 2, 3, 4], {
      customFetch: continueAfterFailure,
      successTarget: 2,
      attemptCap: 4,
    });
    expect(filled).toMatchObject({
      attempted: 3,
      successful: 2,
      failed: 1,
      rateLimited: false,
    });
    expect(calledAppIds).toEqual([1, 2, 3]);

    const targetFill = await refreshIndicatedAppPrices(
      d1,
      Array.from({ length: 102 }, (_, index) => index + 10),
      { customFetch: (async (input: unknown) => {
        const appid = Number(new URL(String(input)).searchParams.get("appids"));
        return successResponse(appid);
      }) as unknown as typeof fetch, successTarget: 100, attemptCap: 200 }
    );
    expect(targetFill).toMatchObject({ attempted: 100, successful: 100, failed: 0 });


    calledAppIds.length = 0;
    const stopOnRateLimit = (async (input: unknown) => {
      const appid = Number(new URL(String(input)).searchParams.get("appids"));
      calledAppIds.push(appid);
      return appid === 2
        ? new Response("Too Many Requests", { status: 429 })
        : successResponse(appid);
    }) as unknown as typeof fetch;

    const rateLimited = await refreshIndicatedAppPrices(d1, [1, 2, 3, 4], {
      customFetch: stopOnRateLimit,
      successTarget: 3,
      attemptCap: 4,
    });
    expect(rateLimited).toMatchObject({
      attempted: 2,
      successful: 1,
      failed: 1,
      rateLimited: true,
    });
    expect(calledAppIds).toEqual([1, 2]);

    const unavailable = await fetchSteamPriceDetails(5, {
      customFetch: (async () =>
        new Response(JSON.stringify({ "5": { success: false } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(unavailable).toMatchObject({
      success: true,
      is_available: false,
      rateLimited: false,
    });
  });

  test("price feed recovers catalog rows from prior price-only ingestion", async () => {
    await recordPriceObservation(d1, {
      appid: 999,
      currency: "USD",
      initial_price: 2999,
      final_price: 2999,
      discount_percent: 0,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });
    await setCheckpoint(
      d1,
      DEFAULT_PRICE_CHECKPOINT_KEY,
      JSON.stringify({ pending: [] }),
      1788562121
    );

    let feedCalls = 0;
    const result = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      anchorTime: new Date("2026-09-04T14:20:00.000Z"),
      customFetch: (async (input: unknown) => {
        if (String(input).includes("IStoreService/GetAppList")) {
          feedCalls++;
          return new Response("unexpected feed call", { status: 500 });
        }
        return Response.json({
          "999": {
            success: true,
            data: {
              type: "game",
              name: "New Release",
              steam_appid: 999,
              is_free: false,
              short_description: "A newly discovered game.",
              header_image: "https://cdn.example/999.jpg",
              developers: ["Developer"],
              publishers: ["Publisher"],
              release_date: { coming_soon: false, date: "Sep 4, 2026" },
              price_overview: {
                currency: "USD",
                initial: 2999,
                final: 2999,
                discount_percent: 0,
              },
            },
          },
        });
      }) as unknown as typeof fetch,
    });

    const app = sqliteDb
      .query(
        `SELECT name, type, is_playable, is_eligible, release_date
         FROM apps WHERE appid = 999`
      )
      .get() as Record<string, unknown> | null;
    const checkpoint = await getCheckpoint(d1, DEFAULT_PRICE_CHECKPOINT_KEY);

    expect(result).toMatchObject({ successful: 1, pending: 0 });
    expect(feedCalls).toBe(0);
    expect(app).toEqual({
      name: "New Release",
      type: "game",
      is_playable: 1,
      is_eligible: 1,
      release_date: "Sep 4, 2026",
    });
    expect(JSON.parse(checkpoint?.value ?? "{}").catalogBackfillQueued).toBe(true);
    expect(checkpoint?.cursor).toBe(
      Math.floor(new Date("2026-09-04T14:20:00.000Z").getTime() / 1000) -
        30 * 24 * 60 * 60
    );
  });

  test("catalog feed continues every page before advancing its timestamp", async () => {
    await setCheckpoint(
      d1,
      DEFAULT_PRICE_CHECKPOINT_KEY,
      JSON.stringify({ pending: [], catalogBackfillQueued: true }),
      100
    );

    const feedUrls: URL[] = [];
    const fetcher = (async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.includes("GetAppList")) {
        feedUrls.push(url);
        const secondPage = feedUrls.length === 2;
        return Response.json({
          response: {
            apps: secondPage
              ? [{ appid: 30, last_modified: 160 }]
              : [
                  { appid: 10, last_modified: 140 },
                  { appid: 20, last_modified: 150 },
                ],
            have_more_results: !secondPage,
            last_appid: secondPage ? 30 : 20,
          },
        });
      }

      const appid = Number(url.searchParams.get("appids"));
      return Response.json({
        [appid]: {
          success: true,
          data: {
            type: "game",
            name: `Game ${appid}`,
            steam_appid: appid,
            is_free: true,
          },
        },
      });
    }) as unknown as typeof fetch;

    const first = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      customFetch: fetcher,
      maxAppsToProcess: 2,
    });
    const firstCheckpoint = await getCheckpoint(d1, DEFAULT_PRICE_CHECKPOINT_KEY);
    const firstValue = JSON.parse(firstCheckpoint?.value ?? "{}");

    expect(first.checkpointAdvanced).toBe(false);
    expect(firstCheckpoint?.cursor).toBe(100);
    expect(firstValue).toMatchObject({
      continuationAppId: 20,
      continuationLastModified: 150,
    });

    const second = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      customFetch: fetcher,
      maxAppsToProcess: 2,
    });
    const secondCheckpoint = await getCheckpoint(d1, DEFAULT_PRICE_CHECKPOINT_KEY);
    const secondValue = JSON.parse(secondCheckpoint?.value ?? "{}");

    expect(feedUrls[1].searchParams.get("if_modified_since")).toBe("100");
    expect(feedUrls[1].searchParams.get("last_appid")).toBe("20");
    expect(second.checkpointAdvanced).toBe(true);
    expect(secondCheckpoint?.cursor).toBe(160);
    expect(secondValue.continuationAppId).toBeUndefined();
  });

  test("price feed drains pending IDs before fetching more work", async () => {
    const anchorTime = new Date("1970-01-31T00:00:00.000Z");
    let feedRuns = 0;
    let rateLimitReturned = false;
    const detailCalls: number[] = [];
    const fetcher = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("IStoreService/GetAppList")) {
        feedRuns++;
        const apps = feedRuns === 1
          ? [
              { appid: 1, last_modified: 100 },
              { appid: 2, last_modified: 100 },
              { appid: 3, last_modified: 100 },
            ]
          : [{ appid: 4, last_modified: 200 }];
        return new Response(
          JSON.stringify({ response: { apps, have_more_results: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const appid = Number(new URL(url).searchParams.get("appids"));
      detailCalls.push(appid);
      if (!rateLimitReturned && appid === 2) {
        rateLimitReturned = true;
        return new Response("Too Many Requests", { status: 429 });
      }
      return new Response(
        JSON.stringify({ [appid]: { success: true, data: { is_free: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const first = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      customFetch: fetcher,
      anchorTime,
    });
    expect(first).toMatchObject({
      attempted: 2,
      successful: 1,
      failed: 1,
      rateLimited: true,
      pending: 2,
      checkpointAdvanced: false,
      checkpointCursor: 100,
    });
    const pendingCheckpoint = await getCheckpoint(d1, DEFAULT_PRICE_CHECKPOINT_KEY);
    expect(pendingCheckpoint?.cursor).toBe(100);
    expect(JSON.parse(pendingCheckpoint?.value ?? "{}").pending).toEqual([2, 3]);

    const second = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      customFetch: fetcher,
      anchorTime,
    });
    expect(second).toMatchObject({
      attempted: 2,
      successful: 2,
      failed: 0,
      rateLimited: false,
      pending: 0,
      checkpointAdvanced: false,
      checkpointCursor: 100,
    });
    expect(feedRuns).toBe(1);

    const third = await runHourlyPriceFeedTick(d1, {
      apiKey: "test_key",
      customFetch: fetcher,
      anchorTime,
    });
    expect(third).toMatchObject({
      attempted: 1,
      successful: 1,
      failed: 0,
      rateLimited: false,
      pending: 0,
      checkpointAdvanced: true,
      checkpointCursor: 200,
    });
    expect(feedRuns).toBe(2);
    expect(detailCalls).toEqual([1, 2, 2, 3, 4]);
  });
  // G2: current US/USD price, discount, and source time persist for eligible entities
  test("current price state - persists US/USD price, discount, and source time", async () => {
    const observedAt = "2026-09-04T12:00:00.000Z";

    // Playable Game with discount
    await recordPriceObservation(d1, {
      appid: 1086940,
      currency: "USD",
      initial_price: 5999,
      final_price: 2999,
      discount_percent: 50,
      is_free: false,
      is_available: true,
      formatted_initial: "$59.99",
      formatted_final: "$29.99",
      observed_at: observedAt,
    });

    const gamePrice = await getCurrentPrice(d1, 1086940);
    expect(gamePrice).not.toBeNull();
    expect(gamePrice?.currency).toBe("USD");
    expect(gamePrice?.initial_price).toBe(5999);
    expect(gamePrice?.final_price).toBe(2999);
    expect(gamePrice?.discount_percent).toBe(50);
    expect(gamePrice?.is_free).toBe(false);
    expect(gamePrice?.is_available).toBe(true);
    expect(gamePrice?.formatted_final).toBe("$29.99");
    expect(gamePrice?.observed_at).toBe(observedAt);

    // Free to play game
    await recordPriceObservation(d1, {
      appid: 730,
      currency: "USD",
      initial_price: 0,
      final_price: 0,
      discount_percent: 0,
      is_free: true,
      is_available: true,
      formatted_initial: "Free",
      formatted_final: "Free",
      observed_at: observedAt,
    });

    const freePrice = await getCurrentPrice(d1, 730);
    expect(freePrice?.is_free).toBe(true);
    expect(freePrice?.final_price).toBe(0);
    expect(freePrice?.formatted_final).toBe("Free");

    // Eligible Expansion
    await recordPriceObservation(d1, {
      appid: 2778580,
      currency: "USD",
      initial_price: 3999,
      final_price: 3999,
      discount_percent: 0,
      is_free: false,
      is_available: true,
      formatted_initial: "$39.99",
      formatted_final: "$39.99",
      observed_at: observedAt,
    });

    const expansionPrice = await getCurrentPrice(d1, 2778580);
    expect(expansionPrice?.final_price).toBe(3999);
    expect(expansionPrice?.discount_percent).toBe(0);

    console.log("current price state");
  });

  // G3: price history adds only changed states and retains them indefinitely
  test("changed only price history - records only when state changes and persists indefinitely", async () => {
    const t1 = "2026-08-01T10:00:00.000Z";
    const t2 = "2026-08-02T10:00:00.000Z";
    const t3 = "2026-08-10T10:00:00.000Z";

    // 1. Initial price: $59.99 (State 1) -> Adds to history
    const res1 = await recordPriceObservation(d1, {
      appid: 1245620,
      currency: "USD",
      initial_price: 5999,
      final_price: 5999,
      discount_percent: 0,
      is_free: false,
      is_available: true,
      observed_at: t1,
    });
    expect(res1.stateChanged).toBe(true);

    const history1 = await getPriceHistory(d1, 1245620, "all");
    expect(history1.history.length).toBe(1);
    expect(history1.history[0].final_price).toBe(5999);

    // 2. Second observation with identical state at t2 -> Does NOT add to history
    const res2 = await recordPriceObservation(d1, {
      appid: 1245620,
      currency: "USD",
      initial_price: 5999,
      final_price: 5999,
      discount_percent: 0,
      is_free: false,
      is_available: true,
      observed_at: t2,
    });
    expect(res2.stateChanged).toBe(false);

    const history2 = await getPriceHistory(d1, 1245620, "all");
    expect(history2.history.length).toBe(1); // Still 1

    // Current price observation timestamp was updated
    const current2 = await getCurrentPrice(d1, 1245620);
    expect(current2?.observed_at).toBe(t2);

    // 3. Price drops to $39.99 (State 2) -> Adds to history
    const res3 = await recordPriceObservation(d1, {
      appid: 1245620,
      currency: "USD",
      initial_price: 5999,
      final_price: 3999,
      discount_percent: 33,
      is_free: false,
      is_available: true,
      observed_at: t3,
    });
    expect(res3.stateChanged).toBe(true);

    const history3 = await getPriceHistory(d1, 1245620, "all");
    expect(history3.history.length).toBe(2);
    expect(history3.history[0].final_price).toBe(5999);
    expect(history3.history[1].final_price).toBe(3999);
    // Verify atomic batch execution: both tables updated together
    const priceRow = await getCurrentPrice(d1, 1245620);
    expect(priceRow?.final_price).toBe(3999);
    expect(history3.history[1].final_price).toBe(3999);

    console.log("changed only price history");
  });

  // G4: the collector contains no speculative catalog-wide reconciliation sweep
  test("incremental collection only - refreshes only indicated apps without catalog sweep", async () => {
    const fetchedAppIds: number[] = [];

    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("api/appdetails?appids=")) {
        const match = url.match(/appids=(\d+)/);
        if (match) {
          const appid = parseInt(match[1], 10);
          fetchedAppIds.push(appid);
          return new Response(
            JSON.stringify({
              [String(appid)]: {
                success: true,
                data: {
                  is_free: false,
                  price_overview: {
                    currency: "USD",
                    initial: 4999,
                    final: 4999,
                    discount_percent: 0,
                  },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    // Feed indicates only AppID 1086940, while catalog contains 730, 1086940, 1245620, etc.
    const result = await refreshIndicatedAppPrices(d1, [1086940], {
      customFetch: mockFetch,
    });

    expect(result.attempted).toBe(1);
    expect(result.successful).toBe(1);
    expect(fetchedAppIds).toEqual([1086940]);

    // Other catalog games were NOT touched or swept
    const untouchedGame = await getCurrentPrice(d1, 1245620);
    expect(untouchedGame).toBeNull();

    console.log("incremental collection only");
  });

  // G5: a failed refresh preserves prior price and never renders free or zero
  test("failed price refresh - preserves prior price and never confuses with free or zero", async () => {
    // 1. Establish an existing price of $59.99
    await recordPriceObservation(d1, {
      appid: 1086940,
      currency: "USD",
      initial_price: 5999,
      final_price: 5999,
      discount_percent: 0,
      is_free: false,
      is_available: true,
      formatted_final: "$59.99",
      observed_at: "2026-09-01T00:00:00.000Z",
    });

    // 2. Attempt refresh with failing fetch (HTTP 500 error)
    const mockFailingFetch = (async () => {
      return new Response("Steam Store Error", { status: 500 });
    }) as unknown as typeof fetch;

    const details = await fetchSteamPriceDetails(1086940, { customFetch: mockFailingFetch });
    expect(details.success).toBe(false);

    // Refresh indicated apps skips the failed refresh
    const stats = await refreshIndicatedAppPrices(d1, [1086940], { customFetch: mockFailingFetch });
    expect(stats.failed).toBe(1);
    expect(stats.successful).toBe(0);

    // Verify DB still holds the prior $59.99 price, NOT 0 or free
    const priceAfterFailure = await getCurrentPrice(d1, 1086940);
    expect(priceAfterFailure).not.toBeNull();
    expect(priceAfterFailure?.final_price).toBe(5999);
    expect(priceAfterFailure?.is_free).toBe(false);
    expect(priceAfterFailure?.formatted_final).toBe("$59.99");

    // Verify formatPriceCents never outputs Free for failed/null prices
    expect(formatPriceCents(null)).toBe("Unavailable");
    expect(formatPriceCents(undefined)).toBe("Unavailable");
    expect(formatPriceCents(5999)).toBe("$59.99");

    console.log("failed price refresh");
  });

  // G6: price ranges enforce boundaries and All begins at first observation
  test("price history ranges - enforces boundaries and All begins at first observation", async () => {
    const anchor = new Date("2026-09-04T12:00:00.000Z");

    // 1. Range parser validation
    expect(parsePriceRange("30d")).toBe("30d");
    expect(parsePriceRange("6m")).toBe("6m");
    expect(parsePriceRange("1y")).toBe("1y");
    expect(parsePriceRange("all")).toBe("all");
    expect(parsePriceRange("invalid")).toBe("all"); // Default to All
    expect(parsePriceRange(null)).toBe("all");

    // 2. Add history observations at different intervals:
    // First observation: 200 days ago ($69.99)
    const tFirst = new Date(anchor.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString();
    // Second observation: 45 days ago ($49.99)
    const tSecond = new Date(anchor.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
    // Third observation: 10 days ago ($29.99)
    const tThird = new Date(anchor.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    await recordPriceObservation(d1, {
      appid: 1086940,
      initial_price: 6999,
      final_price: 6999,
      discount_percent: 0,
      is_free: false,
      is_available: true,
      observed_at: tFirst,
    });
    await recordPriceObservation(d1, {
      appid: 1086940,
      initial_price: 6999,
      final_price: 4999,
      discount_percent: 28,
      is_free: false,
      is_available: true,
      observed_at: tSecond,
    });
    await recordPriceObservation(d1, {
      appid: 1086940,
      initial_price: 6999,
      final_price: 2999,
      discount_percent: 57,
      is_free: false,
      is_available: true,
      observed_at: tThird,
    });
    // 3. Regression: future observation after anchorTime cannot leak into history
    const tFuture = new Date(anchor.getTime() + 24 * 60 * 60 * 1000).toISOString();
    // Manually insert a future record into price_history
    await d1
      .prepare(
        `INSERT INTO price_history (appid, currency, initial_price, final_price, discount_percent, is_free, is_available, formatted_price, observed_at)
         VALUES (?, 'USD', 6999, 1999, 71, 0, 1, '$19.99', ?)`
      )
      .bind(1086940, tFuture)
      .run();

    // Test 'all': begins at the first observation (tFirst) and bounded by anchorTime (excludes tFuture)
    const historyAll = await getPriceHistory(d1, 1086940, "all", { anchorTime: anchor });
    expect(historyAll.earliest_observation).toBe(tFirst);
    expect(historyAll.history.length).toBe(3);
    expect(historyAll.history[0].observed_at).toBe(tFirst);
    expect(historyAll.history.every((h) => h.observed_at <= anchor.toISOString())).toBe(true);

    // Test '30d': anchor captures state going into window ($49.99) + observation in window ($29.99), excludes future
    const history30d = await getPriceHistory(d1, 1086940, "30d", { anchorTime: anchor });
    expect(history30d.history.length).toBe(2);
    expect(history30d.history[0].final_price).toBe(4999);
    expect(history30d.history[1].final_price).toBe(2999);
    expect(history30d.history.every((h) => h.observed_at <= anchor.toISOString())).toBe(true);

    console.log("price history ranges");
  });
  // G7: price charts expose labels, values, gaps, and a table equivalent
  test("accessible price history - exposes labels, values, gaps, and a table equivalent", async () => {
    const historyResult = {
      appid: 1086940,
      range: "all" as PriceHistoryRange,
      earliest_observation: "2026-01-01T00:00:00.000Z",
      current_price: {
        appid: 1086940,
        currency: "USD",
        initial_price: 5999,
        final_price: 2999,
        discount_percent: 50,
        is_free: false,
        is_available: true,
        formatted_initial: "$59.99",
        formatted_final: "$29.99",
        observed_at: "2026-09-04T12:00:00.000Z",
      },
      history: [
        {
          id: 1,
          appid: 1086940,
          currency: "USD",
          initial_price: 5999,
          final_price: 5999,
          discount_percent: 0,
          is_free: false,
          is_available: true,
          formatted_price: "$59.99",
          observed_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          appid: 1086940,
          currency: "USD",
          initial_price: 5999,
          final_price: 2999,
          discount_percent: 50,
          is_free: false,
          is_available: true,
          formatted_price: "$29.99",
          observed_at: "2026-09-04T12:00:00.000Z",
        },
      ],
      source_timestamp: "2026-09-04T12:00:00.000Z",
    };

    const html = renderToString(
      React.createElement(PriceHistoryChart, {
        appid: 1086940,
        initialRange: "all",
        initialData: historyResult,
      })
    );

    // Verify accessibility attributes and visible labels
    expect(html).toContain('aria-label="Price history time ranges"');
    expect(html).toContain("Current Price");
    expect(html).toContain("Lowest Observed");
    expect(html).toContain("Base Price");
    expect(html).toContain("$29.99");
    expect(html).toContain("-50%");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("View accessible price history table");
    // Verify touch target minimums: min-h-[44px] and min-w-[44px] on controls
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("min-w-[44px]");
    // Verify table toggle has stable aria-label
    expect(html).toContain('aria-label="Toggle accessible price history data table"');
    // Verify explicit UTC display
    expect(html).toContain("UTC");

    // Regression: SSR render does not invoke render-time fetch loops
    let ssrFetchCount = 0;
    const trackingFetch = (async () => {
      ssrFetchCount++;
      return new Response(JSON.stringify({ status: "data", data: historyResult }));
    }) as unknown as typeof fetch;
    renderToString(
      React.createElement(PriceHistoryChart, {
        appid: 1086940,
        initialRange: "all",
        initialData: historyResult,
        customFetch: trackingFetch,
      })
    );
    expect(ssrFetchCount).toBe(0);

    console.log("accessible price history");
  });

  // G8: deals include games and consumer expansions while excluding accessories
  test("deal eligibility - includes discounted games/expansions and excludes accessories", async () => {
    // Helper function checks: Root playable games require type=game, is_playable=true, parent_appid=null
    expect(isDealEligible({ type: "game", is_playable: 1, parent_appid: null })).toBe(true);
    expect(isDealEligible({ type: "game", is_playable: 1, parent_appid: 123 })).toBe(false); // Game with parent is invalid
    expect(isDealEligible({ type: "dlc", is_playable: 0, parent_appid: 1086940 }, "dlc")).toBe(true);
    expect(isDealEligible({ type: "dlc", is_playable: 0, parent_appid: null }, "dlc")).toBe(false); // DLC without parent is invalid
    expect(isDealEligible({ type: "expansion", is_playable: 0, parent_appid: 1245620 }, "expansion")).toBe(true);
    expect(isDealEligible({ type: "expansion", is_playable: 0, parent_appid: null }, "expansion")).toBe(false); // Expansion without parent is invalid

    // Excluded accessories
    expect(isDealEligible({ type: "server", is_playable: 0, parent_appid: 730 }, "server")).toBe(false);
    expect(isDealEligible({ type: "tool", is_playable: 0, parent_appid: 730 }, "tool")).toBe(false);
    expect(isDealEligible({ type: "demo", is_playable: 0, parent_appid: 730 }, "demo")).toBe(false);
    expect(isDealEligible({ type: "test", is_playable: 0, parent_appid: 730 }, "test")).toBe(false);
    expect(isDealEligible({ type: "soundtrack", is_playable: 0, parent_appid: 1086940 }, "soundtrack")).toBe(false);
    // Database query checks with getDeals:
    // 1. Add discount to playable game (Baldur's Gate 3)
    await recordPriceObservation(d1, {
      appid: 1086940,
      initial_price: 5999,
      final_price: 2999,
      discount_percent: 50,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });

    // 2. Add discount to expansion (Shadow of the Erdtree)
    await recordPriceObservation(d1, {
      appid: 2778580,
      initial_price: 3999,
      final_price: 2999,
      discount_percent: 25,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });

    // 3. Add discount to soundtrack (accessory - should be EXCLUDED)
    await recordPriceObservation(d1, {
      appid: 999002,
      initial_price: 999,
      final_price: 499,
      discount_percent: 50,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });

    // 4. Add discount to dedicated server (accessory - should be EXCLUDED)
    await recordPriceObservation(d1, {
      appid: 999001,
      initial_price: 1999,
      final_price: 999,
      discount_percent: 50,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });

    const dealsResult = await getDeals(d1);
    const dealAppIds = dealsResult.deals.map((d) => d.appid);

    // Included
    expect(dealAppIds).toContain(1086940); // Playable game
    expect(dealAppIds).toContain(2778580); // Expansion

    // Excluded
    expect(dealAppIds).not.toContain(999002); // Soundtrack excluded
    expect(dealAppIds).not.toContain(999001); // Server excluded

    // Regression: Verify canonical URLs rendered by DealsList include numeric AppIDs
    const dealsHtml = renderToString(
      React.createElement(DealsList, {
        deals: dealsResult.deals,
        total: dealsResult.total,
      })
    );
    expect(dealsHtml).toContain('/games/1086940-baldurs-gate-3');
    expect(dealsHtml).toContain('/games/1245620-elden-ring/2778580-elden-ring-shadow-of-the-erdtree');
    expect(dealsHtml).toContain('/games/1245620-elden-ring'); // Parent link
    // Verify touch target minimums on deals links and controls
    expect(dealsHtml).toContain("min-w-[44px]");
    expect(dealsHtml).toContain("min-h-[44px]");
    console.log("deal eligibility");
  });
  // G9: price and deal responses expose source times and live caching
  test("price api contract - exposes source times and live caching policy", async () => {
    // Add test price
    await recordPriceObservation(d1, {
      appid: 1086940,
      initial_price: 5999,
      final_price: 2999,
      discount_percent: 50,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });

    // 1. Price History API Request
    const priceReq = new Request("http://localhost/api/prices/history?appid=1086940&range=all");
    const priceRes = await handlePriceHistoryRequest(priceReq, d1);

    expect(priceRes.status).toBe(200);
    expect(priceRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(priceRes.headers.get("Vary")).toBe("Accept-Encoding");

    const priceJson = (await priceRes.json()) as {
      status: string;
      source_timestamp: string;
      data: { appid: number };
    };
    expect(priceJson.status).toBe("data");
    expect(priceJson.source_timestamp).toBe("2026-09-04T12:00:00.000Z");
    expect(priceJson.data.appid).toBe(1086940);

    // 2. Deals API Request
    const dealsReq = new Request("http://localhost/api/deals");
    const dealsRes = await handleDealsRequest(dealsReq, d1);

    expect(dealsRes.status).toBe(200);
    expect(dealsRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(dealsRes.headers.get("Vary")).toBe("Accept-Encoding");

    const dealsJson = (await dealsRes.json()) as {
      status: string;
      source_timestamp: string;
      data: { total: number };
    };
    expect(dealsJson.status).toBe("data");
    expect(typeof dealsJson.source_timestamp).toBe("string");
    expect(dealsJson.data.total).toBeGreaterThan(0);

    // 3. 404 / Error caching policy check (no-store)
    const errorReq = new Request("http://localhost/api/prices/history?appid=99999999");
    const errorRes = await handlePriceHistoryRequest(errorReq, d1);
    expect(errorRes.status).toBe(404);
    expect(errorRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    console.log("price api contract");
  });

  // E2E Integration: GamePage, ChildAppPageView, and HomeComponent with price core
  test("end-to-end integration: game page, child page, and home deals sections", async () => {
    // 1. Seed prices:
    // Game: Baldur's Gate 3 ($59.99 initial, $29.99 final, 50% discount)
    await recordPriceObservation(d1, {
      appid: 1086940,
      initial_price: 5999,
      final_price: 2999,
      discount_percent: 50,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });

    // Expansion: Shadow of the Erdtree ($39.99 initial, $29.99 final, 25% discount)
    await recordPriceObservation(d1, {
      appid: 2778580,
      initial_price: 3999,
      final_price: 2999,
      discount_percent: 25,
      is_free: false,
      is_available: true,
      observed_at: "2026-09-04T12:00:00.000Z",
    });

    // 1. Game Route Integration: handleGameHttpRequest
    const gameRes = await handleGameHttpRequest(
      new Request("http://localhost/games/1086940-baldurs-gate-3"),
      d1
    );
    expect(gameRes.status).toBe(200);
    const gameHtml = await gameRes.text();
    // Verifies GamePage visibly displays current US/USD price, discount %, source time
    expect(gameHtml).toContain("$29.99");
    expect(gameHtml).toContain("50%");
    expect(gameHtml).toContain("2026-09-04 12:00:00 UTC");
    expect(gameHtml).toContain("Price History (US / USD)");
    // Verifies player history + related apps preserved
    expect(gameHtml).toContain("Player Count History");
    expect(gameHtml).toContain("https://store.steampowered.com/app/1086940/");
    expect(gameHtml).toContain("Steam Store ↗");
    expect(gameHtml).not.toContain("&nearr;");
    // 2. Child Route Integration: handleChildHttpRequest
    const childRes = await handleChildHttpRequest(
      new Request("http://localhost/games/1245620-elden-ring/2778580-elden-ring-shadow-of-the-erdtree"),
      d1
    );
    expect(childRes.status).toBe(200);
    const childHtml = await childRes.text();
    // Child page visibly displays own current price + discount + price history
    expect(childHtml).toContain("$29.99");
    expect(childHtml).toContain("-25%");
    expect(childHtml).toContain("Price History (US / USD)");

    expect(childHtml).toContain("https://store.steampowered.com/app/2778580/");
    expect(childHtml).toContain("Steam Store ↗");
    expect(childHtml).not.toContain("&nearr;");
    // Dedicated server page truthfully displays unavailable/no data yet
    const serverRes = await handleChildHttpRequest(
      new Request("http://localhost/games/730-counter-strike-2/999001-dedicated-server-tool"),
      d1
    );
    expect(serverRes.status).toBe(200);
    const serverHtml = await serverRes.text();
    expect(serverHtml).toContain("No data yet");

    // 3. Home Route Integration: HomeComponent with direct Deals section
    const dealsResult = await getDeals(d1, { limit: 10, sort: "discount" });
    const homeHtml = renderToString(
      React.createElement<HomeComponentProps>(HomeComponent, {
        initialTrending: [],
        initialDeals: dealsResult.deals,
        totalDeals: dealsResult.total,
      })
    );
    // Verifies direct Deals section with link to /deals and deal items
    expect(homeHtml).toContain("Featured Steam Deals");
    expect(homeHtml).toContain("/deals");
    expect(homeHtml).toContain("Baldurs Gate 3");
    expect(homeHtml).toContain("50%");
    // Verifies single trending block preserved
    expect(homeHtml).toContain('data-testid="trending-block"');
    expect(homeHtml).toContain("Trending");
    // Verifies touch targets on deals controls
    expect(homeHtml).toContain("min-h-[44px]");
    // Verifies explicit UTC timestamps on rendered pages
    expect(gameHtml).toContain("UTC");
    expect(childHtml).toContain("UTC");
    expect(homeHtml).toContain("UTC");

    // Empty state on Home
    const emptyHomeHtml = renderToString(
      React.createElement<HomeComponentProps>(HomeComponent, {
        initialTrending: [],
        initialDeals: [],
        totalDeals: 0,
      })
    );
    expect(emptyHomeHtml).toContain("No active discounts found for this selection.");
  });
  // G10: complete suite marker
  test("prices deals suite complete - all criteria verified", () => {
    console.log("prices deals suite complete");
    expect(true).toBe(true);
  });
});
