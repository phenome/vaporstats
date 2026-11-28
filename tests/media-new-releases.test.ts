import { afterEach, expect, spyOn, test } from "bun:test";
import { ASSESSMENT_MEDIA_OUTLETS, getMediaSources } from "../src/lib/media-discovery";
import { getMediaOverview } from "../src/lib/media-overview";
import { handleGameDetailRequest, type GameDetailResponseData } from "../src/routes/api.games.$appid.detail";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  controlledGeminiApi,
  controlledOpenRouterApi,
  controlledTavilyApi,
  discoveryArticleHtml,
  insertSources,
  runMediaTick,
  type MediaTickOptions,
} from "./support/media";

const START = "2026-11-20";
const ROOT = 2_000_001;
const DLC = 2_000_002;
const EXPANSION = 2_000_003;
const LATE_DLC = 2_000_004;
const DAY_90 = "2027-02-18";
const cleanups: Array<() => void> = [];
const environment = { RECEPTION_ARTIFACT_DIR: process.env.RECEPTION_ARTIFACT_DIR, MEDIA_OVERVIEW_PUBLIC: process.env.MEDIA_OVERVIEW_PUBLIC };
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type CatalogApp = {
  appid: number;
  name: string;
  original?: string | null;
  steam?: string;
  storefront?: string;
  releaseStatus?: string;
  eligible?: boolean;
  playable?: boolean;
  type?: string;
  parent?: number;
};

const released = (appid: number, name: string, original: string | null = START): CatalogApp => ({ appid, name, original });
const root = released(ROOT, "Cloud Harbor");
const dlc = { ...released(DLC, "Cloud Harbor Nightfall"), type: "dlc", parent: ROOT };
const expansion = { ...released(EXPANSION, "Cloud Harbor Deepwater", "2026-11-21"), type: "expansion", parent: ROOT };

