import { afterEach, expect, test } from "bun:test";
import type { TestDatabase } from "./support/db";
import { openTestDatabase } from "./support/db";
import { fetchSteamAppDetails } from "../workers/catalog-seed";
import { upsertApp } from "../src/lib/catalog";
import { getMediaSources, MEDIA_OUTLETS, nextMediaAssessment, replayRejectedPreviewCandidate } from "../src/lib/media-discovery";
import { outletDailyAttemptCap } from "../src/lib/media-outlet-access";
import { changeMediaWatch, expectedMediaReleaseDate, mediaWatchSchedule, previewInterval, PREVIEW_DEFERRAL_KEY, shiftMediaDay } from "../src/lib/media-watchlist";
import { handleGameDetailRequest, type GameDetailResponseData } from "../src/routes/api.games.$appid.detail";
import { controlledGeminiApi, controlledOpenRouterApi, controlledTavilyApi, discoveryArticleHtml, mediaObservation, runMediaTick, overviewOutputForUrls, type MediaTickOptions } from "./support/media";

const ROOT = 2161710;
const CHILD = 2161711;
const REVIEW = 2161712;
const LATE = 2161713;
const names: Record<number, string> = { [ROOT]: "NO LAW", [CHILD]: "NO LAW Night Shift", [REVIEW]: "Fort Harbor", [LATE]: "NO LAW Lost Streets" };
const cleanup: Array<() => void> = [];
const receptionPath = process.env.RECEPTION_ARTIFACT_DIR;
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  if (receptionPath === undefined) delete process.env.RECEPTION_ARTIFACT_DIR;
  else process.env.RECEPTION_ARTIFACT_DIR = receptionPath;
});

function admit(database: TestDatabase, appid: number, { status = "upcoming", date = null, plan = null, parent = null }: {
  status?: string; date?: string | null; plan?: string | null; parent?: number | null;
} = {}) {
  const name = names[appid]!;
  database.native.prepare(`INSERT INTO apps (appid, name, slug, type, release_status, steam_release_date, storefront_release_date_text, parent_appid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(appid, name, name.toLowerCase().replaceAll(" ", "-"), parent === null ? "game" : "dlc", status, date, plan, parent);
}

function fixture() {
  const database = openTestDatabase("vaporstats-watchlist-");
  cleanup.push(database.cleanup);
  return database;
}

async function watch(database: TestDatabase, appid = ROOT, day = "2027-01-25", action: "watch" | "unwatch" = "watch") {
  expect((await changeMediaWatch(database.db, action, String(appid), new Date(`${day}T05:00:00Z`))).status).toBe(200);
}

function queries(database: TestDatabase) {
  return database.native.query<{ pass: string; appid: number; outlet: string; day: string }, []>(
    "SELECT pass, appid, outlet, day FROM media_discovery_attempts WHERE kind = 'search' ORDER BY id",
  ).all();
}

function world() {
  const tavily = controlledTavilyApi(names);
  const openRouter = controlledOpenRouterApi();
  const gemini = controlledGeminiApi();
  let day: string;
  let deliver = true;
  const fetched: string[] = [];
  tavily.results = ({ query, appid, domain }) => {
    const pass = query.endsWith("review revisited") ? "later" : query.endsWith("review preview") ? "initial" : "preview";
    return deliver ? [{ url: `https://${domain}/articles/${appid}/${pass}/${day}` }] : [];
  };
  const quote = "Builds reward experimentation when players select a new set of tools for each mission.";
  const outlet = (url: string) => {
    const { pathname, hostname } = new URL(url);
    const [, , appid, pass, published] = pathname.split("/");
    const name = names[Number(appid)];
    if (!name) return new Response(null, { status: 404 });
    const articleType = pass === "preview" ? hostname.includes("ign") ? "Announcement" : "Preview" : "Review";
    return new Response(discoveryArticleHtml(Number(appid), `${name} ${articleType}`, {
      date: published,
      author: `${hostname} critic`,
      body: `${name} features a mission on a cargo ship where players select their equipment before leaving port. ${quote} `.repeat(3),
    }));
  };
  return {
    tavily, openRouter, gemini, fetched, quote, outlet,
    noArticles() { deliver = false; },
    async tick(database: TestDatabase, on: string, options: MediaTickOptions = {}, time = "06:00") {
      day = on;
      const result = await runMediaTick(database, { tavily, openRouter, gemini }, `${day}T${time}:00.000Z`, {
        fetched, outlet, paidSubmissionsPerTick: 40, ...options,
      });
      expect(result.status).toBe("completed");
      expect(result.mediaError).toBeUndefined();
      expect(result.mediaDiscovery?.status).not.toBe("failed");
      return result;
    },
  };
}

