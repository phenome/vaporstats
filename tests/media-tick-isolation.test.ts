import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { advanceMediaProcessing, authorizeMediaProcessing } from "../src/lib/media-processing";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  CYBERPUNK,
  controlledGeminiApi,
  experimentWorld,
  ControlledGeminiTransport,
  controlledOpenRouterApi,
  extractionOutput,
  HADES_II,
  insertCompletedRun,
  insertSources,
  insertSubmittedGeminiExtraction,
  MALFORMED_ARTICLE_BODIES,
  manualProcessingOutcome,
  runMediaTick,
  seedApps,
  throwingResponse,
  type MediaTickOptions,
} from "./support/media";

// The ingestion tick's isolation of media work (incident of 2026-11-18): an
// article no parser can turn into a document, an item whose handling throws,
// and a throw anywhere in the media part of a tick. Every test runs at the
// ingestion-tick seam with controlled providers and outlets.

const cleanups: Array<() => void> = [];
const artifactDirectory = process.env.RECEPTION_ARTIFACT_DIR;
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (artifactDirectory === undefined) delete process.env.RECEPTION_ARTIFACT_DIR;
  else process.env.RECEPTION_ARTIFACT_DIR = artifactDirectory;
});

function providers() {
  return { gemini: controlledGeminiApi(), openRouter: controlledOpenRouterApi() };
}

/** The media games, each with one accepted initial article, under an authorized run. */
async function authorizedGames(games: readonly number[]): Promise<TestDatabase> {
  const database = openTestDatabase("vaporstats-tick-isolation-");
  cleanups.push(database.cleanup);
  seedApps(database.native, games);
  for (const appid of games) insertSources(database.native, appid, "initial", 1);
  const runId = insertCompletedRun(database.native, "initial:tick-isolation:test", games);
  await authorizeMediaProcessing(database.db, runId);
  return database;
}

function extractionJobs(database: TestDatabase) {
  return database.native.query<{ appid: number; status: string; attempt_count: number; next_attempt_at: string | null; error: string | null }, []>(
    "SELECT appid, status, attempt_count, next_attempt_at, error FROM media_processing_jobs WHERE stage = 'extraction' ORDER BY appid",
  ).all();
}

function tick(database: TestDatabase, apis: ReturnType<typeof providers>, at: string, options: MediaTickOptions = {}) {
  return runMediaTick(database, apis, at, options);
}

describe("an article no parser can turn into a document", () => {
  for (const [kind, body] of Object.entries(MALFORMED_ARTICLE_BODIES)) {
    test(`a processing fetch answered with ${kind} refuses its item as article_unusable inside a completed tick`, async () => {
      const database = await authorizedGames([CYBERPUNK]);
      const apis = providers();
      const result = await tick(database, apis, "2026-11-18T20:30:00.000Z", { outlet: () => new Response(body) });
      expect(result.status).toBe("completed");
      expect(extractionJobs(database)).toEqual([{ appid: CYBERPUNK, status: "refused", attempt_count: 0, next_attempt_at: null, error: "article_unusable" }]);
      expect(apis.openRouter.requests).toEqual([]);
    });
  }
});

/** The URL of `appid`'s `suffix` candidate on `domain` in `experimentWorld`. */
function experimentUrl(appid: number, domain: string, suffix = ""): string {
  return `https://${domain}/articles/${appid}-${domain.replaceAll(".", "-")}${suffix}`;
}

/** A database holding the experiment games, which the first daily media run enrolls. */
function experimentGames(): TestDatabase {
  const database = openTestDatabase("vaporstats-tick-isolation-");
  cleanups.push(database.cleanup);
  seedApps(database.native, [BALDURS_GATE, CYBERPUNK, HADES_II]);
  return database;
}

describe("a discovery candidate no parser can turn into a document", () => {
  for (const [kind, body] of Object.entries(MALFORMED_ARTICLE_BODIES)) {
    test(`a candidate answered with ${kind} is not accepted, and the query's other candidates are`, async () => {
      const database = experimentGames();
      const world = experimentWorld();
      const malformed = experimentUrl(HADES_II, "pcgamer.com", "-preview");
      const outlet = (url: string) => url === malformed ? new Response(body) : world.outlet!(url);
      for (const at of ["2026-11-20T06:00:00.000Z", "2026-11-20T06:15:00.000Z"]) {
        expect((await runMediaTick(database, world, at, { outlet })).status).toBe("completed");
      }
      expect(database.native.query("SELECT status FROM media_discovery_runs WHERE origin = 'scheduled'").all()).toEqual([{ status: "completed" }]);
      const accepted = database.native.query<{ original_url: string }, [number, string]>("SELECT original_url FROM media_sources WHERE appid = ? AND outlet = ?").all(HADES_II, "PC Gamer");
      expect(accepted).toEqual([{ original_url: experimentUrl(HADES_II, "pcgamer.com") }]);
    });
  }
});