function admit(database: TestDatabase, ...apps: CatalogApp[]) {
  const insert = database.native.prepare(
    `INSERT INTO apps (appid, name, slug, original_release_date, steam_release_date, release_date, release_date_source,
                       release_status, is_eligible, is_playable, type, parent_appid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const app of apps) {
    insert.run(app.appid, app.name, app.name.toLowerCase().replaceAll(" ", "-"), app.original ?? null, app.steam ?? null,
      app.storefront ?? null, app.storefront ? "appdetails" : null, app.releaseStatus ?? "released",
      app.eligible === false ? 0 : 1, app.playable === false ? 0 : 1, app.type ?? "game", app.parent ?? null);
  }
}

function fixture(...apps: CatalogApp[]) {
  const database = openTestDatabase("vaporstats-media-new-releases-");
  cleanups.push(database.cleanup);
  admit(database, ...apps);
  return database;
}

function world(...apps: CatalogApp[]) {
  const names = Object.fromEntries(apps.map(({ appid, name }) => [appid, name]));
  const tavily = controlledTavilyApi(names);
  const openRouter = controlledOpenRouterApi();
  const gemini = controlledGeminiApi();
  const fetched: string[] = [];
  const articleUrl = (appid: number, domain: string, later = false) => `https://${domain}/articles/${appid}-${later ? "later" : "initial"}`;
  const searches: Array<{ appid: number; domain: string; later: boolean }> = [];
  tavily.results = ({ appid, domain, query }) => {
    const later = query.endsWith(" review revisited");
    searches.push({ appid, domain, later });
    return [{ url: articleUrl(appid, domain, later) }];
  };
  const outlet = (url: string) => {
    const { hostname, pathname } = new URL(url);
    const appid = Number(pathname.split("/").at(-1)?.split("-")[0]);
    const name = names[appid];
    if (!name) return new Response(null, { status: 404 });
    const later = pathname.endsWith("-later");
    const title = `${name} ${later ? "Review Revisited" : "Review"}`;
    return new Response(discoveryArticleHtml(appid, title, {
      date: later ? "2027-02-17" : "2026-11-25",
      author: `${hostname} critic`,
      body: `${title} at ${hostname} describes a substantial playable campaign with detailed systems and memorable encounters. `.repeat(4) + "Builds reward experimentation.",
    }));
  };
  return {
    tavily, openRouter, gemini, fetched, articleUrl, searches, outlet,
    async tick(database: TestDatabase, day: string, options: MediaTickOptions = {}, time = "06:00") {
      const result = await runMediaTick(database, { tavily, openRouter, gemini }, `${day}T${time}:00.000Z`, {
        outlet, fetched, paidSubmissionsPerTick: 40, ...options,
      });
      expect(result.status).toBe("completed");
      return result;
    },
  };
}

function enrollments(database: TestDatabase) {
  return database.native.query<{ appid: number; reason: string; enrolled_at: string }, []>(
    "SELECT appid, reason, enrolled_at FROM media_enrollments ORDER BY appid",
  ).all();
}

function enrollment(appid: number, day: string) {
  return { appid, reason: "new_release", enrolled_at: `${day}T06:00:00.000Z` };
}

function catalogIds(database: TestDatabase) {
  return database.native.query<{ appid: number }, []>("SELECT appid FROM apps ORDER BY appid").all().map(({ appid }) => appid);
}

test("enrolls only eligible, playable, precisely released roots within the UTC window, using Main Released precedence", async () => {
  const before = { ...released(ROOT + 10, "Yesterday", "2026-11-19"), steam: START, storefront: START };
  const after = released(ROOT + 11, "Tomorrow", "2026-11-21");
  const upcoming = { ...released(ROOT + 12, "Forthcoming"), releaseStatus: "upcoming" };
  const approximate = { ...released(ROOT + 13, "Approximate", "November 2026"), steam: START };
  const missing = released(ROOT + 14, "Undated", null);
  const excluded = [
    { ...released(ROOT + 15, "Ineligible"), eligible: false },
    { ...released(ROOT + 16, "Nonplayable"), playable: false },
    { ...released(ROOT + 17, "Soundtrack"), type: "music" },
    { ...released(ROOT + 18, "Parented game"), parent: ROOT },
    dlc,
  ];
  const steam = { ...released(ROOT + 19, "Steam Date", null), steam: START, storefront: "2026-11-19" };
  const storefront = { ...released(ROOT + 20, "Storefront Date", null), storefront: START };
  const invalid = released(ROOT + 21, "Invalid Calendar Day", "2026-11-31");
  const lateOld = released(ROOT + 22, "Late Catalog Entry", "2026-11-19");
  const apps = [root, before, after, upcoming, approximate, missing, ...excluded, steam, storefront, invalid];
  const database = fixture(...apps);
  const media = world(...apps, lateOld);

  await media.tick(database, "2026-11-19", { mediaAutomaticIngestion: false });
  expect(enrollments(database)).toEqual([]);
  expect((await media.tick(database, START)).mediaDailyRun?.enrollmentStartDate).toBe(START);
  const first = [enrollment(ROOT, START), enrollment(steam.appid, START), enrollment(storefront.appid, START)];
  expect(enrollments(database)).toEqual(first);
  expect(catalogIds(database)).toEqual(apps.map(({ appid }) => appid).sort((a, b) => a - b));
  expect(media.tavily.searches).toEqual([]);

  admit(database, lateOld);
  database.native.prepare("UPDATE apps SET release_status = 'released' WHERE appid = ?").run(upcoming.appid);
  database.native.prepare("UPDATE apps SET original_release_date = ? WHERE appid IN (?, ?)").run(START, approximate.appid, missing.appid);
  database.reopen();
  await media.tick(database, "2026-11-21");
  expect(enrollments(database)).toEqual([
    first[0]!,
    ...[after, upcoming, approximate, missing].map(({ appid }) => enrollment(appid, "2026-11-21")),
    ...first.slice(1),
  ]);
  expect(catalogIds(database)).toEqual([...apps, lateOld].map(({ appid }) => appid).sort((a, b) => a - b));
});

test("reschedules an unstarted initial pass after a Main Released change and starts it exactly seven days after the new date", async () => {
  const database = fixture(root);
  const media = world(root);
  await media.tick(database, START);
  await media.tick(database, "2026-11-26");
  expect(media.tavily.searches).toEqual([]);

  database.native.prepare("UPDATE apps SET original_release_date = '2026-11-22' WHERE appid = ?").run(ROOT);
  await media.tick(database, "2026-11-27");
  await media.tick(database, "2026-11-28");
  expect(media.tavily.searches).toEqual([]);
  await media.tick(database, "2026-11-29");
  expect(media.searches).toEqual(ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => ({ appid: ROOT, domain, later: false })));
  expect(enrollments(database)).toEqual([enrollment(ROOT, START)]);
});

