import { afterEach, describe, expect, test } from "bun:test";
import { getMediaSources } from "../src/lib/media-discovery";
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

const EXPERIMENT = [CYBERPUNK, BALDURS_GATE, HADES_II];

/** Every distinct search, so a repeated query shows up as a count above one. */
function repeatedSearches(providers: Apis): string[] {
  return providers.tavily.searches.filter((search, index, all) => all.indexOf(search) !== index);
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

  test("a scheduled discovery run interrupted by a restart resumes in a later tick on the same UTC day without repeating a query, and a later tick that day starts no search", async () => {
    const database = experimentCatalog();
    const providers = apis();
    let articleFetches = 0;
    // The process stops while it fetches the fourth discovered article.
    const crashed = await tick(database, providers, "2026-11-20T06:00:00.000Z", {
      outlet: () => {
        articleFetches += 1;
        if (articleFetches === 4) {
          database.reopen();
          throw new Error("process stopped");
        }
        return undefined;
      },
    });
    expect(crashed.status).toBe("error");
    expect(providers.tavily.searches).toHaveLength(4);
    expect(scheduledRuns(database)).toEqual([{ identity_key: "scheduled:initial:2026-11-20", status: "running" }]);

    const resumed = await tick(database, providers, "2026-11-20T06:15:00.000Z");

    expect(resumed.mediaDailyRun).toBeUndefined();
    expect(resumed.mediaDiscovery).toMatchObject({ status: "completed", queries: 18 });
    expect(providers.tavily.searches).toHaveLength(18);
    expect(repeatedSearches(providers)).toEqual([]);
    expect(scheduledRuns(database)).toEqual([{ identity_key: "scheduled:initial:2026-11-20", status: "completed" }]);

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
    // queries run once, and November 21 is never made up.
    providers.tavily.remaining = 100;
    const nextRun = await tick(database, providers, "2026-11-22T09:00:00.000Z");
    expect(nextRun.mediaDailyRun?.day).toBe("2026-11-22");
    await tick(database, providers, "2026-11-22T09:15:00.000Z");
    await tick(database, providers, "2026-11-23T05:45:00.000Z");

    expect(scheduledRuns(database)).toEqual([
      { identity_key: "scheduled:initial:2026-11-20", status: "stopped" },
      { identity_key: "scheduled:initial:2026-11-22", status: "completed" },
    ]);
    expect(providers.tavily.searches).toHaveLength(18);
    expect(repeatedSearches(providers)).toEqual([]);
    expect(providers.tavily.usageCalls).toBe(2);
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
