import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { type AppDatabase, type AppPreparedStatement } from "../src/lib/db";
import { upsertApp, type CatalogEntity } from "../src/lib/catalog";
import {
  parsePreciseReleaseDate,
  getIsoWeekString,
  getCurrentIsoWeek,
  parseIsoWeek,
  isReleaseEntityEligible,
  deriveReleaseStatus,
  upsertReleaseFact,
  getReleasesForWeek,
  getRecentReleases,
  getCurrentWeekReleases,
  createReleaseDataResponse,
  createReleaseEmptyResponse,
  createReleaseErrorResponse,
  type ReleaseEntity,
  type WeeklyReleasesResult,
} from "../src/lib/releases";
import {
  syncReleaseFactsFromApps,
  type SyncReleaseFactsResult,
} from "../workers/release-facts";
import {
  ReleaseCalendar,
  HomeReleaseCalendarSection,
  ReleaseCard,
} from "../src/components/release-calendar";
import {
  RecentReleases,
  HomeRecentReleasesSection,
} from "../src/components/recent-releases";
import {
  handleReleasesIndexHttpRequest,
  resolveCurrentReleaseWeek,
} from "../src/routes/releases.index";
import {
  handleWeekReleasesHttpRequest,
  loadReleaseWeekData,
  ReleasesWeekPageView,
  ReleaseWeekNotFoundView,
} from "../src/routes/releases.$week";
import { handleReleasesApiRequest } from "../src/routes/api.releases";
import { HomeComponent, type HomeComponentProps } from "../src/routes/index";
import { runBoundedCatalogImport } from "../workers/catalog-seed";
import { CACHE_POLICIES } from "../src/lib/cache";
const migration0001 = readFileSync(
  resolve(import.meta.dir, "../migrations/0001_catalog.sql"),
  "utf8"
);
const migration0002 = readFileSync(
  resolve(import.meta.dir, "../migrations/0002_player_activity.sql"),
  "utf8"
);
const migration0004Path = resolve(import.meta.dir, "../migrations/0004_related_apps.sql");
const migration0004 = existsSync(migration0004Path) ? readFileSync(migration0004Path, "utf8") : "";
const migration0005Path = resolve(import.meta.dir, "../migrations/0005_prices.sql");
const migration0005 = existsSync(migration0005Path) ? readFileSync(migration0005Path, "utf8") : "";
const migration0006 = readFileSync(
  resolve(import.meta.dir, "../migrations/0006_releases.sql"),
  "utf8"
);
const migration0007 = readFileSync(
  resolve(import.meta.dir, "../migrations/0007_release_lifecycle.sql"),
  "utf8"
);

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
            success: true as const,
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
            success: true as const,
            results,
            meta: {
              changes: 0,
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
      const results = [];
      for (const s of statements) {
        results.push(await s.all<T>());
      }
      return results;
    },
    async exec(query: string) {
      db.run(query);
      return { count: 0, duration: 0 };
    },
  };
}

async function initTestDb(): Promise<AppDatabase> {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON;");
  sqlite.run(migration0001);
  sqlite.run(migration0002);
  if (migration0004) {
    sqlite.run(migration0004);
  }
  if (migration0005) {
    sqlite.run(migration0005);
  }
  sqlite.run(migration0006);
  sqlite.run(migration0007);
  return createSqliteAppAdapter(sqlite);
}

