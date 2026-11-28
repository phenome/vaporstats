import { afterEach, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MediaSources } from "../src/components/media-sources";
import { getMediaSources } from "../src/lib/media-discovery";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { changeMediaWatch, PREVIEW_CEILING } from "../src/lib/media-watchlist";
import { approvedGameSpotVideos, readGameSpotCaptions } from "../src/lib/media-video";
import { openTestDatabase } from "./support/db";
import { CYBERPUNK, GAME_NAMES, controlledOpenRouterApi, controlledTavilyApi, discoveryArticleHtml, emptySynthesisSelection, insertCompletedRun, mediaObservation, mediaTickFetch, runMediaTick, synthesisEvidence, synthesisSelectionId } from "./support/media";

const APPID = 3714800;
const TITLE = "Warlock: Dungeons & Dragons";
const URL = "https://www.youtube.com/watch?v=aemQLUwnw7I";
const VIDEO = {
  id: "aemQLUwnw7I",
  channelId: "UCbu2SsF-Or3Rsn3NxqODImw",
  title: `${TITLE} developer interview`,
  developer: "Invoke",
  publishedOn: "2026-08-26",
  language: "en",
};
const QUOTE = "We want magic to help you explore the world beyond combat.";
const CAPTIONS = `WEBVTT

00:00.000 --> 00:04.000 align:start
We want magic to help you

00:04.000 --> 00:06.000
We want magic to help you <00:05.000><c>explore the world beyond combat.</c>

00:06.000 --> 00:09.000
The prototype lets you choose spells to open routes through the environment. We are still developing that feature.

NOTE This comment must not become evidence.
`;

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function environment(name: string, value?: string) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  cleanups.push(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

async function fixture(watched = true, outlet?: (url: string) => Response | undefined, appid = APPID, title = TITLE) {
  const database = openTestDatabase("vaporstats-video-");
  cleanups.push(database.cleanup);
  environment("RECEPTION_ARTIFACT_DIR", database.directory);
  environment("MEDIA_OVERVIEW_PUBLIC", "true");
  database.native.prepare("INSERT INTO apps (appid, name, slug, type, release_status) VALUES (?, ?, 'warlock', 'game', 'upcoming')")
    .run(appid, title);
  if (watched) expect((await changeMediaWatch(database.db, "watch", String(appid), new Date("2026-11-28T05:00:00Z"))).status).toBe(200);
  await Bun.write(`${database.directory}/${appid}.json`, JSON.stringify([{ ...VIDEO, title: `${title} developer interview` }]));
  await Bun.write(`${database.directory}/${VIDEO.id}.en.vtt`, CAPTIONS);
  const tavily = controlledTavilyApi({ [appid]: title });
  tavily.results = () => [];
  const openRouter = controlledOpenRouterApi();
  const apis = { tavily, openRouter };
  const requests: string[] = [];
  const fetchFixture = mediaTickFetch(apis, [], outlet);
  const customFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(input));
    return fetchFixture(input, init);
  }) as typeof fetch;
  const tick = async (at = "2026-11-28T06:00:00Z", automatic = true, paidSubmissionsPerTick?: number) => {
    const result = await runMediaTick(database, apis, at, { mediaAutomaticIngestion: automatic, paidSubmissionsPerTick, customFetch });
    expect(result.status).toBe("completed");
    expect(result.mediaError).toBeUndefined();
    expect(result.mediaDiscovery?.status).not.toBe("failed");
    return result;
  };
  return Object.assign(database, { tick, tavily, openRouter, requests });
}

