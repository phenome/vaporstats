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
});