test("calendar cadence parses every Steam period and switches at the year and month boundaries", () => {
  const phrases = {
    "2027": "01-01", "q1 2027": "01-01", "q2 2027": "04-01", "q3 2027": "07-01", "q4 2027": "10-01",
    "September 2027": "09-01", "sep 2027": "09-01", "Early 2027": "01-01", "Spring 2027": "03-20",
    "Summer 2027": "06-21", "Fall 2027": "09-22", "Autumn 2027": "09-22", "Winter 2027": "12-21",
    "Mid 2027": "07-01", "Late 2027": "09-01", "25 Jan 2027": "01-25",
  };
  for (const [phrase, expected] of Object.entries(phrases)) {
    expect(expectedMediaReleaseDate(` ${phrase.toUpperCase()} `)).toBe(`2027-${expected}`);
  }
  for (const value of [null, "Coming soon", "TBA", "H2 2027", "Early Fall 2027"]) {
    expect(expectedMediaReleaseDate(value)).toBeNull();
    expect(previewInterval("2027-01-25", expectedMediaReleaseDate(value))).toBe(30);
  }
  const cases = { "2028-01-25": 30, "2028-01-24": 7, "2027-02-25": 7, "2027-02-24": 1, "2027-01-24": 1 };
  for (const [expected, interval] of Object.entries(cases)) expect(previewInterval("2027-01-25", expected)).toBe(interval);
  expect(previewInterval("2027-01-31", "2027-02-28")).toBe(7);
});

test("Steam catalog ingestion retains approximate text without changing Main Released", async () => {
  const database = fixture();
  const controlledSteam = (async () => Response.json({
    [ROOT]: { success: true, data: { steam_appid: ROOT, name: "NO LAW", type: "game",
      release_date: { coming_soon: true, date: "Spring 2027" } } },
  })) as unknown as typeof fetch;
  const game = await fetchSteamAppDetails(ROOT, controlledSteam);
  expect(game).not.toBeNull();
  await upsertApp(database.db, game!);
  expect(database.native.query("SELECT release_date, release_status, storefront_release_date_text FROM apps").get()).toEqual({
    release_date: null, release_status: "upcoming", storefront_release_date_text: "Spring 2027",
  });
});

test.each([
  { boundary: "one month", release: "2027-03-01", first: "2027-01-27", next: "2027-02-02" },
  { boundary: "one year", release: "2028-02-01", first: "2027-01-25", next: "2027-02-02" },
])("preview projection agrees with daily ticks across $boundary before release", async ({ release, first, next }) => {
  const database = fixture();
  admit(database, ROOT, { date: release });
  await watch(database, ROOT, first);
  const api = world();
  api.noArticles();
  await api.tick(database, first);
  const [entity] = await mediaWatchSchedule(database.db, ROOT, new Date(`${first}T06:15:00Z`), new Map());

  for (let day = shiftMediaDay(first, 1); day <= next; day = shiftMediaDay(day, 1)) {
    await api.tick(database, day);
  }
  const searchDays = [...new Set(queries(database).map(({ day }) => day))];
  expect(searchDays).toEqual([first, next]);
  expect(entity?.next).toEqual({ pass: "preview", dueAt: `${searchDays[1]}T06:00:00.000Z` });
});

test("disabled watches persist, release changes move preview cadence, and rewatch resumes at the next run", async () => {
  const database = fixture();
  admit(database, ROOT, { plan: "Q4 2028" });
  await watch(database);
  const api = world();
  api.noArticles();
  await api.tick(database, "2027-01-25", { mediaAutomaticIngestion: false });
  expect(queries(database)).toEqual([]);
  expect(api.tavily.usageCalls).toBe(0);
  await api.tick(database, "2027-01-26");
  await api.tick(database, "2027-01-27");
  expect(queries(database).map(({ day }) => day)).toEqual(Array(6).fill("2027-01-26"));
  database.native.exec(`UPDATE apps SET storefront_release_date_text = 'Feb 2027' WHERE appid = ${ROOT}`);
  await api.tick(database, "2027-01-28");
  expect(queries(database)).toHaveLength(12);
  await watch(database, ROOT, "2027-01-29", "unwatch");
  await api.tick(database, "2027-01-29");
  expect(queries(database)).toHaveLength(12);
  database.native.exec(`UPDATE apps SET storefront_release_date_text = 'Q4 2028' WHERE appid = ${ROOT}`);
  await watch(database, ROOT, "2027-01-30");
  await api.tick(database, "2027-01-30");
  expect(queries(database)).toHaveLength(18);
  expect(database.native.query("SELECT reason, enrolled_at FROM media_enrollments").get()).toEqual({
    reason: "watchlist", enrolled_at: "2027-01-25T05:00:00.000Z",
  });
});