test("retains enrollment after a pre-start release correction, and waits for a valid release date before searching", async () => {
  const database = fixture(root);
  const media = world(root);
  await media.tick(database, START);

  const updateRelease = database.native.prepare("UPDATE apps SET original_release_date = ? WHERE appid = ?");
  updateRelease.run("2026-11-19", ROOT);
  await media.tick(database, "2026-12-15");
  expect(enrollments(database)).toEqual([enrollment(ROOT, START)]);
  expect(media.tavily.searches).toEqual([]);

  updateRelease.run("2026-12-16", ROOT);
  await media.tick(database, "2026-12-22");
  expect(media.tavily.searches).toEqual([]);
  await media.tick(database, "2026-12-23");
  expect(media.searches).toEqual(ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => ({ appid: ROOT, domain, later: false })));
  expect(enrollments(database)).toEqual([enrollment(ROOT, START)]);
});

test("gives a root and its released DLC and expansion their own passes and evidence, and excludes a child released after both passes", async () => {
  const late = { ...released(LATE_DLC, "Cloud Harbor New Coast", "2027-02-20"), type: "dlc", parent: ROOT };
  const apps = [root, dlc, expansion];
  const database = fixture(...apps, { ...late, releaseStatus: "upcoming" });
  const media = world(...apps, late);
  await media.tick(database, START);
  await media.tick(database, "2026-11-27");
  expect(new Set(media.searches.map(({ appid }) => appid))).toEqual(new Set([ROOT, DLC]));
  await media.tick(database, "2026-11-28");
  expect(media.searches.filter(({ appid }) => appid === EXPANSION)).toHaveLength(ASSESSMENT_MEDIA_OUTLETS.length);
  await media.tick(database, "2027-02-17");
  expect(media.searches.filter(({ later }) => later)).toEqual([]);

  await media.tick(database, DAY_90);
  expect(new Set(media.searches.filter(({ later }) => later).map(({ appid }) => appid))).toEqual(new Set([ROOT, DLC]));
  await media.tick(database, "2027-02-19");
  for (const app of apps) {
    const own = media.searches.filter(({ appid }) => appid === app.appid);
    expect(own).toEqual([false, true].flatMap((later) => ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => ({ appid: app.appid, domain, later }))));
    const urls = own.map(({ domain, later }) => media.articleUrl(app.appid, domain, later)).sort();
    const sources = await getMediaSources(database.db, app.appid, { includeUnpublished: true });
    expect(sources.map(({ originalUrl }) => originalUrl).sort()).toEqual(urls);
    const overview = await getMediaOverview(database.db, app.appid, { includeUnpublished: true });
    expect([...new Set(overview?.statements.flatMap(({ sourceUrls }) => sourceUrls))].sort()).toEqual(urls);
  }

  database.native.prepare("UPDATE apps SET release_status = 'released' WHERE appid = ?").run(LATE_DLC);
  await media.tick(database, "2027-02-20");
  await media.tick(database, "2027-02-27");
  await media.tick(database, "2027-05-21");
  expect(media.tavily.searches).toHaveLength(2 * apps.length * ASSESSMENT_MEDIA_OUTLETS.length);
  expect(enrollments(database)).toEqual([enrollment(ROOT, START)]);
  expect(await getMediaSources(database.db, LATE_DLC, { includeUnpublished: true })).toEqual([]);
});

