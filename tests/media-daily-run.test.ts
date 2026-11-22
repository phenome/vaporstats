import { afterEach, describe, expect, test } from "bun:test";
import { getMediaSources, MEDIA_OUTLETS } from "../src/lib/media-discovery";
import { getMediaOverview } from "../src/lib/media-overview";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  controlledGeminiApi,
  controlledOpenRouterApi,
  controlledTavilyApi,
  CYBERPUNK,
  HADES_II,
  insertCompletedRun,
  insertSources,
  insertSubmittedGeminiExtraction,
  overviewOutputForUrls,
  runMediaTick,
  seedApps,
  type MediaTickOptions,
} from "./support/media";

// Automatic media ingestion at the ingestion-tick seam: one temporary SQLite
// file, a controlled clock, and controlled Tavily, outlet, OpenRouter and
// Gemini APIs. Nothing reaches a real provider.

const cleanups: Array<() => void> = [];
const environment = { artifacts: process.env.RECEPTION_ARTIFACT_DIR, overviewPublic: process.env.MEDIA_OVERVIEW_PUBLIC, automatic: process.env.MEDIA_AUTOMATIC_INGESTION };
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const [name, value] of [["RECEPTION_ARTIFACT_DIR", environment.artifacts], ["MEDIA_OVERVIEW_PUBLIC", environment.overviewPublic], ["MEDIA_AUTOMATIC_INGESTION", environment.automatic]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Apis = {
  gemini: ReturnType<typeof controlledGeminiApi>;
  openRouter: ReturnType<typeof controlledOpenRouterApi>;
  tavily: ReturnType<typeof controlledTavilyApi>;
};

function apis(): Apis {
  return { gemini: controlledGeminiApi(), openRouter: controlledOpenRouterApi(), tavily: controlledTavilyApi() };
}

function experimentCatalog(): TestDatabase {
  const database = openTestDatabase("vaporstats-media-daily-");
  cleanups.push(database.cleanup);
  seedApps(database.native, [CYBERPUNK, BALDURS_GATE, HADES_II]);
  return database;
}

function tick(database: TestDatabase, providers: Partial<Apis>, at: string, options: MediaTickOptions = {}) {
  return runMediaTick(database, providers, at, options);
}

function enrollments(database: TestDatabase) {
  return database.native.query<{ appid: number; reason: string; enrolled_at: string }, []>("SELECT appid, reason, enrolled_at FROM media_enrollments ORDER BY appid").all();
}

function activeOutputs(database: TestDatabase) {
  return {
    extractions: database.native.query("SELECT id, source_id, input_identity FROM media_article_extractions WHERE active = 1 ORDER BY id").all(),
    overviews: database.native.query("SELECT id, appid, input_identity, output_json FROM media_game_overviews WHERE active = 1 ORDER BY id").all(),
    embeddings: database.native.query("SELECT id, appid, dimension, input_identity FROM media_game_embeddings WHERE active = 1 ORDER BY id").all(),
    sources: database.native.query("SELECT id, appid, original_url, processing_run_id FROM media_sources ORDER BY id").all(),
  };
}

describe("enrollment in the daily media run", () => {
  test("the first daily media run while enabled records the enrollment start date once and enrolls the three experiment games, whose existing sources and outputs carry over unchanged", async () => {
    const database = experimentCatalog();
    insertSources(database.native, CYBERPUNK, "initial", 1);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:experiment", [CYBERPUNK]));
    // Without search results, no article is added, so only enrollment changes.
    const providers = { gemini: controlledGeminiApi(), openRouter: controlledOpenRouterApi() };
    // Before 06:00 UTC no daily media run happens; the experiment's authorized
    // work produces Cyberpunk 2077's extraction, Overview and embedding.
    const early = await tick(database, providers, "2026-11-20T05:45:00.000Z", { mediaAutomaticIngestion: true });
    expect(early.mediaDailyRun).toBeUndefined();
    expect(enrollments(database)).toEqual([]);
    const before = activeOutputs(database);
    expect(before.overviews).toHaveLength(1);
    const paidRequests = providers.openRouter.requests.length + providers.gemini.submitted.length;

    const first = await tick(database, providers, "2026-11-20T06:00:00.000Z");

    expect(first.mediaDailyRun).toMatchObject({ day: "2026-11-20", enrollmentStartDate: "2026-11-20", enrolled: [BALDURS_GATE, CYBERPUNK, HADES_II] });
    expect(enrollments(database)).toEqual([
      { appid: BALDURS_GATE, reason: "experiment", enrolled_at: "2026-11-20T06:00:00.000Z" },
      { appid: CYBERPUNK, reason: "experiment", enrolled_at: "2026-11-20T06:00:00.000Z" },
      { appid: HADES_II, reason: "experiment", enrolled_at: "2026-11-20T06:00:00.000Z" },
    ]);
    expect(activeOutputs(database)).toEqual(before);
    expect(providers.openRouter.requests.length + providers.gemini.submitted.length).toBe(paidRequests);

    const next = await tick(database, providers, "2026-11-21T06:00:00.000Z");

    expect(next.mediaDailyRun).toMatchObject({ day: "2026-11-21", enrollmentStartDate: "2026-11-20", enrolled: [] });
    expect(enrollments(database).map(({ enrolled_at }) => enrolled_at)).toEqual(Array(3).fill("2026-11-20T06:00:00.000Z"));
    expect(activeOutputs(database)).toEqual(before);
  });
});

describe("automatic Paid-work summaries", () => {
  test("an OpenRouter-only tick reports its completed work without a Gemini key", async () => {
    const database = experimentCatalog();
    insertSources(database.native, CYBERPUNK, "initial", 1);
    const sources = await getMediaSources(database.db, CYBERPUNK);
    const openRouter = controlledOpenRouterApi();
    openRouter.output("synthesis", overviewOutputForUrls(sources.map(({ originalUrl }) => originalUrl)));

    const result = await tick(database, { openRouter }, "2026-11-20T06:00:00.000Z", { geminiApiKey: "" });

    expect(openRouter.requests.map(({ stage }) => stage)).toEqual(["extraction", "synthesis"]);
    expect(result.mediaProcessing).toMatchObject({
      submitted: 2, completed: 2, status: "completed", overviewAppids: [CYBERPUNK],
    });
  });

  test("a combined tick reports successful OpenRouter and Gemini work and sorts active Overview AppIDs", async () => {
    const database = experimentCatalog();
    insertSources(database.native, CYBERPUNK, "initial", 1);
    insertSources(database.native, BALDURS_GATE, "initial", 1);
    const providers = { openRouter: controlledOpenRouterApi(), gemini: controlledGeminiApi() };

    providers.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_PENDING" } } });

    const result = await tick(database, providers, "2026-11-20T06:00:00.000Z");

    expect(providers.openRouter.requests).toHaveLength(4);
    expect(providers.gemini.submitted).toHaveLength(2);
    expect(result.mediaProcessing).toMatchObject({
      submitted: 6, completed: 5, status: "waiting", overviewAppids: [BALDURS_GATE, CYBERPUNK],
    });
    const settled = await tick(database, providers, "2026-11-20T06:15:00.000Z");
    expect(settled.mediaProcessing).toMatchObject({
      submitted: 0, completed: 1, status: "completed", overviewAppids: [BALDURS_GATE, CYBERPUNK],
    });
    const idle = await tick(database, providers, "2026-11-20T06:30:00.000Z");
    expect(idle.mediaProcessing).toMatchObject({
      submitted: 0, completed: 0, status: "completed", overviewAppids: [BALDURS_GATE, CYBERPUNK],
    });
  });

  test("a connection failure before an OpenRouter request is sent leaves work waiting without a submission", async () => {
    const database = experimentCatalog();
    insertSources(database.native, CYBERPUNK, "initial", 1);
    const openRouter = controlledOpenRouterApi();
    openRouter.reply("chat", { network: "connection refused", code: "ECONNREFUSED" });

    const result = await tick(database, { openRouter }, "2026-11-20T06:00:00.000Z", { geminiApiKey: "" });

    expect(result.mediaProcessing).toMatchObject({
      submitted: 0, completed: 0, status: "waiting", overviewAppids: [], queued: { openrouter: 1 },
    });
  });

  test("paused Gemini work keeps the automatic summary waiting after OpenRouter completes", async () => {
    const database = experimentCatalog();
    insertSources(database.native, CYBERPUNK, "initial", 1);
    const openRouter = controlledOpenRouterApi();

    const result = await tick(database, { openRouter }, "2026-11-20T06:00:00.000Z", { geminiApiKey: "" });

    expect(result.mediaProcessing).toMatchObject({
      submitted: 2, completed: 2, status: "waiting", overviewAppids: [CYBERPUNK],
      queued: { openrouter: 0, gemini: 1 },
      providers: { gemini: { paused: true, reason: "missing_key" } },
    });
  });
});

const EXPERIMENT = [CYBERPUNK, BALDURS_GATE, HADES_II];

/** Every search as its query and outlet domain, so a repeated query shows up as a count above one. */
function repeatedSearches(providers: Apis): string[] {
  const queries = providers.tavily.requests.map(({ body }) => {
    const payload = JSON.parse(String(body)) as { query: string; include_domains: string[] };
    return `${payload.query}@${payload.include_domains[0]}`;
  });
  return queries.filter((query, index, all) => all.indexOf(query) !== index);
}

function waitingItems(database: TestDatabase) {
  return database.native.query<{ id: number; stage: string; appid: number; provider: string; status: string }, []>("SELECT id, stage, appid, provider, status FROM media_processing_jobs WHERE status = 'queued' AND retained = 0 ORDER BY id").all();
}

function authorizationCount(database: TestDatabase): number {
  return database.native.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM media_processing_authorizations").get()!.count;
}

function scheduledRuns(database: TestDatabase) {
  return database.native.query<{ identity_key: string; status: string }, []>("SELECT identity_key, status FROM media_discovery_runs WHERE origin = 'scheduled' ORDER BY id").all();
}

async function detailOverview(database: TestDatabase, appid: number) {
  const response = await handleGameDetailRequest(new Request(`https://vaporstats.test/api/games/${appid}/detail`), database.db, appid);
  expect(response.status).toBe(200);
  return (await response.json() as { data: { mediaOverview: unknown; mediaSources?: unknown } }).data;
}

describe("the daily media run", () => {
  test("searches the outlets for the experiment games once, and the queue takes the accepted articles without authorization through extraction, Overview and embeddings to the Internal website API across ticks", async () => {
    const database = experimentCatalog();
    const providers = apis();

    const first = await tick(database, providers, "2026-11-20T06:00:00.000Z", { paidSubmissionsPerTick: 4 });

    // One query per entity and outlet, with one accepted article each.
    expect(first.mediaDailyRun?.discoveryRunId).toEqual(expect.any(Number));
    expect(first.mediaDiscovery).toMatchObject({ runId: first.mediaDailyRun!.discoveryRunId, status: "completed", queries: 18, articles: 18 });
    expect(providers.tavily.searches).toHaveLength(18);
    expect(repeatedSearches(providers)).toEqual([]);
    // The queue took four text items in this tick; the rest wait their turn.
    expect(providers.openRouter.requests).toHaveLength(4);
    expect(first.mediaProcessing?.queued.openrouter).toBeGreaterThan(0);

    const ticks = ["06:15", "06:30", "06:45", "07:00", "07:15", "07:30", "07:45", "08:00"];
    for (const at of ticks) await tick(database, providers, `2026-11-20T${at}:00.000Z`, { paidSubmissionsPerTick: 4 });

    // Ticks after the daily media run search nothing.
    expect(providers.tavily.searches).toHaveLength(18);
    expect(providers.tavily.usageCalls).toBe(1);
    expect(providers.openRouter.requests.map(({ stage }) => stage).sort()).toEqual([...Array(18).fill("extraction"), ...Array(3).fill("synthesis")]);
    expect(providers.gemini.submitted.map((key) => key.split(":").slice(0, 2).join(":")).sort()).toEqual(EXPERIMENT.map((appid) => `embedding:${appid}`).sort());
    expect(waitingItems(database)).toEqual([]);
    expect(authorizationCount(database)).toBe(0);
    for (const appid of EXPERIMENT) {
      const sources = await getMediaSources(database.db, appid);
      expect(sources).toHaveLength(6);
      const overview = await getMediaOverview(database.db, appid, { includeUnpublished: true });
      expect(overview?.statements[0]?.sourceUrls.slice().sort()).toEqual(sources.map(({ originalUrl }) => originalUrl).sort());
      // Publication stays behind MEDIA_OVERVIEW_PUBLIC.
      delete process.env.MEDIA_OVERVIEW_PUBLIC;
      expect((await detailOverview(database, appid)).mediaOverview).toBeNull();
    }
  });

  test("a scheduled discovery run interrupted by a restart resumes in a later tick on the same UTC day without repeating a query or a fetch, and a later tick that day starts no search", async () => {
    const database = experimentCatalog();
    const providers = apis();
    const fetched: string[] = [];
    let crashedFetch: string | null = null;
    // The process stops while it fetches the fourth discovered article.
    const crashed = await tick(database, providers, "2026-11-20T06:00:00.000Z", {
      fetched,
      outlet: (url) => {
        if (fetched.length === 4) {
          crashedFetch = url;
          database.reopen();
          throw new Error("process stopped");
        }
        return undefined;
      },
    });
    expect(crashed.status).toBe("error");
    expect(providers.tavily.searches).toHaveLength(4);
    expect(scheduledRuns(database)).toEqual([{ identity_key: "scheduled:2026-11-20", status: "running" }]);

    const resumed = await tick(database, providers, "2026-11-20T06:15:00.000Z", { fetched });

    expect(resumed.mediaDailyRun).toBeUndefined();
    expect(resumed.mediaDiscovery).toMatchObject({ status: "completed", queries: 18 });
    // The fetch in flight at the restart may have reached its outlet, so it is
    // never repeated; its candidate is skipped with that reason.
    const crashedOutlet = MEDIA_OUTLETS.find(({ domain }) => new URL(crashedFetch!).hostname === domain)!;
    expect(resumed.mediaDiscovery?.stopReasons).toContain(`${crashedOutlet.name}:fetch_interrupted`);
    expect(fetched.filter((url) => url === crashedFetch)).toEqual([crashedFetch!]);
    // Its attempt, reserved before the restart, records that it was interrupted.
    expect(database.native.query("SELECT kind, status_code, error FROM media_discovery_attempts WHERE url = ?").all(crashedFetch!)).toEqual([{ kind: "failure", status_code: null, error: "interrupted_by_restart" }]);
    expect((await getMediaSources(database.db, CYBERPUNK)).map(({ originalUrl }) => originalUrl)).not.toContain(crashedFetch);
    expect(providers.tavily.searches).toHaveLength(18);
    expect(repeatedSearches(providers)).toEqual([]);
    expect(scheduledRuns(database)).toEqual([{ identity_key: "scheduled:2026-11-20", status: "completed" }]);

    const later = await tick(database, providers, "2026-11-20T06:30:00.000Z");

    expect(later.mediaDailyRun).toBeUndefined();
    expect(later.mediaDiscovery).toBeUndefined();
    expect(providers.tavily.searches).toHaveLength(18);
  });

  test("runs once per UTC day, catches up once after a missed 06:00, never makes up a missed day, and retries a query kept by a Provider stop in the next daily media run", async () => {
    const database = experimentCatalog();
    const providers = apis();
    // Six free credits remain: the seventh query meets a Provider stop and is kept.
    providers.tavily.remaining = 6;

    const early = await tick(database, providers, "2026-11-20T05:45:00.000Z");
    expect(early.mediaDailyRun).toBeUndefined();
    expect(providers.tavily.usageCalls).toBe(0);

    // The process was down at 06:00; the first tick afterwards catches up.
    const caughtUp = await tick(database, providers, "2026-11-20T10:00:00.000Z");
    expect(caughtUp.mediaDailyRun?.day).toBe("2026-11-20");
    expect(caughtUp.mediaDiscovery).toMatchObject({ status: "stopped", stopReasons: expect.arrayContaining(["tavily_credits_exhausted"]) });
    expect(providers.tavily.searches).toHaveLength(6);

    const sameDay = await tick(database, providers, "2026-11-20T10:15:00.000Z");
    expect(sameDay.mediaDailyRun).toBeUndefined();
    expect(sameDay.mediaDiscovery).toBeUndefined();
    expect(providers.tavily.searches).toHaveLength(6);

    // November 21 passes with the process down. On November 22 the kept
    // queries run once, and November 21 is never made up. Baldur's Gate 3's
    // initial discovery finished on November 20, so its later pass searches
    // its six outlets on November 22 too.
    providers.tavily.remaining = 100;
    const nextRun = await tick(database, providers, "2026-11-22T09:00:00.000Z");
    expect(nextRun.mediaDailyRun?.day).toBe("2026-11-22");
    await tick(database, providers, "2026-11-22T09:15:00.000Z");
    await tick(database, providers, "2026-11-23T05:45:00.000Z");

    expect(scheduledRuns(database)).toEqual([
      { identity_key: "scheduled:2026-11-20", status: "stopped" },
      { identity_key: "scheduled:2026-11-22", status: "completed" },
    ]);
    expect(providers.tavily.searches).toHaveLength(24);
    expect(repeatedSearches(providers)).toEqual([]);
    expect(providers.tavily.usageCalls).toBe(2);
  });

  test("the tick log reports the searches, outlet attempts and articles of each daily media run, not the pass's totals, with Tavily's usage", async () => {
    const database = experimentCatalog();
    const providers = apis();
    providers.tavily.remaining = 6;
    const logged: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
    const discoveryLog = () => (JSON.parse(logged.filter((line) => line.includes("\"ingestion_completion\"")).at(-1)!) as { mediaDiscovery: unknown }).mediaDiscovery;
    try {
      await tick(database, providers, "2026-11-20T06:00:00.000Z");
      // Six searches, each with the one candidate it found fetched and accepted.
      expect(discoveryLog()).toMatchObject({
        searches: 6,
        attempts: 12,
        articles: 6,
        tavily: { searchCreditsConsumed: 6, planUsage: 1_000, planLimit: 1_000, remainingCredits: 0 },
      });

      providers.tavily.remaining = 100;
      await tick(database, providers, "2026-11-21T06:00:00.000Z");
      // The twelve initial queries left over, each with an accepted article,
      // and Baldur's Gate 3's later pass, due since its initial discovery
      // finished on November 20: six searches that find only the articles it
      // already has, so nothing is fetched.
      expect(discoveryLog()).toMatchObject({
        searches: 18,
        attempts: 30,
        articles: 12,
        tavily: { searchCreditsConsumed: 18, planUsage: 918, planLimit: 1_000, remainingCredits: 82 },
      });
    } finally {
      console.log = log;
    }
  });
});

describe("the automatic media ingestion switch", () => {
  test("is off unless MEDIA_AUTOMATIC_INGESTION is exactly true", async () => {
    const database = experimentCatalog();
    const providers = apis();
    for (const value of [undefined, "", "1", "TRUE", "yes", "on"]) {
      if (value === undefined) delete process.env.MEDIA_AUTOMATIC_INGESTION;
      else process.env.MEDIA_AUTOMATIC_INGESTION = value;
      const result = await tick(database, providers, "2026-11-20T06:00:00.000Z", { mediaAutomaticIngestion: undefined });
      expect(result.mediaDailyRun).toBeUndefined();
    }
    expect(enrollments(database)).toEqual([]);
    expect(providers.tavily.usageCalls).toBe(0);
    expect(providers.openRouter.calls).toEqual([]);

    process.env.MEDIA_AUTOMATIC_INGESTION = "true";
    const enabled = await tick(database, providers, "2026-11-20T06:15:00.000Z", { mediaAutomaticIngestion: undefined });
    expect(enabled.mediaDailyRun?.day).toBe("2026-11-20");
  });

  test("when disabled, the daily media run does nothing for media and no paid submission is made, while submitted Gemini batches are still polled and queued work and due passes are kept for when it is enabled again", async () => {
    const database = experimentCatalog();
    const providers = apis();
    providers.tavily.remaining = 3;
    await tick(database, providers, "2026-11-20T06:00:00.000Z", { paidSubmissionsPerTick: 1 });
    expect(providers.tavily.searches).toHaveLength(3);
    const waiting = waitingItems(database);
    expect(waiting.length).toBeGreaterThan(0);
    const dueQueries = () => database.native.query("SELECT appid, outlet, status, stop_reason, query_attempted_at FROM media_discovery_progress ORDER BY id").all();
    const duePasses = dueQueries();
    // A text batch Gemini accepted before the move to OpenRouter is still out.
    insertSources(database.native, CYBERPUNK, "initial", 1);
    const sourceId = database.native.query<{ id: number }, []>("SELECT MAX(id) AS id FROM media_sources").get()!.id;
    const jobId = insertSubmittedGeminiExtraction(database.native, { runId: insertCompletedRun(database.native, "initial:pre-cutover", [CYBERPUNK]), sourceId, batch: "batches/pre-cutover" });
    providers.gemini.batch("batches/pre-cutover", "extraction");
    const before = { searches: providers.tavily.searches.length, usage: providers.tavily.usageCalls, openRouter: providers.openRouter.calls.length, gemini: providers.gemini.submitted.length };

    const disabled = [];
    for (const at of ["2026-11-20T06:15:00.000Z", "2026-11-21T06:00:00.000Z", "2026-11-21T06:15:00.000Z"]) {
      disabled.push(await tick(database, providers, at, { mediaAutomaticIngestion: false }));
    }

    expect(disabled.map((result) => result.mediaDailyRun)).toEqual([undefined, undefined, undefined]);
    expect(disabled.map((result) => result.mediaDiscovery)).toEqual([undefined, undefined, undefined]);
    expect({ searches: providers.tavily.searches.length, usage: providers.tavily.usageCalls, openRouter: providers.openRouter.calls.length, gemini: providers.gemini.submitted.length }).toEqual(before);
    expect(providers.gemini.calls.filter((call) => call.kind === "poll").map((call) => call.key)).toEqual(["extraction:batches/pre-cutover"]);
    expect(database.native.query("SELECT status FROM media_processing_jobs WHERE id = ?").get(jobId)).toEqual({ status: "succeeded" });
    expect(waitingItems(database)).toEqual(waiting);
    expect(dueQueries()).toEqual(duePasses);
    expect(enrollments(database)).toHaveLength(3);

    // Enabled again later that day, the missed daily media run catches up,
    // takes the kept queries, and the waiting items are submitted.
    providers.tavily.remaining = 100;
    const enabled = await tick(database, providers, "2026-11-21T09:00:00.000Z", { paidSubmissionsPerTick: 60 });
    expect(enabled.mediaDailyRun?.day).toBe("2026-11-21");
    expect(providers.tavily.searches).toHaveLength(18);
    expect(repeatedSearches(providers)).toEqual([]);
    expect(waitingItems(database).filter(({ id }) => waiting.some((item) => item.id === id))).toEqual([]);
  });
});

describe("article ceilings in automatic runs", () => {
  test("the 45-article experiment total is retired: roots and an eligible child whose accepted articles exceed 45 in total each admit up to their own 15-article ceiling, and every new article is queued for processing", async () => {
    const PHANTOM_LIBERTY = 2138330;
    const database = experimentCatalog();
    database.native.prepare("INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid) VALUES (?, 'Cyberpunk 2077: Phantom Liberty', 'phantom-liberty', 'expansion', 1, 1, ?)").run(PHANTOM_LIBERTY, CYBERPUNK);
    insertSources(database.native, BALDURS_GATE, "initial", 15);
    insertSources(database.native, HADES_II, "initial", 15);
    insertSources(database.native, CYBERPUNK, "initial", 14);
    // The seeded articles were processed under the experiment.
    const processed = insertCompletedRun(database.native, "initial:experiment", [CYBERPUNK, BALDURS_GATE, HADES_II]);
    database.native.prepare("UPDATE media_sources SET processing_run_id = ?").run(processed);
    const providers = { ...apis(), tavily: controlledTavilyApi({ [CYBERPUNK]: "Cyberpunk 2077", [BALDURS_GATE]: "Baldur's Gate 3", [HADES_II]: "Hades II", [PHANTOM_LIBERTY]: "Cyberpunk 2077: Phantom Liberty" }) };
    const expansionReview = `<!doctype html><html><head><meta property="og:title" content="Cyberpunk 2077: Phantom Liberty Review"><meta property="article:published_time" content="2026-11-01"></head><body><article><h1>Cyberpunk 2077: Phantom Liberty Review</h1><p>${"Phantom Liberty adds a substantial spy story with detailed systems and memorable encounters. ".repeat(5)}</p></article></body></html>`;

    await tick(database, providers, "2026-11-20T06:00:00.000Z", {
      paidSubmissionsPerTick: 1,
      outlet: (url) => url.includes(`/${PHANTOM_LIBERTY}-`) ? new Response(expansionReview) : undefined,
    });

    const perEntity = database.native.query<{ appid: number; count: number }, []>("SELECT appid, COUNT(*) AS count FROM media_sources GROUP BY appid ORDER BY appid").all();
    expect(perEntity).toEqual([
      { appid: BALDURS_GATE, count: 15 },
      { appid: CYBERPUNK, count: 15 },
      { appid: HADES_II, count: 15 },
      { appid: PHANTOM_LIBERTY, count: 6 },
    ]);
    // Baldur's Gate 3 and Hades II are at their ceilings: no query for them.
    expect(providers.tavily.searches.filter((search) => search.startsWith("Baldur") || search.startsWith("Hades"))).toEqual([]);
    const newSources = database.native.query<{ id: number }, [number]>("SELECT id FROM media_sources WHERE processing_run_id IS NOT ? OR processing_run_id IS NULL ORDER BY id").all(processed);
    expect(newSources).toHaveLength(7);
    const extractionItems = database.native.query<{ source_id: number }, []>("SELECT source_id FROM media_processing_jobs WHERE stage = 'extraction' ORDER BY source_id").all();
    expect(extractionItems.map(({ source_id }) => source_id)).toEqual(newSources.map(({ id }) => id));
  });
});

function attempts(database: TestDatabase, outlet: string) {
  return database.native.query<{ day: string; kind: string; count: number }, [string]>("SELECT day, kind, COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = ? GROUP BY day, kind ORDER BY day, kind").all(outlet);
}

function extractionStatus(database: TestDatabase, url: string) {
  return database.native.query<{ status: string }, [string]>("SELECT job.status FROM media_processing_jobs AS job JOIN media_sources AS source ON source.id = job.source_id WHERE job.stage = 'extraction' AND source.original_url = ?").all(url).map(({ status }) => status);
}

describe("settled source rules in automatic runs", () => {
  test("an Outlet denial is permanent across daily media runs and the processing fetches they cause, and an Outlet day stop at the 30-attempt cap holds discovery and processing until the next UTC day", async () => {
    const database = experimentCatalog();
    const [ign, eurogamer] = [MEDIA_OUTLETS[0], MEDIA_OUTLETS[1]];
    // An unprocessed article on each outlet, carried over from the experiment.
    insertSources(database.native, CYBERPUNK, "initial", 1, ign);
    insertSources(database.native, CYBERPUNK, "initial", 1, eurogamer);
    const [ignArticle, eurogamerArticle] = database.native.query<{ original_url: string }, []>("SELECT original_url FROM media_sources ORDER BY id").all().map(({ original_url }) => original_url);
    // Earlier work used 29 of Eurogamer's 30 attempts on November 20.
    const seed = database.native.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, succeeded, attempted_at) VALUES (?, 'Eurogamer', 'initial', '2026-11-20', 'fetch', 1, '2026-11-20T00:00:00.000Z')");
    for (let index = 0; index < 29; index += 1) seed.run(CYBERPUNK);
    const providers = apis();
    const fetched: string[] = [];
    // IGN denies every article fetch.
    const outlet = (url: string) => new URL(url).hostname === ign.domain ? new Response("Forbidden", { status: 403 }) : undefined;

    await tick(database, providers, "2026-11-20T06:00:00.000Z", { outlet, fetched });

    // IGN: one search and the fetch it refused; nothing else that day. The
    // denial is permanent, so the article's extraction is refused (#80).
    expect(attempts(database, "IGN")).toEqual([{ day: "2026-11-20", kind: "fetch", count: 1 }, { day: "2026-11-20", kind: "search", count: 1 }]);
    expect(extractionStatus(database, ignArticle!)).toEqual(["refused"]);
    // Eurogamer: the one search left under the cap, then a day stop for
    // discovery's fetch and for processing's.
    expect(attempts(database, "Eurogamer")).toEqual([{ day: "2026-11-20", kind: "fetch", count: 29 }, { day: "2026-11-20", kind: "search", count: 1 }]);
    expect(extractionStatus(database, eurogamerArticle!)).toEqual(["queued"]);
    expect(fetched.filter((url) => new URL(url).hostname === eurogamer.domain)).toEqual([]);

    await tick(database, providers, "2026-11-20T06:15:00.000Z", { outlet, fetched });
    await tick(database, providers, "2026-11-21T06:00:00.000Z", { outlet, fetched });

    // The denial holds on the next day: IGN is never contacted again, and
    // its article stays refused as outlet_denied.
    expect(attempts(database, "IGN")).toEqual([{ day: "2026-11-20", kind: "fetch", count: 1 }, { day: "2026-11-20", kind: "search", count: 1 }]);
    expect(providers.tavily.searches.filter((search) => search.endsWith(`@${ign.domain}`))).toHaveLength(1);
    expect(extractionStatus(database, ignArticle!)).toEqual(["refused"]);
    expect(database.native.query<{ error: string }, [string]>("SELECT j.error FROM media_processing_jobs AS j JOIN media_sources AS s ON s.id = j.source_id WHERE s.original_url = ?").all(ignArticle!)).toEqual([{ error: "outlet_denied" }]);
    // Eurogamer reopens on November 21: the stopped query's candidate is
    // fetched, the other entities are searched once, and processing fetches
    // the waiting article and the three new ones: 2 searches and 3 + 4 fetches.
    expect(providers.tavily.searches.filter((search) => search.endsWith(`@${eurogamer.domain}`))).toHaveLength(3);
    expect(repeatedSearches(providers)).toEqual([]);
    expect(attempts(database, "Eurogamer").filter(({ day }) => day === "2026-11-21")).toEqual([{ day: "2026-11-21", kind: "fetch", count: 7 }, { day: "2026-11-21", kind: "search", count: 2 }]);
    expect(extractionStatus(database, eurogamerArticle!)).toEqual(["succeeded"]);
  });

  test.each([
    ["the 30-attempt cap", "daily_attempt_cap"],
    ["an outlet rate limit", "fetch_http_429"],
  ] as const)("a query stopped by an Outlet day stop at %s reopens in the next daily media run even after the queue fetched from that outlet earlier that UTC day", async (_, stopReason) => {
    const database = experimentCatalog();
    const eurogamer = MEDIA_OUTLETS[1];
    // An unprocessed Eurogamer article carried over from the experiment keeps
    // the paid-work queue fetching from Eurogamer in every tick.
    insertSources(database.native, CYBERPUNK, "initial", 1, eurogamer);
    if (stopReason === "daily_attempt_cap") {
      const seed = database.native.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, succeeded, attempted_at) VALUES (?, 'Eurogamer', 'initial', '2026-11-20', 'fetch', 1, '2026-11-20T00:00:00.000Z')");
      for (let index = 0; index < 29; index += 1) seed.run(CYBERPUNK);
    }
    let rateLimited = stopReason === "fetch_http_429";
    const outlet = (url: string) => rateLimited && new URL(url).hostname === eurogamer.domain ? new Response("Too Many Requests", { status: 429 }) : undefined;
    const providers = apis();
    const eurogamerQueries = () => database.native.query<{ status: string; stop_reason: string | null }, []>("SELECT status, stop_reason FROM media_discovery_progress WHERE outlet = 'Eurogamer' ORDER BY id").all();

    await tick(database, providers, "2026-11-20T06:00:00.000Z", { outlet });
    expect(eurogamerQueries()).toEqual([{ status: "stopped", stop_reason: stopReason }]);

    // Before November 21's daily media run, the queue fetches from Eurogamer.
    rateLimited = false;
    const fetched: string[] = [];
    await tick(database, providers, "2026-11-21T00:00:00.000Z", { outlet, fetched });
    expect(fetched.filter((url) => new URL(url).hostname === eurogamer.domain)).not.toEqual([]);
    expect(attempts(database, "Eurogamer").filter(({ day }) => day === "2026-11-21")).not.toEqual([]);

    await tick(database, providers, "2026-11-21T06:00:00.000Z", { outlet });

    // The stopped query is served in November 21's daily media run, along
    // with the other entities' Eurogamer queries, and none is repeated.
    expect(eurogamerQueries()).toEqual(Array(3).fill({ status: "completed", stop_reason: null }));
    expect(providers.tavily.searches.filter((search) => search.endsWith(`@${eurogamer.domain}`))).toHaveLength(3);
    expect(repeatedSearches(providers)).toEqual([]);
  });

  test("searches stay on Tavily's free plan with paid overage disabled, and take at most 10 candidates per query", async () => {
    const paid = experimentCatalog();
    const paidProviders = apis();
    paidProviders.tavily.paygoLimit = 50;
    const overage = await tick(paid, paidProviders, "2026-11-20T06:00:00.000Z");
    expect(overage.mediaDiscovery).toMatchObject({ status: "stopped", queries: 0, stopReasons: ["tavily_free_credits_unavailable"] });
    paidProviders.tavily.paygoLimit = 0;
    paidProviders.tavily.plan = "bootstrap";
    const paidPlan = await tick(paid, paidProviders, "2026-11-21T06:00:00.000Z");
    expect(paidPlan.mediaDiscovery).toMatchObject({ status: "stopped", queries: 0, stopReasons: ["tavily_account_not_free"] });
    expect(paidProviders.tavily.searches).toEqual([]);

    const database = experimentCatalog();
    const providers = apis();
    const results = Array.from({ length: 12 }, (_, index) => ({ url: `https://ign.com/articles/${BALDURS_GATE}-candidate-${index}` }));
    providers.tavily.reply({ status: 200, body: { results, usage: { credits_used: 1 } } });
    const fetched: string[] = [];
    await tick(database, providers, "2026-11-20T06:00:00.000Z", { fetched });
    // Discovery fetches the first ten; processing later fetches the accepted one again.
    expect([...new Set(fetched.filter((url) => url.includes(`${BALDURS_GATE}-candidate-`)))]).toEqual(results.slice(0, 10).map(({ url }) => url));
    const request = JSON.parse(String(providers.tavily.requests[0]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ search_depth: "basic", max_results: 10, include_answer: false, include_raw_content: false });
  });
});