test("old reviews precede previews for new children and a late released child stays in scope", async () => {
  const database = fixture();
  admit(database, ROOT, { status: "released", date: "2024-12-01" });
  admit(database, CHILD, { parent: ROOT });
  admit(database, REVIEW, { status: "released", date: "2027-01-22" });
  await watch(database);
  await watch(database, REVIEW);
  const api = world();
  await api.tick(database, "2027-01-25");
  expect(queries(database).map(({ appid, pass }) => [appid, pass])).toEqual([
    ...Array(6).fill([ROOT, "initial"]), ...Array(6).fill([CHILD, "preview"]),
  ]);
  await api.tick(database, "2027-01-26");
  expect(queries(database).filter(({ pass, appid }) => pass === "later" && appid === ROOT)).toHaveLength(6);
  await api.tick(database, "2027-01-28");
  expect(queries(database).filter(({ appid }) => appid === REVIEW)).toHaveLength(0);
  await api.tick(database, "2027-01-29");
  expect(queries(database).filter(({ appid }) => appid === REVIEW)).toHaveLength(6);
  admit(database, LATE, { parent: ROOT, status: "released", date: "2027-01-27" });
  await api.tick(database, "2027-02-03");
  expect(queries(database).filter(({ appid, pass }) => appid === LATE && pass === "initial")).toHaveLength(6);
  const coverage = database.native.query("SELECT appid FROM media_watch_coverage WHERE root_appid = ? ORDER BY appid").all(ROOT);
  expect(coverage).toEqual([{ appid: ROOT }, { appid: CHILD }, { appid: LATE }]);
  expect(database.native.query("SELECT DISTINCT appid FROM media_sources WHERE pass = 'preview'").all()).toEqual([{ appid: CHILD }]);
});

test("credit reservation survives restart and resets at the UTC month boundary", async () => {
  const database = fixture();
  admit(database, ROOT, { date: "2027-01-30" });
  admit(database, REVIEW, { status: "released", date: "2027-01-22" });
  await watch(database);
  await watch(database, REVIEW);
  const api = world();
  api.noArticles();
  api.tavily.remaining = 11;
  await api.tick(database, "2027-01-25");
  expect(queries(database)).toEqual([]);
  expect(database.native.query("SELECT value FROM checkpoints WHERE key = ?").get(PREVIEW_DEFERRAL_KEY)).toEqual({ value: "2027-01" });
  database.reopen();
  api.tavily.remaining = 100;
  await api.tick(database, "2027-01-29");
  await api.tick(database, "2027-01-31");
  expect(queries(database).map(({ pass }) => pass)).toEqual(Array(6).fill("initial"));
  await api.tick(database, "2027-02-01");
  expect(queries(database).map(({ pass }) => pass)).toEqual([...Array(6).fill("initial"), ...Array(6).fill("preview")]);
  expect(database.native.query("SELECT scheduled_on, due_at, end_reason FROM media_preview_occurrences ORDER BY id").all()).toEqual(
    ["2027-01-25", "2027-01-29", "2027-01-31", "2027-02-01"].map((scheduled_on, i) => ({
      scheduled_on, due_at: "2027-01-25T06:00:00.000Z", end_reason: i < 3 ? "superseded" : "completed",
    })),
  );
});

test("release without a date ends previews and uses the first observed day for both review passes", async () => {
  const database = fixture();
  admit(database, ROOT, { plan: "Early 2027" });
  await watch(database);
  const api = world();
  await api.tick(database, "2027-01-25");
  database.native.exec(`UPDATE apps SET release_status = 'released' WHERE appid = ${ROOT}`);
  await api.tick(database, "2027-01-26");
  expect(database.native.query("SELECT observed_released_on FROM media_watch_coverage").get()).toEqual({ observed_released_on: "2027-01-26" });
  await watch(database, ROOT, "2027-01-27", "unwatch");
  await api.tick(database, "2027-02-01");
  expect(queries(database).map(({ pass }) => pass)).toEqual(Array(6).fill("preview"));
  await api.tick(database, "2027-02-02");
  expect(queries(database).filter(({ pass }) => pass === "initial")).toHaveLength(6);
  database.native.exec(`UPDATE apps SET steam_release_date = '2027-02-01' WHERE appid = ${ROOT}`);
  await api.tick(database, shiftMediaDay("2027-01-26", 90));
  expect(queries(database).filter(({ pass }) => pass === "later")).toHaveLength(6);
});

