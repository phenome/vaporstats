import { afterEach, expect, test } from "bun:test";
import type { TestDatabase } from "./support/db";
import { openTestDatabase } from "./support/db";
import { fetchSteamAppDetails } from "../workers/catalog-seed";
import { upsertApp } from "../src/lib/catalog";
import { ASSESSMENT_MEDIA_OUTLETS, getMediaSources, MEDIA_OUTLETS, nextMediaAssessment, replayRejectedPreviewCandidate } from "../src/lib/media-discovery";
import { outletDailyAttemptCap, previewDailyAttemptShare } from "../src/lib/media-outlet-access";
import { changeMediaWatch, expectedMediaReleaseDate, mediaWatchSchedule, previewInterval, PREVIEW_DEFERRAL_KEY, previewMonthlyCreditShare, shiftMediaDay } from "../src/lib/media-watchlist";
import { handleGameDetailRequest, type GameDetailResponseData } from "../src/routes/api.games.$appid.detail";
import { controlledGeminiApi, controlledOpenRouterApi, controlledTavilyApi, discoveryArticleHtml, outletFixtureUrl, mediaObservation, runMediaTick, overviewOutputForUrls, synthesisEvidence, synthesisSelectionId, emptySynthesisSelection, type MediaTickOptions } from "./support/media";

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

/**
 * Sets the production daily attempt cap of 200 per outlet for one test, so
 * its preview share of 20 attempts leaves room for several candidates of
 * several entities per outlet and UTC day.
 */
function productionOutletCap() {
  const previous = process.env.MEDIA_OUTLET_DAILY_ATTEMPTS;
  process.env.MEDIA_OUTLET_DAILY_ATTEMPTS = "200";
  cleanup.push(() => {
    if (previous === undefined) delete process.env.MEDIA_OUTLET_DAILY_ATTEMPTS;
    else process.env.MEDIA_OUTLET_DAILY_ATTEMPTS = previous;
  });
}

/** Marks the searches `usePreviewCreditShare` records, which `queries` leaves out. */
const SEEDED_SEARCH = "seeded:preview-credit-share";

/** Records `count` preview searches served earlier in `month`, so its preview credit share is used. */
function usePreviewCreditShare(database: TestDatabase, month: string, count = 100) {
  const insert = database.native.prepare(`INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, status_code, succeeded, attempted_at)
    VALUES (?, 'IGN', 'preview', ?, 'search', '${SEEDED_SEARCH}', 200, 1, ?)`);
  for (let i = 0; i < count; i += 1) insert.run(ROOT, `${month}-01`, `${month}-01T00:00:00.000Z`);
}

async function watch(database: TestDatabase, appid = ROOT, day = "2027-01-25", action: "watch" | "unwatch" = "watch") {
  expect((await changeMediaWatch(database.db, action, String(appid), new Date(`${day}T05:00:00Z`))).status).toBe(200);
}

function queries(database: TestDatabase) {
  return database.native.query<{ pass: string; appid: number; outlet: string; day: string }, [string]>(
    "SELECT pass, appid, outlet, day FROM media_discovery_attempts WHERE kind = 'search' AND url IS NOT ? ORDER BY id",
  ).all(SEEDED_SEARCH);
}