describe("experiment progress", () => {
  test("the experiment games' unfinished initial-pass queries are due at the first daily media run, and a query the experiment already served is never repeated", async () => {
    const database = experimentCatalog();
    // The manual experiment searched Cyberpunk 2077 on IGN; its Eurogamer
    // query was kept by a Provider stop.
    const experimentRun = insertCompletedRun(database.native, "initial:experiment", [CYBERPUNK]);
    database.native.prepare("INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, status, query_attempted_at, candidate_urls, candidate_index) VALUES (?, ?, 'initial', 'IGN', 'completed', '2026-09-01T00:00:00.000Z', '[]', 0)").run(experimentRun, CYBERPUNK);
    database.native.prepare("INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, status, stop_reason) VALUES (?, ?, 'initial', 'Eurogamer', 'queued', 'tavily_credits_exhausted')").run(experimentRun, CYBERPUNK);
    const providers = apis();

    await tick(database, providers, "2026-11-20T06:00:00.000Z");

    const cyberpunk = providers.tavily.searches.filter((search) => search.startsWith("Cyberpunk 2077@"));
    expect(cyberpunk.sort()).toEqual(MEDIA_OUTLETS.filter(({ name }) => name !== "IGN").map(({ domain }) => `Cyberpunk 2077@${domain}`).sort());
    expect(providers.tavily.searches).toHaveLength(17);
  });
});