test("an approved caption-only Warlock interview is extracted and cited under GameSpot despite its website denial", async () => {
  const { db, native, directory, tick, tavily, openRouter, requests } = await fixture();
  environment("MEDIA_GAMESPOT_CAPTION_DIRECTORY", directory);
  await Bun.write(`${directory}/${APPID}.json`, JSON.stringify([{ ...VIDEO, language: "en-US" }, VIDEO]));
  native.prepare(`INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, succeeded, status_code, attempted_at)
    VALUES (?, 'GameSpot', 'preview', '2026-11-27', 'fetch', 'https://www.gamespot.com/articles/blocked', 0, 403, '2026-11-27T06:00:00Z')`).run(APPID);
  openRouter.onChat = ({ stage, body }) => {
    if (stage === "extraction") {
      expect(body.messages[0]!.content).toContain("Attribute plans and design statements to the developer");
      const prompt = body.messages[1]!.content;
      expect(prompt).toContain('"developer":"Invoke"');
      expect(prompt).toContain(QUOTE);
      expect(prompt).not.toContain("We want magic to help you We want magic");
      expect(prompt).not.toContain("This comment must not become evidence.");
      openRouter.output("extraction", {
        observations: [
          mediaObservation(APPID, "magic", "finding", "Invoke plans to make spells useful during exploration.", QUOTE),
          mediaObservation(APPID, "quality", "pro", "Magic feels great to use.", QUOTE),
        ],
      });
      return;
    }
    expect(body.messages[0]!.content).toContain("attribute its pre-release statements to that developer");
    const sources = synthesisEvidence(body);
    const interview = sources.find(({ sourceUrl }) => sourceUrl === URL)!;
    expect(interview).toBeDefined();
    openRouter.output("synthesis", {
      ...emptySynthesisSelection(sources),
      statements: [{ text: "In a developer interview, Invoke said it plans to make spells useful during exploration.", observationIds: [synthesisSelectionId(interview, "magic")] }],
    });
  };

  const discovery = (await tick()).mediaDiscovery;
  expect(discovery?.issued.articles).toBe(1);
  expect(discovery?.summary.discovered).toBe(1);
  await tick("2026-11-28T06:15:00Z");
  expect((await tick("2026-12-29T06:00:00Z")).mediaDiscovery?.issued.articles).toBe(0);
  expect(requests.some((url) => /youtube\.com|gamespot\.com/.test(url))).toBe(false);
  expect(openRouter.requests.filter(({ stage }) => stage === "extraction")).toHaveLength(1);
  expect(tavily.requests.every(({ body }) => !JSON.stringify(body).includes("gamespot.com"))).toBe(true);
  expect(native.query("SELECT url FROM media_discovery_attempts WHERE outlet = 'GameSpot'").all())
    .toEqual([{ url: "https://www.gamespot.com/articles/blocked" }]);
  const persisted = native.query("SELECT original_url, processing_content FROM media_sources").all();
  expect(persisted).toEqual([{ original_url: URL, processing_content: null }]);
  const extraction = native.query<{ output_json: string }, []>("SELECT output_json FROM media_article_extractions").get()!.output_json;
  expect(extraction).toContain("Invoke plans to make spells useful during exploration.");
  expect(extraction).not.toContain(QUOTE);
  expect(extraction).not.toContain("Magic feels great");
  expect(extraction).not.toContain("We are still developing that feature.");
  const overview = native.query<{ output_json: string }, []>("SELECT output_json FROM media_game_overviews WHERE active = 1").get()!.output_json;
  expect(overview).toContain(URL);
  expect(overview).toContain("Invoke said it plans");

  const sources = await getMediaSources(db, APPID);
  expect(sources).toEqual([expect.objectContaining({ originalUrl: URL, outlet: "GameSpot", handsOn: false, affiliation: "Invoke" })]);
  const written = { ...sources[0]!, originalUrl: "https://www.gamespot.com/articles/warlock", title: "Warlock preview" };
  const { document } = parseHTML(renderToStaticMarkup(<MediaSources sources={[written, ...sources]} />));
  const group = document.querySelector("details")!;
  expect(group.querySelector("summary")?.textContent).toContain("GameSpot");
  expect(group.querySelector(`a[href="${URL}"]`)?.parentElement?.textContent).toContain("Developer interview");
  expect(group.querySelector(`a[href="${URL}"]`)?.parentElement?.textContent).toContain("Invoke");
  expect(group.querySelectorAll("a")).toHaveLength(2);
  process.env.MEDIA_OVERVIEW_PUBLIC = "false";
  expect(await getMediaSources(db, APPID)).toEqual([]);
});