test("a root's empty later pass keeps its late-child cutoff after a release-date correction", async () => {
  const late = { ...released(LATE_DLC, "Cloud Harbor New Coast", "2027-02-19"), type: "dlc", parent: ROOT };
  const database = fixture(root);
  const media = world(root, late);
  const standardResults = media.tavily.results!;
  media.tavily.results = (search) => search.appid === ROOT ? [] : standardResults(search);
  await media.tick(database, START);
  await media.tick(database, "2026-11-27");
  await media.tick(database, DAY_90);
  const initialSearches = media.tavily.searches.slice();
  expect(initialSearches).toEqual(ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => `${root.name}@${domain}`));

  database.reopen();
  database.native.prepare("UPDATE apps SET original_release_date = '2026-12-20' WHERE appid = ?").run(ROOT);
  admit(database, late);
  await media.tick(database, "2027-02-26");
  await media.tick(database, "2027-03-20");
  expect(media.tavily.searches).toEqual(initialSearches);
  expect(await getMediaSources(database.db, LATE_DLC, { includeUnpublished: true })).toEqual([]);
});

test("a root at the 15-article ceiling leaves its child's independent allowance available", async () => {
  const database = fixture(root, dlc);
  const media = world(root, dlc);
  insertSources(database.native, ROOT, "initial", 14);
  insertSources(database.native, DLC, "initial", 13);
  await media.tick(database, START);
  await media.tick(database, "2026-11-27");
  const urls = async (appid: number) => (await getMediaSources(database.db, appid, { includeUnpublished: true })).map(({ originalUrl }) => originalUrl);
  expect(await urls(ROOT)).toHaveLength(15);
  expect(await urls(DLC)).toHaveLength(15);
  expect(await urls(ROOT)).toContain(media.articleUrl(ROOT, ASSESSMENT_MEDIA_OUTLETS[0]!.domain));
  expect(await urls(DLC)).toEqual(expect.arrayContaining(ASSESSMENT_MEDIA_OUTLETS.slice(0, 2).map(({ domain }) => media.articleUrl(DLC, domain))));
});

test("records the pending initial pass skip after eligibility loss and retains the enrollment across a restart", async () => {
  const database = fixture(root);
  const media = world(root);
  await media.tick(database, START);
  database.native.prepare("UPDATE apps SET is_eligible = 0 WHERE appid = ?").run(ROOT);
  await media.tick(database, "2026-11-27");
  database.reopen();

  expect(enrollments(database)).toEqual([enrollment(ROOT, START)]);
  expect(media.tavily.searches).toEqual([]);
  expect(media.fetched).toEqual([]);
  expect(media.openRouter.requests).toEqual([]);
  const skipped = database.native.query<{ outlet: string; status: string; stop_reason: string }, [number]>(
    "SELECT outlet, status, stop_reason FROM media_discovery_progress WHERE appid = ? AND pass = 'initial' ORDER BY outlet",
  ).all(ROOT);
  expect(skipped).toEqual(ASSESSMENT_MEDIA_OUTLETS.map(({ name }) => ({ outlet: name, status: "stopped", stop_reason: "entity_ineligible" })).sort((a, b) => a.outlet.localeCompare(b.outlet)));
});