test("preview and review each admit 15 articles and rejected preview URLs are remembered", async () => {
  const database = fixture();
  admit(database, ROOT, { date: "2027-01-30" });
  admit(database, CHILD, { parent: ROOT, date: "2027-01-30" });
  await watch(database);
  const api = world();
  const defaultResults = api.tavily.results!;
  api.tavily.results = (search) => {
    const accepted = defaultResults(search)!;
    if (search.query.endsWith("announcement")) {
      return [{ url: `https://${search.domain}/articles/${search.appid}/rejected-preview` }, ...accepted];
    }
    if (search.appid === ROOT && search.query.endsWith("review preview")) {
      const extra = defaultResults({ ...search, appid: CHILD })![0]!;
      return [...accepted, { url: `${extra.url}?via-root` }];
    }
    return accepted;
  };
  const controlledOutlet = (url: string) =>
    url.endsWith("rejected-preview") ? new Response("Not an article") : api.outlet(url);
  for (const day of ["2027-01-25", "2027-01-26", "2027-01-27", "2027-01-28"]) {
    await api.tick(database, day, { outlet: controlledOutlet });
  }
  expect(api.fetched.filter((url) => url.endsWith("rejected-preview"))).toHaveLength(MEDIA_OUTLETS.length * 2);
  expect(queries(database).filter(({ appid, pass }) => appid === CHILD && pass === "preview")).toHaveLength(15);
  database.native.exec("UPDATE apps SET release_status = 'released', steam_release_date = '2027-01-30'");
  await api.tick(database, "2027-02-06");
  await api.tick(database, "2027-04-30");
  expect(database.native.query("SELECT pass, COUNT(*) AS count FROM media_sources WHERE appid = ? GROUP BY pass ORDER BY pass").all(CHILD)).toEqual([
    { pass: "initial", count: 12 }, { pass: "later", count: 3 }, { pass: "preview", count: 15 },
  ]);
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources WHERE appid = ? AND original_url LIKE '%via-root'").get(ROOT)).toEqual({ count: 0 });
});

test("non-hands-on coverage enters extraction and the Internal website API keeps its scope", async () => {
  const database = fixture();
  admit(database, ROOT);
  await watch(database);
  const api = world();
  const discoveryResults = api.tavily.results!;
  api.tavily.results = (request) => request.domain.includes("ign") || request.domain.includes("gamespot") ? discoveryResults(request) : [];
  api.openRouter.onChat = (request) => {
    if (request.stage === "extraction") {
      const finding = mediaObservation(ROOT, "gear", "finding", "Players choose tools for each mission.", api.quote);
      const assessment = mediaObservation(ROOT, "praise", "pro", "The combat feels responsive.", api.quote);
      const tag = mediaObservation(ROOT, "gear-tag", "tag", "Mission loadouts", api.quote);
      api.openRouter.output("extraction", { observations: [finding, tag, assessment], originatingAssessment: "An enthusiastic endorsement." });
      return;
    }
    api.openRouter.output("synthesis", overviewOutputForUrls(request.urls));
  };
  await api.tick(database, "2027-01-25");
  const extracted = database.native.query<{ output_json: string }, []>("SELECT output_json FROM media_article_extractions ORDER BY id").all();
  expect(extracted).toHaveLength(2);
  expect(extracted.every(({ output_json }) => !output_json.includes("The combat feels responsive") && !output_json.includes("enthusiastic endorsement"))).toBe(true);
  expect(extracted.some(({ output_json }) => output_json.includes("non-hands-on preview"))).toBe(true);
  expect(extracted.some(({ output_json }) => output_json.includes("announcement"))).toBe(true);

  const previousPublic = process.env.MEDIA_OVERVIEW_PUBLIC;
  process.env.MEDIA_OVERVIEW_PUBLIC = "true";
  try {
    const request = new Request(`http://vaporstats.test/api/games/${ROOT}/detail`);
    const priorCalls = api.openRouter.requests.length;
    const response = await handleGameDetailRequest(request, database.db, ROOT, { includeUnpublished: true });
    const { data } = await response.json() as { data: GameDetailResponseData };
    expect(data.sources.map(({ type, handsOn }) => [type, handsOn]).sort()).toEqual([["announcement", false], ["preview", false]]);
    expect(data.mediaOverview).not.toBeNull();
    expect(JSON.stringify(data.mediaOverview)).toMatch(/announcement|non-hands-on preview/);
    expect(JSON.stringify(data.mediaOverview)).not.toContain("The combat feels responsive");
    const memberships = database.native.query<{ tag_label: string }, []>("SELECT tag_label FROM media_tag_memberships ORDER BY tag_label").all();
    expect(memberships.map(({ tag_label }) => tag_label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Mission loadouts.*announcement/i), expect.stringMatching(/Mission loadouts.*non-hands-on preview/i)]),
    );
    const publicResponse = await handleGameDetailRequest(request, database.db, ROOT);
    expect((await publicResponse.json()).data.sources).toEqual([]);
    expect(api.openRouter.requests).toHaveLength(priorCalls);
  } finally {
    if (previousPublic === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
    else process.env.MEDIA_OVERVIEW_PUBLIC = previousPublic;
  }
});