test("both the automatic ingestion switch and the explicit caption directory gate video intake", async () => {
  const { db, directory, tick, openRouter } = await fixture();
  environment("MEDIA_GAMESPOT_CAPTION_DIRECTORY", directory);
  await tick("2026-11-28T06:00:00Z", false);
  expect(await getMediaSources(db, APPID)).toEqual([]);
  expect(openRouter.calls).toEqual([]);
  delete process.env.MEDIA_GAMESPOT_CAPTION_DIRECTORY;
  await tick("2026-11-28T06:15:00Z");
  expect(await getMediaSources(db, APPID)).toEqual([]);
});

test("caption intake requires an active preview watch and room under its ceiling", async () => {
  const { db, native, directory, tick, openRouter } = await fixture(false);
  environment("MEDIA_GAMESPOT_CAPTION_DIRECTORY", directory);
  await tick();
  expect(await getMediaSources(db, APPID)).toEqual([]);
  await changeMediaWatch(db, "watch", String(APPID), new Date("2026-11-29T05:00:00Z"));
  native.prepare(`INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type)
    SELECT ?, 'preview', 'https://www.ign.com/articles/old-' || value, 'Warlock preview', 'IGN', '2026-11-27T06:00:00Z', 'preview'
    FROM json_each(?)`).run(APPID, JSON.stringify(Array.from({ length: PREVIEW_CEILING }, (_, i) => i)));
  await tick("2026-11-29T06:00:00Z");
  expect((await getMediaSources(db, APPID)).every(({ outlet }) => outlet === "IGN")).toBe(true);
  expect(openRouter.requests.every(({ body }) => !body.messages.some(({ content }) => content.includes(URL)))).toBe(true);
});

test("an unapproved channel, non-English track, and missing or unusable captions cannot supply evidence", async () => {
  const { db, directory, tick } = await fixture();
  environment("MEDIA_GAMESPOT_CAPTION_DIRECTORY", directory);
  await Bun.write(`${directory}/${APPID}.json`, JSON.stringify([
    { ...VIDEO, channelId: "unverified" },
    { ...VIDEO, language: "fr" },
    { ...VIDEO, id: VIDEO.id + "\n" },
    { ...VIDEO, id: VIDEO.id + "&t=60" },
    { ...VIDEO, language: "en-US" },
    VIDEO,
  ]));
  const approved = await approvedGameSpotVideos(directory, APPID);
  expect(approved.map(({ language }) => language)).toEqual(["en-US", "en"]);
  expect(await readGameSpotCaptions(directory, approved[0]!)).toBeNull();
  await Bun.write(`${directory}/${VIDEO.id}.en.vtt`, "WEBVTT\n\n00:00.000 --> 00:04.000\n[music]\n");
  expect(await readGameSpotCaptions(directory, approved[1]!)).toBeNull();
  await tick();
  expect(await getMediaSources(db, APPID)).toEqual([]);
});


