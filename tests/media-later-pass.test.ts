import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MEDIA_OUTLETS, type MediaSource } from "../src/lib/media-discovery";
import { handleCatalogRequest } from "../src/routes/api.catalog";
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
  stableJson,
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
      // Each article has its own text, so no two are one originating assessment.
      const body = (when: string) => `${GAME_NAMES[appid]} offers a substantial playable campaign with detailed systems, as ${outlet.name}'s ${when} assessment describes at length. `.repeat(5);
      page(articleUrl(appid, outlet), discoveryArticleHtml(appid, `${GAME_NAMES[appid]} Review`, { date: "2026-11-10T00:00:00.000Z", author: `${outlet.name} critic`, body: body("first") }));
      page(articleUrl(appid, outlet, "-revisited"), discoveryArticleHtml(appid, `${GAME_NAMES[appid]} Review Revisited`, { date: "2026-11-19T00:00:00.000Z", author: `${outlet.name} critic`, body: body("second") }));
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

describe("the automatic media ingestion switch", () => {
  test("while MEDIA_AUTOMATIC_INGESTION is off, a due later pass searches, fetches and submits nothing, and stays due for when it is on again", async () => {
    const database = experimentCatalog();
    const { tavily, openRouter, gemini, fetched, tick } = world();
    for (const at of ["2026-11-20T06:00", "2026-11-20T06:15", "2026-11-20T06:30"]) await tick(database, `${at}:00.000Z`);
    const before = { searches: tavily.requests.length, usage: tavily.usageCalls, fetched: fetched.length, openRouter: openRouter.calls.length, gemini: gemini.calls.length };

    for (const at of ["2026-11-21T06:00", "2026-11-21T06:15", "2026-11-22T06:00"]) {
      const result = await tick(database, `${at}:00.000Z`, { mediaAutomaticIngestion: false });
      expect(result.mediaDiscovery).toBeUndefined();
    }
    expect({ searches: tavily.requests.length, usage: tavily.usageCalls, fetched: fetched.length, openRouter: openRouter.calls.length, gemini: gemini.calls.length }).toEqual(before);

    await tick(database, "2026-11-23T06:00:00.000Z");
    expect(queries(tavily).filter((query) => query.includes(" review revisited@"))).toHaveLength(18);
  });
});

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
    expect(laterSources.map(({ outlet, originalUrl, publishedAt }): { outlet: string; originalUrl: string; publishedAt: string | null } => ({ outlet, originalUrl, publishedAt })).sort((a, b) => a.originalUrl.localeCompare(b.originalUrl))).toEqual([
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

describe("later articles in processing and results", () => {
  test("later articles feed synthesis, the Overview evidence map, Sources, citations and tag results without counting as additional outlet endorsements", async () => {
    const database = experimentCatalog();
    const { openRouter, tick } = world();
    const [ignInitial, ignLater, eurogamerInitial] = [articleUrl(CYBERPUNK, IGN), articleUrl(CYBERPUNK, IGN, "-revisited"), articleUrl(CYBERPUNK, EUROGAMER)];
    const syntheses: Array<{ urls: string[]; content: string }> = [];
    openRouter.onChat = (request) => {
      if (request.stage !== "synthesis") return;
      syntheses.push({ urls: request.urls, content: JSON.stringify(request.body.messages) });
      if (!request.urls.includes(ignLater)) return;
      // The model lists the statement with two IGN articles first.
      openRouter.output("synthesis", {
        statements: [
          { text: "Night City rewards exploring its districts on foot.", sourceUrls: [ignInitial, ignLater] },
          { text: "Combat supports both stealth and gunplay builds.", sourceUrls: [ignInitial, eurogamerInitial] },
        ],
        tags: [{ label: "Reworked skill trees", sourceUrls: [ignLater] }],
        similarityInputs: { gameplay: ["Stealth and gunplay builds"] },
      });
    };
    for (const at of ["2026-11-20T06:00", "2026-11-20T06:15", "2026-11-20T06:30", "2026-11-21T06:00", "2026-11-21T06:15", "2026-11-21T06:30"]) await tick(database, `${at}:00.000Z`);

    const synthesis = syntheses.filter(({ urls }) => urls.includes(ignLater));
    expect(synthesis).toHaveLength(1);
    expect(synthesis[0]!.urls).toEqual(expect.arrayContaining(MEDIA_OUTLETS.flatMap((outlet) => [articleUrl(CYBERPUNK, outlet), articleUrl(CYBERPUNK, outlet, "-revisited")])));
    expect(synthesis[0]!.content).not.toMatch(/initial assessments/i);

    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    const { sources, mediaOverview } = await detail(database, CYBERPUNK);
    expect(sources.map(({ originalUrl }) => originalUrl)).toEqual(expect.arrayContaining([ignInitial, ignLater]));
    // Two IGN articles are one outlet's support; IGN and Eurogamer are two.
    expect(mediaOverview?.statements).toEqual([
      { text: "Combat supports both stealth and gunplay builds.", sourceUrls: [ignInitial, eurogamerInitial] },
      { text: "Night City rewards exploring its districts on foot.", sourceUrls: [ignInitial, ignLater] },
    ]);
    expect(mediaOverview?.tags.map(({ slug }) => slug)).toEqual(["reworked-skill-trees"]);
    const catalog = await handleCatalogRequest(new Request("https://vaporstats.test/api/catalog?media_tag=Reworked%20skill%20trees"), database.db);
    expect((await catalog.json() as { data: Array<{ appid: number }> }).data.map(({ appid }) => appid)).toEqual([CYBERPUNK]);
  });

  test("an Overview built before synthesis took inputs from both passes stays active, and that configuration change queues no work for an entity whose contributions are unchanged", async () => {
    const database = experimentCatalog();
    const { openRouter, gemini, tick } = world({ later: () => [] });
    for (const at of ["2026-11-20T06:00", "2026-11-20T06:15", "2026-11-20T06:30"]) await tick(database, `${at}:00.000Z`);
    // Rewrite each active Overview, and the synthesis that built it, as made
    // under the previous synthesis configuration.
    const extractions = database.native.query<{ appid: number; source_id: number; input_identity: string; model: string }, []>(
      "SELECT source.appid, extraction.source_id, extraction.input_identity, extraction.model FROM media_article_extractions AS extraction JOIN media_sources AS source ON source.id = extraction.source_id WHERE extraction.active = 1",
    ).all();
    for (const appid of EXPERIMENT) {
      const own = extractions.filter((row) => row.appid === appid).map((row) => ({ sourceId: row.source_id, inputIdentity: row.input_identity })).sort((a, b) => a.sourceId - b.sourceId);
      const model = extractions.find((row) => row.appid === appid)!.model;
      const identity = createHash("sha256").update(stableJson({ stage: "synthesis", appid, model, configVersion: "media-synthesis-2026-09-13-v5", extractions: own })).digest("hex");
      const current = database.native.query<{ input_identity: string }, [number]>("SELECT input_identity FROM media_game_overviews WHERE appid = ? AND active = 1").get(appid)!.input_identity;
      database.native.prepare("UPDATE media_game_overviews SET config_version = 'media-synthesis-2026-09-13-v5', input_identity = ? WHERE appid = ? AND active = 1").run(identity, appid);
      database.native.prepare("UPDATE media_processing_jobs SET config_version = 'media-synthesis-2026-09-13-v5', input_identity = ?1, request_key = replace(request_key, ?2, ?1) WHERE stage = 'synthesis' AND appid = ?3").run(identity, current, appid);
    }
    const before = database.native.query("SELECT id, appid, input_identity, config_version FROM media_game_overviews WHERE active = 1 ORDER BY id").all();
    const requests = { openRouter: openRouter.requests.length, gemini: gemini.submitted.length };

    for (const at of ["2026-11-21T06:00", "2026-11-21T06:15", "2026-11-22T06:00", "2026-11-22T06:15"]) await tick(database, `${at}:00.000Z`);

    expect(database.native.query("SELECT id, appid, input_identity, config_version FROM media_game_overviews WHERE active = 1 ORDER BY id").all()).toEqual(before);
    expect({ openRouter: openRouter.requests.length, gemini: gemini.submitted.length }).toEqual(requests);
    expect(database.native.query("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE status = 'queued'").get()).toEqual({ count: 0 });
  });
});

describe("undated articles in Sources", () => {
  test("Sources list dated articles by publication date and undated articles after them, keeping their unknown date instead of placing them by retrieval time", async () => {
    const database = experimentCatalog();
    const { page, tick } = world({ later: (appid, outlet) => appid === CYBERPUNK && outlet === IGN ? [{ url: articleUrl(CYBERPUNK, IGN, "-revisited") }] : [] });
    // GameSpot's initial review, retrieved on November 20, has no date.
    page(articleUrl(CYBERPUNK, GAMESPOT), reviewPage(CYBERPUNK, "Cyberpunk 2077 Review", { date: null }));
    // IGN's later review was published after that retrieval.
    page(articleUrl(CYBERPUNK, IGN, "-revisited"), reviewPage(CYBERPUNK, "Cyberpunk 2077 Review Revisited", { date: "2026-11-20T12:00:00.000Z" }));

    await tick(database, "2026-11-20T06:00:00.000Z");
    await tick(database, "2026-11-21T06:00:00.000Z");

    const { sources } = await detail(database, CYBERPUNK);
    expect(sources.map(({ outlet, publishedAt }) => ({ outlet, publishedAt }))).toEqual([
      ...MEDIA_OUTLETS.filter((outlet) => outlet !== GAMESPOT).map(({ name }) => ({ outlet: name, publishedAt: "2026-11-10T00:00:00.000Z" })),
      { outlet: "IGN", publishedAt: "2026-11-20T12:00:00.000Z" },
      { outlet: "GameSpot", publishedAt: null },
    ]);
  });
});

describe("fairness between due passes", () => {
  test("due passes run oldest due time first and then by entity within the day's free credits, initial and later passes compete only by due time, a pass not yet due waits, and leftover passes come first the next day until none waits", async () => {
    const database = experimentCatalog();
    // Due times: Hades II's initial pass from November 18, Cyberpunk 2077's
    // from November 19, and Baldur's Gate 3's from November 20 at 12:00.
    const enroll = database.native.prepare("INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (?, 'experiment', ?)");
    enroll.run(HADES_II, "2026-11-18T06:00:00.000Z");
    enroll.run(CYBERPUNK, "2026-11-19T06:00:00.000Z");
    enroll.run(BALDURS_GATE, "2026-11-20T12:00:00.000Z");
    const { tavily, tick } = world();
    const days: string[][] = [];
    // November 20 has 18 free credits; every later day has six.
    for (let day = 20; day <= 26; day += 1) {
      tavily.remaining = day === 20 ? 18 : 6;
      const before = tavily.requests.length;
      await tick(database, `2026-11-${day}T06:00:00.000Z`);
      const searched = queries(tavily).slice(before).map((query) => query.split("@")[0]!);
      days.push([...new Set(searched)].map((pass) => `${pass} ×${searched.filter((query) => query === pass).length}`));
    }

    expect(days).toEqual([
      // Baldur's Gate 3's initial pass is not due until 12:00, so six credits stay unused.
      ["Hades II review preview ×6", "Cyberpunk 2077 review preview ×6"],
      // Both later passes have been due since November 20 at 06:00, before
      // Baldur's Gate 3's initial pass; the earlier entity goes first.
      ["Cyberpunk 2077 review revisited ×6"],
      ["Hades II review revisited ×6"],
      ["Baldur's Gate 3 review preview ×6"],
      ["Baldur's Gate 3 review revisited ×6"],
      [],
      [],
    ]);
  });
});

describe("the later pass end to end", () => {
  test("daily media run, later-pass discovery across a restart, the paid-work queue across a restart, then the Internal website API; a further daily media run with nothing new admits, fetches and submits nothing", async () => {
    const database = experimentCatalog();
    const { tavily, openRouter, gemini, fetched, tick } = world();
    const ticks = async (day: string, times: string[], options: MediaTickOptions = {}) => {
      for (const time of times) await tick(database, `${day}T${time}:00.000Z`, options);
    };
    await ticks("2026-11-20", ["06:00", "06:15", "06:30"]);
    expect(queries(tavily)).toHaveLength(18);

    // The process stops during the fourth later-pass search on November 21.
    const answer = tavily.results!;
    let crashed: string | null = null;
    tavily.results = (search) => {
      if (tavily.requests.length === 22 && crashed === null) {
        crashed = `${search.query}@${search.domain}`;
        database.reopen();
        throw new Error("process stopped");
      }
      return answer(search);
    };
    const interrupted = await tick(database, "2026-11-21T06:00:00.000Z");
    expect(interrupted.status).toBe("error");
    expect(crashed).toMatch(/ review revisited@/);

    // A later tick that day resumes the scheduled run, then the queue
    // processes the later articles four requests a tick, restarting between ticks.
    await ticks("2026-11-21", ["06:15"], { paidSubmissionsPerTick: 4 });
    for (const time of ["06:30", "06:45", "07:00", "07:15", "07:30", "07:45"]) {
      database.reopen();
      await ticks("2026-11-21", [time], { paidSubmissionsPerTick: 4 });
    }

    const searched = queries(tavily);
    expect(searched).toHaveLength(36);
    expect(searched.filter((query, index) => searched.indexOf(query) !== index)).toEqual([]);
    const laterUrls = EXPERIMENT.flatMap((appid) => MEDIA_OUTLETS.map((outlet) => articleUrl(appid, outlet, "-revisited")));
    const lost = laterUrls.find((url) => crashed === `${GAME_NAMES[Number(new URL(url).pathname.split("/")[2]!.split("-")[0])]} review revisited@${new URL(url).hostname}`)!;
    // Each later article was fetched once by discovery and once by processing;
    // the crashed search may have been served, so it is never repeated.
    for (const url of laterUrls) expect(fetched.filter((item) => item === url)).toHaveLength(url === lost ? 0 : 2);
    const extractions = openRouter.requests.filter(({ stage }) => stage === "extraction");
    expect(extractions).toHaveLength(18 + 17);
    expect(new Set(extractions.map(({ body }) => JSON.stringify(body.messages))).size).toBe(35);

    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    for (const appid of EXPERIMENT) {
      const { sources, mediaOverview } = await detail(database, appid);
      const ownLater = laterUrls.filter((url) => url.includes(`/${appid}-`) && url !== lost);
      expect(sources.map(({ originalUrl }) => originalUrl)).toEqual(expect.arrayContaining(ownLater));
      expect(mediaOverview?.statements[0]?.sourceUrls).toEqual(expect.arrayContaining(ownLater));
    }

    const before = { articles: (await Promise.all(EXPERIMENT.map(async (appid) => (await detail(database, appid)).sources.length))), fetched: fetched.length, openRouter: openRouter.requests.length, gemini: gemini.submitted.length };
    await ticks("2026-11-22", ["06:00", "06:15", "06:30"]);
    expect({ articles: (await Promise.all(EXPERIMENT.map(async (appid) => (await detail(database, appid)).sources.length))), fetched: fetched.length, openRouter: openRouter.requests.length, gemini: gemini.submitted.length }).toEqual(before);
    expect(queries(tavily)).toHaveLength(36);
  });
});