test("preview searches share Outlet denials, the daily cap, and Tavily Provider stops", async () => {
  const database = fixture();
  admit(database, ROOT);
  await watch(database);
  const api = world();
  api.noArticles();
  const addAttempt = database.native.prepare(`INSERT INTO media_discovery_attempts
    (appid, outlet, pass, day, kind, status_code, succeeded, attempted_at)
    VALUES (?, ?, 'initial', '2027-01-25', 'fetch', ?, ?, '2027-01-25T05:00:00Z')`);
  addAttempt.run(ROOT, "IGN", 403, 0);
  for (let i = 0; i < 30; i += 1) addAttempt.run(ROOT, "Eurogamer", 200, 1);
  api.tavily.reply({ status: 503 });
  await api.tick(database, "2027-01-25");
  expect(queries(database).map(({ outlet }) => outlet)).toEqual(["GameSpot"]);
  await api.tick(database, "2027-01-25", {}, "06:15");
  expect(queries(database).map(({ outlet }) => outlet)).toEqual(["GameSpot"]);
  await api.tick(database, "2027-01-26");
  expect(queries(database).filter(({ day }) => day === "2027-01-26").map(({ outlet }) => outlet)).toEqual(
    MEDIA_OUTLETS.filter(({ name }) => name !== "IGN").map(({ name }) => name),
  );
  expect(database.native.query("SELECT end_reason FROM media_preview_occurrences").all()).toEqual([{ end_reason: "completed" }]);
  expect(database.native.query("SELECT stop_reason FROM media_discovery_progress WHERE outlet = 'IGN'").get()).toEqual({ stop_reason: "fetch_http_403" });
});

test("an unwatch during a due occurrence stops its remaining queries and keeps admitted evidence", async () => {
  const database = fixture();
  admit(database, ROOT);
  admit(database, CHILD, { parent: ROOT });
  await watch(database);
  const api = world();
  await api.tick(database, "2027-01-25");
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources").get()).toEqual({ count: 12 });
  api.tavily.reply({ status: 503 });
  await api.tick(database, "2027-02-24");
  const served = queries(database).length;
  await watch(database, ROOT, "2027-02-25", "unwatch");
  await api.tick(database, "2027-02-25");
  expect(queries(database)).toHaveLength(served);
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources").get()).toEqual({ count: 12 });
  expect(database.native.query("SELECT end_reason FROM media_preview_occurrences WHERE scheduled_on = '2027-02-24'").all()).toEqual([
    { end_reason: "unwatched" }, { end_reason: "unwatched" },
  ]);
});

test("a resumed preview skips the prior occurrence's article and admits one new article for the outlet", async () => {
  const database = fixture();
  admit(database, ROOT);
  await watch(database);
  const api = world();
  const { name, domain } = MEDIA_OUTLETS[0]!;
  const articleA = `https://${domain}/articles/a`;
  const articleB = `https://${domain}/articles/b`;
  const articleC = `https://${domain}/articles/c`;
  const sources = () => database.native.query("SELECT original_url FROM media_sources WHERE pass = 'preview' ORDER BY id").all();
  api.tavily.results = (request) => request.domain === domain ? [{ url: articleA }] : [];
  const outlet = () => new Response(discoveryArticleHtml(ROOT, "NO LAW Hands-on Preview", {
    date: "2027-01-25",
    body: `NO LAW features a cargo ship mission where you pick your equipment before leaving port. ${api.quote} `.repeat(3),
  }));
  await api.tick(database, "2027-01-25", { outlet });
  expect(sources()).toEqual([{ original_url: articleA }]);

  const addAttempt = database.native.prepare(`INSERT INTO media_discovery_attempts
    (appid, outlet, pass, day, kind, status_code, succeeded, attempted_at)
    VALUES (?, ?, 'initial', '2027-02-24', 'fetch', 200, 1, '2027-02-24T05:00:00Z')`);
  // The second search takes the last daily attempt, so A is skipped and B awaits the next day's allowance.
  for (let i = 0; i < 29; i += 1) addAttempt.run(ROOT, name);
  api.tavily.results = (request) => request.domain === domain
    ? [articleA, articleB, articleC].map((url) => ({ url }))
    : [];
  await api.tick(database, "2027-02-24", { outlet });
  const progress = () => database.native.query(`SELECT progress.candidate_index, progress.status
    FROM media_discovery_progress AS progress JOIN media_preview_occurrences AS occurrence ON occurrence.id = progress.occurrence_id
    WHERE occurrence.scheduled_on = '2027-02-24' AND progress.outlet = ?`).get(name);
  expect(progress()).toEqual({ candidate_index: 1, status: "stopped" });
  expect(sources()).toEqual([{ original_url: articleA }]);

  const searchCount = queries(database).filter(({ outlet }) => outlet === name).length;
  database.reopen();
  api.fetched.length = 0;
  await api.tick(database, "2027-02-25", { outlet });
  await api.tick(database, "2027-02-25", { outlet }, "06:15");
  expect(sources()).toEqual([{ original_url: articleA }, { original_url: articleB }]);
  expect(progress()).toEqual({ candidate_index: 2, status: "completed" });
  expect(queries(database).filter(({ outlet }) => outlet === name)).toHaveLength(searchCount);
  expect(api.fetched).toContain(articleB);
  expect(api.fetched).not.toContain(articleA);
  expect(api.fetched).not.toContain(articleC);
});