test.each(["file removed", "directory unset"])("written coverage publishes and the queued video resumes when captions return (%s)", async (missing) => {
  const appid = CYBERPUNK;
  const title = GAME_NAMES[appid]!;
  const writtenUrl = "https://ign.com/articles/cyberpunk-preview";
  const writtenQuote = "The announcement revealed that the campaign takes place in a city built around a mountain.";
  const fixtureState = await fixture(true, (url) => url === writtenUrl
    ? new Response(discoveryArticleHtml(appid, `${title} Preview`, {
      body: `${writtenQuote} The publisher also detailed the setting and described the project during its official announcement. The preview explains how the city is divided into districts.`,
      author: "IGN journalist",
    }))
    : undefined, appid, title);
  const { directory, tick, openRouter, tavily } = fixtureState;
  tavily.results = ({ domain }) => domain === "ign.com" ? [{ url: writtenUrl }] : [];
  environment("MEDIA_GAMESPOT_CAPTION_DIRECTORY", directory);
  expect((await tick(undefined, true, 0)).mediaDiscovery?.issued.articles).toBe(2);
  const path = `${directory}/${VIDEO.id}.en.vtt`;
  if (missing === "file removed") await unlink(path);
  else delete process.env.MEDIA_GAMESPOT_CAPTION_DIRECTORY;
  openRouter.onChat = ({ stage, body }) => {
    if (stage !== "extraction") return;
    const observation = body.messages[1]!.content.includes(QUOTE)
      ? mediaObservation(appid, "magic", "finding", "Invoke plans to make spells useful during exploration.", QUOTE)
      : { ...mediaObservation(appid, "city", "finding", writtenQuote, writtenQuote), previewEvidence: { scope: "announcement" } };
    openRouter.output("extraction", { observations: [observation] });
  };
  const held = await tick("2026-11-28T06:15:00Z");
  expect(held.mediaProcessing?.stopReasons).toContain("approved_captions_unavailable");
  const { native, db } = fixtureState.reopen();
  const videoJob = () => native.query<{ id: number; source_id: number; status: string; error: string | null }, [string]>(`
    SELECT j.id, j.source_id, j.status, j.error FROM media_processing_jobs AS j
    JOIN media_sources AS s ON s.id = j.source_id WHERE s.original_url = ? AND j.stage = 'extraction'`).all(URL);
  const [job] = videoJob();
  const activeOverview = () => native.query<{ output_json: string }, []>("SELECT output_json FROM media_game_overviews WHERE active = 1").get()?.output_json;
  expect(videoJob()).toEqual([{ id: expect.any(Number), source_id: expect.any(Number), status: "queued", error: "approved_captions_unavailable" }]);
  expect(native.query("SELECT 1 FROM media_processing_attempts WHERE job_id = ?").all(job!.id)).toEqual([]);
  const requestsBeforeRestore = openRouter.requests.length;
  expect(openRouter.requests.map(({ stage, urls }) => ({ stage, urls }))).toEqual([
    { stage: "extraction", urls: [] },
    { stage: "synthesis", urls: [writtenUrl] },
  ]);
  expect(activeOverview()).toContain(writtenUrl);
  expect(activeOverview()).not.toContain(URL);
  expect((await tick("2026-11-28T06:30:00Z")).mediaProcessing?.stopReasons).toContain("approved_captions_unavailable");
  expect(openRouter.requests).toHaveLength(requestsBeforeRestore);

  await Bun.write(path, CAPTIONS);
  process.env.MEDIA_GAMESPOT_CAPTION_DIRECTORY = directory;
  expect((await tick("2026-11-28T06:45:00Z")).mediaProcessing?.stopReasons).toEqual([]);
  expect(videoJob()).toEqual([{ ...job!, status: "succeeded", error: null }]);
  expect(openRouter.requests.slice(requestsBeforeRestore).map(({ stage }) => stage)).toEqual(["extraction", "synthesis"]);
  expect(openRouter.requests.at(-1)?.urls).toEqual(expect.arrayContaining([writtenUrl, URL]));
  expect(activeOverview()).toContain(writtenUrl);
  expect(activeOverview()).toContain(URL);

  const correction = insertCompletedRun(native, "initial:captions:unchanged", [appid]);
  await authorizeMediaProcessing(db, correction, { affectedSourceIds: [job!.source_id] });
  await unlink(path);
  await tick("2026-11-28T07:00:00Z");
  expect(videoJob()).toHaveLength(2);
  const requestsBeforeUnchanged = openRouter.requests.length;
  await Bun.write(path, CAPTIONS);
  await tick("2026-11-28T07:15:00Z");
  expect(videoJob()).toEqual([{ ...job!, status: "succeeded", error: null }]);
  expect(openRouter.requests).toHaveLength(requestsBeforeUnchanged);
});


test("a verified English preview video can supply reporting without an interview affiliation", async () => {
  const { db, directory, tick, openRouter } = await fixture();
  environment("MEDIA_GAMESPOT_CAPTION_DIRECTORY", directory);
  const preview = { ...VIDEO, id: "G4Q-WLK0J2Y", developer: null, title: `${TITLE} preview` };
  await Bun.write(`${directory}/${APPID}.json`, JSON.stringify([preview]));
  await Bun.write(`${directory}/${preview.id}.en.vtt`, CAPTIONS);
  await tick();
  expect(await getMediaSources(db, APPID)).toEqual([expect.objectContaining({
    originalUrl: "https://www.youtube.com/watch?v=G4Q-WLK0J2Y", outlet: "GameSpot", affiliation: null, handsOn: false,
  })]);
  const extraction = openRouter.requests.find(({ stage }) => stage === "extraction");
  expect(extraction?.body.messages[0]?.content).toContain("Distinguish the outlet's reporting from developer statements.");
});
