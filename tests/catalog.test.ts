import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDb, getDb, type AppDatabase, type AppPreparedStatement } from "../src/lib/db";
import {
  listPlayableGames,
  getGameByAppId,
  upsertApp,
  getCheckpoint,
  type CatalogEntity,
} from "../src/lib/catalog";
import {
  CATALOG_REFRESH_CHECKPOINT_KEY,
  queueCatalogRefresh,
  refreshCatalogBatch,
  runBoundedCatalogImport,
  runCatalogSeed,
  type SeedAppInput,
} from "../workers/catalog-seed";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { CACHE_POLICIES } from "../src/lib/cache";
import { toSlug, parseGameSlug, getCanonicalGamePath } from "../src/lib/slug";

const migrationFiles = [
  "0001_catalog.sql",
  "0002_player_activity.sql",
  "0003_player_rollups.sql",
  "0004_related_apps.sql",
  "0005_prices.sql",
  "0006_releases.sql",
  "0007_release_lifecycle.sql",
];
const migrationSql = migrationFiles
  .map((file) => readFileSync(resolve(import.meta.dir, `../migrations/${file}`), "utf8"))
  .join("\n");

/**
 * In-memory SQLite application database adapter for test execution.
 * Isolated to tests so the production database runtime stays behind AppDatabase.
 */
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

function createFreshDb(): AppDatabase {
  const sqlite = new Database(":memory:");
  return createSqliteAppAdapter(sqlite);
}

