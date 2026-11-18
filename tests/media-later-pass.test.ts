import { afterEach, describe, expect, test } from "bun:test";
import { MEDIA_OUTLETS, type MediaSource } from "../src/lib/media-discovery";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  controlledGeminiApi,
  controlledOpenRouterApi,
  controlledTavilyApi,
  CYBERPUNK,
  discoveryArticleHtml,
  GAME_NAMES,
  HADES_II,
  runMediaTick,
  seedApps,
  type MediaTickOptions,
} from "./support/media";

// The later assessment pass at the ingestion-tick seam: one temporary SQLite
// file, a controlled clock, and controlled Tavily, outlet, OpenRouter and
// Gemini APIs. Nothing reaches a real provider.

const cleanups: Array<() => void> = [];
const environment = { artifacts: process.env.RECEPTION_ARTIFACT_DIR, overviewPublic: process.env.MEDIA_OVERVIEW_PUBLIC };
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const [name, value] of [["RECEPTION_ARTIFACT_DIR", environment.artifacts], ["MEDIA_OVERVIEW_PUBLIC", environment.overviewPublic]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const EXPERIMENT = [BALDURS_GATE, CYBERPUNK, HADES_II];
type Outlet = (typeof MEDIA_OUTLETS)[number];

function experimentCatalog(): TestDatabase {
  const database = openTestDatabase("vaporstats-media-later-");
  cleanups.push(database.cleanup);
  seedApps(database.native, EXPERIMENT);
  return database;
}

function articleUrl(appid: number, outlet: Outlet, suffix = ""): string {
  return `https://${outlet.domain}/articles/${appid}-${outlet.domain.replaceAll(".", "-")}${suffix}`;
}

function outletOf(url: string): Outlet {
  return MEDIA_OUTLETS.find(({ domain }) => new URL(url).hostname === domain)!;
}

/**
 * Controlled providers and outlets. Each entity's first search on an outlet
 * finds its initial article, published 2026-11-10; every later search finds
 * `later(appid, outlet)`'s results, by default one later review published
 * 2026-11-19. `pages` overrides an article page by URL.
 */
function world(options: { later?: (appid: number, outlet: Outlet) => Array<{ url: string; published_date?: string }> } = {}) {
  const tavily = controlledTavilyApi();
  const openRouter = controlledOpenRouterApi();
  const gemini = controlledGeminiApi();
  const searchCounts = new Map<string, number>();
  const later = options.later ?? ((appid, outlet) => [{ url: articleUrl(appid, outlet, "-revisited") }]);
  tavily.results = ({ appid, domain }) => {
    const key = `${appid}@${domain}`;
    const count = (searchCounts.get(key) ?? 0) + 1;
    searchCounts.set(key, count);
    const outlet = MEDIA_OUTLETS.find((item) => item.domain === domain)!;
    return count === 1 ? [{ url: articleUrl(appid, outlet) }] : later(appid, outlet);
  };
  const pages = new Map<string, () => Response>();
  const fetched: string[] = [];
  const page = (url: string, html: string) => pages.set(url, () => new Response(html));
  for (const appid of EXPERIMENT) {
    for (const outlet of MEDIA_OUTLETS) {
      page(articleUrl(appid, outlet), discoveryArticleHtml(appid, `${GAME_NAMES[appid]} Review`, { date: "2026-11-10T00:00:00.000Z", author: `${outlet.name} critic` }));
      page(articleUrl(appid, outlet, "-revisited"), discoveryArticleHtml(appid, `${GAME_NAMES[appid]} Review Revisited`, { date: "2026-11-19T00:00:00.000Z", author: `${outlet.name} critic` }));
    }
  }
  const outlet = (url: string) => pages.get(url)?.();
  return {
    providers: { tavily, openRouter, gemini },
    tavily,
    openRouter,
    gemini,
    fetched,
    page,
    pages,
    tick(database: TestDatabase, at: string, tickOptions: MediaTickOptions = {}) {
      return runMediaTick(database, { tavily, openRouter, gemini }, at, { outlet, fetched, paidSubmissionsPerTick: 60, ...tickOptions });
    },
  };
}

/** The query each search sent, as `<query>@<domain>`. */
function queries(tavily: ReturnType<typeof controlledTavilyApi>): string[] {
  return tavily.requests.map(({ body }) => {
    const payload = JSON.parse(String(body)) as { query: string; include_domains: string[] };
    return `${payload.query}@${payload.include_domains[0]}`;
  });
}

async function detail(database: TestDatabase, appid: number) {
  const response = await handleGameDetailRequest(new Request(`https://vaporstats.test/api/games/${appid}/detail`), database.db, appid);
  expect(response.status).toBe(200);
  return (await response.json() as { data: { sources: MediaSource[]; mediaOverview: { statements: Array<{ text: string; sourceUrls: string[] }>; tags: Array<{ slug: string }> } | null } }).data;
}

describe("when the later pass is due", () => {
  test("an experiment game's later pass is due at the first daily media run after its initial discovery finished, searches each represented outlet once with the documented wording, and never runs again", async () => {
    const database = experimentCatalog();
    const { tavily, tick } = world();

    await tick(database, "2026-11-20T06:00:00.000Z");
    await tick(database, "2026-11-20T06:15:00.000Z");

    // The initial pass finished during November 20's daily media run.
    expect(queries(tavily)).toHaveLength(18);
    expect(queries(tavily).every((query) => / review preview@/.test(query))).toBe(true);

    await tick(database, "2026-11-21T06:00:00.000Z");

    const later = queries(tavily).slice(18);
    expect(later.sort()).toEqual(EXPERIMENT.flatMap((appid) => MEDIA_OUTLETS.map(({ domain }) => `${GAME_NAMES[appid]} review revisited@${domain}`)).sort());
    for (const appid of EXPERIMENT) {
      const { sources } = await detail(database, appid);
      expect(sources.map(({ originalUrl }) => originalUrl).sort()).toEqual(MEDIA_OUTLETS.flatMap((outlet) => [articleUrl(appid, outlet), articleUrl(appid, outlet, "-revisited")]).sort());
    }

    for (const day of ["2026-11-22", "2026-11-23", "2027-03-01"]) await tick(database, `${day}T06:00:00.000Z`);

    expect(queries(tavily)).toHaveLength(36);
  });

  test("an entity enrolled for another reason waits for its Main Released date to be at least 90 days old as well", async () => {
    const database = experimentCatalog();
    // Hades II is enrolled as a newly released game, released on 2026-09-01;
    // its Main Released date is 90 days old on 2026-11-30.
    database.native.prepare("UPDATE apps SET release_status = 'released', original_release_date = '2026-09-01' WHERE appid = ?").run(HADES_II);
    database.native.prepare("INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (?, 'new_release', '2026-11-19T06:00:00.000Z')").run(HADES_II);
    const { tavily, tick } = world();
    const laterQueries = (name: string) => queries(tavily).filter((query) => query.startsWith(`${name} review revisited@`));

    await tick(database, "2026-11-20T06:00:00.000Z");
    await tick(database, "2026-11-21T06:00:00.000Z");

    expect(laterQueries("Cyberpunk 2077")).toHaveLength(6);
    expect(laterQueries("Hades II")).toEqual([]);

    for (let day = 22; day <= 29; day += 1) await tick(database, `2026-11-${day}T06:00:00.000Z`);
    expect(laterQueries("Hades II")).toEqual([]);

    await tick(database, "2026-11-30T06:00:00.000Z");
    expect(laterQueries("Hades II")).toHaveLength(6);
  });
});

const [IGN, EUROGAMER, GAMESPOT, PC_GAMER, KOTAKU, GAMESRADAR] = MEDIA_OUTLETS;
const PHANTOM_LIBERTY = 2138330;

function reviewPage(appid: number, title: string, options: { date?: string | null; canonical?: string } = {}): string {
  const canonical = options.canonical ? `<meta property="og:url" content="${options.canonical}">` : "";
  return discoveryArticleHtml(appid, title, { date: options.date, author: "Later critic" }).replace("<head>", `<head>${canonical}`);
}

describe("later-pass selection", () => {
  test("follows the 2026-11-16 decision: only outlets with an accepted initial article, a URL new to the entity, a dated article published after that outlet's initial article, and an undated article kept undated", async () => {
    const database = experimentCatalog();
    // Phantom Liberty is its own entity; its initial searches find nothing.
    database.native.prepare("INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid) VALUES (?, 'Cyberpunk 2077: Phantom Liberty', 'phantom-liberty', 'expansion', 1, 1, ?)").run(PHANTOM_LIBERTY, CYBERPUNK);
    const later = (url: string) => ({ url });
    const { tavily, fetched, page, pages, tick } = world({
      later: (appid, outlet) => {
        if (appid !== CYBERPUNK) return [];
        if (outlet === IGN) return [later(articleUrl(CYBERPUNK, IGN)), later(articleUrl(CYBERPUNK, IGN, "-canonical")), later(articleUrl(CYBERPUNK, IGN, "-revisited"))];
        if (outlet === EUROGAMER) return [later(articleUrl(CYBERPUNK, EUROGAMER, "-earlier"))];
        if (outlet === GAMESPOT) return [later(articleUrl(CYBERPUNK, GAMESPOT, "-undated"))];
        if (outlet === PC_GAMER) return [later(articleUrl(CYBERPUNK, PC_GAMER, "-expansion")), later(articleUrl(CYBERPUNK, PC_GAMER, "-revisited"))];
        return [later(articleUrl(CYBERPUNK, outlet, "-revisited"))];
      },
    });
    // Kotaku's initial search finds no qualifying article for Cyberpunk 2077.
    pages.set(articleUrl(CYBERPUNK, KOTAKU), () => new Response("Not Found", { status: 404 }));
    // A new URL whose canonical address is the IGN article it already has,
    // published before IGN's genuine later review.
    page(articleUrl(CYBERPUNK, IGN, "-canonical"), reviewPage(CYBERPUNK, "Cyberpunk 2077 Review", { date: "2026-11-15T00:00:00.000Z", canonical: articleUrl(CYBERPUNK, IGN) }));
    // Phantom Liberty has no initial article from PC Gamer.
    page(articleUrl(CYBERPUNK, PC_GAMER, "-expansion"), reviewPage(CYBERPUNK, "Cyberpunk 2077: Phantom Liberty Review", { date: "2026-11-19T00:00:00.000Z" }));
    // Published before Eurogamer's initial review of 2026-11-10.
    page(articleUrl(CYBERPUNK, EUROGAMER, "-earlier"), reviewPage(CYBERPUNK, "Cyberpunk 2077 Review in Progress", { date: "2026-11-05T00:00:00.000Z" }));
    page(articleUrl(CYBERPUNK, GAMESPOT, "-undated"), reviewPage(CYBERPUNK, "Cyberpunk 2077 Review Revisited", { date: null }));

    await tick(database, "2026-11-20T06:00:00.000Z");
    await tick(database, "2026-11-21T06:00:00.000Z");

    // Kotaku has no initial article for Cyberpunk 2077, so the later pass does not ask it.
    expect(queries(tavily).filter((query) => query.startsWith("Cyberpunk 2077 review revisited@")).sort()).toEqual(
      [IGN, EUROGAMER, GAMESPOT, PC_GAMER, GAMESRADAR].map(({ domain }) => `Cyberpunk 2077 review revisited@${domain}`).sort(),
    );
    // The IGN article it already has is not fetched by the later pass: one
    // discovery fetch and one processing fetch.
    expect(fetched.filter((url) => url === articleUrl(CYBERPUNK, IGN))).toHaveLength(2);
    const { sources } = await detail(database, CYBERPUNK);
    const laterSources = sources.filter(({ originalUrl }) => !MEDIA_OUTLETS.some((outlet) => originalUrl === articleUrl(CYBERPUNK, outlet)));
    expect(laterSources.map(({ outlet, originalUrl, publishedAt }) => ({ outlet, originalUrl, publishedAt })).sort((a, b) => a.originalUrl.localeCompare(b.originalUrl))).toEqual([
      { outlet: "GameSpot", originalUrl: articleUrl(CYBERPUNK, GAMESPOT, "-undated"), publishedAt: null },
      { outlet: "GamesRadar+", originalUrl: articleUrl(CYBERPUNK, GAMESRADAR, "-revisited"), publishedAt: "2026-11-19T00:00:00.000Z" },
      { outlet: "IGN", originalUrl: articleUrl(CYBERPUNK, IGN, "-revisited"), publishedAt: "2026-11-19T00:00:00.000Z" },
      { outlet: "PC Gamer", originalUrl: articleUrl(CYBERPUNK, PC_GAMER, "-revisited"), publishedAt: "2026-11-19T00:00:00.000Z" },
    ].sort((a, b) => a.originalUrl.localeCompare(b.originalUrl)));
    expect((await detail(database, PHANTOM_LIBERTY)).sources).toEqual([]);
  });
});

describe("later-pass article rules", () => {
  test("later candidates pass the exact-subject and article-type rules, and an entity's later query on an outlet is never reformulated or repeated when nothing qualifies", async () => {
    const database = experimentCatalog();
    const later = (outlet: Outlet, slug: string) => [{ url: articleUrl(CYBERPUNK, outlet, `-${slug}`) }];
    const { tavily, page, tick } = world({
      later: (appid, outlet) => appid !== CYBERPUNK ? [] : later(outlet, outlet === GAMESRADAR ? "revisited" : "candidate"),
    });
    const after = "2026-11-19T00:00:00.000Z";
    page(articleUrl(CYBERPUNK, IGN, "-candidate"), reviewPage(CYBERPUNK, "Cyberpunk 2077 Patch Notes for Update 2.3", { date: after }));
    page(articleUrl(CYBERPUNK, EUROGAMER, "-candidate"), reviewPage(CYBERPUNK, "Best Games Like Cyberpunk 2077", { date: after }));
    page(articleUrl(CYBERPUNK, GAMESPOT, "-candidate"), reviewPage(CYBERPUNK, "Cyberpunk 2077 Versus Starfield: A Comparison", { date: after }));
    page(articleUrl(CYBERPUNK, PC_GAMER, "-candidate"), reviewPage(BALDURS_GATE, "Baldur's Gate 3 Review", { date: after }));
    page(articleUrl(CYBERPUNK, KOTAKU, "-candidate"), reviewPage(CYBERPUNK, "Cyberpunk 2077 Hands-On Preview", { date: after }));

    await tick(database, "2026-11-20T06:00:00.000Z");
    await tick(database, "2026-11-21T06:00:00.000Z");
    await tick(database, "2026-11-22T06:00:00.000Z");

    const { sources } = await detail(database, CYBERPUNK);
    expect(sources.filter(({ publishedAt }) => publishedAt === after).map(({ outlet, type, handsOn }) => ({ outlet, type, handsOn })).sort((a, b) => a.outlet.localeCompare(b.outlet))).toEqual([
      { outlet: "GamesRadar+", type: "review", handsOn: null },
      { outlet: "Kotaku", type: "preview", handsOn: true },
    ]);
    // The Baldur's Gate 3 review found on Cyberpunk 2077's query is not attributed to either game.
    expect((await detail(database, BALDURS_GATE)).sources.map(({ originalUrl }) => originalUrl)).not.toContain(articleUrl(CYBERPUNK, PC_GAMER, "-candidate"));
    const cyberpunkQueries = queries(tavily).filter((query) => query.startsWith("Cyberpunk 2077 "));
    expect(cyberpunkQueries.filter((query) => query.includes("review revisited"))).toHaveLength(6);
    expect(cyberpunkQueries).toHaveLength(12);
  });
});