/** Outlet attempts that never recorded how they ended. */
function unfinishedOutletAttempts(database: TestDatabase) {
  return database.native.query("SELECT id, url FROM media_discovery_attempts WHERE status_code IS NULL AND error IS NULL").all();
}

describe("a paid-work item whose handling throws", () => {
  const CYBERPUNK_ARTICLE = `https://ign.com/articles/${CYBERPUNK}-initial-seeded-0`;
  const FAILURE = "Cannot destructure property 'firstElementChild' from null or undefined value";

  test("is recorded with its reason and backed off, while the tick's other items progress", async () => {
    const database = await authorizedGames([BALDURS_GATE, CYBERPUNK, HADES_II]);
    const apis = providers();
    const fetched: string[] = [];
    const outlet = (url: string) => url === CYBERPUNK_ARTICLE ? throwingResponse(FAILURE) : undefined;
    const result = await tick(database, apis, "2026-11-18T20:30:00.000Z", { outlet, fetched });
    expect(result.status).toBe("completed");
    expect(extractionJobs(database)).toEqual([
      { appid: BALDURS_GATE, status: "succeeded", attempt_count: 0, next_attempt_at: null, error: null },
      { appid: CYBERPUNK, status: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T20:45:00.000Z", error: `item_error:${FAILURE}` },
      { appid: HADES_II, status: "succeeded", attempt_count: 0, next_attempt_at: null, error: null },
    ]);
    // The other games' Overviews are written in the same tick.
    expect(database.native.query("SELECT appid, status FROM media_processing_jobs WHERE stage = 'synthesis' ORDER BY appid").all()).toEqual([
      { appid: BALDURS_GATE, status: "succeeded" },
      { appid: HADES_II, status: "succeeded" },
    ]);
    expect(manualProcessingOutcome(database).stopReasons).toContain("item_error");
    // The outlet attempt the item reserved ended with an outcome.
    expect(unfinishedOutletAttempts(database)).toEqual([]);
    expect(database.native.query("SELECT kind, succeeded, error FROM media_discovery_attempts WHERE url = ?").all(CYBERPUNK_ARTICLE)).toEqual([
      { kind: "failure", succeeded: 0, error: FAILURE },
    ]);
  });

  test("stops as client_error_exhausted after its third occurrence and is not fetched again", async () => {
    const database = await authorizedGames([CYBERPUNK]);
    const apis = providers();
    const fetched: string[] = [];
    const outlet = (url: string) => url === CYBERPUNK_ARTICLE ? throwingResponse(FAILURE) : undefined;
    for (const at of ["20:30", "20:45", "21:15", "22:15", "23:15"]) {
      expect((await tick(database, apis, `2026-11-18T${at}:00.000Z`, { outlet, fetched })).status).toBe("completed");
    }
    expect(fetched.filter((url) => url === CYBERPUNK_ARTICLE)).toHaveLength(3);
    expect(extractionJobs(database)).toEqual([
      { appid: CYBERPUNK, status: "client_error_exhausted", attempt_count: 2, next_attempt_at: null, error: "client_error_exhausted:item_error" },
    ]);
    expect(apis.openRouter.requests).toEqual([]);
    expect(unfinishedOutletAttempts(database)).toEqual([]);
  });
});

describe("a submitted batch whose settlement throws", () => {
  test("returns to the queue as uncertain with its reason, while the other batches settle", async () => {
    const database = openTestDatabase("vaporstats-tick-isolation-");
    cleanups.push(database.cleanup);
    seedApps(database.native, [CYBERPUNK, HADES_II]);
    const runId = insertCompletedRun(database.native, "initial:pre-cutover", [CYBERPUNK, HADES_II]);
    const jobs: Record<number, number> = {};
    for (const appid of [CYBERPUNK, HADES_II]) {
      insertSources(database.native, appid, "initial", 1);
      const sourceId = database.native.query<{ id: number }, []>("SELECT MAX(id) AS id FROM media_sources").get()!.id;
      jobs[appid] = insertSubmittedGeminiExtraction(database.native, { runId, sourceId, batch: `batches/${appid}` });
    }
    const transport = new ControlledGeminiTransport();
    const throwing = { state: "succeeded", usage: { inputTokens: 1_000, outputTokens: 100 } } as const;
    Object.defineProperty(throwing, "output", { enumerable: true, get() { throw new Error("settlement defect"); } });
    transport.polls.set(`batches/${CYBERPUNK}`, throwing as never);
    transport.polls.set(`batches/${HADES_II}`, { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 1_000, outputTokens: 100 } });

    const summary = await advanceMediaProcessing(database.db, { transport, openRouter: transport.openRouter, now: new Date("2026-11-18T20:30:00.000Z"), pollOnly: true });

    expect(summary.completed).toBe(1);
    const job = (id: number) => database.native.query("SELECT status, attempt_count, next_attempt_at, error FROM media_processing_jobs WHERE id = ?").get(id);
    expect(job(jobs[HADES_II]!)).toEqual({ status: "succeeded", attempt_count: 0, next_attempt_at: null, error: null });
    expect(job(jobs[CYBERPUNK]!)).toEqual({ status: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T20:45:00.000Z", error: "uncertain:item_error:settlement defect" });
  });
});

describe("a discovery candidate whose handling throws", () => {
  test("is recorded on its outlet attempt and skipped, while the run's other candidates and queries progress", async () => {
    const database = experimentGames();
    const world = experimentWorld();
    const throwing = experimentUrl(BALDURS_GATE, "gamesradar.com", "-preview");
    const outlet = (url: string) => url === throwing ? throwingResponse("candidate defect") : world.outlet!(url);
    const fetched: string[] = [];
    for (const at of ["2026-11-20T06:00:00.000Z", "2026-11-20T06:15:00.000Z", "2026-11-20T06:30:00.000Z"]) {
      expect((await runMediaTick(database, world, at, { outlet, fetched })).status).toBe("completed");
    }
    expect(fetched.filter((url) => url === throwing)).toHaveLength(1);
    expect(database.native.query("SELECT status FROM media_discovery_runs WHERE origin = 'scheduled'").all()).toEqual([{ status: "completed" }]);
    expect(database.native.query("SELECT kind, status_code, succeeded, error FROM media_discovery_attempts WHERE url = ?").all(throwing)).toEqual([
      { kind: "failure", status_code: null, succeeded: 0, error: "candidate_error:candidate defect" },
    ]);
    expect(unfinishedOutletAttempts(database)).toEqual([]);
    // The query's review is still accepted, and every game keeps its articles.
    expect(database.native.query("SELECT original_url FROM media_sources WHERE appid = ? AND outlet = 'GamesRadar+'").all(BALDURS_GATE)).toEqual([
      { original_url: experimentUrl(BALDURS_GATE, "gamesradar.com") },
    ]);
    expect(database.native.query("SELECT COUNT(*) AS count FROM media_sources").get()).toEqual({ count: 18 });
  });
});

describe("a throw anywhere in the media part of a tick", () => {
  /** Runs `work`, returning what it logged as JSON events. */
  async function logged<T>(work: () => Promise<T>): Promise<{ result: T; events: Array<Record<string, unknown>> }> {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const error = spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const result = await work();
      return { result, events: lines.flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }) };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  /** Every non-media part of a tick reports. */
  function expectNonMediaReported(result: Awaited<ReturnType<typeof runMediaTick>>) {
    expect(result.status).toBe("completed");
    for (const part of ["scoreUpgrade", "prices", "tick", "reviewCollection", "criticCollection", "tagDictionary", "catalogRefresh", "receptionPublication"] as const) {
      expect(result[part]).toBeDefined();
    }
  }

  test("in the paid-work queue is logged as a media error inside a completed tick", async () => {
    const database = await authorizedGames([CYBERPUNK]);
    const { result, events } = await logged(() => tick(database, providers(), "2026-11-18T20:30:00.000Z", {
      paidWorkClock: () => { throw new Error("queue defect"); },
    }));
    expectNonMediaReported(result);
    expect(result.mediaError).toBe("queue defect");
    expect(result.mediaProcessing).toBeUndefined();
    expect(events.filter((event) => event.event === "media_error")).toEqual([{ event: "media_error", anchorTime: "2026-11-18T20:30:00.000Z", error: "queue defect" }]);
    expect(events.filter((event) => event.event === "ingestion_error")).toEqual([]);
    expect(events.find((event) => event.event === "ingestion_completion")).toEqual(expect.objectContaining({ status: "completed", mediaError: "queue defect" }));
  });

  test("in the daily media run is logged as a media error inside a completed tick", async () => {
    const database = experimentGames();
    database.native.exec("CREATE TRIGGER enrollment_defect BEFORE INSERT ON media_enrollments BEGIN SELECT RAISE(ABORT, 'enrollment defect'); END");
    const { result, events } = await logged(() => runMediaTick(database, experimentWorld(), "2026-11-20T06:00:00.000Z"));
    expectNonMediaReported(result);
    expect(result.mediaError).toContain("enrollment defect");
    expect(events.filter((event) => event.event === "media_error")).toHaveLength(1);
  });
});