test("carries an outlet-capped and credit-limited backlog forward oldest due first across days", async () => {
  const oldest = released(ROOT + 3, "Oldest Release");
  const middle = released(ROOT + 2, "Middle Release", "2026-11-21");
  const newest = released(ROOT + 1, "Newest Release", "2026-11-22");
  const apps = [oldest, middle, newest];
  const database = fixture(...apps);
  const media = world(...apps);
  const outlet = ASSESSMENT_MEDIA_OUTLETS[0]!;
  await media.tick(database, START);
  await media.tick(database, "2026-11-22");

  // Earlier attempts leave one slot for the oldest pass's search. Its
  // candidate fetch then waits until the outlet's budget resets.
  const insert = database.native.prepare(
    `INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, status_code, succeeded, attempted_at)
     VALUES (?, ?, 'initial', '2026-11-29', 'fetch', ?, 200, 1, '2026-11-29T05:00:00.000Z')`,
  );
  for (let index = 0; index < 29; index++) insert.run(oldest.appid, outlet.name, `https://${outlet.domain}/articles/earlier-${index}`);

  media.tavily.remaining = 8;
  const day1 = await media.tick(database, "2026-11-29", { paidSubmissionsPerTick: 0 });
  expect(day1.mediaDiscovery?.stopReasons).toContain(`${outlet.name}:daily_attempt_cap`);
  expect(day1.mediaDiscovery?.stopReasons).toContain("tavily_credits_exhausted");
  expect(media.searches).toHaveLength(8);
  expect(media.searches.slice(0, 6).map(({ appid }) => appid)).toEqual(Array(6).fill(oldest.appid));
  expect(media.searches.slice(6).map(({ appid }) => appid)).toEqual(Array(2).fill(middle.appid));

  database.reopen();
  const day2 = await media.tick(database, "2026-11-30", { paidSubmissionsPerTick: 0 });
  expect(day2.mediaDiscovery?.stopReasons).toContain("tavily_credits_exhausted");
  expect(media.searches.slice(8, 12).map(({ appid }) => appid)).toEqual(Array(4).fill(middle.appid));
  expect(media.searches.slice(12).map(({ appid }) => appid)).toEqual(Array(4).fill(newest.appid));

  await media.tick(database, "2026-12-01", { paidSubmissionsPerTick: 0 });
  const ids = media.searches.map(({ appid, domain }) => `${appid}@${domain}`);
  expect(ids.sort()).toEqual(apps.flatMap(({ appid }) => ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => `${appid}@${domain}`)).sort());
  for (const { appid } of apps) {
    expect(await getMediaSources(database.db, appid, { includeUnpublished: true })).toHaveLength(6);
  }
  const attemptCount = database.native.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = ? AND day = '2026-11-29'",
  ).get(outlet.name);
  expect(attemptCount?.count).toBe(30);
});

test("serves an Overview persisted by ingestion through the trusted API and checks the publication gate without writes or outbound calls", async () => {
  const database = fixture(root);
  const media = world(root);
  await media.tick(database, START);
  for (const time of ["06:00", "06:15", "06:30"]) await media.tick(database, "2026-11-27", {}, time);
  expect(media.openRouter.requests.map(({ stage }) => stage)).toContain("synthesis");
  database.reopen();
  database.native.prepare("UPDATE apps SET header_image = ?, header_lqip = NULL, icon_lqip = NULL WHERE appid = ?")
    .run("https://artwork.test/cloud-harbor.jpg", ROOT);

  const before = database.native.query<{ count: number }, []>("SELECT total_changes() AS count").get();
  const unexpectedFetch = Object.assign(async () => {
    throw new Error("Unexpected outbound call while reading the game page");
  }, { preconnect: globalThis.fetch.preconnect });
  const outboundFetch = spyOn(globalThis, "fetch").mockImplementation(unexpectedFetch);
  cleanups.push(() => outboundFetch.mockRestore());
  async function detail(includeUnpublished = false, query = "") {
    const request = new Request(`https://vaporstats.test/api/games/${ROOT}/detail${query}`);
    const response = await handleGameDetailRequest(request, database.db, ROOT, { includeUnpublished });
    expect(response.status).toBe(200);
    return (await response.json() as { data: GameDetailResponseData }).data;
  }

  delete process.env.MEDIA_OVERVIEW_PUBLIC;
  expect(await detail()).toMatchObject({ mediaOverview: null, sources: [], mediaMatches: [] });
  expect(await detail(false, "?includeUnpublished=true")).toMatchObject({ mediaOverview: null, sources: [], mediaMatches: [] });
  const internal = await detail(true);
  const urls = ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => media.articleUrl(ROOT, domain)).sort();
  expect(internal.sources.map(({ originalUrl }) => originalUrl).sort()).toEqual(urls);
  expect([...new Set(internal.mediaOverview?.statements.flatMap(({ sourceUrls }) => sourceUrls))].sort()).toEqual(urls);

  process.env.MEDIA_OVERVIEW_PUBLIC = "true";
  // The first-publication scope still excludes this root.
  expect(await detail()).toMatchObject({ mediaOverview: null, sources: [], mediaMatches: [] });
  expect((await detail(true)).mediaOverview).toEqual(internal.mediaOverview);
  expect(outboundFetch).not.toHaveBeenCalled();
  expect(database.native.query("SELECT total_changes() AS count").get()).toEqual(before);
});