test("a catalog entity that becomes ineligible skips the pending occurrence", async () => {
  const database = fixture();
  admit(database, ROOT);
  await watch(database);
  const api = world();
  api.tavily.reply({ status: 503 });
  await api.tick(database, "2027-01-25");
  database.native.exec(`UPDATE apps SET is_eligible = 0 WHERE appid = ${ROOT}`);
  await api.tick(database, "2027-01-26");
  expect(queries(database)).toHaveLength(1);
  expect(database.native.query("SELECT end_reason FROM media_preview_occurrences").get()).toEqual({ end_reason: "entity_ineligible" });
  expect(database.native.query("SELECT DISTINCT stop_reason FROM media_discovery_progress").all()).toEqual([{ stop_reason: "entity_ineligible" }]);
});

test("reserve credits for later queries that depend on unfinished initial discovery", async () => {
  const database = fixture();
  admit(database, ROOT);
  admit(database, REVIEW, { status: "released", date: "2024-12-05" });
  await watch(database);
  await watch(database, REVIEW);
  const capped = database.native.prepare(`INSERT INTO media_discovery_attempts
    (appid, outlet, pass, day, kind, status_code, succeeded, attempted_at)
    VALUES (?, 'IGN', 'initial', '2027-01-25', 'fetch', 200, 1, '2027-01-25T05:00:00Z')`);
  for (let i = 0; i < 30; i += 1) capped.run(REVIEW);
  const api = world();
  api.tavily.remaining = 16;
  await api.tick(database, "2027-01-25");
  expect(queries(database).map(({ pass }) => pass)).toEqual(Array(5).fill("initial"));
  expect(database.native.query("SELECT value FROM checkpoints WHERE key = ?").get(PREVIEW_DEFERRAL_KEY)).toEqual({ value: "2027-01" });
  await api.tick(database, "2027-01-26");
  await api.tick(database, "2027-01-27");
  expect(queries(database).map(({ pass }) => pass)).toEqual([...Array(6).fill("initial"), ...Array(6).fill("later")]);
});

test("reject non-preview candidates and admit the pre-release review in the released assessment flow", async () => {
  const database = fixture();
  admit(database, ROOT, { date: "2027-01-30" });
  admit(database, CHILD, { parent: ROOT, status: "released", date: "2027-01-30" });
  await watch(database);
  const api = world();
  const titles: Record<string, string> = {
    review: "NO LAW Review",
    guide: "NO LAW Preview Guide",
    patch: "NO LAW Patch Notes",
    roundup: "NO LAW Preview Roundup",
    comparison: "NO LAW and Fort Harbor Preview",
    child: "NO LAW Night Shift Preview",
    hands: "NO LAW Hands-on Preview",
  };
  api.tavily.results = ({ domain, query, appid }) => {
    if (appid !== ROOT || domain !== MEDIA_OUTLETS[0]!.domain) return [];
    const titlesForPass = query.endsWith("announcement") ? Object.keys(titles) : ["review"];
    return titlesForPass.map((kind) => ({ url: `https://${domain}/articles/${kind}` }));
  };
  const outlet = (url: string) => {
    const name = new URL(url).pathname.split("/").at(-1)!;
    return new Response(discoveryArticleHtml(ROOT, titles[name]!, {
      body: `${titles[name]} details a campaign where you choose tools before each mission. ${api.quote} `.repeat(3),
      date: "2027-01-25",
    }));
  };
  await api.tick(database, "2027-01-25", { outlet });
  expect(database.native.query("SELECT type, hands_on, title FROM media_sources").all()).toEqual([
    { type: "preview", hands_on: 1, title: titles.hands },
  ]);
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_preview_rejections WHERE appid = ?").get(ROOT)).toEqual({ count: 6 });
  database.native.exec(`UPDATE apps SET release_status = 'released' WHERE appid = ${ROOT}`);
  await api.tick(database, "2027-02-06", { outlet });
  expect(database.native.query("SELECT pass, title FROM media_sources WHERE appid = ? ORDER BY pass").all(ROOT)).toEqual([
    { pass: "initial", title: titles.review }, { pass: "preview", title: titles.hands },
  ]);
});