function world(extraArticleText = "") {
  const tavily = controlledTavilyApi(names);
  const openRouter = controlledOpenRouterApi();
  const gemini = controlledGeminiApi();
  let day: string;
  let deliver = true;
  const fetched: string[] = [];
  tavily.results = ({ query, appid, domain }) => {
    const pass = query.endsWith("review revisited") ? "later" : query.endsWith("review preview") ? "initial" : "preview";
    return deliver ? [{ url: outletFixtureUrl(domain, `articles/${appid}/${pass}/${day}`) }] : [];
  };
  const quote = "Builds reward experimentation when players select a new set of tools for each mission.";
  const outlet = (url: string) => {
    const { pathname, hostname } = new URL(url);
    const [, , appid, pass, published] = pathname.replace(/^\/gaming(?=\/)/, "").split("/");
    const name = names[Number(appid)];
    if (!name) return new Response(null, { status: 404 });
    const articleType = pass === "preview" ? hostname.includes("ign") ? "Announcement" : "Preview" : "Review";
    return new Response(discoveryArticleHtml(Number(appid), `${name} ${articleType}`, {
      date: published,
      author: `${hostname} critic`,
      body: `${name} features a mission on a cargo ship where players select their equipment before leaving port. ${quote} `.repeat(3) + extraArticleText,
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
  expect(queries(database).map(({ day }) => day)).toEqual(Array(MEDIA_OUTLETS.length).fill("2027-01-26"));
  database.native.exec(`UPDATE apps SET storefront_release_date_text = 'Feb 2027' WHERE appid = ${ROOT}`);
  await api.tick(database, "2027-01-28");
  expect(queries(database)).toHaveLength(2 * MEDIA_OUTLETS.length);
  await watch(database, ROOT, "2027-01-29", "unwatch");
  await api.tick(database, "2027-01-29");
  expect(queries(database)).toHaveLength(2 * MEDIA_OUTLETS.length);
  database.native.exec(`UPDATE apps SET storefront_release_date_text = 'Q4 2028' WHERE appid = ${ROOT}`);
  await watch(database, ROOT, "2027-01-30");
  await api.tick(database, "2027-01-30");
  expect(queries(database)).toHaveLength(3 * MEDIA_OUTLETS.length);
  expect(database.native.query("SELECT reason, enrolled_at FROM media_enrollments").get()).toEqual({
    reason: "watchlist", enrolled_at: "2027-01-25T05:00:00.000Z",
  });
});

test("previews of new children precede old reviews and a late released child stays in scope", async () => {
  const database = fixture();
  admit(database, ROOT, { status: "released", date: "2024-12-01" });
  admit(database, CHILD, { parent: ROOT });
  admit(database, REVIEW, { status: "released", date: "2027-01-22" });
  await watch(database);
  await watch(database, REVIEW);
  const api = world();
  await api.tick(database, "2027-01-25");
  expect(queries(database).map(({ appid, pass }) => [appid, pass])).toEqual([
    ...Array(MEDIA_OUTLETS.length).fill([CHILD, "preview"]), ...Array(6).fill([ROOT, "initial"]),
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

test("beyond the preview credit share, the credit reservation survives restart and resets at the UTC month boundary", async () => {
  const database = fixture();
  admit(database, ROOT, { date: "2027-01-30" });
  admit(database, REVIEW, { status: "released", date: "2027-01-22" });
  await watch(database);
  await watch(database, REVIEW);
  usePreviewCreditShare(database, "2027-01");
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
  // A new month brings a new preview credit share.
  expect(queries(database).map(({ pass }) => pass)).toEqual([...Array(6).fill("initial"), ...Array(MEDIA_OUTLETS.length).fill("preview")]);
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
  expect(queries(database).map(({ pass }) => pass)).toEqual(Array(MEDIA_OUTLETS.length).fill("preview"));
  await api.tick(database, "2027-02-02");
  expect(queries(database).filter(({ pass }) => pass === "initial")).toHaveLength(6);
  database.native.exec(`UPDATE apps SET steam_release_date = '2027-02-01' WHERE appid = ${ROOT}`);
  await api.tick(database, shiftMediaDay("2027-01-26", 90));
  expect(queries(database).filter(({ pass }) => pass === "later")).toHaveLength(6);
});

test("preview and review each admit 15 articles and rejected preview URLs are remembered", async () => {
  const database = fixture();
  productionOutletCap();
  admit(database, ROOT, { date: "2027-01-30" });
  admit(database, CHILD, { parent: ROOT, date: "2027-01-30" });
  await watch(database);
  const api = world();
  const defaultResults = api.tavily.results!;
  api.tavily.results = (search) => {
    const accepted = defaultResults(search)!;
    if (search.query.endsWith("announcement")) {
      return [{ url: outletFixtureUrl(search.domain, `articles/${search.appid}/rejected-preview`) }, ...accepted];
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

test("non-hands-on coverage enters extraction and keeps NO LAW browse tags concise with scoped prose", async () => {
  const database = fixture();
  admit(database, ROOT);
  await watch(database);
  const genreQuote = "NO LAW is an upcoming cyber-noir role-playing game.";
  const api = world(genreQuote);
  const discoveryResults = api.tavily.results!;
  api.tavily.results = (request) => request.domain.includes("ign") || request.domain.includes("gamespot") ? discoveryResults(request) : [];
  api.openRouter.onChat = (request) => {
    if (request.stage === "extraction") {
      const finding = mediaObservation(ROOT, "gear", "finding", "Players choose tools for each mission.", api.quote);
      const setting = mediaObservation(ROOT, "setting", "finding", "The mission takes place on a cargo ship.",
        "features a mission on a cargo ship where players select their equipment before leaving port.");
      const departure = mediaObservation(ROOT, "departure", "finding", "Players leave port after selecting their equipment.",
        "features a mission on a cargo ship where players select their equipment before leaving port.");
      const assessment = mediaObservation(ROOT, "praise", "pro", "The combat feels responsive.", api.quote);
      const traits = [
        { ...mediaObservation(ROOT, "world", "tag", "Cyber-noir", genreQuote), qualifiers: ["upcoming"] },
        { ...mediaObservation(ROOT, "genre", "tag", "Role-playing game", genreQuote), qualifiers: ["upcoming"] },
      ];
      api.openRouter.output("extraction", { observations: [finding, setting, departure, assessment, ...traits], originatingAssessment: "An enthusiastic endorsement." });
      return;
    }
    const sources = synthesisEvidence(request.body);
    const announcement = sources.find(({ sourceUrl }) => sourceUrl.includes("ign"))!;
    const preview = sources.find(({ sourceUrl }) => sourceUrl.includes("gamespot"))!;
    const clause = (text: string, source: typeof preview, id: string) => ({ text, observationIds: [synthesisSelectionId(source, id)] });
    expect(request.body.messages[0]!.content).toContain("Attach the announcement only to the setting span.");
    expect(request.body.messages[0]!.content).toContain("separate ‘Cyber-noir’ and ‘Role-playing game’ labels");
    api.openRouter.output("synthesis", {
      ...emptySynthesisSelection(sources),
      tags: [
        { label: "Upcoming Cyber-noir (non-hands-on preview)", observationIds: [synthesisSelectionId(preview, "world")] },
        { label: "Role-playing game", observationIds: [synthesisSelectionId(preview, "genre")] },
      ],
      statements: [
        clause("The announcement sets the mission on a cargo ship.", announcement, "setting"),
        clause("You choose tools for each mission (non-hands-on preview, preview)", preview, "gear"),
        clause("and leave port with your chosen equipment.", preview, "departure"),
      ],
      categories: {
        ...emptySynthesisSelection(sources).categories,
        "Gameplay & systems": [clause("You leave port after picking equipment.", preview, "departure")],
      },
    });
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
    const announcement = data.sources.find(({ type }) => type === "announcement")!.originalUrl;
    const preview = data.sources.find(({ type }) => type === "preview")!.originalUrl;
    expect(data.mediaOverview?.statements).toEqual([
      { text: "The announcement sets the mission on a cargo ship.", sourceUrls: [announcement] },
      { text: "You choose tools for each mission (hands-off preview)", sourceUrls: [preview] },
      { text: "and leave port with your chosen equipment.", sourceUrls: [preview] },
    ]);
    expect(data.mediaOverview?.categories).toEqual([
      { name: "Gameplay & systems", findings: [{ text: "You leave port after picking equipment (hands-off preview)", sourceUrls: [preview] }] },
    ]);
    const saved = JSON.parse(database.native.query<{ output_json: string }, []>("SELECT output_json FROM media_game_overviews WHERE active = 1").get()!.output_json);
    expect(saved.statements.map(({ observationRefs }: { observationRefs: Array<{ observationId: string }> }) =>
      observationRefs.map(({ observationId }) => observationId))).toEqual([["setting"], ["gear"], ["departure"]]);
    expect(JSON.stringify(data.mediaOverview)).not.toContain("The combat feels responsive");
    const memberships = database.native.query(`SELECT tag_slug, tag_label, original_url
      FROM media_tag_memberships JOIN media_sources ON media_sources.id = media_tag_memberships.source_id
      ORDER BY tag_slug`).all();
    expect(memberships).toEqual([
      { tag_slug: "cyber-noir", tag_label: "Cyber-noir", original_url: preview },
      { tag_slug: "role-playing-game", tag_label: "Role-playing game", original_url: preview },
    ]);
    expect(saved.tags.map(({ label, sourceUrls, observationRefs }: {
      label: string; sourceUrls: string[]; observationRefs: Array<{ observationId: string }>;
    }) => [label, sourceUrls, observationRefs.map(({ observationId }) => observationId)])).toEqual([
      ["Cyber-noir", [preview], ["world"]],
      ["Role-playing game", [preview], ["genre"]],
    ]);
    const publicResponse = await handleGameDetailRequest(request, database.db, ROOT);
    const published = (await publicResponse.json()).data;
    expect(published.sources).toEqual(data.sources);
    expect(published.mediaOverview).toEqual(data.mediaOverview);
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
  productionOutletCap();
  admit(database, ROOT);
  admit(database, CHILD, { parent: ROOT });
  await watch(database);
  const api = world();
  await api.tick(database, "2027-01-25");
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources").get()).toEqual({ count: 2 * MEDIA_OUTLETS.length });
  api.tavily.reply({ status: 503 });
  await api.tick(database, "2027-02-24");
  const served = queries(database).length;
  await watch(database, ROOT, "2027-02-25", "unwatch");
  await api.tick(database, "2027-02-25");
  expect(queries(database)).toHaveLength(served);
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources").get()).toEqual({ count: 2 * MEDIA_OUTLETS.length });
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
  const articleA = outletFixtureUrl(domain, `articles/a`);
  const articleB = outletFixtureUrl(domain, `articles/b`);
  const articleC = outletFixtureUrl(domain, `articles/c`);
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
  usePreviewCreditShare(database, "2027-01");
  const api = world();
  api.tavily.remaining = 16;
  await api.tick(database, "2027-01-25");
  expect(queries(database).map(({ pass }) => pass)).toEqual(Array(5).fill("initial"));
  expect(database.native.query("SELECT value FROM checkpoints WHERE key = ?").get(PREVIEW_DEFERRAL_KEY)).toEqual({ value: "2027-01" });
  await api.tick(database, "2027-01-26");
  await api.tick(database, "2027-01-27");
  expect(queries(database).map(({ pass }) => pass)).toEqual([...Array(6).fill("initial"), ...Array(6).fill("later")]);
});

test("reject non-preview candidates, admit plain coverage without preview wording, and admit the pre-release review in the released assessment flow", async () => {
  const database = fixture();
  productionOutletCap();
  admit(database, ROOT, { date: "2027-01-30" });
  admit(database, CHILD, { parent: ROOT, status: "released", date: "2027-01-30" });
  await watch(database);
  const api = world();
  // Every refused kind, in the order the outlets return them; IGN's hands-on preview comes last.
  const titles: Record<string, string> = {
    review: "NO LAW Review",
    guide: "NO LAW Preview Guide",
    patch: "NO LAW Patch Notes",
    roundup: "NO LAW Preview Roundup",
    comparison: "NO LAW and Fort Harbor Preview",
    versus: "NO LAW versus Fort Harbor",
    reviewNews: "NO LAW review embargo details",
    developer: "NO LAW dev diary: building the harbor",
    short: "NO LAW in brief",
    child: "NO LAW Night Shift Preview",
    hands: "NO LAW Hands-on Preview",
  };
  const GAMESPOT_KINDS = ["developer", "short"];
  // Eurogamer's only candidate: a plain descriptive feature with no preview wording.
  const plain = "NO LAW sends you through a harbor city one mission at a time";
  api.tavily.results = ({ domain, query, appid }) => {
    if (appid !== ROOT) return [];
    if (domain === MEDIA_OUTLETS[1]!.domain) return query.endsWith("announcement") ? [{ url: outletFixtureUrl(domain, `articles/plain`) }] : [];
    // A query returns at most 10 candidates, so GameSpot returns the developer page and the unusable one.
    if (domain === MEDIA_OUTLETS[2]!.domain) return query.endsWith("announcement") ? GAMESPOT_KINDS.map((kind) => ({ url: outletFixtureUrl(domain, `articles/${kind}`) })) : [];
    if (domain !== MEDIA_OUTLETS[0]!.domain) return [];
    const titlesForPass = query.endsWith("announcement") ? Object.keys(titles).filter((kind) => !GAMESPOT_KINDS.includes(kind)) : ["review"];
    return titlesForPass.map((kind) => ({ url: outletFixtureUrl(domain, `articles/${kind}`) }));
  };
  const outlet = (url: string) => {
    const name = new URL(url).pathname.replace(/^\/gaming(?=\/)/, "").split("/").at(-1)!;
    const title = name === "plain" ? plain : titles[name]!;
    return new Response(discoveryArticleHtml(ROOT, title, {
      body: name === "short" ? "NO LAW in brief." : `${title} details a campaign where you choose tools before each mission. ${api.quote} `.repeat(3),
      author: name === "developer" ? "NO LAW developer" : "Reviewer",
      date: "2027-01-25",
    }));
  };
  await api.tick(database, "2027-01-25", { outlet });
  expect(database.native.query("SELECT outlet, type, hands_on, title FROM media_sources ORDER BY outlet").all()).toEqual([
    { outlet: "Eurogamer", type: "preview", hands_on: 0, title: plain },
    { outlet: "IGN", type: "preview", hands_on: 1, title: titles.hands },
  ]);
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_preview_rejections WHERE appid = ?").get(ROOT)).toEqual({ count: Object.keys(titles).length - 1 });
  database.native.exec(`UPDATE apps SET release_status = 'released' WHERE appid = ${ROOT}`);
  await api.tick(database, "2027-02-06", { outlet });
  expect(database.native.query("SELECT pass, title FROM media_sources WHERE appid = ? AND outlet = 'IGN' ORDER BY pass").all(ROOT)).toEqual([
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

test.each(["admit", "preview_share", "denied", "canonical_duplicate", "candidate_error"] as const)(
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
    if (scenario === "preview_share") {
      // The occurrence's search, fetch and redirect used GamesRadar+'s preview share for the day.
      expect(database.native.query("SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = 'GamesRadar+' AND pass = 'preview' AND day = '2027-01-25'").get())
        .toEqual({ count: previewDailyAttemptShare() });
      expect(await replay("2027-01-25T08:00Z")).toEqual({ admitted: false, reason: "preview_daily_share" });
      expect(calls).toEqual([]);
    }
    if (scenario === "canonical_duplicate") {
      database.native.prepare(`INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type)
        VALUES (?, 'initial', ?, 'Existing assessment', 'GamesRadar+', '2027-01-25', 'review')`).run(ROOT, canonical);
    }

    const admits = scenario === "admit" || scenario === "preview_share";
    const reason = { admit: null, preview_share: null, denied: "fetch_http_403", canonical_duplicate: "already_admitted", candidate_error: "candidate_error" }[scenario];
    expect(await replay("2027-01-26T05:00Z")).toEqual({ admitted: admits, reason });
    database.reopen();
    expect(await replay("2027-01-26T05:01Z")).toEqual({
      admitted: false, reason: admits ? "already_admitted" : "already_replayed",
    });
    expect(calls).toEqual(scenario === "denied" ? [] : [url]);
    expect(progressForOutlet()).toEqual(progress);
    expect(queries(database)).toHaveLength(searches);
    expect(database.native.query("SELECT * FROM media_discovery_attempts ORDER BY id").all().slice(0, historical.length)).toEqual(historical);
    expect(database.native.query("SELECT url FROM media_preview_rejections").all()).toEqual([{ url }]);
    if (admits) {
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
    ...ASSESSMENT_MEDIA_OUTLETS.map(() => ["initial", "2027-01-25"]),
    ...ASSESSMENT_MEDIA_OUTLETS.map(() => ["later", "2027-01-26"]),
  ]);
});

const WARLOCK = 3714800;
const BG3 = 1086940;
const WARLOCK_NAMES: Record<number, string> = { [WARLOCK]: "Warlock: Dungeons & Dragons", [BG3]: "Baldur's Gate 3" };

/**
 * A synthetic GamesRadar+-shaped feature page: `tags` in `mrf:tags`, no
 * preview or announcement wording and no hands-on phrase unless the title or
 * body adds them.
 */
function featureHtml(title: string, body: string, tags = "region:GB;articleType:Features;channel:Gaming software;unindexedFreeform:preview") {
  return `<!doctype html><html><head><meta property="og:title" content="${title.replaceAll("\"", "&quot;")}">`
    + `<meta property="article:published_time" content="2026-08-26T12:00:00Z"><meta name="author" content="Staff writer">`
    + `<meta property="mrf:tags" content="${tags}"></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
}

/** Warlock's GamesRadar+-shaped feature: short name first in the title, Baldur's Gate 3 also named, the full name once in the body. */
const WARLOCK_FEATURE = {
  title: "Warlock steps out of Baldur's Gate 3's shadow with its own spin on D&D that I want to see more of",
  body: [
    "Warlock: Dungeons & Dragons casts you as a lone spellcaster bound to a demanding patron.",
    "In a demo shown behind closed doors, Warlock moved quickly from a ruined chapel to a flooded crypt.",
    "Baldur's Gate 3 made party banter its heart, while Warlock keeps you alone with the voice of your patron.",
    "Warlock trades turn order for real-time spell chains, and Warlock lets each pact reshape your spell list.",
    "Fans of Baldur's Gate 3 will spot familiar monsters, but Warlock frames them as rivals for your patron's favour.",
    "By the end of the demo, Warlock had shown three pacts and a boss that steals spells mid-fight.",
  ].join(" "),
};

function warlockWorld(articles: Record<string, string>, names: Record<number, string> = WARLOCK_NAMES) {
  const tavily = controlledTavilyApi(names);
  const openRouter = controlledOpenRouterApi();
  const gemini = controlledGeminiApi();
  const fetched: string[] = [];
  /** Candidate URLs by entity, pass and outlet domain. */
  const results: Record<string, string[]> = {};
  tavily.results = ({ appid, query, domain }) => {
    const pass = query.endsWith("announcement") ? "preview" : query.endsWith("review preview") ? "initial" : "later";
    return (results[`${appid}:${pass}:${domain}`] ?? []).map((url) => ({ url }));
  };
  const outlet = (url: string) => articles[url] === undefined ? new Response(null, { status: 404 }) : new Response(articles[url]);
  return {
    tavily, openRouter, gemini, fetched, results,
    async tick(database: TestDatabase, at: string) {
      const result = await runMediaTick(database, { tavily, openRouter, gemini }, at, { fetched, outlet, paidSubmissionsPerTick: 40 });
      expect(result.status).toBe("completed");
      expect(result.mediaError).toBeUndefined();
      return result;
    },
  };
}

function admitWarlockCatalog(database: TestDatabase, warlockStatus = "upcoming", warlockDate: string | null = null, bg3Status = "released") {
  database.native.prepare(`INSERT INTO apps (appid, name, slug, type, release_status, steam_release_date) VALUES
    (?, 'Warlock: Dungeons & Dragons', 'warlock-dungeons-dragons', 'game', ?, ?),
    (?, 'Baldur''s Gate 3', 'baldurs-gate-3', 'game', ?, '2023-08-03')`).run(WARLOCK, warlockStatus, warlockDate, BG3, bg3Status);
}

test("a Warlock-shaped feature naming Baldur's Gate 3 is admitted as a hands-off preview of Warlock and rejected by subject for Baldur's Gate 3's own preview query", async () => {
  const database = fixture();
  // Baldur's Gate 3 is a second watched upcoming root here, so its preview query fetches the same article.
  admitWarlockCatalog(database, "upcoming", null, "upcoming");
  await watch(database, WARLOCK, "2026-11-27");
  await watch(database, BG3, "2026-11-27");
  const feature = "https://gamesradar.com/articles/warlock-feature";
  const api = warlockWorld({ [feature]: featureHtml(WARLOCK_FEATURE.title, WARLOCK_FEATURE.body) });
  api.results[`${WARLOCK}:preview:gamesradar.com`] = [feature];
  api.results[`${BG3}:preview:gamesradar.com`] = [feature];
  productionOutletCap();
  await api.tick(database, "2026-11-27T06:00:00.000Z");
  expect(database.native.query("SELECT appid, pass, type, hands_on, original_url FROM media_sources").all()).toEqual([
    { appid: WARLOCK, pass: "preview", type: "preview", hands_on: 0, original_url: feature },
  ]);
  // Baldur's Gate 3's preview query fetched the same article and rejected it: its subject is Warlock.
  expect(database.native.query("SELECT pass FROM media_discovery_attempts WHERE kind = 'fetch' AND url = ? AND appid = ? ORDER BY id").all(feature, BG3))
    .toEqual([{ pass: "preview" }]);
  expect(database.native.query("SELECT appid FROM media_preview_rejections WHERE url = ?").all(feature)).toEqual([{ appid: BG3 }]);
});

test("preview subject attribution rejects unconfirmed short names, a game named only as a common word, and ambiguous families", async () => {
  const database = fixture();
  admitWarlockCatalog(database);
  await watch(database, WARLOCK, "2026-11-27");
  const warlockLine = "Warlock casts you as a lone spellcaster bound to a demanding patron, and Warlock lets each pact reshape your spell list.";
  const fullName = "Warlock: Dungeons & Dragons";
  const bg3Line = "Baldur's Gate 3 made party banter its heart and Baldur's Gate 3 keeps every companion close.";
  const articles = {
    // A short name the body never confirms with the full name.
    unconfirmed: featureHtml("Warlock wants you to bargain with your patron", `${warlockLine} ${warlockLine}`),
    // Baldur's Gate 3's warlock class: "warlock" names a class, not the game.
    classGuide: featureHtml("Baldur's Gate 3 warlock class explained", `${bg3Line} The warlock class in Baldur's Gate 3 draws power from a patron. ${bg3Line}`, "articleType:Features"),
    // Warlock is named first in the title, Baldur's Gate 3 most often in the body.
    disagree: featureHtml("Warlock looks up to Baldur's Gate 3", `${fullName} borrows ideas. ${bg3Line} ${bg3Line} Baldur's Gate 3 again sets the bar.`),
    // Both families are named equally often in the body.
    tie: featureHtml("Warlock and its debt to Baldur's Gate 3, in pictures", `${fullName} borrows ideas, and Warlock owes much. ${bg3Line} Each spell feels distinct in a demo full of patrons and pacts.`),
    // A plain descriptive feature with no preview wording, on the subject alone.
    plain: featureHtml(`${fullName} builds its spellcasting around a patron's pact`, `${fullName} puts a patron's pact at the center of its spellcasting. ${warlockLine}`, "articleType:Features"),
  };
  const urls = Object.fromEntries(Object.keys(articles).map((kind) => [kind, `https://ign.com/articles/${kind}`]));
  const api = warlockWorld(Object.fromEntries(Object.entries(articles).map(([kind, html]) => [urls[kind]!, html])));
  api.results[`${WARLOCK}:preview:ign.com`] = Object.keys(articles).map((kind) => urls[kind]!);
  productionOutletCap();
  await api.tick(database, "2026-11-27T06:00:00.000Z");
  expect(database.native.query("SELECT url FROM media_preview_rejections ORDER BY url").all()).toEqual(
    ["classGuide", "disagree", "tie", "unconfirmed"].map((kind) => ({ url: urls[kind] })).sort((a, b) => a.url!.localeCompare(b.url!)),
  );
  expect(database.native.query("SELECT original_url, type, hands_on FROM media_sources").all()).toEqual([
    { original_url: urls.plain, type: "preview", hands_on: 0 },
  ]);
});

test("an initial pass rejects a review titled only with a short name, confirmed or not", async () => {
  const database = fixture();
  admitWarlockCatalog(database, "released", "2026-10-01");
  await watch(database, WARLOCK, "2026-11-27");
  const confirmed = "https://ign.com/articles/warlock-review";
  const unconfirmed = "https://eurogamer.net/articles/warlock-review";
  const body = "Warlock rewards patient spell chains, and Warlock's pacts change how every fight plays out over its twenty-hour campaign.";
  const api = warlockWorld({
    [confirmed]: featureHtml("Warlock review", `Warlock: Dungeons & Dragons is a lean action RPG. ${body}`, "articleType:Reviews"),
    [unconfirmed]: featureHtml("Warlock review", `${body} ${body}`, "articleType:Reviews"),
  });
  api.results[`${WARLOCK}:initial:ign.com`] = [confirmed];
  api.results[`${WARLOCK}:initial:eurogamer.net`] = [unconfirmed];
  await api.tick(database, "2026-11-27T06:00:00.000Z");
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources").get()).toEqual({ count: 0 });
  expect(database.native.query("SELECT DISTINCT url FROM media_discovery_attempts WHERE kind = 'fetch' ORDER BY url").all())
    .toEqual([{ url: unconfirmed }, { url: confirmed }]);
});

type SubjectGame = { name: string; status?: "upcoming" | "released"; parent?: number };

/**
 * Inserts `games` into the catalog: a released game is enrolled for its
 * assessment passes, an upcoming one is watched for its preview pass.
 */
async function subjectCatalog(database: TestDatabase, games: Record<number, SubjectGame>) {
  const insert = database.native.prepare(`INSERT INTO apps (appid, name, slug, type, release_status, steam_release_date, parent_appid) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const [appid, { name, status = "upcoming", parent = null }] of Object.entries(games)) {
    insert.run(Number(appid), name, `game-${appid}`, parent === null ? "game" : "dlc", status, status === "released" ? "2026-10-01" : null, parent);
  }
  for (const [appid, { status = "upcoming", parent }] of Object.entries(games)) {
    if (parent !== undefined) continue;
    if (status === "released") database.native.prepare("INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (?, 'experiment', '2026-11-20T05:00:00.000Z')").run(Number(appid));
    else await watch(database, Number(appid), "2026-11-27");
  }
}

/** Runs one scheduled tick in which `candidates[appid:pass]` lists, per outlet domain, the article titles and bodies that query finds. */
async function subjectTick(
  database: TestDatabase, games: Record<number, SubjectGame>,
  candidates: Record<string, Record<string, Array<{ title: string; body: string; tags?: string }>>>,
) {
  await subjectCatalog(database, games);
  const articles: Record<string, string> = {};
  const urls: Record<string, string[]> = {};
  for (const [key, byDomain] of Object.entries(candidates)) {
    for (const [domain, list] of Object.entries(byDomain)) {
      urls[`${key}:${domain}`] = list.map(({ title, body, tags }, index) => {
        const url = outletFixtureUrl(domain, `articles/${key.replace(":", "-")}-${index}`);
        articles[url] = featureHtml(title, body, tags ?? "articleType:Features");
        return url;
      });
    }
  }
  const api = warlockWorld(articles, Object.fromEntries(Object.entries(games).map(([appid, { name }]) => [appid, name])));
  Object.assign(api.results, urls);
  productionOutletCap();
  await api.tick(database, "2026-11-27T06:00:00.000Z");
  return {
    sources: () => database.native.query<{ appid: number; pass: string; title: string }, []>("SELECT appid, pass, title FROM media_sources ORDER BY appid, title").all(),
    rejected: () => database.native.query<{ appid: number; title: string }, []>(
      `SELECT DISTINCT attempt.appid, attempt.url FROM media_discovery_attempts AS attempt WHERE attempt.kind = 'fetch'
       AND NOT EXISTS (SELECT 1 FROM media_sources WHERE appid = attempt.appid AND original_url = attempt.url) ORDER BY attempt.appid, attempt.url`,
    ).all().map((row) => ({ appid: row.appid, title: articleTitle(articles[(row as unknown as { url: string }).url]!) })),
  };
}

function articleTitle(html: string) {
  return /<h1>(.*?)<\/h1>/.exec(html)![1]!.replaceAll("&amp;", "&");
}

const filler = "The campaign moves between districts where each mission asks you to choose tools, routes and companions before leaving. ".repeat(3);

test("an initial pass keeps the assessment subject rule: another enrolled family's full name in the title rejects, a short name never matches, and a full name containing a joiner is not co-titled", async () => {
  const DUNE = 1172710, MARINE = 2183900, TRADER = 2186680, ORI = 1057090;
  const database = fixture();
  const games: Record<number, SubjectGame> = {
    [DUNE]: { name: "Dune: Awakening", status: "released" },
    [MARINE]: { name: "Warhammer 40,000: Space Marine 2", status: "released" },
    [TRADER]: { name: "Warhammer 40,000: Rogue Trader", status: "released" },
    [ROOT]: { name: "NO LAW", status: "released" },
    [REVIEW]: { name: "Fort Harbor", status: "released" },
    [WARLOCK]: { name: "Warlock: Dungeons & Dragons", status: "released" },
    [ORI]: { name: "Ori and the Will of the Wisps", status: "released" },
  };
  const run = await subjectTick(database, games, {
    // Only Dune: Awakening is enrolled; "Dune" heads a different game's title.
    [`${DUNE}:initial`]: { "ign.com": [{ title: "Dune: Spice Wars review", body: `Unlike Dune: Awakening, this is a strategy game. ${filler}` }] },
    // Rogue Trader is named once, past the lead.
    [`${MARINE}:initial`]: { "ign.com": [{ title: "Warhammer 40,000: Space Marine 2 review", body: `${filler} Fans of Warhammer 40,000: Rogue Trader will recognise the setting.` }] },
    [`${ROOT}:initial`]: {
      "ign.com": [{ title: "NO LAW & Fort Harbor review", body: `NO LAW and its harbor. ${filler}` }],
      "eurogamer.net": [{ title: "NO LAW, Fort Harbor review: two for one", body: `NO LAW and its harbor. ${filler}` }],
      "gamespot.com": [{ title: "NO LAW and Fort Harbor hands-on preview", body: `We played NO LAW for hours. ${filler}` }],
    },
    [`${WARLOCK}:initial`]: { "ign.com": [{ title: "Warlock: Dungeons & Dragons review", body: `Warlock: Dungeons & Dragons is a lean action RPG. ${filler}` }] },
    [`${ORI}:initial`]: { "ign.com": [{ title: "Ori and the Will of the Wisps review", body: `Ori and the Will of the Wisps is a gorgeous platformer. ${filler}` }] },
  });
  expect(run.sources()).toEqual([
    { appid: ORI, pass: "initial", title: "Ori and the Will of the Wisps review" },
    { appid: MARINE, pass: "initial", title: "Warhammer 40,000: Space Marine 2 review" },
    { appid: WARLOCK, pass: "initial", title: "Warlock: Dungeons & Dragons review" },
  ].sort((a, b) => a.appid - b.appid));
  const byTitle = (a: { appid: number; title: string }, b: { appid: number; title: string }) => a.appid - b.appid || a.title.localeCompare(b.title);
  expect(run.rejected().sort(byTitle)).toEqual([
    { appid: DUNE, title: "Dune: Spice Wars review" },
    ...["NO LAW & Fort Harbor review", "NO LAW, Fort Harbor review: two for one", "NO LAW and Fort Harbor hands-on preview"].map((title) => ({ appid: ROOT, title })),
  ].sort(byTitle));
});

test("a preview pass refuses a short name that heads another title, is shared by two roots, or is shorter than four characters, and accepts a unique confirmed one", async () => {
  const DUNE = 1172710, SPIDER = 1817190, MARINE = 2183900, TRADER = 2186680, RUIN = 3000001, ARC = 3000002, EMBER = 3000003, EMBER_ROOT = 3000004;
  const database = fixture();
  const games: Record<number, SubjectGame> = {
    [DUNE]: { name: "Dune: Awakening" },
    [SPIDER]: { name: "Marvel's Spider-Man: Miles Morales" },
    [MARINE]: { name: "Warhammer 40,000: Space Marine 2" },
    [TRADER]: { name: "Warhammer 40,000: Rogue Trader", status: "released" },
    [RUIN]: { name: "Ruin: Ashes" },
    [ARC]: { name: "Arc: Embers" },
    [EMBER]: { name: "Ember: Rising" },
    [EMBER_ROOT]: { name: "Ember", status: "released" },
  };
  const run = await subjectTick(database, games, {
    [`${DUNE}:preview`]: { "ign.com": [{ title: "Dune: Spice Wars adds a new faction", body: `Dune: Awakening players may recognise it. ${filler}` }] },
    [`${SPIDER}:preview`]: { "ign.com": [{ title: "Marvel's Spider-Man 2 shows a new suit", body: `Marvel's Spider-Man: Miles Morales fans will spot it. ${filler}` }] },
    // "warhammer 40,000" leads both roots' names, so neither has it as a short name.
    [`${MARINE}:preview`]: { "ign.com": [{ title: "Warhammer 40,000 returns to the hive cities", body: `Warhammer 40,000: Space Marine 2 opens in a hive city. ${filler}` }] },
    // "ruin" has four characters and is derived; "arc" has three and is not.
    [`${RUIN}:preview`]: { "ign.com": [{ title: "Ruin lets you rebuild a burned city", body: `Ruin: Ashes is about rebuilding. ${filler}` }] },
    [`${ARC}:preview`]: { "ign.com": [{ title: "Arc lets you rebuild a burned city", body: `Arc: Embers is about rebuilding. ${filler}` }] },
    // "ember" is another loaded root's full name, so it is no short name of Ember: Rising.
    [`${EMBER}:preview`]: { "ign.com": [{ title: "Ember gets a winter festival", body: `Ember: Rising adds a festival. ${filler}` }] },
  });
  expect(run.sources()).toEqual([{ appid: RUIN, pass: "preview", title: "Ruin lets you rebuild a burned city" }]);
  expect(run.rejected().map(({ appid }) => appid)).toEqual([DUNE, SPIDER, MARINE, ARC, EMBER].sort((a, b) => a - b));
});

test("a preview pass rejects two enrolled families joined in the title by a co-title joiner and admits the leading family when they are not joined", async () => {
  const database = fixture();
  const joined = ["&", "and", ",", "+", "/", "x", "meets", "vs", "versus"].map((joiner) => `NO LAW${joiner === "," ? "" : " "}${joiner} Fort Harbor share one harbor city`);
  const body = `NO LAW sends you through its harbor. NO LAW rewards patience, and Fort Harbor is nearby. ${filler}`;
  const run = await subjectTick(database, { [ROOT]: { name: "NO LAW" }, [REVIEW]: { name: "Fort Harbor" } }, {
    [`${ROOT}:preview`]: {
      "ign.com": joined.map((title) => ({ title, body })),
      "eurogamer.net": [{ title: "NO LAW builds a harbor city that feels nothing like Fort Harbor", body }],
    },
  });
  expect(run.sources()).toEqual([{ appid: ROOT, pass: "preview", title: "NO LAW builds a harbor city that feels nothing like Fort Harbor" }]);
  expect(run.rejected().map(({ title }) => title).sort()).toEqual([...joined].sort());
});

test("a preview pass keeps single-game titles with a conjunction or a record word and reads a lone x after a short name as a joiner", async () => {
  const WARLOCK = 3714800;
  const database = fixture();
  const crossover = "Warlock x Fort Harbor share a stage demo";
  const crossoverBody = `Fort Harbor led the show. Fort Harbor returned twice, and Warlock: Dungeons & Dragons joined Fort Harbor on stage. ${filler}`;
  const body = `NO LAW sends you through its harbor one mission at a time. ${filler}`;
  const run = await subjectTick(database, { [ROOT]: { name: "NO LAW" }, [REVIEW]: { name: "Fort Harbor" }, [WARLOCK]: { name: "Warlock: Dungeons & Dragons" } }, {
    [`${ROOT}:preview`]: {
      "ign.com": [{ title: "NO LAW and the cost of running a harbor: a hands-off preview", body }],
      "eurogamer.net": [{ title: "NO LAW beats its own wishlist record", body }],
      // The outlet's own list of games is still a multi-game piece; news of joining someone else's list is not.
      "kotaku.com": [{ title: "NO LAW leads our list of games to watch in 2027", body }],
      "pcgamer.com": [{ title: "NO LAW joins Steam's list of most wishlisted games", body }],
    },
    // Fort Harbor is named most in the body, but the title names Warlock first, joined by "x".
    [`${REVIEW}:preview`]: { "ign.com": [{ title: crossover, body: crossoverBody }] },
    [`${WARLOCK}:preview`]: { "ign.com": [{ title: crossover, body: crossoverBody }] },
  });
  expect(run.sources()).toEqual([
    { appid: ROOT, pass: "preview", title: "NO LAW and the cost of running a harbor: a hands-off preview" },
    { appid: ROOT, pass: "preview", title: "NO LAW beats its own wishlist record" },
    { appid: ROOT, pass: "preview", title: "NO LAW joins Steam's list of most wishlisted games" },
  ]);
  expect(run.rejected().map(({ appid }) => appid)).toEqual([ROOT, REVIEW, WARLOCK].sort((a, b) => a - b));
});

test("a preview pass rejects an article whose title names two families at the same position", async () => {
  const database = fixture();
  const run = await subjectTick(database, { [ROOT]: { name: "NO LAW" }, [LATE]: { name: "NO LAW Lost Streets" } }, {
    [`${ROOT}:preview`]: { "ign.com": [{ title: "NO LAW Lost Streets opens a new district", body: `NO LAW Lost Streets is set in NO LAW's city. NO LAW returns. ${filler}` }] },
    [`${LATE}:preview`]: { "ign.com": [{ title: "NO LAW Lost Streets opens a new district", body: `NO LAW Lost Streets is set in NO LAW's city. NO LAW returns. ${filler}` }] },
  });
  expect(run.sources()).toEqual([]);
  expect(run.rejected().map(({ appid }) => appid)).toEqual([ROOT, LATE].sort((a, b) => a - b));
});

test("a preview pass types announcements by title, preview wording and hands-on evidence, and an outlet preview marker is never hands-on", async () => {
  const database = fixture();
  admit(database, ROOT);
  await watch(database);
  const api = world();
  const body = "NO LAW sends you through a harbor city where each mission lets you pick new equipment and routes. ".repeat(3);
  const pages: Record<string, string> = {
    "ign.com": discoveryArticleHtml(ROOT, "NO LAW announced with a debut trailer", { body }),
    "eurogamer.net": discoveryArticleHtml(ROOT, "NO LAW revealed in a hands-on session", { body }),
    "gamespot.com": discoveryArticleHtml(ROOT, "NO LAW announced for next year", { body: `I went hands-on with the first district. ${body}` }),
    "gamesradar.com": featureHtml("NO LAW revealed for next year", body),
    "pcgamer.com": featureHtml("NO LAW sends you through a harbor city", body, "articleType:Features"),
    // The word "preview" in the title outweighs an announcement word.
    "kotaku.com": discoveryArticleHtml(ROOT, "NO LAW preview: new trailer breakdown", { body }),
  };
  api.tavily.results = ({ domain }) => pages[domain] ? [{ url: outletFixtureUrl(domain, `articles/no-law`) }] : [];
  await api.tick(database, "2027-01-25", { outlet: (url) => new Response(pages[new URL(url).hostname]) });
  expect(database.native.query("SELECT outlet, type, hands_on FROM media_sources ORDER BY outlet").all()).toEqual([
    { outlet: "Eurogamer", type: "preview", hands_on: 1 },
    { outlet: "GameSpot", type: "preview", hands_on: 1 },
    { outlet: "GamesRadar+", type: "preview", hands_on: 0 },
    { outlet: "IGN", type: "announcement", hands_on: 0 },
    { outlet: "Kotaku", type: "preview", hands_on: 0 },
    { outlet: "PC Gamer", type: "preview", hands_on: 0 },
  ]);
});

function previewProgress(database: TestDatabase) {
  return database.native.query("SELECT outlet, status, stop_reason, candidate_index FROM media_discovery_progress WHERE pass = 'preview' ORDER BY id").all();
}

test("previews go first within each outlet's daily preview share, assessment queries on the same outlet are still served that day, and the share reopens the next UTC day", async () => {
  const database = fixture();
  admit(database, ROOT);
  admit(database, REVIEW, { status: "released", date: "2024-12-05" });
  await watch(database);
  await watch(database, REVIEW);
  const api = world();
  const defaultResults = api.tavily.results!;
  // Two rejected candidates (reviews, left for the released-game flow) come before the preview.
  api.tavily.results = (search) => search.query.endsWith("announcement")
    ? [outletFixtureUrl(search.domain, `articles/${ROOT}/review-1`), outletFixtureUrl(search.domain, `articles/${ROOT}/review-2`)].map((url) => ({ url })).concat(defaultResults(search)!)
    : defaultResults(search);
  expect(previewDailyAttemptShare()).toBe(3);
  expect(previewDailyAttemptShare(200)).toBe(20);
  expect(previewDailyAttemptShare(5)).toBe(1);

  await api.tick(database, "2027-01-25");
  expect(queries(database).map(({ appid, pass }) => [appid, pass])).toEqual([
    ...Array(MEDIA_OUTLETS.length).fill([ROOT, "preview"]), ...Array(6).fill([REVIEW, "initial"]),
  ]);
  // Each preview query used the share on its search and two rejected fetches; its third candidate waits.
  expect(previewProgress(database)).toEqual(MEDIA_OUTLETS.map(({ name }) => ({
    outlet: name, status: "stopped", stop_reason: "preview_daily_share", candidate_index: 2,
  })));
  expect(database.native.query("SELECT outlet, COUNT(*) AS attempts FROM media_discovery_attempts WHERE pass = 'preview' GROUP BY outlet ORDER BY outlet").all())
    .toEqual(MEDIA_OUTLETS.map(({ name }) => ({ outlet: name, attempts: 3 })).sort((a, b) => a.outlet.localeCompare(b.outlet)));
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources WHERE appid = ? AND pass = 'initial'").get(REVIEW)).toEqual({ count: 6 });
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources WHERE pass = 'preview'").get()).toEqual({ count: 0 });

  await api.tick(database, "2027-01-26");
  expect(queries(database).filter(({ pass, day }) => pass === "preview" && day === "2027-01-26")).toEqual([]);
  expect(previewProgress(database)).toEqual(MEDIA_OUTLETS.map(({ name }) => ({ outlet: name, status: "completed", stop_reason: null, candidate_index: 3 })));
  expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources WHERE appid = ? AND pass = 'preview'").get(ROOT)).toEqual({ count: MEDIA_OUTLETS.length });
  expect(database.native.query("SELECT end_reason FROM media_preview_occurrences").all()).toEqual([{ end_reason: "completed" }]);
});

test("previews are searched within the month's preview credit share despite the review reservation and a deferral recorded earlier that month, deferred once the share is used, and resumed the next month", async () => {
  const database = fixture();
  admit(database, ROOT, { date: "2027-02-10" });
  admit(database, REVIEW, { status: "released", date: "2024-12-05" });
  await watch(database, ROOT, "2027-01-30");
  await watch(database, REVIEW, "2027-01-30");
  database.native.prepare("INSERT INTO checkpoints (key, value) VALUES (?, '2027-01')").run(PREVIEW_DEFERRAL_KEY);
  // 94 of January's 100 preview searches are already served.
  usePreviewCreditShare(database, "2027-01", 94);
  expect(previewMonthlyCreditShare(1_000)).toBe(100);
  expect(previewMonthlyCreditShare(null)).toBe(0);
  const api = world();
  // 13 credits: the initial and later passes reserve 12, which alone would defer the 6 preview queries.
  api.tavily.remaining = 13;
  await api.tick(database, "2027-01-30");
  expect(queries(database).map(({ pass }) => pass)).toEqual([...Array(6).fill("preview"), ...Array(6).fill("initial")]);

  // The share is used: the 6 later queries' reservation leaves too few credits, so previews wait for February.
  api.tavily.remaining = 11;
  await api.tick(database, "2027-01-31");
  expect(queries(database).filter(({ day }) => day === "2027-01-31").map(({ pass }) => pass)).toEqual(Array(6).fill("later"));
  expect(database.native.query("SELECT value FROM checkpoints WHERE key = ?").get(PREVIEW_DEFERRAL_KEY)).toEqual({ value: "2027-01" });

  api.tavily.remaining = 100;
  await api.tick(database, "2027-02-01");
  expect(queries(database).filter(({ day }) => day === "2027-02-01").map(({ pass }) => pass)).toEqual(Array(MEDIA_OUTLETS.length).fill("preview"));
});

test("a deferral recorded earlier in the month with previews still within their credit share holds nothing: status shows the next daily run, which searches them", async () => {
  const database = fixture();
  admit(database, ROOT);
  admit(database, REVIEW, { status: "released", date: "2024-12-05" });
  await watch(database, ROOT, "2027-01-30");
  await watch(database, REVIEW, "2027-01-30");
  // Production on 2026-11-27 in miniature: November's deferral, 5 preview searches served, and the plan limit of the last scheduled run.
  database.native.prepare("INSERT INTO checkpoints (key, value) VALUES (?, '2027-01')").run(PREVIEW_DEFERRAL_KEY);
  usePreviewCreditShare(database, "2027-01", 5);
  database.native.prepare(`INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status, origin, usage, started_at)
    VALUES ('initial', 'scheduled:2027-01-29', '[]', 'completed', 'scheduled', '{"planLimit":1000,"remainingCredits":13}', '2027-01-29T06:00:00.000Z')`).run();
  const schedule = await mediaWatchSchedule(database.db, ROOT, new Date("2027-01-30T05:30:00Z"), new Map());
  expect(schedule.map(({ appid, next }) => [appid, next])).toEqual([[ROOT, { pass: "preview", dueAt: "2027-01-30T06:00:00.000Z" }]]);
  const api = world();
  api.noArticles();
  api.tavily.remaining = 16;
  await api.tick(database, "2027-01-30");
  expect(queries(database).map(({ pass }) => pass)).toEqual([...Array(MEDIA_OUTLETS.length).fill("preview"), ...Array(6).fill("initial")]);
});

test.each(["daily_attempt_cap", "fetch_http_429", "preview_daily_share"] as const)(
  "a scoped preview replay stopped by %s is re-runnable only when none of its requests reached the outlet",
  async (stop) => {
    const database = fixture();
    admit(database, ROOT);
    await watch(database);
    const api = world();
    const url = "https://gamesradar.com/articles/preview";
    api.tavily.results = ({ domain }) => domain === "gamesradar.com" ? [{ url }] : [];
    const body = "NO LAW takes place in a city where each mission lets you pick new equipment and routes. ".repeat(4);
    await api.tick(database, "2027-01-25", { outlet: () => new Response(discoveryArticleHtml(ROOT, "NO LAW Roundup", { body })) });
    const progress = database.native.query<{ id: number }, []>("SELECT id FROM media_discovery_progress WHERE outlet = 'GamesRadar+'").get()!;
    const hop = `${url}/moved`;
    const article = discoveryArticleHtml(ROOT, "NO LAW Preview", { body: `We saw NO LAW in a hands-off preview. ${body}` });
    const calls: string[] = [];
    const fetch = async (input: RequestInfo | URL) => {
      const requested = String(input);
      calls.push(requested);
      if (requested === url) return new Response(null, { status: 301, headers: { location: hop } });
      return stop === "fetch_http_429" ? new Response(null, { status: 429 }) : new Response(article);
    };
    const seed = (pass: string, day: string, count: number) => {
      const insert = database.native.prepare(`INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, status_code, succeeded, attempted_at)
        VALUES (?, 'GamesRadar+', ?, ?, 'fetch', 200, 1, ?)`);
      for (let i = 0; i < count; i += 1) insert.run(ROOT, pass, day, `${day}T05:00:00Z`);
    };
    const replay = (date: string) => replayRejectedPreviewCandidate(database.db, { progressId: progress.id, url, now: new Date(date), fetch });
    // A replay refused before any contact stays re-runnable.
    if (stop === "fetch_http_429") {
      database.native.prepare(`INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, status_code, succeeded, attempted_at)
        VALUES (?, 'GamesRadar+', 'initial', '2027-01-26', 'fetch', 429, 0, '2027-01-26T04:00:00Z')`).run(ROOT);
    } else if (stop === "daily_attempt_cap") {
      seed("initial", "2027-01-26", outletDailyAttemptCap());
    } else {
      seed("preview", "2027-01-26", previewDailyAttemptShare());
    }
    expect(await replay("2027-01-26T05:00Z")).toEqual({ admitted: false, reason: stop });
    expect(calls).toEqual([]);
    // On the next day the replay runs again; its first hop reaches the outlet and the redirect hop is stopped.
    if (stop === "daily_attempt_cap") seed("initial", "2027-01-27", outletDailyAttemptCap() - 1);
    if (stop === "preview_daily_share") seed("preview", "2027-01-27", previewDailyAttemptShare() - 1);
    expect(await replay("2027-01-27T05:00Z")).toEqual({ admitted: false, reason: stop });
    expect(calls).toEqual(stop === "fetch_http_429" ? [url, hop] : [url]);
    // A request of that replay reached the outlet, so it never runs again.
    database.reopen();
    expect(await replay("2027-01-28T05:00Z")).toEqual({ admitted: false, reason: "already_replayed" });
    expect(calls).toEqual(stop === "fetch_http_429" ? [url, hop] : [url]);
  },
);

test("the review reservation checked mid-run counts only the preview queries still unsearched, so previews served earlier in the run never cause a deferral", async () => {
  const database = fixture();
  admit(database, ROOT, { date: "2027-02-10" });
  admit(database, REVIEW, { status: "released", date: "2024-12-05" });
  await watch(database, ROOT, "2027-01-30");
  await watch(database, REVIEW, "2027-01-30");
  // 97 of January's 100 preview searches are served: three previews fit the share, the other six need the reservation check.
  usePreviewCreditShare(database, "2027-01", 97);
  const api = world();
  // 22 credits: after three previews, 19 remain; the initial and later passes reserve 12, which leaves 7 for the 6 unsearched previews.
  api.tavily.remaining = 22;
  await api.tick(database, "2027-01-30");
  expect(queries(database).map(({ pass }) => pass)).toEqual([...Array(MEDIA_OUTLETS.length).fill("preview"), ...Array(6).fill("initial")]);
  expect(database.native.query("SELECT value FROM checkpoints WHERE key = ?").get(PREVIEW_DEFERRAL_KEY)).toBeNull();
});

test("written preview outlets stay game-specific and retain demo, play and developer attribution", async () => {
  const database = fixture();
  productionOutletCap();
  admit(database, ROOT);
  admit(database, REVIEW);
  await watch(database);
  const api = world();
  const demo = "https://gameinformer.com/preview/2027/01/24/no-law";
  const wrongGame = "https://www.rpgsite.net/preview/one";
  const played = "https://www.rpgsite.net/preview/two";
  const interview = "https://www.techradar.com/gaming/no-law-interview";
  const wrongSection = "https://www.techradar.com/computing/no-law";
  const moved = "https://techradar.com/gaming/no-law-moved";
  const badCanonical = "https://techradar.com/gaming/no-law-canonical";
  const roundup = "https://gameinformer.com/feature/2027/01/24/every-game";
  const pages: Record<string, { title: string; text: string; canonical?: string }> = {
    [roundup]: { title: "NO LAW and every game we played", text: "We played NO LAW at the show." },
    [demo]: { title: "NO LAW Preview", text: "The developer showed me gameplay in a hands-off demo. The director said, “I played the game for hours.”" },
    [wrongGame]: { title: "Fort Harbor Preview", text: "I played Fort Harbor myself at the show." },
    [played]: { title: "NO LAW Preview", text: "I went hands-on with NO LAW at the show." },
    [interview]: { title: "NO LAW director discusses the upcoming game", text: "Speaking in an interview with TechRadar Gaming, the creative director discussed the team's plans. “We played with the idea of alternate routes,” she said." },
    [badCanonical]: { title: "NO LAW Preview", text: "I played NO LAW at the show.", canonical: wrongSection },
  };
  api.tavily.results = ({ domain }) => ({
    "gameinformer.com": [roundup, demo],
    "rpgsite.net": [wrongGame, played],
    "techradar.com": [wrongSection, moved, badCanonical, interview],
  }[domain] ?? []).map((url) => ({ url }));
  await api.tick(database, "2027-01-25", { outlet: (url) => {
    if (url === moved) return new Response(null, { status: 301, headers: { Location: wrongSection } });
    const page = pages[url];
    if (!page) throw new Error(`Unexpected article fetch: ${url}`);
    return new Response(`<html><head><meta property="og:title" content="${page.title}"><meta property="article:author" content="https://author.example/profile">
      ${page.canonical ? `<link rel="canonical" href="${page.canonical}">` : ""}
      <script type="application/ld+json">invalid</script>
      <script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "Article", datePublished: "2027-01-24T09:30:00-0500", dateModified: "2027-01-24T19:00:00Z", author: { name: "Fixture Journalist" } }] })}</script>
      </head><body><article><h1>${page.title}</h1><p>${page.text} ${"The article describes an upcoming game's missions and the equipment players can select. ".repeat(4)}</p></article></body></html>`);
  } });
  const sources = await getMediaSources(database.db, ROOT, { includeUnpublished: true });
  expect(sources.map(({ outlet, originalUrl, handsOn, previewEvidence }) => [outlet, originalUrl, handsOn, previewEvidence])).toEqual([
    ["Game Informer", demo, false, "observed_demo"],
    ["RPG Site", played, true, undefined],
    ["TechRadar Gaming", interview, false, "developer_interview"],
  ]);
  for (const source of sources) {
    expect(source).toMatchObject({ author: "Fixture Journalist", publishedAt: "2027-01-24T14:30:00.000Z", updatedAt: "2027-01-24T19:00:00.000Z" });
  }
  expect(api.fetched).not.toContain(wrongSection);
  const techRadarSearch = api.tavily.requests.map(({ body }) => JSON.parse(String(body)) as { include_domains: string[]; query: string })
    .find(({ include_domains }) => include_domains[0] === "techradar.com");
  expect(techRadarSearch?.query).toContain("site:techradar.com/gaming/");
  expect(techRadarSearch?.query).toContain("developer interview");
  const interviewExtraction = api.openRouter.requests.find(({ stage, body }) =>
    stage === "extraction" && body.messages.some(({ content }) => content?.includes('"previewEvidence":"developer_interview"')));
  expect(interviewExtraction?.body.messages[0]?.content).toContain("Attribute developer claims to the speaker");
  expect(interviewExtraction?.body.messages[1]?.content).toContain('"handsOn":0');
});
