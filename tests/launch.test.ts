import { describe, it, expect, beforeEach } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import {
  CACHE_POLICIES,
  getHomeCacheHeaders,
  getPageCacheHeaders,
} from "../src/lib/cache";
import {
  TICK_REQUEST_CAP,
  DAILY_REQUEST_CAP,
  TIER_FAST_MAX,
  TIER_HOURLY_MAX,
  TIER_DAILY_MAX,
  MAX_TRACKED_GAMES,
  CONCURRENCY_LIMIT,
} from "../src/lib/player";
import { handleGameOverviewRequest } from "../src/routes/api.games.$appid.overview";
import { handlePlayerHistoryRequest } from "../src/routes/api.players.history";
import { handlePriceHistoryRequest } from "../src/routes/api.prices.history";
import { handleRankingsRequest } from "../src/routes/api.rankings";
import { handleDealsRequest } from "../src/routes/api.deals";
import { handleReleasesApiRequest } from "../src/routes/api.releases";
import { handleSearchApiRequest } from "../src/routes/api.search";
import { handleCatalogRequest } from "../src/routes/api.catalog";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { handleChildHttpRequest } from "../src/routes/games.$game_.$child";
import { handlePrivacyHttpRequest } from "../src/routes/privacy";
import { runBoundedCatalogImport, INITIAL_SEED_APP_IDS } from "../workers/catalog-seed";
import { runHourlyPriceFeedTick } from "../workers/price-collector";
import { syncReleaseFactsFromApps } from "../workers/release-facts";