test.each([
  "In this roundup, we preview several games coming next year.",
  "NO LAW headlines our roundup of several upcoming games. We also preview Zelda and Starfield below.",
])("preview discovery rejects roundup framing (%s) and accepts a closing recommendation", async (lead) => {
  const database = fixture();
  admit(database, ROOT);
  await watch(database);
  const api = world();
  const roundup = "https://gamesradar.com/articles/roundup";
  const preview = "https://gamesradar.com/articles/no-law";
  api.tavily.results = ({ domain }) => domain === "gamesradar.com" ? [{ url: roundup }, { url: preview }] : [];
  const body = "NO LAW takes place in a city where each mission lets you pick new equipment and routes. ".repeat(4);
  await api.tick(database, "2027-01-25", { outlet: (url) => new Response(discoveryArticleHtml(ROOT, "NO LAW Preview", {
    body: url === roundup
      ? lead + " " + body
      : "We saw NO LAW in a hands-off preview. " + body + "If you can't wait, here are some games like Cyberpunk 2077.",
  })) });
  expect(database.native.query("SELECT discovery_url, type, hands_on FROM media_sources").all()).toEqual([
    { discovery_url: preview, type: "preview", hands_on: 0 },
  ]);
  expect(database.native.query("SELECT url FROM media_preview_rejections").all()).toEqual([{ url: roundup }]);
});

test.each(["admit", "denied", "canonical_duplicate", "candidate_error"] as const)(
  "scoped preview replay preserves history and outlet rules (%s)",
  async (scenario) => {
    const database = fixture();
    admit(database, ROOT);
    await watch(database);
    const api = world();
    const url = "https://gamesradar.com/articles/preview";
    const canonical = "https://gamesradar.com/canonical";
    api.tavily.results = ({ domain }) => domain === "gamesradar.com" ? [{ url }] : [];
    const body = "NO LAW takes place in a city where each mission lets you pick new equipment and routes. ".repeat(4);
    await api.tick(database, "2027-01-25", { outlet: (candidate) =>
      candidate === url ? Response.redirect(url + "/", 301) : new Response(discoveryArticleHtml(ROOT, "NO LAW Roundup", { body })),
    });
    const progressForOutlet = () => database.native.query<{ id: number }, []>(
      "SELECT * FROM media_discovery_progress WHERE outlet = 'GamesRadar+'",
    ).get()!;
    const progress = progressForOutlet();
    const historical = database.native.query("SELECT * FROM media_discovery_attempts ORDER BY id").all();
    const searches = api.tavily.requests.length;
    const article = discoveryArticleHtml(ROOT, "NO LAW Preview", {
      body: "We saw NO LAW in a hands-off preview. " + body + "Here are some games like Cyberpunk 2077.",
    }).replace("</head>", `<link rel="canonical" href="${canonical}"></head>`);
    const calls: string[] = [];
    const fetch = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (scenario === "candidate_error") {
        return new class extends Response {
          override async text(): Promise<string> { throw new Error("Article body read failed"); }
        }(article);
      }
      return new Response(article);
    };
    const insertAttempt = database.native.prepare(`INSERT INTO media_discovery_attempts
      (appid, outlet, pass, day, kind, status_code, succeeded, attempted_at)
      VALUES (?, 'GamesRadar+', 'initial', '2027-01-25', 'fetch', ?, ?, '2027-01-25T07:00:00Z')`);
    const replay = (date: string, candidate = url) => replayRejectedPreviewCandidate(database.db, { progressId: progress.id, url: candidate, now: new Date(date), fetch });
    expect(await replay("2027-01-25T08:00Z", canonical)).toEqual({ admitted: false, reason: "not_a_rejected_candidate" });

    if (scenario === "denied") insertAttempt.run(ROOT, 403, 0);
    if (scenario === "admit") {
      for (let i = 0; i < outletDailyAttemptCap(); i += 1) insertAttempt.run(ROOT, 200, 1);
      expect(await replay("2027-01-25T08:00Z")).toEqual({ admitted: false, reason: "daily_attempt_cap" });
      expect(calls).toEqual([]);
    }
    if (scenario === "canonical_duplicate") {
      database.native.prepare(`INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type)
        VALUES (?, 'initial', ?, 'Existing assessment', 'GamesRadar+', '2027-01-25', 'review')`).run(ROOT, canonical);
    }

    const reason = { admit: null, denied: "fetch_http_403", canonical_duplicate: "already_admitted", candidate_error: "candidate_error" }[scenario];
    expect(await replay("2027-01-26T05:00Z")).toEqual({ admitted: scenario === "admit", reason });
    database.reopen();
    expect(await replay("2027-01-26T05:01Z")).toEqual({
      admitted: false, reason: scenario === "admit" ? "already_admitted" : "already_replayed",
    });
    expect(calls).toEqual(scenario === "denied" ? [] : [url]);
    expect(progressForOutlet()).toEqual(progress);
    expect(queries(database)).toHaveLength(searches);
    expect(database.native.query("SELECT * FROM media_discovery_attempts ORDER BY id").all().slice(0, historical.length)).toEqual(historical);
    expect(database.native.query("SELECT url FROM media_preview_rejections").all()).toEqual([{ url }]);
    if (scenario === "admit") {
      expect(database.native.query("SELECT discovery_url, type, hands_on FROM media_sources").all()).toEqual([
        { discovery_url: url, type: "preview", hands_on: 0 },
      ]);
      await api.tick(database, "2027-01-26", { paidSubmissionsPerTick: 0 }, "05:30");
      expect(api.tavily.requests).toHaveLength(searches);
      expect(api.openRouter.requests).toHaveLength(0);
      expect(database.native.query("SELECT stage, status FROM media_processing_jobs").all()).toEqual([
        { stage: "extraction", status: "queued" },
      ]);
    }
  },
);