describe("Catalog Foundation", () => {
  let db: AppDatabase;

  beforeAll(async () => {
    db = createFreshDb();
    await db.exec(migrationSql);
  });

  afterAll(() => {
    console.log("catalog suite complete");
  });

  test("fresh catalog migration", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);


    const previousDatabasePath = process.env.DATABASE_PATH;
    const tempDatabaseDir = mkdtempSync(join(tmpdir(), "vaporstats-catalog-"));
    const tempDatabasePath = join(tempDatabaseDir, "catalog.sqlite");
    process.env.DATABASE_PATH = tempDatabasePath;
    try {
      const openedDb = await getDb();
      expect(await listPlayableGames(openedDb)).toEqual([]);
      expect(await getCheckpoint(openedDb, "nonexistent")).toBeNull();
    } finally {
      try {
        await closeDb();
      } finally {
        if (previousDatabasePath === undefined) {
          delete process.env.DATABASE_PATH;
        } else {
          process.env.DATABASE_PATH = previousDatabasePath;
        }
        rmSync(tempDatabaseDir, { recursive: true, force: true });
      }
    }

    const obtainedDb = await getDb(freshDb);
    expect(obtainedDb).toBe(freshDb);

    // Verify apps table is ready
    await upsertApp(freshDb, {
      appid: 440,
      name: "Team Fortress 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });

    const game = await getGameByAppId(freshDb, 440);
    expect(game).not.toBeNull();
    expect(game?.appid).toBe(440);
    expect(game?.name).toBe("Team Fortress 2");
    expect(game?.slug).toBe("team-fortress-2");
    expect(game?.is_playable).toBe(true);

    // Verify checkpoints table is ready
    const checkpoint = await getCheckpoint(freshDb, "nonexistent");
    expect(checkpoint).toBeNull();

    console.log("fresh catalog migration");
  });

  test("bounded catalog seed", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    // Mock Steam store API response
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("IStoreBrowseService/GetItems")) {
        return Response.json({
          response: {
            store_items: [
              { appid: 730, release: { steam_release_date: "2012-08-21", is_early_access: null } },
              { appid: 570, release: { steam_release_date: "2012-08-21", is_early_access: null } },
              { appid: 440, release: { steam_release_date: "2012-08-21", is_early_access: null } },
            ],
          },
        });
      }
      const match = urlStr.match(/appids=(\d+)/);
      const id = match ? match[1] : "730";

      return new Response(
        JSON.stringify({
          [id]: {
            success: true,
            data: {
              type: "game",
              name: `Steam Game ${id}`,
              steam_appid: parseInt(id, 10),
              is_free: false,
              short_description: `Description for Steam game ${id}`,
              header_image: `https://example.com/${id}.jpg`,
              developers: ["Valve"],
              publishers: ["Valve"],
              release_date: {
                coming_soon: false,
                date: "Aug 21, 2012",
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    // Run bounded catalog import with explicit limit of 3
    const bound = 3;
    const result = await runBoundedCatalogImport(freshDb, {
      limit: bound,
      appIds: [730, 570, 440, 1086940, 1091500],
      checkpointKey: "steam_seed_bound",
      fetchFn: mockFetch,
    });

    expect(result.seededCount).toBe(bound);
    expect(result.lastAppId).toBe(440);

    // Verify checkpoint is recorded
    const checkpoint = await getCheckpoint(freshDb, "steam_seed_bound");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.value).toBe(`seeded:${bound}`);
    expect(checkpoint?.cursor).toBe(440);

    // Verify count in database equals bound and respects ORDER BY appid ASC
    const games = await listPlayableGames(freshDb, { limit: 100 });
    expect(games.length).toBe(bound);
    expect(games.map((g) => g.appid)).toEqual([440, 570, 730]);
    expect(games[0].name).toBe("Steam Game 440");

    console.log("bounded catalog seed");
  });
  test("prefers original release date over Steam release date", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("IStoreBrowseService/GetItems")) {
        return Response.json({
          response: {
            store_items: [
              {
                appid: 339820,
                release: {
                  original_release_date: "2018-06-30",
                  steam_release_date: "2026-08-31",
                  original_steam_release_date: "2018-06-29",
                  release_from_early_access_date: "2018-06-30",
                  is_coming_soon: false,
                  is_early_access: null,
                },
              },
            ],
          },
        });
      }

      return Response.json({
        "339820": {
          success: true,
          data: {
            type: "game",
            name: "Starwalker",
            steam_appid: 339820,
            release_date: { coming_soon: false, date: "Aug 31, 2026" },
          },
        },
      });
    }) as unknown as typeof fetch;

    const result = await runBoundedCatalogImport(freshDb, {
      limit: 1,
      appIds: [339820],
      fetchFn: mockFetch,
    });
    const app = await getGameByAppId(freshDb, 339820);

    expect(result.seededCount).toBe(1);
    expect(app).toMatchObject({
      release_date: "2018-06-30",
      release_date_source: "original_release_date",
      original_release_date: "2018-06-30",
      steam_release_date: "2026-08-31",
      original_steam_release_date: "2018-06-29",
      release_from_early_access_date: "2018-06-30",
      is_early_access: null,
    });
  });
  test("targeted refresh IDs merge and dedupe in the durable queue", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    const first = await queueCatalogRefresh(freshDb, {
      appIds: [339820, 339821, 339820],
    });
    const second = await queueCatalogRefresh(freshDb, {
      appIds: [339821, 339822],
    });
    const repeated = await queueCatalogRefresh(freshDb, {
      appIds: [339820, 339822],
    });
    const checkpoint = await getCheckpoint(freshDb, CATALOG_REFRESH_CHECKPOINT_KEY);

    expect(first).toMatchObject({ queued: 2, alreadyQueued: false });
    expect(second).toMatchObject({ queued: 3, alreadyQueued: false });
    expect(repeated).toMatchObject({ queued: 3, alreadyQueued: true });
    expect(JSON.parse(checkpoint?.value ?? "{}").pending).toEqual([339820, 339821, 339822]);
  });
  test("ordinary refresh failures remain pending", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);
    for (const appid of [339824, 339825]) {
      await upsertApp(freshDb, {
        appid,
        name: appid === 339824 ? "Failed Refresh Game" : "Successful Refresh Game",
        type: "game",
        is_playable: true,
        is_eligible: true,
        release_date: "2026-08-31",
      });
    }

    await queueCatalogRefresh(freshDb, { appIds: [339824, 339825] });
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("IStoreBrowseService/GetItems")) {
        return Response.json({
          response: {
            store_items: [
              { appid: 339824, release: { steam_release_date: "2024-01-01", is_early_access: null } },
              { appid: 339825, release: { steam_release_date: "2024-02-02", is_early_access: null } },
            ],
          },
        });
      }
      const appid = Number(urlStr.match(/appids=(\d+)/)?.[1]);
      if (appid === 339824) {
        return Response.json({ [appid]: { success: false } });
      }
      return Response.json({
        [appid]: {
          success: true,
          data: {
            type: "game",
            name: "Successful Refresh Game",
            steam_appid: appid,
            release_date: { coming_soon: false, date: "2026-08-31" },
          },
        },
      });
    }) as unknown as typeof fetch;

    const refresh = await refreshCatalogBatch(freshDb, {
      successTarget: 1,
      attemptCap: 2,
      fetchFn: mockFetch,
    });
    const checkpoint = await getCheckpoint(freshDb, CATALOG_REFRESH_CHECKPOINT_KEY);
    const successfulApp = await freshDb
      .prepare("SELECT release_date FROM apps WHERE appid = ?")
      .bind(339825)
      .first<{ release_date: string }>();

    expect(refresh).toMatchObject({ attempted: 2, successful: 1, failed: 1, pending: 1, active: true });
    expect(successfulApp?.release_date).toBe("2024-02-02");
    expect(JSON.parse(checkpoint?.value ?? "{}").pending).toEqual([339824]);
  });
  test("catalog refresh preserves current and unattempted IDs after a Steam rate limit", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);
    for (const appid of [339823, 339824, 339825]) {
      await upsertApp(freshDb, {
        appid,
        name: "Rate Limited Game",
        type: "game",
        is_playable: true,
        is_eligible: true,
        release_date: "2026-08-31",
      });
    }

    await queueCatalogRefresh(freshDb, { appIds: [339823, 339824, 339825] });
    const mockFetch = (async (url: string | URL | Request) => {
      if (url.toString().includes("IStoreBrowseService/GetItems")) {
        return Response.json({
          response: {
            store_items: [
              { appid: 339823, release: { steam_release_date: "2026-08-31", is_early_access: null } },
              { appid: 339824, release: { steam_release_date: "2026-08-31", is_early_access: null } },
              { appid: 339825, release: { steam_release_date: "2026-08-31", is_early_access: null } },
            ],
          },
        });
      }
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch;
    const refresh = await refreshCatalogBatch(freshDb, { fetchFn: mockFetch });
    const checkpoint = await getCheckpoint(freshDb, CATALOG_REFRESH_CHECKPOINT_KEY);

    expect(refresh).toMatchObject({ active: true, rateLimited: true, attempted: 1, pending: 3 });
    expect(JSON.parse(checkpoint?.value ?? "{}").pending).toEqual([339823, 339824, 339825]);
  });



  test("playable catalog only", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    // Seed playable games and accessory peers (DLC, server, tool, ineligible)
    await upsertApp(freshDb, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(freshDb, {
      appid: 2322010,
      name: "Counter-Strike 2 Dedicated Server",
      type: "tool",
      is_playable: false,
      is_eligible: true,
      parent_appid: 730,
    });
    await upsertApp(freshDb, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(freshDb, {
      appid: 2138330,
      name: "Cyberpunk 2077: Phantom Liberty",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
    });
    await upsertApp(freshDb, {
      appid: 99999,
      name: "Internal Test App",
      type: "game",
      is_playable: true,
      is_eligible: false, // Ineligible
    });

    const catalog = await listPlayableGames(freshDb);
    const appIds = catalog.map((g) => g.appid);

    expect(appIds).toContain(730);
    expect(appIds).toContain(1091500);
    // Accessory entities must not be top-level catalog peers
    expect(appIds).not.toContain(2322010); // Dedicated server
    expect(appIds).not.toContain(2138330); // Expansion
    expect(appIds).not.toContain(99999); // Ineligible app

    for (const item of catalog) {
      expect(item.is_playable).toBe(true);
      expect(item.is_eligible).toBe(true);
      expect(item.parent_appid).toBeNull();
    }

    // Direct game lookup must reject accessory apps as top-level entities
    const accessoryGame = await getGameByAppId(freshDb, 2322010);
    expect(accessoryGame).toBeNull();

    const dlcGame = await getGameByAppId(freshDb, 2138330);
    expect(dlcGame).toBeNull();

    console.log("playable catalog only");
  });

  test("canonical game response", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    await upsertApp(freshDb, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
      description: "Tactical first-person shooter.",
    });

    const req = new Request("https://vaporstats.com/games/730-counter-strike-2");
    const res = await handleGameHttpRequest(req, freshDb);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);

    const body = await res.text();
    expect(body).toContain("Counter-Strike 2");
    expect(body).toContain("730");

    console.log("canonical game response");
  });

  test("appid authoritative routing", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    await upsertApp(freshDb, {
      appid: 570,
      name: "Dota 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(freshDb, {
      appid: 888,
      name: "Ineligible Closed Beta",
      type: "game",
      is_playable: true,
      is_eligible: false,
    });
    await upsertApp(freshDb, {
      appid: 2322010,
      name: "Dota 2 Dedicated Server",
      type: "tool",
      is_playable: false,
      is_eligible: true,
      parent_appid: 570,
    });

    // 1. Stale / mistyped slug redirects to canonical URL (301)
    const staleReq = new Request("https://vaporstats.com/games/570-wrong-stale-slug");
    const staleRes = await handleGameHttpRequest(staleReq, freshDb);
    expect(staleRes.status).toBe(301);
    expect(staleRes.headers.get("Location")).toBe("/games/570-dota-2");

    // 2. Slug with AppID only redirects to canonical URL (301)
    const bareAppIdReq = new Request("https://vaporstats.com/games/570");
    const bareRes = await handleGameHttpRequest(bareAppIdReq, freshDb);
    expect(bareRes.status).toBe(301);
    expect(bareRes.headers.get("Location")).toBe("/games/570-dota-2");

    // 3. Unknown AppID returns 404
    const unknownReq = new Request("https://vaporstats.com/games/9999999-no-game");
    const unknownRes = await handleGameHttpRequest(unknownReq, freshDb);
    expect(unknownRes.status).toBe(404);

    // 4. Ineligible AppID returns 404
    const ineligibleReq = new Request("https://vaporstats.com/games/888-ineligible-closed-beta");
    const ineligibleRes = await handleGameHttpRequest(ineligibleReq, freshDb);
    expect(ineligibleRes.status).toBe(404);

    // 5. Accessory AppID returns 404 for top-level game route
    const accessoryReq = new Request("https://vaporstats.com/games/2322010-dota-2-dedicated-server");
    const accessoryRes = await handleGameHttpRequest(accessoryReq, freshDb);
    expect(accessoryRes.status).toBe(404);

    // 6. Malformed slug returns 404
    const malformedReq = new Request("https://vaporstats.com/games/not-a-valid-appid");
    const malformedRes = await handleGameHttpRequest(malformedReq, freshDb);
    expect(malformedRes.status).toBe(404);

    console.log("appid authoritative routing");
  });

  test("unobserved game state", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    // Eligible game with NO observations
    await upsertApp(freshDb, {
      appid: 1086940,
      name: "Baldur's Gate 3",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });

    const game = await getGameByAppId(freshDb, 1086940);
    expect(game).not.toBeNull();
    // In the catalog, an unobserved entity has latest_players as null, not zero
    expect(game?.latest_players).toBeNull();

    const req = new Request("https://vaporstats.com/games/1086940-baldurs-gate-3");
    const res = await handleGameHttpRequest(req, freshDb);
    expect(res.status).toBe(200);

    const html = await res.text();
    // Must render "No data yet"
    expect(html).toContain("No data yet");
    expect(html).toContain('data-testid="no-data-state"');

    console.log("unobserved game state");
  });

  test("generation and cache boundary", async () => {
    const freshDb = createFreshDb();
    await freshDb.exec(migrationSql);

    await upsertApp(freshDb, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });

    // Parameterized entity SSR route has 1-hour s-maxage, 24-hour SWR
    const entityReq = new Request("https://vaporstats.com/games/730-counter-strike-2");
    const entityRes = await handleGameHttpRequest(entityReq, freshDb);
    expect(entityRes.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
    );

    // Fixed route shell cache policies remain distinct from parameterized entity cache
    expect(CACHE_POLICIES.entity).toBe(
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
    );
    expect(CACHE_POLICIES.liveApi).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60"
    );
    expect(CACHE_POLICIES.entity).not.toBe("public, max-age=0, must-revalidate");

    // Ingestion seeding preserves cache contracts and does not mutate route definitions
    await runBoundedCatalogImport(freshDb, {
      limit: 1,
      apps: [{ appid: 730, name: "Counter-Strike 2", is_playable: true, is_eligible: true }],
    });
    const postSeedRes = await handleGameHttpRequest(entityReq, freshDb);
    expect(postSeedRes.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
    );

    console.log("generation and cache boundary");
  });
});