test("discards a model answer received after eligibility loss and explicitly skips the pending later pass", async () => {
  const database = fixture(root);
  const media = world(root);
  await media.tick(database, START);
  media.openRouter.onChat = ({ stage }) => {
    if (stage === "extraction") database.native.prepare("UPDATE apps SET is_eligible = 0 WHERE appid = ?").run(ROOT);
  };
  await media.tick(database, "2026-11-27");
  expect(media.openRouter.requests.map(({ stage }) => stage)).toContain("extraction");
  expect(media.openRouter.requests.map(({ stage }) => stage)).not.toContain("synthesis");
  const outcomes = database.native.query<{ status: string }, [number]>(
    "SELECT status FROM media_processing_jobs WHERE appid = ? AND stage = 'extraction'",
  ).all(ROOT);
  expect(outcomes.map(({ status }) => status)).toContain("stale");
  expect(await getMediaOverview(database.db, ROOT, { includeUnpublished: true })).toBeNull();

  const searched = media.tavily.searches.slice();
  await media.tick(database, DAY_90);
  const reasons = database.native.query<{ stop_reason: string }, [number]>(
    "SELECT DISTINCT stop_reason FROM media_discovery_progress WHERE appid = ? AND pass = 'later' AND status = 'stopped'",
  ).all(ROOT);
  expect(reasons).toEqual([{ stop_reason: "entity_ineligible" }]);
  expect(media.tavily.searches).toEqual(searched);
});

test("a Provider stop keeps the pass due, an Outlet day stop reopens, and an Outlet denial persists", async () => {
  const database = fixture(root);
  const media = world(root);
  const denied = ASSESSMENT_MEDIA_OUTLETS[0]!;
  const limited = ASSESSMENT_MEDIA_OUTLETS[1]!;
  const limitedCandidate = media.articleUrl(ROOT, limited.domain);
  const fallback = limitedCandidate + "-second";
  const standardResults = media.tavily.results!;
  media.tavily.results = (search) => search.domain === limited.domain
    ? [{ url: limitedCandidate }, { url: fallback }]
    : standardResults(search);
  await media.tick(database, START);
  media.tavily.reply({ status: 503 });
  const stopped = await media.tick(database, "2026-11-27");
  expect(stopped.mediaDiscovery?.stopReasons).toContain("tavily_search_http_503");
  expect(media.tavily.searches).toHaveLength(1);
  expect(media.fetched).toEqual([]);

  const dayStop = await media.tick(database, "2026-11-28", {
    outlet: (url) => {
      const domain = new URL(url).hostname;
      if (domain === denied.domain) return new Response(null, { status: 403 });
      if (domain === limited.domain) return new Response(null, { status: 429 });
      return media.outlet(url);
    },
  });
  expect(dayStop.mediaDiscovery?.stopReasons).toEqual(expect.arrayContaining([
    `${denied.name}:fetch_http_403`, `${limited.name}:fetch_http_429`,
  ]));
  const contacted = (domain: string) => media.fetched.filter((url) => new URL(url).hostname === domain).length;
  expect(contacted(denied.domain)).toBe(1);
  expect(contacted(limited.domain)).toBe(1);

  database.reopen();
  await media.tick(database, "2026-11-29");
  expect(contacted(denied.domain)).toBe(1);
  expect(media.fetched.filter((url) => url === limitedCandidate)).toHaveLength(1);
  expect(media.fetched).toContain(fallback);
  const sources = await getMediaSources(database.db, ROOT, { includeUnpublished: true });
  expect(sources.map(({ outlet }) => outlet).sort()).toEqual(ASSESSMENT_MEDIA_OUTLETS.slice(1).map(({ name }) => name).sort());
  expect(sources.find(({ outlet }) => outlet === limited.name)?.originalUrl).toBe(fallback);
});