function createSqliteAdapter(db: Database): AppDatabase {
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
        async run() {
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

    async batch<T = unknown>(statements: AppPreparedStatement[]) {
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

describe("public API launch contract", () => {
  let sqliteDb: Database;
  let d1: AppDatabase;

  beforeEach(async () => {
    sqliteDb = new Database(":memory:");
    applyMigrations(sqliteDb);
    d1 = createSqliteAdapter(sqliteDb);

    // Seed test playable game and child expansion
    sqliteDb.exec(`
      INSERT INTO apps (appid, name, slug, type, is_playable, is_eligible, release_date, release_status)
      VALUES 
        (10, 'Counter-Strike', '10-counter-strike', 'game', 1, 1, '2000-11-01', 'released'),
        (1086940, 'Baldurs Gate 3', '1086940-baldurs-gate-3', 'game', 1, 1, '2023-08-03', 'released'),
        (2778580, 'BG3 Expansion', '2778580-bg3-expansion', 'expansion', 0, 1, '2024-05-15', 'released');

      INSERT INTO app_relationships (parent_appid, child_appid, relationship_type, prominence)
      VALUES (1086940, 2778580, 'expansion', 1);

      INSERT INTO observations (appid, current_players, observed_at)
      VALUES (10, 15000, '2026-09-04T12:00:00.000Z');

      INSERT INTO tracked_games (appid, tier, slot, next_due_at, last_successful_at, latest_players)
      VALUES (10, 'fast', 0, '2026-09-04T12:10:00.000Z', '2026-09-04T12:00:00.000Z', 15000);

      INSERT INTO app_prices (appid, currency, initial_price, final_price, discount_percent, is_free, is_available, formatted_initial, formatted_final, observed_at)
      VALUES (10, 'USD', 999, 499, 50, 0, 1, '$9.99', '$4.99', '2026-09-04T12:00:00.000Z');

      INSERT INTO price_history (appid, currency, initial_price, final_price, discount_percent, is_free, is_available, formatted_price, observed_at)
      VALUES (10, 'USD', 999, 499, 50, 0, 1, '$4.99', '2026-09-04T12:00:00.000Z');

      INSERT INTO release_facts (appid, name, slug, type, release_date, release_year, release_week, release_status, is_precise)
      VALUES (10, 'Counter-Strike', '10-counter-strike', 'game', '2000-11-01', 2000, '2000-W44', 'released', 1);
    `);
  });

  it("enforces 5-minute CDN cache + 1-minute SWR on live APIs", async () => {
    // 1. Overview API
    const overviewReq = new Request("https://vaporstats.com/api/games/10/overview");
    const overviewRes = await handleGameOverviewRequest(overviewReq, d1, 10);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(overviewRes.headers.get("Vary")).toBe("Accept-Encoding");
    const overviewData = await overviewRes.json() as {
      appid: number;
      latest_players: number;
      current_price: { final_price: number; observed_at: string };
    };
    expect(overviewData.appid).toBe(10);
    expect(overviewData.latest_players).toBe(15000);
    expect(overviewData.current_price.final_price).toBe(499);
    expect(overviewData.current_price.observed_at).toBe("2026-09-04T12:00:00.000Z");

    // 2. Player history API
    const playerHistReq = new Request("https://vaporstats.com/api/players/history?appid=10");
    const playerHistRes = await handlePlayerHistoryRequest(playerHistReq, d1);
    expect(playerHistRes.status).toBe(200);
    expect(playerHistRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(playerHistRes.headers.get("Vary")).toBe("Accept-Encoding");

    // 3. Price history API
    const priceHistReq = new Request("https://vaporstats.com/api/prices/history?appid=10");
    const priceHistRes = await handlePriceHistoryRequest(priceHistReq, d1);
    expect(priceHistRes.status).toBe(200);
    expect(priceHistRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(priceHistRes.headers.get("Vary")).toBe("Accept-Encoding");

    // 4. Rankings API
    const rankingsReq = new Request("https://vaporstats.com/api/rankings");
    const rankingsRes = await handleRankingsRequest(rankingsReq, d1);
    expect(rankingsRes.status).toBe(200);
    expect(rankingsRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(rankingsRes.headers.get("Vary")).toBe("Accept-Encoding");

    // 5. Deals API
    const dealsReq = new Request("https://vaporstats.com/api/deals");
    const dealsRes = await handleDealsRequest(dealsReq, d1);
    expect(dealsRes.status).toBe(200);
    expect(dealsRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(dealsRes.headers.get("Vary")).toBe("Accept-Encoding");

    // 6. Releases API
    const releasesReq = new Request("https://vaporstats.com/api/releases");
    const releasesRes = await handleReleasesApiRequest(releasesReq, d1);
    expect(releasesRes.status).toBe(200);
    expect(releasesRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(releasesRes.headers.get("Vary")).toBe("Accept-Encoding");

    // 7. Search API
    const searchReq = new Request("https://vaporstats.com/api/search?q=Counter");
    const searchRes = await handleSearchApiRequest(searchReq, d1);
    expect(searchRes.status).toBe(200);
    expect(searchRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(searchRes.headers.get("Vary")).toBe("Accept-Encoding");

    // 8. Playable catalog API
    const catalogReq = new Request("https://vaporstats.com/api/catalog?limit=100");
    const catalogRes = await handleCatalogRequest(catalogReq, d1);
    expect(catalogRes.status).toBe(200);
    expect(catalogRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    expect(catalogRes.headers.get("Vary")).toBe("Accept-Encoding");
  });

  it("enforces 1-hour CDN cache + 24-hour SWR on entity documents and no-store on 404", async () => {
    // 1. Existing playable game SSR document
    const gameReq = new Request("https://vaporstats.com/games/10-counter-strike");
    const gameRes = await handleGameHttpRequest(gameReq, d1);
    expect(gameRes.status).toBe(200);
    expect(gameRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);
    expect(gameRes.headers.get("Vary")).toBe("Accept-Encoding");
    const gameHtml = await gameRes.text();
    expect(gameHtml).toContain("Counter-Strike");

    // 2. Non-existent playable game returns 404 with no-store
    const missingGameReq = new Request("https://vaporstats.com/games/999999-missing-game");
    const missingGameRes = await handleGameHttpRequest(missingGameReq, d1);
    expect(missingGameRes.status).toBe(404);
    expect(missingGameRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    // 3. Existing child expansion SSR document
    const childReq = new Request("https://vaporstats.com/games/1086940-baldurs-gate-3/2778580-bg3-expansion");
    const childRes = await handleChildHttpRequest(childReq, d1);
    expect(childRes.status).toBe(200);
    expect(childRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);
    expect(childRes.headers.get("Vary")).toBe("Accept-Encoding");

    // 4. Non-existent child returns 404 with no-store
    const missingChildReq = new Request("https://vaporstats.com/games/1086940-baldurs-gate-3/999999-unknown");
    const missingChildRes = await handleChildHttpRequest(missingChildReq, d1);
    expect(missingChildRes.status).toBe(404);
    expect(missingChildRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    // 5. Privacy notice page returns 200 with entity cache policy
    const privacyReq = new Request("https://vaporstats.com/privacy");
    const privacyRes = handlePrivacyHttpRequest(privacyReq);
    expect(privacyRes.status).toBe(200);
    expect(privacyRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);

    // 6. Fast-refresh page and home cache headers
    expect(getHomeCacheHeaders()).toEqual({
      "Cache-Control": CACHE_POLICIES.homePage,
      Vary: "Accept-Encoding",
    });
    expect(getPageCacheHeaders()).toEqual({
      "Cache-Control": CACHE_POLICIES.page,
      Vary: "Accept-Encoding",
    });
    expect(CACHE_POLICIES.homePage).toBe(
      "public, max-age=30, s-maxage=30, stale-while-revalidate=30"
    );
    expect(CACHE_POLICIES.page).toBe(
      "public, max-age=60, s-maxage=60, stale-while-revalidate=60"
    );
    expect(CACHE_POLICIES.immutableAsset).toBe(
      "public, max-age=31536000, immutable"
    );
  });

  it("handles malformed/missing params with appropriate 400 error responses", async () => {
    const invalidPlayerReq = new Request("https://vaporstats.com/api/players/history");
    const invalidPlayerRes = await handlePlayerHistoryRequest(invalidPlayerReq, d1);
    expect(invalidPlayerRes.status).toBe(400);

    const invalidPriceReq = new Request("https://vaporstats.com/api/prices/history");
    const invalidPriceRes = await handlePriceHistoryRequest(invalidPriceReq, d1);
    expect(invalidPriceRes.status).toBe(400);

    const invalidOverviewReq = new Request("https://vaporstats.com/api/games/notanumber/overview");
    const invalidOverviewRes = await handleGameOverviewRequest(invalidOverviewReq, d1, NaN);
    expect(invalidOverviewRes.status).toBe(400);
  });
});

describe("launch scope exclusions", () => {
  it("verifies no admin or debug routes exist in public routing tree", () => {
    const routesDir = resolve(import.meta.dir, "../src/routes");
    const routeFiles = readdirSync(routesDir);

    for (const file of routeFiles) {
      const lower = file.toLowerCase();
      expect(lower.includes("admin")).toBe(false);
      expect(lower.includes("debug")).toBe(false);
      expect(lower.startsWith("test.")).toBe(false);
    }
  });
});

describe("operating triggers", () => {
  let sqliteDb: Database;
  let d1: AppDatabase;

  beforeEach(() => {
    sqliteDb = new Database(":memory:");
    applyMigrations(sqliteDb);
    d1 = createSqliteAdapter(sqliteDb);
  });

  it("verifies hard ingestion constants are bounded and inspectable", () => {
    expect(TICK_REQUEST_CAP).toBe(100);
    expect(DAILY_REQUEST_CAP).toBe(5000);
    expect(TIER_FAST_MAX).toBe(10);
    expect(TIER_HOURLY_MAX).toBe(90);
    expect(TIER_DAILY_MAX).toBe(900);
    expect(MAX_TRACKED_GAMES).toBe(1000);
    expect(CONCURRENCY_LIMIT).toBe(6);

    // All constants must be positive finite integers
    const constants = [
      TICK_REQUEST_CAP,
      DAILY_REQUEST_CAP,
      TIER_FAST_MAX,
      TIER_HOURLY_MAX,
      TIER_DAILY_MAX,
      MAX_TRACKED_GAMES,
      CONCURRENCY_LIMIT,
    ];

    for (const val of constants) {
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThan(0);
    }
  });

  it("bootstraps an empty catalog from the finite initial seed list", async () => {
    sqliteDb.exec("DELETE FROM apps");
    const detailCalls: number[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("IStoreBrowseService/GetItems")) {
        return Response.json({ response: { store_items: [] } });
      }
      const appid = Number(new URL(url).searchParams.get("appids"));
      detailCalls.push(appid);
      return Response.json({
        [String(appid)]: {
          success: true,
          data: {
            type: "game",
            name: "Seeded " + appid,
            steam_appid: appid,
            release_date: { coming_soon: false, date: "Jan 1, 2020" },
          },
        },
      });
    }) as unknown as typeof fetch;

    const result = await runBoundedCatalogImport(d1, { limit: 3, children: [], fetchFn });
    expect(result.seededCount).toBe(3);
    expect(result.importedAppIds).toEqual(INITIAL_SEED_APP_IDS.slice(0, 3));
    expect(detailCalls).toEqual(INITIAL_SEED_APP_IDS.slice(0, 3));
    expect(
      sqliteDb.query("SELECT COUNT(*) AS count FROM apps").get() as { count: number }
    ).toEqual({ count: 3 });
  });

  it("persists bounded orphan retry state instead of rescanning prices each tick", async () => {
    sqliteDb.exec(
      "INSERT INTO app_prices (appid, observed_at) VALUES (999001, '2026-09-04T12:00:00.000Z')"
    );
    const queries: string[] = [];
    const observedDb: AppDatabase = {
      ...d1,
      prepare(query: string) {
        queries.push(query);
        return d1.prepare(query);
      },
    };
    const failingFetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

    const first = await runHourlyPriceFeedTick(observedDb, {
      apiKey: "test-key",
      anchorTime: new Date("2026-09-04T14:20:00.000Z"),
      customFetch: failingFetch,
    });
    const orphanQueriesAfterFirst = queries.filter((query) => query.includes("FROM app_prices"));
    const second = await runHourlyPriceFeedTick(observedDb, {
      apiKey: "test-key",
      anchorTime: new Date("2026-09-04T14:30:00.000Z"),
      customFetch: failingFetch,
    });

    expect(first.pending).toBe(1);
    expect(second.pending).toBe(1);
    expect(queries.filter((query) => query.includes("FROM app_prices"))).toHaveLength(
      orphanQueriesAfterFirst.length
    );
  });

  it("limits release synchronization to changed app IDs", async () => {
    sqliteDb.exec(
      "INSERT INTO apps (appid, name, slug, type, is_playable, is_eligible, release_date, release_status) VALUES (910001, 'Changed Game', '910001-changed-game', 'game', 1, 1, '2020-01-01', 'released'), (910002, 'Unchanged Game', '910002-unchanged-game', 'game', 1, 1, '2020-01-02', 'released')"
    );

    const result = await syncReleaseFactsFromApps(d1, { appIds: [910001] });
    const changed = await d1
      .prepare("SELECT appid FROM release_facts WHERE appid = ?")
      .bind(910001)
      .first<{ appid: number }>();
    const unchanged = await d1
      .prepare("SELECT appid FROM release_facts WHERE appid = ?")
      .bind(910002)
      .first<{ appid: number }>();

    expect(result.processedCount).toBe(1);
    expect(changed?.appid).toBe(910001);
    expect(unchanged).toBeNull();
  });
});