test("a watch preserves an existing enrollment and preview metadata respects the public switch", async () => {
  const database = fixture();
  const appid = 1091500;
  database.native.prepare("INSERT INTO apps (appid, name, slug, release_status) VALUES (?, 'Cyberpunk 2077', 'cyberpunk-2077', 'released')").run(appid);
  database.native.prepare("INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (?, 'experiment', '2026-11-20')").run(appid);
  await watch(database, appid);
  expect(database.native.query("SELECT reason, enrolled_at FROM media_enrollments").get()).toEqual({
    reason: "experiment", enrolled_at: "2026-11-20",
  });
  database.native.prepare(`INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type)
    VALUES (?, 'preview', 'https://ign.com/preview', 'Preview', 'IGN', '2027-01-01', 'preview'),
           (?, 'initial', 'https://ign.com/review', 'Review', 'IGN', '2027-01-02', 'review')`).run(appid, appid);
  const original = process.env.MEDIA_OVERVIEW_PUBLIC;
  try {
    process.env.MEDIA_OVERVIEW_PUBLIC = "false";
    expect((await getMediaSources(database.db, appid)).map(({ type }) => type)).toEqual(["review"]);
    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    expect((await getMediaSources(database.db, appid)).map(({ type }) => type)).toEqual(["preview", "review"]);
  } finally {
    if (original === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
    else process.env.MEDIA_OVERVIEW_PUBLIC = original;
  }
});

test("watching and unwatching an undated experiment root preserves its due assessments", async () => {
  const database = fixture();
  admit(database, ROOT, { status: "released" });
  const enrolledAt = "2027-01-20T05:00:00.000Z";
  database.native.prepare("INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (?, 'experiment', ?)").run(ROOT, enrolledAt);
  const next = async (day: string) => (await nextMediaAssessment(database.db, ROOT, new Date(`${day}T05:30:00Z`))).get(ROOT);
  const initial = { pass: "initial", dueAt: enrolledAt } as const;
  expect(await next("2027-01-25")).toEqual(initial);
  await watch(database);
  expect(await next("2027-01-25")).toEqual(initial);

  const api = world();
  await api.tick(database, "2027-01-25");
  const later = { pass: "later", dueAt: "2027-01-25T06:00:00.000Z" } as const;
  expect(await next("2027-01-26")).toEqual(later);
  await watch(database, ROOT, "2027-01-26", "unwatch");
  expect(await next("2027-01-26")).toEqual(later);
  await api.tick(database, "2027-01-26");
  expect(queries(database).map(({ pass, day }) => [pass, day])).toEqual([
    ...MEDIA_OUTLETS.map(() => ["initial", "2027-01-25"]),
    ...MEDIA_OUTLETS.map(() => ["later", "2027-01-26"]),
  ]);
});
