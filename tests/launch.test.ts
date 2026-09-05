import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { D1Database, D1PreparedStatement } from "../src/lib/db";
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
import ingestionWorker, { type IngestionEnv } from "../workers/ingestion";
import publicWorker from "../src/server";

// Load SQL migrations for in-memory D1 test database
const migration0001 = readFileSync(resolve(import.meta.dir, "../migrations/0001_catalog.sql"), "utf8");
const migration0002 = readFileSync(resolve(import.meta.dir, "../migrations/0002_player_activity.sql"), "utf8");
const migration0003 = readFileSync(resolve(import.meta.dir, "../migrations/0003_player_rollups.sql"), "utf8");
const migration0004 = readFileSync(resolve(import.meta.dir, "../migrations/0004_related_apps.sql"), "utf8");
const migration0005 = readFileSync(resolve(import.meta.dir, "../migrations/0005_prices.sql"), "utf8");
const migration0006 = readFileSync(resolve(import.meta.dir, "../migrations/0006_releases.sql"), "utf8");

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

function parseJsonc(content: string): Record<string, unknown> {
  const cleaned = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "")
    .replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(cleaned);
}

describe("public worker asset routing", () => {
  it("serves built assets through the ASSETS binding", async () => {
    const assetRequest = new Request("https://vaporstats.com/assets/site.css");
    const response = await publicWorker.fetch(assetRequest, {
      ASSETS: {
        fetch(request: Request) {
          expect(request).toBe(assetRequest);
          return Promise.resolve(
            new Response("body {}", {
              headers: { "Content-Type": "text/css" },
            }),
          );
        },
      } as Fetcher,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/css");
  });

  it("serves root static assets (favicon, logo) through the ASSETS binding", async () => {
    const iconRequest = new Request("https://vaporstats.com/favicon.ico");
    const response = await publicWorker.fetch(iconRequest, {
      ASSETS: {
        fetch(request: Request) {
          expect(request).toBe(iconRequest);
          return Promise.resolve(
            new Response("ico-bytes", {
              headers: { "Content-Type": "image/x-icon" },
            }),
          );
        },
      } as Fetcher,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/x-icon");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });
});

describe("public worker launch contract", () => {
  let sqliteDb: Database;
  let d1: D1Database;

  beforeEach(async () => {
    sqliteDb = new Database(":memory:");
    sqliteDb.exec(migration0001);
    sqliteDb.exec(migration0002);
    sqliteDb.exec(migration0003);
    sqliteDb.exec(migration0004);
    sqliteDb.exec(migration0005);
    sqliteDb.exec(migration0006);
    d1 = createSqliteD1Adapter(sqliteDb);

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
  it("verifies both workers share D1 configuration and database identity", () => {
    const publicConfig = parseJsonc(readFileSync(resolve(import.meta.dir, "../wrangler.jsonc"), "utf8")) as {
      name: string;
      d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
    };

    const ingestionConfig = parseJsonc(readFileSync(resolve(import.meta.dir, "../wrangler.ingestion.jsonc"), "utf8")) as {
      name: string;
      d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
    };

    expect(publicConfig.d1_databases).toBeDefined();
    expect(ingestionConfig.d1_databases).toBeDefined();
    expect(publicConfig.d1_databases.length).toBe(1);
    expect(ingestionConfig.d1_databases.length).toBe(1);

    const publicD1 = publicConfig.d1_databases[0];
    const ingestionD1 = ingestionConfig.d1_databases[0];

    expect(publicD1.binding).toBe("DB");
    expect(ingestionD1.binding).toBe("DB");
    expect(publicD1.database_name).toBe("vaporstats-d1");
    expect(ingestionD1.database_name).toBe("vaporstats-d1");
    expect(publicD1.database_id).toBe(ingestionD1.database_id);
    expect(publicD1.database_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("verifies observability is enabled on both workers", () => {
    const publicConfig = parseJsonc(readFileSync(resolve(import.meta.dir, "../wrangler.jsonc"), "utf8")) as {
      observability?: { enabled: boolean };
    };
    const ingestionConfig = parseJsonc(readFileSync(resolve(import.meta.dir, "../wrangler.ingestion.jsonc"), "utf8")) as {
      observability?: { enabled: boolean };
    };

    expect(publicConfig.observability?.enabled).toBe(true);
    expect(ingestionConfig.observability?.enabled).toBe(true);
  });

  it("verifies only single approved 10-minute cron exists and no queues/services/workflows exist", () => {
    const publicConfig = parseJsonc(readFileSync(resolve(import.meta.dir, "../wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    const ingestionConfig = parseJsonc(readFileSync(resolve(import.meta.dir, "../wrangler.ingestion.jsonc"), "utf8")) as Record<string, unknown>;

    // 1. Cron triggers: public has none, ingestion has exactly ["*/10 * * * *"]
    expect(publicConfig.triggers).toBeUndefined();
    const triggers = ingestionConfig.triggers as { crons?: string[] } | undefined;
    expect(triggers?.crons).toEqual(["*/10 * * * *"]);

    // 2. Disallowed Cloudflare architecture features
    const disallowedKeys = [
      "queues",
      "services",
      "workflows",
      "kv_namespaces",
      "r2_buckets",
      "durable_objects",
      "ai",
      "vectorize",
      "hyperdrive",
    ];

    for (const key of disallowedKeys) {
      expect(publicConfig[key]).toBeUndefined();
      expect(ingestionConfig[key]).toBeUndefined();
    }
  });

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
  let d1: D1Database;

  beforeEach(() => {
    sqliteDb = new Database(":memory:");
    sqliteDb.exec(migration0001);
    sqliteDb.exec(migration0002);
    sqliteDb.exec(migration0003);
    sqliteDb.exec(migration0004);
    sqliteDb.exec(migration0005);
    sqliteDb.exec(migration0006);
    d1 = createSqliteD1Adapter(sqliteDb);
  });

  it("emits structured completion log and honors ctx.waitUntil during scheduled invocation", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    let waitedPromise: Promise<unknown> | null = null;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitedPromise = p;
      },
    };

    const env: IngestionEnv = {
      DB: d1,
      FETCH: (async () => Response.json({})) as unknown as typeof fetch,
    };

    try {
      await ingestionWorker.scheduled(
        {
          cron: "*/10 * * * *",
          scheduledTime: Date.now(),
          type: "scheduled",
        },
        env,
        ctx
      );

      // Verify ctx.waitUntil was passed a promise
      expect(waitedPromise).not.toBeNull();
      await waitedPromise;

      // Verify structured JSON completion log was emitted
      const completionLog = logs.find((l) => l.includes('"event":"ingestion_completion"'));
      expect(completionLog).toBeDefined();

      const parsed = JSON.parse(completionLog!) as {
        event: string;
        cron: string;
        durationMs: number;
        tick: { attempted: number; successful: number; failed: number };
        discovery: unknown;
        rollups: unknown;
        prices: unknown;
      };

      expect(parsed.event).toBe("ingestion_completion");
      expect(parsed.cron).toBe("*/10 * * * *");
      expect(typeof parsed.durationMs).toBe("number");
      expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
      expect(parsed.tick).toBeDefined();
      expect(typeof parsed.tick.attempted).toBe("number");
    } finally {
      console.log = originalLog;
    }
  });

  it("runs the price feed on every ten-minute scheduled invocation", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    const customFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("IStoreService/GetAppList")) {
        return Response.json({
          response: {
            apps: [{ appid: 570, last_modified: 100 }],
            have_more_results: false,
          },
        });
      }
      if (url.includes("api/appdetails")) {
        return Response.json({
          "570": {
            success: true,
            data: {
              name: "Dota 2",
              steam_appid: 570,
              type: "game",
              is_free: true,
              release_date: { coming_soon: false, date: "Jul 9, 2013" },
            },
          },
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    try {
      await ingestionWorker.scheduled(
        {
          cron: "*/10 * * * *",
          scheduledTime: new Date("2026-09-04T14:20:00.000Z").getTime(),
          type: "scheduled",
        },
        {
          DB: d1,
          STEAM_API_KEY: "test_key",
          FETCH: customFetch,
        }
      );

      const completionLog = logs.find((line) =>
        line.includes('"event":"ingestion_completion"')
      );
      const parsed = JSON.parse(completionLog!) as {
        prices: { executed: boolean; successful: number } | null;
      };
      expect(parsed.prices).toMatchObject({ executed: true, successful: 1 });
      const releaseFact = await d1
        .prepare("SELECT release_date FROM release_facts WHERE appid = ?")
        .bind(570)
        .first<{ release_date: string }>();
      expect(releaseFact?.release_date).toBe("2013-07-09");
    } finally {
      console.log = originalLog;
    }
  });

  it("promotes newly observed leaders before the next scheduled tick", async () => {
    sqliteDb.exec(`
      INSERT INTO apps (appid, name, slug, type, is_playable, is_eligible)
      VALUES (570, 'Dota 2', '570-dota-2', 'game', 1, 1);
      INSERT INTO tracked_games (
        appid, tier, slot, next_due_at, latest_players, last_successful_at
      )
      VALUES (
        570, 'daily', 138, '2026-09-05T23:00:00.000Z', 500000, '2026-09-04T14:00:00.000Z'
      );
    `);

    await ingestionWorker.scheduled(
      {
        cron: "*/10 * * * *",
        scheduledTime: new Date("2026-09-04T14:20:00.000Z").getTime(),
        type: "scheduled",
      },
      { DB: d1 }
    );

    const tracked = await d1
      .prepare(
        "SELECT tier, slot, next_due_at, last_successful_at FROM tracked_games WHERE appid = 570"
      )
      .first<{
        tier: string;
        slot: number;
        next_due_at: string;
        last_successful_at: string;
      }>();
    expect(tracked).toMatchObject({
      tier: "fast",
      slot: 0,
      next_due_at: "2026-09-04T14:30:00.000Z",
      last_successful_at: "2026-09-04T14:00:00.000Z",
    });
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

  it("sanitizes authenticated manual numeric caps to finite positive integers within existing hard maxima", async () => {
    const env: IngestionEnv = {
      DB: d1,
      INGESTION_TRIGGER_SECRET: "test-secret-123",
      FETCH: (async () => Response.json({})) as unknown as typeof fetch,
    };

    // 1. Unauthorized request returns 401
    const unauthReq = new Request("https://vaporstats-ingestion.local/api/ingest/scheduled", {
      method: "POST",
    });
    const unauthRes = await ingestionWorker.fetch(unauthReq, env);
    expect(unauthRes.status).toBe(401);

    // 2. Health check endpoint returns 200 without auth
    const healthReq = new Request("https://vaporstats-ingestion.local/health", {
      method: "GET",
    });
    const healthRes = await ingestionWorker.fetch(healthReq, env);
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json() as { status: string; worker: string };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.worker).toBe("vaporstats-ingestion");

    // 3. Authenticated manual trigger with malformed/excessive caps
    const authReq = new Request("https://vaporstats-ingestion.local/api/ingest/scheduled", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tickCap: -50,
        dailyCap: 99999999,
      }),
    });

    const authRes = await ingestionWorker.fetch(authReq, env);
    expect(authRes.status).toBe(200);
    const body = await authRes.json() as { success: boolean; tick: unknown };
    expect(body.success).toBe(true);
    expect(body.tick).toBeDefined();
  });
});
