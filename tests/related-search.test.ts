import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import React from "react";
import { renderToString } from "react-dom/server";
import { type AppDatabase, type AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import {
  listPlayableGames,
  getGameByAppId,
  upsertApp,
  type CatalogEntity,
} from "../src/lib/catalog";
import {
  normalizeAppType,
  isAccessoryType,
  upsertAppRelationship,
  getRelatedApps,
  getChildApp,
  getCanonicalChildPath,
  parseChildSlug,
  searchCatalog,
  createApiDataResponse,
  createApiEmptyResponse,
  createApiErrorResponse,
  type RelatedAppEntity,
  type GroupedRelatedApps,
} from "../src/lib/related";
import { toSlug, parseGameSlug, getCanonicalGamePath } from "../src/lib/slug";
import { CACHE_POLICIES } from "../src/lib/cache";
import { RelatedApps } from "../src/components/related-apps";
import { SearchForm } from "../src/components/search-form";
import { SiteHeader } from "../src/components/site-header";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { ChildAppPageView } from "../src/components/child-app-page";
import { handleChildHttpRequest } from "../src/routes/games.$game_.$child";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { SearchResultsPageView } from "../src/components/search-page";
import { handleSearchHttpRequest } from "../src/routes/search";
import { handleSearchApiRequest } from "../src/routes/api.search";

function createSqliteAppAdapter(db: Database, stats?: { firstCalls: number }): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let boundValues: unknown[] = [];

      const statement = {
        bind(...values: unknown[]): AppPreparedStatement {
          boundValues = values;
          return statement;
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          if (stats) stats.firstCalls++;
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
  applyMigrations(sqlite);
  const appDb = createSqliteAppAdapter(sqlite);
  return appDb;
}

async function initDb(): Promise<AppDatabase> {
  return createFreshDb();
}

describe("Related Apps and Search", () => {
  afterAll(() => {
    console.log("related search suite complete");
  });

  test("relationship classification", async () => {
    const db = await initDb();

    // 1. Verify app type normalization handles all required types
    expect(normalizeAppType("expansion")).toBe("expansion");
    expect(normalizeAppType("major_expansion")).toBe("expansion");
    expect(normalizeAppType("dlc")).toBe("dlc");
    expect(normalizeAppType("downloadable_content")).toBe("dlc");
    expect(normalizeAppType("music")).toBe("soundtrack");
    expect(normalizeAppType("soundtrack")).toBe("soundtrack");
    expect(normalizeAppType("server")).toBe("server");
    expect(normalizeAppType("dedicated_server")).toBe("server");
    expect(normalizeAppType("tool")).toBe("tool");
    expect(normalizeAppType("demo")).toBe("demo");
    expect(normalizeAppType("beta")).toBe("test");
    expect(normalizeAppType("test")).toBe("test");
    expect(normalizeAppType("other")).toBe("other");
    expect(normalizeAppType("unknown_custom_type")).toBe("other");

    // 2. Persist parent game
    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
      description: "Open-world action adventure RPG.",
    });

    // 3. Persist every required app type related to Cyberpunk 2077
    const relatedSpecs = [
      { appid: 2138330, name: "Cyberpunk 2077: Phantom Liberty", type: "expansion", prominence: 1 },
      { appid: 1091501, name: "Cyberpunk 2077: Quadra Sport Pack", type: "dlc", prominence: 0 },
      { appid: 1091502, name: "Cyberpunk 2077 Official Soundtrack", type: "soundtrack", prominence: 0 },
      { appid: 1091503, name: "Cyberpunk 2077 Dedicated Server", type: "server", prominence: 0 },
      { appid: 1091504, name: "Cyberpunk 2077 REDmod Tool", type: "tool", prominence: 0 },
      { appid: 1091505, name: "Cyberpunk 2077 Demo", type: "demo", prominence: 0 },
      { appid: 1091506, name: "Cyberpunk 2077 Beta Test", type: "test", prominence: 0 },
      { appid: 1091507, name: "Cyberpunk 2077 Bonus Wallpapers", type: "other", prominence: 0 },
    ];

    for (const spec of relatedSpecs) {
      await upsertApp(db, {
        appid: spec.appid,
        name: spec.name,
        type: spec.type,
        is_playable: false,
        is_eligible: true,
        parent_appid: 1091500,
      });

      await upsertAppRelationship(db, {
        parent_appid: 1091500,
        child_appid: spec.appid,
        relationship_type: spec.type,
        prominence: spec.prominence,
      });
    }

    // 4. Retrieve grouped related apps and verify all classifications
    const grouped = await getRelatedApps(db, 1091500);
    expect(grouped.total_count).toBe(8);
    expect(grouped.expansions.length).toBe(1);
    expect(grouped.expansions[0].appid).toBe(2138330);
    expect(grouped.expansions[0].type).toBe("expansion");
    expect(grouped.expansions[0].prominence).toBeGreaterThanOrEqual(1);

    expect(grouped.dlc.length).toBe(1);
    expect(grouped.dlc[0].appid).toBe(1091501);

    expect(grouped.soundtracks.length).toBe(1);
    expect(grouped.soundtracks[0].appid).toBe(1091502);

    expect(grouped.servers.length).toBe(1);
    expect(grouped.servers[0].appid).toBe(1091503);

    expect(grouped.tools.length).toBe(1);
    expect(grouped.tools[0].appid).toBe(1091504);

    expect(grouped.demos.length).toBe(1);
    expect(grouped.demos[0].appid).toBe(1091505);

    expect(grouped.tests.length).toBe(1);
    expect(grouped.tests[0].appid).toBe(1091506);

    expect(grouped.other.length).toBe(1);
    expect(grouped.other[0].appid).toBe(1091507);

    console.log("relationship classification");
  });

  test("parent related grouping", async () => {
    const db = await initDb();

    // Setup parent game with expansion and ordinary DLC
    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(db, {
      appid: 2138330,
      name: "Cyberpunk 2077: Phantom Liberty",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 2138330,
      relationship_type: "expansion",
      prominence: 2,
    });
    await upsertApp(db, {
      appid: 1091501,
      name: "Cyberpunk 2077: Cosmetic Pack",
      type: "dlc",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 1091501,
      relationship_type: "dlc",
      prominence: 0,
    });

    const parent = await getGameByAppId(db, 1091500);
    expect(parent).not.toBeNull();
    const grouped = await getRelatedApps(db, 1091500);

    expect(grouped.expansions.length).toBe(1);
    expect(grouped.dlc.length).toBe(1);

    // Render RelatedApps component and verify expansion promotion
    const html = renderToString(React.createElement(RelatedApps, { parent: parent!, grouped }));
    // Verification of expansion prominence in rendered HTML
    expect(html).toContain("Major Expansions &amp; Content");
    expect(html).toContain("Phantom Liberty");
    expect(html).toContain("Major Expansion");
    expect(html).toContain("border-orange-500");

    // Ordinary DLC is present in separate section
    expect(html).toContain("Downloadable Content (DLC)");
    expect(html).toContain("Cosmetic Pack");

    // Canonical link rendered correctly
    expect(html).toContain("/games/1091500-cyberpunk-2077/2138330-cyberpunk-2077-phantom-liberty");

    // Root stale-slug redirects retain validated graph, price, and event state.
    const staleRootReq = new Request(
      "https://vaporstats.com/games/1091500-old-cyberpunk?range=2&pricerange=2&event=full-release-2023",
    );
    const staleRootRes = await handleGameHttpRequest(staleRootReq, db);
    expect(staleRootRes.status).toBe(301);
    expect(staleRootRes.headers.get("Location")).toBe(
      "/games/1091500-cyberpunk-2077?range=2&pricerange=2&event=full-release-2023",
    );

    console.log("parent related grouping");
  });

  test("canonical child route", async () => {
    const db = await initDb();

    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
      developer: "CD PROJEKT RED",
      publisher: "CD PROJEKT RED",
    });
    await upsertApp(db, {
      appid: 2138330,
      name: "Cyberpunk 2077: Phantom Liberty",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
      release_date: "2023-09-26",
      steam_release_date: "2023-09-26",
      original_release_date: "2023-09-26",
      original_steam_release_date: "2023-09-26",
      release_from_early_access_date: "2023-09-26",
      release_date_source: "steam_release_date",
      is_early_access: false,
      has_left_early_access: true,
      description: "Phantom Liberty is a spy-thriller expansion for Cyberpunk 2077.",
      header_image: "https://example.com/phantom-header.jpg",
      header_lqip: "data:image/png;base64,header",
      icon_hash: "phantom-icon-hash",
      icon_lqip: "data:image/png;base64,icon",
      developer: "CD PROJEKT RED",
      publisher: "CD PROJEKT RED",
      metacritic_score: 89,
      metacritic_url: "https://www.metacritic.com/game/phantom-liberty/",
      metacritic_observed_at: "2026-09-01T00:00:00Z",
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 2138330,
      relationship_type: "expansion",
      prominence: 1,
    });
    await db
      .prepare(
        "INSERT INTO app_release_events (appid, event_type, source, event_date) VALUES (?, ?, ?, ?)",
      )
      .bind(2138330, "early_access", "original_steam_release_date", "2022-12-01")
      .run();
    await db
      .prepare(
        "INSERT INTO app_release_events (appid, event_type, source, event_date) VALUES (?, ?, ?, ?)",
      )
      .bind(2138330, "full_release", "release_from_early_access_date", "2023-09-26")
      .run();
    await db
      .prepare(
        "INSERT INTO app_release_events (appid, event_type, source, event_date) VALUES (?, ?, ?, ?)",
      )
      .bind(2138330, "patch", "original_release_date", "2024-01-15")
      .run();


    const req = new Request(
      "https://vaporstats.com/games/1091500-cyberpunk-2077/2138330-cyberpunk-2077-phantom-liberty?pricerange=2"
    );
    const res = await handleChildHttpRequest(req, db);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);

    const body = await res.text();
    expect(body).toContain("Cyberpunk 2077: Phantom Liberty");
    expect(body).toContain("Cyberpunk 2077");
    expect(body).toContain("AppID #");
    expect(body).toContain("2138330");
    expect(body.replace(/<!--.*?-->/g, "")).toContain("AppID #2138330");
    expect(body).toContain("Subordinate Related Entity");
    expect(body).toContain("Major Expansion");
    expect(body).toContain("/games/1091500-cyberpunk-2077");
    expect(body).not.toContain("Media matches");
    expect(body).toMatch(/aria-pressed="true"[^>]*>6m<\/button>/);

    const detailRes = await handleGameDetailRequest(
      new Request("https://vaporstats.com/api/games/2138330/detail"),
      db,
      2138330,
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      data: {
        game: {
          appid: number;
          release_date: string | null;
          steam_release_date: string | null;
          original_release_date: string | null;
          original_steam_release_date: string | null;
          release_from_early_access_date: string | null;
          is_early_access: boolean | null;
          has_left_early_access: boolean | null;
          header_lqip: string | null;
          icon_hash: string | null;
          icon_lqip: string | null;
          metacritic_score: number | null;
          metacritic_url: string | null;
          release_events: Array<{ event_type: string; event_date: string; source: string }>;
        };
        mediaMatches: unknown[];
        mediaMatchPaths: Record<string, string>;
      };
    };
    expect(detailJson.data.game.appid).toBe(2138330);
    expect(detailJson.data.game.release_date).toBe("2023-09-26");
    expect(detailJson.data.game.steam_release_date).toBe("2023-09-26");
    expect(detailJson.data.game.original_release_date).toBe("2023-09-26");
    expect(detailJson.data.game.original_steam_release_date).toBe("2023-09-26");
    expect(detailJson.data.game.release_from_early_access_date).toBe("2023-09-26");
    expect(detailJson.data.game.is_early_access).toBe(false);
    expect(detailJson.data.game.has_left_early_access).toBe(true);
    expect(detailJson.data.game.header_lqip).toBe("data:image/png;base64,header");
    expect(detailJson.data.game.icon_hash).toBe("phantom-icon-hash");
    expect(detailJson.data.game.icon_lqip).toBe("data:image/png;base64,icon");
    expect(detailJson.data.game.metacritic_score).toBe(89);
    expect(detailJson.data.game.metacritic_url).toBe("https://www.metacritic.com/game/phantom-liberty/");
    expect(detailJson.data.game.release_events).toEqual([
      { event_type: "patch", event_date: "2024-01-15", source: "original_release_date" },
      { event_type: "full_release", event_date: "2023-09-26", source: "release_from_early_access_date" },
    ]);
    expect(detailJson.data.mediaMatches).toEqual([]);
    expect(detailJson.data.mediaMatchPaths).toEqual({});

    const childResult = await getChildApp(db, 1091500, 2138330);
    expect(childResult).not.toBeNull();
    const childMatches = [
      {
        dimension: "gameplay" as const,
        similarity: 0.9,
        matchedGame: { appid: 730, name: "Counter-Strike 2", slug: "counter-strike-2" },
      },
      {
        dimension: "story_world" as const,
        similarity: 0.8,
        matchedGame: { appid: 2138331, name: "Another Expansion", slug: "another-expansion" },
      },
    ];
    const childPageHtml = renderToString(
      React.createElement(ChildAppPageView, {
        parent: childResult!.parent,
        child: childResult!.child,
        mediaMatches: childMatches,
        mediaMatchPaths: {
          730: "/games/730-counter-strike-2",
          2138331: "/games/1091500-cyberpunk-2077/2138331-another-expansion",
        },
      }),
    );
    expect(childPageHtml).toContain("Media matches");
    expect(childPageHtml).toContain("Gameplay &amp; systems");
    expect(childPageHtml).toContain("Story &amp; world");
    expect(childPageHtml).toContain('href="/games/730-counter-strike-2"');
    expect(childPageHtml).toContain(
      'href="/games/1091500-cyberpunk-2077/2138331-another-expansion"',
    );
    const childPageWithoutMatches = renderToString(
      React.createElement(ChildAppPageView, {
        parent: childResult!.parent,
        child: childResult!.child,
        mediaMatches: [],
        mediaMatchPaths: {},
      }),
    );
    expect(childPageWithoutMatches).not.toContain("Media matches");
    console.log("canonical child route");
  });

  test("child route authority", async () => {
    const db = await initDb();

    // Seed parent 1091500 with child 2138330
    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(db, {
      appid: 2138330,
      name: "Cyberpunk 2077: Phantom Liberty",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 2138330,
      relationship_type: "expansion",
    });

    // Seed second parent 730 with dedicated server 2322010
    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(db, {
      appid: 2322010,
      name: "Counter-Strike 2 Dedicated Server",
      type: "server",
      is_playable: false,
      is_eligible: true,
      parent_appid: 730,
    });
    await upsertAppRelationship(db, {
      parent_appid: 730,
      child_appid: 2322010,
      relationship_type: "server",
    });
    // A relationship row must not override a conflicting direct parent.
    await upsertApp(db, {
      appid: 2138331,
      name: "Conflicting Phantom Liberty",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: 730,
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 2138331,
      relationship_type: "expansion",
    });

    // Relationship-only children remain valid when no direct parent exists.
    await upsertApp(db, {
      appid: 2138332,
      name: "Relationship Only Expansion",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: null,
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 2138332,
      relationship_type: "expansion",
    });

    const conflictingRelated = await getRelatedApps(db, 1091500);
    expect(conflictingRelated.expansions.map((child) => child.appid)).not.toContain(2138331);
    expect((await getRelatedApps(db, 730)).expansions.map((child) => child.appid)).toContain(2138331);
    expect(await getChildApp(db, 1091500, 2138331)).toBeNull();
    expect(await getChildApp(db, 730, 2138331)).not.toBeNull();
    expect(await getChildApp(db, 1091500, 2138332)).not.toBeNull();
    expect(getCanonicalChildPath(730, "Counter-Strike 2", 2138331, "Conflicting Phantom Liberty")).toBe(
      "/games/730-counter-strike-2/2138331-conflicting-phantom-liberty",
    );
    expect(parseChildSlug(
      "730-counter-strike-2",
      "2138331-conflicting-phantom-liberty",
    )).toEqual({
      parentAppId: 730,
      parentSlug: "counter-strike-2",
      childAppId: 2138331,
      childSlug: "conflicting-phantom-liberty",
    });

    const conflictingUnderA = await handleChildHttpRequest(
      new Request(
        "https://vaporstats.com/games/1091500-cyberpunk-2077/2138331-conflicting-phantom-liberty",
      ),
      db,
    );
    expect(conflictingUnderA.status).toBe(404);
    const conflictingUnderB = await handleChildHttpRequest(
      new Request(
        "https://vaporstats.com/games/730-counter-strike-2/2138331-conflicting-phantom-liberty",
      ),
      db,
    );
    expect(conflictingUnderB.status).toBe(200);


    const relationshipOnlyRoute = await handleChildHttpRequest(
      new Request(
        "https://vaporstats.com/games/1091500-cyberpunk-2077/2138332-relationship-only-expansion",
      ),
      db,
    );
    expect(relationshipOnlyRoute.status).toBe(200);

    // 1. Stale child slug triggers 301 redirect to canonical URL
    const staleChildReq = new Request(
      "https://vaporstats.com/games/1091500-cyberpunk-2077/2138330-stale-slug"
    );
    const staleChildRes = await handleChildHttpRequest(staleChildReq, db);
    expect(staleChildRes.status).toBe(301);
    expect(staleChildRes.headers.get("Location")).toBe(
      "/games/1091500-cyberpunk-2077/2138330-cyberpunk-2077-phantom-liberty"
    );

    // 2. Stale parent slug triggers 301 redirect to canonical URL
    const staleParentReq = new Request(
      "https://vaporstats.com/games/1091500-old-parent/2138330-cyberpunk-2077-phantom-liberty"
    );
    const staleParentRes = await handleChildHttpRequest(staleParentReq, db);
    expect(staleParentRes.status).toBe(301);
    expect(staleParentRes.headers.get("Location")).toBe(
      "/games/1091500-cyberpunk-2077/2138330-cyberpunk-2077-phantom-liberty"
    );

    // 3. Mismatched parent-child pair (child 2138330 requested under parent 730) returns 404
    const mismatchReq = new Request(
      "https://vaporstats.com/games/730-counter-strike-2/2138330-cyberpunk-2077-phantom-liberty"
    );
    const mismatchRes = await handleChildHttpRequest(mismatchReq, db);
    expect(mismatchRes.status).toBe(404);

    // 4. Nonexistent child AppID returns 404
    const nonChildReq = new Request(
      "https://vaporstats.com/games/1091500-cyberpunk-2077/9999999-missing-child"
    );
    const nonChildRes = await handleChildHttpRequest(nonChildReq, db);
    expect(nonChildRes.status).toBe(404);

    // 5. Nonexistent parent AppID returns 404
    const nonParentReq = new Request(
      "https://vaporstats.com/games/9999999-missing-parent/2138330-phantom-liberty"
    );
    const nonParentRes = await handleChildHttpRequest(nonParentReq, db);
    expect(nonParentRes.status).toBe(404);

    console.log("child route authority");
  });

  test("accessory hierarchy", async () => {
    const db = await initDb();

    // Playable root game
    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });

    // Accessories with parent_appid
    await upsertApp(db, {
      appid: 2322010,
      name: "Counter-Strike 2 Dedicated Server",
      type: "server",
      is_playable: false,
      is_eligible: true,
      parent_appid: 730,
    });
    await upsertAppRelationship(db, {
      parent_appid: 730,
      child_appid: 2322010,
      relationship_type: "server",
    });

    await upsertApp(db, {
      appid: 731,
      name: "Counter-Strike 2 SDK",
      type: "tool",
      is_playable: false,
      is_eligible: true,
      parent_appid: 730,
    });
    await upsertAppRelationship(db, {
      parent_appid: 730,
      child_appid: 731,
      relationship_type: "tool",
    });

    // 1. Playable catalog list MUST NOT contain accessory peers
    const catalog = await listPlayableGames(db);
    const catalogIds = catalog.map((g) => g.appid);
    expect(catalogIds).toContain(730);
    expect(catalogIds).not.toContain(2322010);
    expect(catalogIds).not.toContain(731);

    // 2. Direct playable game lookup for an accessory ID MUST return null
    const serverGame = await getGameByAppId(db, 2322010);
    expect(serverGame).toBeNull();

    const toolGame = await getGameByAppId(db, 731);
    expect(toolGame).toBeNull();

    // 3. Accessory app is accessible only under its parent
    const childResult = await getChildApp(db, 730, 2322010);
    expect(childResult).not.toBeNull();
    expect(childResult?.parent.appid).toBe(730);
    expect(childResult?.child.appid).toBe(2322010);
    expect(childResult?.child.type).toBe("server");

    console.log("accessory hierarchy");
  });

  test("navigation search contract", async () => {
    // 1. Verify permanent navigation exposes four sections
    const headerHtml = renderToString(React.createElement(SiteHeader));
    expect(headerHtml).toContain('href="/games"');
    expect(headerHtml).toContain("Games");

    expect(headerHtml).toContain('href="/rankings"');
    expect(headerHtml).toContain("Rankings");

    expect(headerHtml).toContain('href="/deals"');
    expect(headerHtml).toContain("Deals");

    expect(headerHtml).toContain('href="/releases"');
    expect(headerHtml).toContain("Releases");

    // 2. Verify search form in header
    expect(headerHtml).toContain('action="/search"');
    expect(headerHtml).toContain('name="q"');

    // 3. Verify standalone SearchForm accessibility and contract
    const searchFormHtml = renderToString(
      React.createElement(SearchForm, { initialQuery: "Counter-Strike", size: "large" })
    );
    expect(searchFormHtml).toContain('role="search"');
    expect(searchFormHtml).toContain('action="/search"');
    expect(searchFormHtml).toContain('name="q"');
    expect(searchFormHtml).toContain('value="Counter-Strike"');
    expect(searchFormHtml).toContain('aria-label="Search games or AppID"');
    expect(searchFormHtml).toContain('type="submit"');

    console.log("navigation search contract");
  });

  test("playable first search", async () => {
    const db = await initDb();

    // Seed playable games
    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
      description: "An open-world action-adventure story.",
    });
    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      type: "game",
      is_playable: true,
      is_eligible: true,
      description: "Tactical first-person shooter.",
    });

    // Seed accessories under Cyberpunk
    await upsertApp(db, {
      appid: 2138330,
      name: "Cyberpunk 2077: Phantom Liberty",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 2138330,
      relationship_type: "expansion",
      prominence: 1,
    });

    await upsertApp(db, {
      appid: 1091502,
      name: "Cyberpunk 2077 Official Soundtrack",
      type: "soundtrack",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
    });
    await upsertAppRelationship(db, {
      parent_appid: 1091500,
      child_appid: 1091502,
      relationship_type: "soundtrack",
    });

    // Seed accessory under Counter-Strike
    await upsertApp(db, {
      appid: 2322010,
      name: "Counter-Strike 2 Dedicated Server",
      type: "server",
      is_playable: false,
      is_eligible: true,
      parent_appid: 730,
    });
    await upsertAppRelationship(db, {
      parent_appid: 730,
      child_appid: 2322010,
      relationship_type: "server",
    });

    // Case 1: Search "cyberpunk" matches game and its related apps
    const resCyberpunk = await searchCatalog(db, "cyberpunk");
    expect(resCyberpunk.items.length).toBe(1);
    expect(resCyberpunk.items[0].game.appid).toBe(1091500);
    expect(resCyberpunk.items[0].game.is_playable).toBe(true);

    // Matching related apps nested under Cyberpunk 2077
    const relatedUnderCyberpunk = resCyberpunk.items[0].matching_related;
    expect(relatedUnderCyberpunk.length).toBe(2);
    const childIds = relatedUnderCyberpunk.map((c) => c.appid);
    expect(childIds).toContain(2138330);
    expect(childIds).toContain(1091502);

    // Case 2: Search "phantom liberty" matches accessory only:
    // MUST return parent game at top level with child nested beneath it!
    const resPhantom = await searchCatalog(db, "phantom liberty");
    expect(resPhantom.items.length).toBe(1);
    expect(resPhantom.items[0].game.appid).toBe(1091500); // Parent game Cyberpunk
    expect(resPhantom.items[0].matching_related.length).toBe(1);
    expect(resPhantom.items[0].matching_related[0].appid).toBe(2138330);

    // Case 3: Search "dedicated server" matches accessory only:
    // MUST return parent game Counter-Strike 2 at top level with server nested!
    const resServer = await searchCatalog(db, "dedicated server");
    expect(resServer.items.length).toBe(1);
    expect(resServer.items[0].game.appid).toBe(730);
    expect(resServer.items[0].matching_related.length).toBe(1);
    expect(resServer.items[0].matching_related[0].appid).toBe(2322010);

    // Case 4: Test SSR Search HTTP handler
    const searchHttpReq = new Request("https://vaporstats.com/search?q=cyberpunk");
    const searchHttpRes = await handleSearchHttpRequest(searchHttpReq, db);
    expect(searchHttpRes.status).toBe(200);
    expect(searchHttpRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);

    const searchHtml = await searchHttpRes.text();
    expect(searchHtml).toContain("Cyberpunk 2077");
    expect(searchHtml).toContain("Phantom Liberty");
    expect(searchHtml).toContain("Matching Related Content");

    console.log("playable first search");
  });

  test("groups matching accessories under each parent without parent fetches", async () => {
    const sqlite = new Database(":memory:");
    const stats = { firstCalls: 0 };
    applyMigrations(sqlite);
    const db = createSqliteAppAdapter(sqlite, stats);

    await upsertApp(db, {
      appid: 100,
      name: "Alpha Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    await upsertApp(db, {
      appid: 200,
      name: "Beta Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });
    for (const app of [
      { appid: 101, name: "Alpha Dedicated Server", parent_appid: 100 },
      { appid: 102, name: "Alpha Dedicated Server Tools", parent_appid: 100 },
      { appid: 201, name: "Beta Dedicated Server", parent_appid: 200 },
    ]) {
      await upsertApp(db, {
        ...app,
        type: "server",
        is_playable: false,
        is_eligible: true,
      });
    }

    const result = await searchCatalog(db, "dedicated server");
    expect(result.items).toHaveLength(2);
    const alpha = result.items.find((item) => item.game.appid === 100);
    const beta = result.items.find((item) => item.game.appid === 200);
    expect(alpha?.matching_related.map((child) => child.appid).sort()).toEqual([101, 102]);
    expect(beta?.matching_related.map((child) => child.appid)).toEqual([201]);
    expect(stats.firstCalls).toBe(0);
  });

  test("search response outcomes", async () => {
    const db = await initDb();

    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
    });

    // 1. Empty query outcome: 200 with status: "empty"
    const emptyReq = new Request("https://vaporstats.com/api/search?q=");
    const emptyRes = await handleSearchApiRequest(emptyReq, db);
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const emptyJson = (await emptyRes.json()) as { status: string; data: unknown; source_timestamp: string };
    expect(emptyJson.status).toBe("empty");
    expect(emptyJson.data).toBeNull();
    expect(typeof emptyJson.source_timestamp).toBe("string");

    // 2. Query with no matches: 200 with status: "empty"
    const noMatchReq = new Request("https://vaporstats.com/api/search?q=nonexistent_game_xyz");
    const noMatchRes = await handleSearchApiRequest(noMatchReq, db);
    expect(noMatchRes.status).toBe(200);
    expect(noMatchRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const noMatchJson = (await noMatchRes.json()) as { status: string; data: unknown; source_timestamp: string };
    expect(noMatchJson.status).toBe("empty");
    expect(noMatchJson.data).toBeNull();
    expect(typeof noMatchJson.source_timestamp).toBe("string");

    // 3. Query with matches: 200 with status: "data"
    const matchReq = new Request("https://vaporstats.com/api/search?q=cyberpunk");
    const matchRes = await handleSearchApiRequest(matchReq, db);
    expect(matchRes.status).toBe(200);
    expect(matchRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const matchJson = (await matchRes.json()) as { status: string; data: { items: Array<{ game: { appid: number } }> }; source_timestamp: string };
    expect(matchJson.status).toBe("data");
    expect(matchJson.data.items.length).toBeGreaterThan(0);
    expect(matchJson.data.items[0].game.appid).toBe(1091500);
    expect(typeof matchJson.source_timestamp).toBe("string");

    // 4. API helpers check
    const helperDataRes = createApiDataResponse({ test: true });
    expect(helperDataRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const helperDataJson = (await helperDataRes.json()) as { status: string; data: { test: boolean } };
    expect(helperDataJson.status).toBe("data");
    expect(helperDataJson.data.test).toBe(true);

    const helperEmptyRes = createApiEmptyResponse("No data yet");
    expect(helperEmptyRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const helperEmptyJson = (await helperEmptyRes.json()) as { status: string; message: string };
    expect(helperEmptyJson.status).toBe("empty");
    expect(helperEmptyJson.message).toBe("No data yet");

    const helperErrorRes = createApiErrorResponse("Service failure", 500);
    expect(helperErrorRes.status).toBe(500);
    expect(helperErrorRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);
    const helperErrorJson = (await helperErrorRes.json()) as { status: string; error: string };
    expect(helperErrorJson.status).toBe("error");
    expect(helperErrorJson.error).toBe("Service failure");

    console.log("search response outcomes");
  });
});