describe("Releases Discovery and Calendar", () => {
  afterAll(() => {
    console.log("releases suite complete");
  });

  // G1: ingestion persists precise eligible release dates without inventing imprecise dates
  test("precise release facts", async () => {
    // 1. Verify parser rules:
    // Precise dates parsed to ISO YYYY-MM-DD
    expect(parsePreciseReleaseDate("2026-09-04")).toBe("2026-09-04");
    expect(parsePreciseReleaseDate("4 Sep, 2026")).toBe("2026-09-04");
    expect(parsePreciseReleaseDate("Sep 4, 2026")).toBe("2026-09-04");
    expect(parsePreciseReleaseDate("September 4, 2026")).toBe("2026-09-04");
    expect(parsePreciseReleaseDate("18 Aug, 2020")).toBe("2020-08-18");
    expect(parsePreciseReleaseDate("Aug 18, 2020")).toBe("2020-08-18");

    // Imprecise dates MUST return null (never invent dates!)
    expect(parsePreciseReleaseDate("2026")).toBeNull();
    expect(parsePreciseReleaseDate("Q3 2026")).toBeNull();
    expect(parsePreciseReleaseDate("Q1 2025")).toBeNull();
    expect(parsePreciseReleaseDate("September 2026")).toBeNull();
    expect(parsePreciseReleaseDate("Sep 2026")).toBeNull();
    expect(parsePreciseReleaseDate("Coming soon")).toBeNull();
    expect(parsePreciseReleaseDate("To be announced")).toBeNull();
    expect(parsePreciseReleaseDate("TBA")).toBeNull();
    expect(parsePreciseReleaseDate("")).toBeNull();
    expect(parsePreciseReleaseDate(null)).toBeNull();

    // Invalid calendar dates rejected
    expect(parsePreciseReleaseDate("2026-02-30")).toBeNull(); // Feb 30 does not exist
    expect(parsePreciseReleaseDate("2026-04-31")).toBeNull(); // Apr 31 does not exist

    // 2. Ingestion into DB via release-facts worker
    const db = await initTestDb();

    // Insert catalog apps: some precise, some imprecise
    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "Dec 10, 2020",
    });

    await upsertApp(db, {
      appid: 2138330,
      name: "Phantom Liberty",
      type: "expansion",
      is_playable: false,
      is_eligible: true,
      parent_appid: 1091500,
      release_date: "2023-09-26",
    });

    // Imprecise apps
    await upsertApp(db, {
      appid: 900001,
      name: "Imprecise Year Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2026",
    });

    await upsertApp(db, {
      appid: 900002,
      name: "Imprecise Quarter Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "Q4 2026",
    });

    await upsertApp(db, {
      appid: 900003,
      name: "Coming Soon Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "Coming Soon",
    });

    // Run ingestion
    const syncRes: SyncReleaseFactsResult = await syncReleaseFactsFromApps(db);
    expect(syncRes.processedCount).toBe(5);
    expect(syncRes.persistedCount).toBe(2); // Only Cyberpunk and Phantom Liberty
    expect(syncRes.skippedImpreciseCount).toBe(3); // 900001, 900002, 900003

    // Verify persisted rows in release_facts
    const fact1 = await db
      .prepare("SELECT * FROM release_facts WHERE appid = ?")
      .bind(1091500)
      .first<{ release_date: string; release_week: string; is_precise: number }>();
    expect(fact1).not.toBeNull();
    expect(fact1?.release_date).toBe("2020-12-10");
    expect(fact1?.release_week).toBe("2020-W50");
    expect(fact1?.is_precise).toBe(1);

    const fact2 = await db
      .prepare("SELECT * FROM release_facts WHERE appid = ?")
      .bind(2138330)
      .first<{ release_date: string; release_week: string }>();
    expect(fact2).not.toBeNull();
    expect(fact2?.release_date).toBe("2023-09-26");
    expect(fact2?.release_week).toBe("2023-W39");

    // Verify consumer child entity canonical path with parent context
    const week2023W39 = await getReleasesForWeek(db, "2023-W39");
    expect(week2023W39).not.toBeNull();
    const phantom = week2023W39?.days.flatMap((d) => d.entities).find((e) => e.appid === 2138330);
    expect(phantom).toBeDefined();
    expect(phantom?.parent_appid).toBe(1091500);
    expect(phantom?.parent_name).toBe("Cyberpunk 2077");
    expect(phantom?.canonical_path).toBe("/games/1091500-cyberpunk-2077/2138330-phantom-liberty");

    // Ensure imprecise apps are NEVER persisted
    const factImprecise = await db
      .prepare("SELECT * FROM release_facts WHERE appid = ?")
      .bind(900001)
      .first();
    expect(factImprecise).toBeNull();
    // 2b. Bounded helper guarantees: clamp limit/offset and slice options.apps
    const manyApps = Array.from({ length: 10 }, (_, i) => ({
      appid: 800000 + i,
      name: `Bounded App ${i}`,
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2026-09-04",
    }));

    // Bounded with explicit limit: 3 -> only 3 processed
    const boundedRes = await syncReleaseFactsFromApps(db, {
      apps: manyApps,
      limit: 3,
    });
    expect(boundedRes.processedCount).toBe(3);
    expect(boundedRes.persistedCount).toBe(3);

    // Negative limit clamped to 1
    const clampedNegRes = await syncReleaseFactsFromApps(db, {
      apps: manyApps,
      limit: -10,
    });
    expect(clampedNegRes.processedCount).toBe(1);

    // Catalog seed bounding:
    // limit=1 with parent 730 does not overflow to 2 (root takes the 1 slot, children capacity is 0)
    const seedLimit1 = await runBoundedCatalogImport(db, {
      limit: 1,
      apps: [{ appid: 730, name: "Counter-Strike 2", is_playable: true, is_eligible: true, release_date: "2012-08-21" }],
    });
    expect(seedLimit1.seededCount).toBe(1);
    expect(seedLimit1.records.length).toBe(1);

    // NaN limit clamped to default 50
    const seedNanLimit = await runBoundedCatalogImport(db, {
      limit: NaN,
      apps: [{ appid: 730, name: "Counter-Strike 2", is_playable: true, is_eligible: true }],
    });
    expect(seedNanLimit.seededCount).toBe(2); // 730 + attached curated child 740
    expect(seedNanLimit.seededCount).toBeLessThanOrEqual(50);
    // Huge limit clamped to 50
    const seedHugeLimit = await runBoundedCatalogImport(db, {
      limit: 9999,
      apps: [{ appid: 730, name: "Counter-Strike 2", is_playable: true, is_eligible: true }],
    });
    expect(seedHugeLimit.seededCount).toBe(2); // 730 + attached curated child 740
    expect(seedHugeLimit.seededCount).toBeLessThanOrEqual(50);
    // Custom children exceeding remaining capacity are sliced so total <= limit
    const customChildren = Array.from({ length: 10 }, (_, i) => ({
      appid: 888000 + i,
      parentAppId: 730,
      name: `Extra Child ${i}`,
      relationshipType: "expansion" as const,
      prominence: 1,
    }));
    const seedCustomChild = await runBoundedCatalogImport(db, {
      limit: 3,
      apps: [{ appid: 730, name: "Counter-Strike 2", is_playable: true, is_eligible: true }],
      children: customChildren,
    });
    expect(seedCustomChild.records.length).toBeLessThanOrEqual(3);
    expect(seedCustomChild.seededCount).toBeLessThanOrEqual(3);


    console.log("precise release facts");
  });
  test("release lifecycle events re-sync idempotently and preserve patches", async () => {
    const db = await initTestDb();
    await upsertApp(db, {
      appid: 990001,
      name: "Lifecycle Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2024-06-20",
      original_release_date: "2024-01-15",
      original_steam_release_date: "2024-01-15",
      release_from_early_access_date: "2024-06-20",
      is_early_access: false,
    });
    await db
      .prepare("INSERT INTO app_release_events (appid, event_type, source, event_date) VALUES (?, 'patch', 'original_release_date', ?)")
      .bind(990001, "2024-03-10")
      .run();

    const firstSync = await syncReleaseFactsFromApps(db);
    const firstEvents = await db
      .prepare(
        "SELECT event_type, event_date, source FROM app_release_events WHERE appid = ? ORDER BY event_type, event_date"
      )
      .bind(990001)
      .all<{ event_type: string; event_date: string; source: string }>();
    const secondSync = await syncReleaseFactsFromApps(db);
    const secondEvents = await db
      .prepare(
        "SELECT event_type, event_date, source FROM app_release_events WHERE appid = ? ORDER BY event_type, event_date"
      )
      .bind(990001)
      .all<{ event_type: string; event_date: string; source: string }>();

    expect(firstSync.persistedCount).toBe(1);
    expect(secondSync.persistedCount).toBe(1);
    expect(firstEvents.results).toEqual([
      { event_type: "early_access", event_date: "2024-01-15", source: "original_steam_release_date" },
      { event_type: "full_release", event_date: "2024-06-20", source: "release_from_early_access_date" },
      { event_type: "patch", event_date: "2024-03-10", source: "original_release_date" },
    ]);
    expect(secondEvents.results).toEqual(firstEvents.results);
  });

  test("release week loader fetches its client-safe API", async () => {
    const requests: string[] = [];
    const result = await loadReleaseWeekData(
      "2026-W36",
      (async (input: string | URL | Request) => {
        requests.push(String(input));
        return Response.json({
          status: "empty",
          data: null,
          message: "No releases found for week 2026-W36",
          source_timestamp: "2026-09-04T00:00:00.000Z",
        });
      }) as typeof fetch
    );

    expect(requests).toEqual(["/api/releases?week=2026-W36"]);
    expect(result.week).toBe("2026-W36");
    expect(result.data.days).toHaveLength(7);
  });

  // G2: the Releases root resolves to the current Monday-through-Sunday week
  test("current release week", async () => {
    const db = await initTestDb();

    // Test with anchor date 2026-09-04 (Friday)
    const asOf = "2026-09-04";
    const current = resolveCurrentReleaseWeek(asOf);

    expect(current.week).toBe("2026-W36");
    expect(current.startDate).toBe("2026-08-31"); // Monday
    expect(current.endDate).toBe("2026-09-06");   // Sunday
    expect(current.canonicalPath).toBe("/releases/2026-W36");

    // HTTP handler for /releases redirects (307) to canonical shareable route
    const req = new Request(`https://vaporstats.com/releases?as_of=${asOf}`);
    const res = await handleReleasesIndexHttpRequest(req, db);

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("/releases/2026-W36");
    expect(res.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);

    // Direct render option (?render=true) returns 200 HTML
    const renderReq = new Request(`https://vaporstats.com/releases?as_of=${asOf}&render=true`);
    const renderRes = await handleReleasesIndexHttpRequest(renderReq, db);
    expect(renderRes.status).toBe(200);
    expect(renderRes.headers.get("Content-Type")).toContain("text/html");
    const html = await renderRes.text();
    expect(html).toContain("2026-W36");
    expect(html).toContain("2026-08-31");
    expect(html).toContain("2026-09-06");

    console.log("current release week");
  });

  // G3: canonical ISO-week pages expose previous and next week navigation
  test("iso week navigation", async () => {
    const db = await initTestDb();

    // 1. Check week boundary logic
    const bounds = parseIsoWeek("2026-W36");
    expect(bounds).not.toBeNull();
    expect(bounds?.week).toBe("2026-W36");
    expect(bounds?.prevWeek).toBe("2026-W35");
    expect(bounds?.nextWeek).toBe("2026-W37");

    // Year boundary week 1
    const w01Bounds = parseIsoWeek("2026-W01");
    expect(w01Bounds).not.toBeNull();
    expect(w01Bounds?.prevWeek).toBe("2025-W52");
    expect(w01Bounds?.nextWeek).toBe("2026-W02");

    // 2. HTTP response for canonical week page
    const req = new Request("https://vaporstats.com/releases/2026-W36?as_of=2026-09-04");
    const res = await handleWeekReleasesHttpRequest(req, "2026-W36", db);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);
    const html = await res.text();

    // Navigation links present in rendered HTML
    expect(html).toContain('href="/releases/2026-W35"');
    expect(html).toContain('href="/releases/2026-W37"');
    expect(html).toContain('data-testid="week-navigation"');
    expect(html).toContain('data-testid="prev-week-link"');
    expect(html).toContain('data-testid="next-week-link"');

    // Strict validation: invalid week format returns 404 with noStore
    const invalidReq = new Request("https://vaporstats.com/releases/invalid-week");
    const invalidRes = await handleWeekReleasesHttpRequest(invalidReq, "invalid-week", db);
    expect(invalidRes.status).toBe(404);
    expect(invalidRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    const outOfBoundsReq = new Request("https://vaporstats.com/releases/2026-W99");
    const outOfBoundsRes = await handleWeekReleasesHttpRequest(outOfBoundsReq, "2026-W99", db);
    expect(outOfBoundsRes.status).toBe(404);

    console.log("iso week navigation");
  });

  // G4: release days group eligible entities and derive Released or Upcoming status
  test("release day status", async () => {
    const db = await initTestDb();

    // Seed releases in week 2026-W36 (Mon Aug 31 – Sun Sep 06)
    // As-of date is 2026-09-04 (Friday)
    // Past/Current:
    // Tue 2026-09-01 -> Released
    // Fri 2026-09-04 -> Released
    // Future:
    // Sat 2026-09-05 -> Upcoming
    // Sun 2026-09-06 -> Upcoming

    await upsertReleaseFact(
      db,
      {
        appid: 1001,
        name: "Tuesday Released Game",
        type: "game",
        release_date: "2026-09-01",
      },
      "2026-09-04"
    );

    await upsertReleaseFact(
      db,
      {
        appid: 1002,
        name: "Friday Launch Day Game",
        type: "game",
        release_date: "2026-09-04",
      },
      "2026-09-04"
    );

    await upsertReleaseFact(
      db,
      {
        appid: 1003,
        name: "Saturday Upcoming Game",
        type: "game",
        release_date: "2026-09-05",
      },
      "2026-09-04"
    );

    const result = await getReleasesForWeek(db, "2026-W36", { asOfDate: "2026-09-04" });
    expect(result).not.toBeNull();
    expect(result!.days.length).toBe(7);

    // Day 0: Monday 2026-08-31
    expect(result!.days[0].date).toBe("2026-08-31");
    expect(result!.days[0].status).toBe("released");
    expect(result!.days[0].entities.length).toBe(0);

    // Day 1: Tuesday 2026-09-01
    expect(result!.days[1].date).toBe("2026-09-01");
    expect(result!.days[1].status).toBe("released");
    expect(result!.days[1].entities.length).toBe(1);
    expect(result!.days[1].entities[0].name).toBe("Tuesday Released Game");
    expect(result!.days[1].entities[0].release_status).toBe("released");

    // Day 4: Friday 2026-09-04 (Today)
    expect(result!.days[4].date).toBe("2026-09-04");
    expect(result!.days[4].status).toBe("released");
    expect(result!.days[4].entities.length).toBe(1);
    expect(result!.days[4].entities[0].name).toBe("Friday Launch Day Game");
    expect(result!.days[4].entities[0].release_status).toBe("released");

    // Day 5: Saturday 2026-09-05 (Tomorrow)
    expect(result!.days[5].date).toBe("2026-09-05");
    expect(result!.days[5].status).toBe("upcoming");
    expect(result!.days[5].entities.length).toBe(1);
    expect(result!.days[5].entities[0].name).toBe("Saturday Upcoming Game");
    expect(result!.days[5].entities[0].release_status).toBe("upcoming");

    // Verify rendered HTML has data-status attributes and badges
    const html = renderToString(React.createElement(ReleasesWeekPageView, { data: result! }));
    expect(html).toContain('data-status="released"');
    expect(html).toContain('data-status="upcoming"');
    expect(html).toContain("Tuesday Released Game");
    expect(html).toContain("Saturday Upcoming Game");

    console.log("release day status");
  });

  // G5: entities without precise dates stay out of specific week views
  test("imprecise date exclusion", async () => {
    const db = await initTestDb();

    // Directly attempt to upsert imprecise date entities
    const u1 = await upsertReleaseFact(db, {
      appid: 2001,
      name: "Imprecise Year",
      type: "game",
      release_date: "2026",
    });
    expect(u1).toBe(false);

    const u2 = await upsertReleaseFact(db, {
      appid: 2002,
      name: "Imprecise Month",
      type: "game",
      release_date: "September 2026",
    });
    expect(u2).toBe(false);

    const u3 = await upsertReleaseFact(db, {
      appid: 2003,
      name: "Imprecise Quarter",
      type: "game",
      release_date: "Q3 2026",
    });
    expect(u3).toBe(false);

    const u4 = await upsertReleaseFact(db, {
      appid: 2004,
      name: "Imprecise Null",
      type: "game",
      release_date: null,
    });
    expect(u4).toBe(false);

    // Verify that none of these exist in week 2026-W36 (or any week)
    const weekResult = await getReleasesForWeek(db, "2026-W36");
    expect(weekResult?.totalCount).toBe(0);

    console.log("imprecise date exclusion");
  });

  // G6: home discovery contains current-week and separate recent-release sections
  test("home release sections", async () => {
    const db = await initTestDb();

    // Populate a release
    await upsertReleaseFact(
      db,
      {
        appid: 3001,
        name: "Home Featured Game",
        type: "game",
        release_date: "2026-09-02",
      },
      "2026-09-04"
    );

    const weekData = await getReleasesForWeek(db, "2026-W36", { asOfDate: "2026-09-04" });
    const recentData = await getRecentReleases(db, { asOfDate: "2026-09-04" });

    // 1. Render HomeReleaseCalendarSection
    const calendarSectionHtml = renderToString(
      React.createElement(HomeReleaseCalendarSection, { data: weekData! })
    );
    expect(calendarSectionHtml).toContain("This Week&#x27;s Releases");
    expect(calendarSectionHtml).toContain("Home Featured Game");
    expect(calendarSectionHtml).toContain('href="/releases"');
    expect(calendarSectionHtml).toContain('data-testid="release-calendar"');

    // 2. Render HomeRecentReleasesSection
    const recentSectionHtml = renderToString(
      React.createElement(HomeRecentReleasesSection, { releases: recentData })
    );
    expect(recentSectionHtml).toContain("Recent Releases");
    expect(recentSectionHtml).toContain("Home Featured Game");
    // 3. Render actual integrated HomeComponent
    const homeHtml = renderToString(
      React.createElement<HomeComponentProps>(HomeComponent, {
        initialTrending: [
          {
            appid: 3001,
            name: "Home Featured Game",
            slug: "home-featured-game",
            current_players: 1250,
            rank: 1,
            last_observed_at: "2026-09-04T12:00:00Z",
            relative_age: "4 hours ago",
            exact_utc: "2026-09-04 12:00:00 UTC",
          },
        ],
        initialDeals: [
          {
            appid: 3001,
            name: "Home Featured Game",
            slug: "home-featured-game",
            type: "game",
            parent_appid: null,
            parent_name: null,
            parent_slug: null,
            initial_price: 2999,
            final_price: 1499,
            discount_percent: 50,
            currency: "USD",
            is_free: false,
            formatted_initial: "$29.99",
            formatted_final: "$14.99",
            header_image: "",
            observed_at: "2026-09-04T12:00:00Z",
          },
        ],
        totalDeals: 1,
        currentWeekReleases: weekData,
        recentReleases: recentData,
      })
    );

    // Verify HomeComponent integrates both release sections after Trending and Deals
    expect(homeHtml).toContain('data-testid="trending-block"');
    expect(homeHtml).toContain('data-testid="home-deals-section"');
    expect(homeHtml).toContain('data-testid="home-current-week-releases"');
    expect(homeHtml).toContain('data-testid="home-recent-releases"');
    expect(homeHtml).toContain("This Week&#x27;s Releases");
    expect(homeHtml).toContain("Recent Releases");

    console.log("home release sections");
  });

  // G7: accessory app types remain absent from independent release cards
  test("release entity eligibility", async () => {
    // 1. Test isReleaseEntityEligible function:
    // 1. Playable root games: must have type "game", playable, and no parent
    expect(isReleaseEntityEligible("game", true, true, null)).toBe(true);
    // Arbitrary or non-game root types are rejected even if marked playable
    expect(isReleaseEntityEligible("tool", true, true, null)).toBe(false);
    expect(isReleaseEntityEligible("hardware", true, true, null)).toBe(false);
    expect(isReleaseEntityEligible("application", true, true, null)).toBe(false);
    expect(isReleaseEntityEligible("video", true, true, null)).toBe(false);
    expect(isReleaseEntityEligible("unknown", true, true, null)).toBe(false);
    // Root game cannot have a parent
    expect(isReleaseEntityEligible("game", true, true, 730)).toBe(false);

    // 2. Consumer DLC and Expansions: must have a parent game
    expect(isReleaseEntityEligible("dlc", true, false, 730)).toBe(true);
    expect(isReleaseEntityEligible("expansion", true, false, 730)).toBe(true);
    // DLC/expansion without parent is rejected
    expect(isReleaseEntityEligible("dlc", true, false, null)).toBe(false);
    expect(isReleaseEntityEligible("expansion", true, false, null)).toBe(false);

    // 3. Accessories are strictly excluded:
    expect(isReleaseEntityEligible("server", true, false, 730)).toBe(false);
    expect(isReleaseEntityEligible("dedicated_server", true, false, 730)).toBe(false);
    expect(isReleaseEntityEligible("tool", true, false, 730)).toBe(false);
    expect(isReleaseEntityEligible("demo", true, false, 730)).toBe(false);
    expect(isReleaseEntityEligible("test", true, false, 730)).toBe(false);
    expect(isReleaseEntityEligible("soundtrack", true, false, 730)).toBe(false);
    expect(isReleaseEntityEligible("music", true, false, 730)).toBe(false);

    // 4. Ineligible apps are strictly excluded
    expect(isReleaseEntityEligible("game", false, true, null)).toBe(false);
    expect(isReleaseEntityEligible("dlc", false, false, 730)).toBe(false);
    // 2. Database ingestion prevents accessories from becoming release facts
    const db = await initTestDb();

    // Dedicated server with precise date
    const s1 = await upsertReleaseFact(db, {
      appid: 2322010,
      name: "Counter-Strike 2 Dedicated Server",
      type: "server",
      parent_appid: 730,
      release_date: "2023-09-27",
    });
    expect(s1).toBe(false);

    // Soundtrack with precise date
    const s2 = await upsertReleaseFact(db, {
      appid: 1091502,
      name: "Cyberpunk 2077 Soundtrack",
      type: "soundtrack",
      parent_appid: 1091500,
      release_date: "2020-12-10",
    });
    expect(s2).toBe(false);

    // Tool with precise date
    const s3 = await upsertReleaseFact(db, {
      appid: 9991,
      name: "SDK Tool",
      type: "tool",
      parent_appid: 730,
      release_date: "2026-09-04",
    });
    expect(s3).toBe(false);

    // Demo with precise date
    const s4 = await upsertReleaseFact(db, {
      appid: 9992,
      name: "Action Game Demo",
      type: "demo",
      parent_appid: 1001,
      release_date: "2026-09-04",
    });
    expect(s4).toBe(false);

    // Check release facts table is completely empty of these accessories
    const count = await db
      .prepare("SELECT COUNT(*) as c FROM release_facts")
      .first<{ c: number }>();
    expect(count?.c).toBe(0);

    console.log("release entity eligibility");
  });

  // G8: release responses distinguish empty data from failure and carry caching
  test("release response outcomes", async () => {
    const db = await initTestDb();

    await upsertReleaseFact(
      db,
      {
        appid: 4001,
        name: "Release API Test Game",
        type: "game",
        release_date: "2026-09-04",
      },
      "2026-09-04"
    );

    // 1. Data outcome: 200 with status: "data", data object, live API cache headers
    const dataReq = new Request("https://vaporstats.com/api/releases?week=2026-W36&as_of=2026-09-04");
    const dataRes = await handleReleasesApiRequest(dataReq, db);
    expect(dataRes.status).toBe(200);
    expect(dataRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const dataJson = (await dataRes.json()) as { status: string; data: { week: string; totalCount: number }; source_timestamp: string };
    expect(dataJson.status).toBe("data");
    expect(dataJson.data.week).toBe("2026-W36");
    expect(dataJson.data.totalCount).toBe(1);
    expect(typeof dataJson.source_timestamp).toBe("string");

    // 2. Empty outcome: week with no releases returns 200 with status: "empty"
    const emptyReq = new Request("https://vaporstats.com/api/releases?week=2026-W01&as_of=2026-09-04");
    const emptyRes = await handleReleasesApiRequest(emptyReq, db);
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const emptyJson = (await emptyRes.json()) as { status: string; data: unknown; message: string; source_timestamp: string };
    expect(emptyJson.status).toBe("empty");
    expect(emptyJson.data).toBeNull();
    expect(typeof emptyJson.message).toBe("string");
    expect(typeof emptyJson.source_timestamp).toBe("string");

    // 3. Error outcome: malformed week returns 400 with status: "error" and noStore cache
    const errorReq = new Request("https://vaporstats.com/api/releases?week=invalid-week-param");
    const errorRes = await handleReleasesApiRequest(errorReq, db);
    expect(errorRes.status).toBe(400);
    expect(errorRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);
    const errorJson = (await errorRes.json()) as { status: string; error: string };
    expect(errorJson.status).toBe("error");
    expect(typeof errorJson.error).toBe("string");

    // 3b. Error outcome: invalid as_of returns 400 with status: "error" and noStore cache
    const invalidAsOfReq = new Request("https://vaporstats.com/api/releases?as_of=invalid-date-xyz");
    const invalidAsOfRes = await handleReleasesApiRequest(invalidAsOfReq, db);
    expect(invalidAsOfRes.status).toBe(400);
    expect(invalidAsOfRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);
    const invalidAsOfJson = (await invalidAsOfRes.json()) as { status: string; error: string };
    expect(invalidAsOfJson.status).toBe("error");
    expect(invalidAsOfJson.error).toContain("Invalid as_of date parameter");

    // 4. Recent releases type: /api/releases?type=recent
    const recentReq = new Request("https://vaporstats.com/api/releases?type=recent&as_of=2026-09-04");
    const recentRes = await handleReleasesApiRequest(recentReq, db);
    expect(recentRes.status).toBe(200);
    expect(recentRes.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const recentJson = (await recentRes.json()) as { status: string; data: Array<{ name: string }> };
    expect(recentJson.status).toBe("data");
    expect(Array.isArray(recentJson.data)).toBe(true);
    expect(recentJson.data.length).toBe(1);
    expect(recentJson.data[0].name).toBe("Release API Test Game");

    // 5. Direct helper tests
    const hData = createReleaseDataResponse({ ok: true });
    expect(hData.status).toBe(200);
    expect(hData.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const hDataJson = (await hData.json()) as { status: string };
    expect(hDataJson.status).toBe("data");

    const hEmpty = createReleaseEmptyResponse("No releases");
    expect(hEmpty.status).toBe(200);
    expect(hEmpty.headers.get("Cache-Control")).toBe(CACHE_POLICIES.liveApi);
    const hEmptyJson = (await hEmpty.json()) as { status: string };
    expect(hEmptyJson.status).toBe("empty");

    const hErr = createReleaseErrorResponse("Internal error", 500);
    expect(hErr.status).toBe(500);
    expect(hErr.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);
    const hErrJson = (await hErr.json()) as { status: string };
    expect(hErrJson.status).toBe("error");

    console.log("release response outcomes");
  });
});