test.each([
  { childDate: "2027-02-08", childLaterDue: false },
  { childDate: START, childLaterDue: true },
])("a root's later search can attribute a review to its DLC only in the DLC's own later pass ($childDate)", async ({ childDate, childLaterDue }) => {
  const child = { ...dlc, original: childDate };
  const database = fixture(root, child);
  const media = world(root, child);
  const options = { paidSubmissionsPerTick: 0 };
  await media.tick(database, START, options);
  await media.tick(database, "2026-11-27", options);
  if (!childLaterDue) {
    // The first outlet has covered the child. Its other initial queries are still due.
    media.tavily.remaining = 1;
    await media.tick(database, "2027-02-15", options);
    media.tavily.remaining = 100;
  }
  const domain = ASSESSMENT_MEDIA_OUTLETS[0]!.domain;
  const childReview = media.articleUrl(DLC, domain, true);
  // Only the root's query finds this particular follow-up about the child.
  media.tavily.results = (search) =>
    search.appid === ROOT && search.domain === domain && search.query.endsWith(" review revisited")
      ? [{ url: childReview }] : [];
  await media.tick(database, DAY_90, options);
  expect(database.native.query("SELECT appid, pass FROM media_sources WHERE original_url = ?").all(childReview))
    .toEqual(childLaterDue ? [{ appid: DLC, pass: "later" }] : []);
});

test("a corrected release date leaves a partially searched initial pass due across restart", async () => {
  const database = fixture(root);
  const media = world(root);
  const options = { paidSubmissionsPerTick: 0 };
  await media.tick(database, START, options);
  media.tavily.remaining = 1;
  await media.tick(database, "2026-11-27", options);
  expect(media.searches).toHaveLength(1);

  database.native.prepare("UPDATE apps SET original_release_date = '2026-11-26' WHERE appid = ?").run(ROOT);
  database.reopen();
  media.tavily.remaining = 100;
  await media.tick(database, "2026-11-28", options);
  expect(media.searches).toEqual(ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => ({ appid: ROOT, domain, later: false })));
});

test("a deferred root leaves its child's started pass due across restart", async () => {
  const child = { ...dlc, original: "2026-11-10" };
  const database = fixture(root, child, expansion);
  const media = world(root, child, expansion);
  const options = { paidSubmissionsPerTick: 0 };
  media.tavily.remaining = 1;
  await media.tick(database, START, options);
  expect(media.searches.map(({ appid }) => appid)).toEqual([DLC]);

  database.native.prepare("UPDATE apps SET original_release_date = '2026-11-01' WHERE appid = ?").run(ROOT);
  database.reopen();
  media.tavily.remaining = 100;
  await media.tick(database, "2026-11-27", options);
  expect(media.searches).toEqual(ASSESSMENT_MEDIA_OUTLETS.map(({ domain }) => ({ appid: DLC, domain, later: false })));
});
