import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { getMediaOverview } from "../src/lib/media-overview";
import { MEDIA_OUTLETS } from "../src/lib/media-discovery";
import { openTestDatabase, openUpgradedTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  CYBERPUNK,
  HADES_II,
  controlledGeminiApi,
  controlledOpenRouterApi,
  GEMINI_BILLING_DISABLED,
  GEMINI_KEY_INVALID,
  GEMINI_MODEL_NOT_FOUND,
  GEMINI_PREPAY_DEPLETED,
  GEMINI_RATE_LIMIT,
  GEMINI_SPEND_CAP,
  insertCompletedRun,
  insertSources,
  OPENROUTER_TRUNCATED,
  openRouterKeyLimit,
  overviewOutputForUrls,
  processingArticleHtml,
  runMediaTick,
  seedApps,
  TLS_FAILURE_CODES,
  type GeminiCall,
  type GeminiReply,
  type MediaTickOptions,
} from "./support/media";

const cleanups: Array<() => void> = [];
const artifactDirectory = process.env.RECEPTION_ARTIFACT_DIR;
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (artifactDirectory === undefined) delete process.env.RECEPTION_ARTIFACT_DIR;
  else process.env.RECEPTION_ARTIFACT_DIR = artifactDirectory;
});

/** The controlled paid providers: Gemini for embeddings, OpenRouter for text. */
type Providers = { gemini: ReturnType<typeof controlledGeminiApi>; openRouter: ReturnType<typeof controlledOpenRouterApi> };

function providers(): Providers {
  return { gemini: controlledGeminiApi(), openRouter: controlledOpenRouterApi() };
}

/**
 * A database holding the three media games with `sourcesPerGame` initial
 * articles each, and an authorized initial run covering them.
 */
async function authorizedGames(sourcesPerGame: Partial<Record<number, number>> = { [CYBERPUNK]: 1 }): Promise<{ database: TestDatabase; runId: number }> {
  const database = openTestDatabase("vaporstats-paid-work-");
  cleanups.push(database.cleanup);
  const games = Object.keys(sourcesPerGame).map(Number);
  seedApps(database.native, games);
  for (const appid of games) insertSources(database.native, appid, "initial", sourcesPerGame[appid]!);
  const runId = insertCompletedRun(database.native, "initial:paid-work:test", games);
  await authorizeMediaProcessing(database.db, runId);
  return { database, runId };
}

/** Runs one ingestion tick at `at` with the controlled providers and outlets. */
function tick(database: TestDatabase, apis: Providers, at: string, options: MediaTickOptions = {}) {
  return runMediaTick(database, apis, at, options);
}

function jobs(database: TestDatabase) {
  return database.native.query<{ request_key: string; stage: string; status: string; attempt_count: number; next_attempt_at: string | null; error: string | null }, []>(
    "SELECT request_key, stage, status, attempt_count, next_attempt_at, error FROM media_processing_jobs ORDER BY id",
  ).all();
}

/** Gemini's queue items: embeddings. */
function embeddingJobs(database: TestDatabase) {
  return jobs(database).filter((job) => job.stage === "embedding");
}

/** Every recorded attempt of Gemini's embedding items, in order. */
function geminiAttempts(database: TestDatabase) {
  return database.native.query<{ attempt: number; outcome: string | null; provider_batch_id: string | null }, []>(
    "SELECT a.attempt, a.outcome, a.provider_batch_id FROM media_processing_attempts AS a JOIN media_processing_jobs AS j ON j.id = a.job_id WHERE j.stage = 'embedding' ORDER BY a.id",
  ).all();
}

/** The stage of every batch Gemini accepted, in order. */
function geminiStages(apis: Providers): string[] {
  return apis.gemini.submitted.map((key) => key.split(":")[0]!);
}

describe("retired lifetime allowance", () => {
  test("a database whose charges and reservations already exceed US$5 still submits new paid work, and keeps its old rows unchanged", async () => {
    const { database } = await authorizedGames();
    const history = insertCompletedRun(database.native, "initial:history:test", [CYBERPUNK]);
    database.native.prepare(
      `INSERT INTO media_processing_jobs (run_id, stage, appid, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, enqueued_at, completed_at, retained)
       VALUES (?1, 'synthesis', ?2, 'history-settled', 'history-settled', 'gemini-3.1-flash-lite', 'v1', 100, 10, 3000000, 3000000, 0, 'succeeded', '2026-10-01T00:00:00.000Z', '2026-10-01T00:10:00.000Z', 1),
              (?1, 'synthesis', ?2, 'history-uncertain', 'history-uncertain', 'gemini-3.1-flash-lite', 'v1', 100, 10, 2500000, NULL, 1, 'uncertain', '2026-10-01T00:00:00.000Z', NULL, 1)`,
    ).run(history, CYBERPUNK);
    const historyRows = () => database.native.query("SELECT * FROM media_processing_jobs WHERE request_key LIKE 'history-%' ORDER BY id").all();
    const before = historyRows();
    const apis = providers();

    const result = await tick(database, apis, "2026-11-10T03:00:00.000Z");

    expect(apis.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis"]);
    expect(geminiStages(apis)).toEqual(["embedding"]);
    expect(historyRows()).toEqual(before);
    expect(result.mediaProcessing?.cost.uncertain).toBe(1);
    // The old reservation is not spend; the settled historical charge is.
    expect(result.mediaProcessing?.cost.providers.gemini.allTimeMicrousd).toBeGreaterThanOrEqual(3_000_000);
    expect(result.mediaProcessing?.cost.providers.gemini.allTimeMicrousd).toBeLessThan(5_500_000);
  });
});

describe("retained paid-job rows", () => {
  test("rows from before the paid-work queue are never deleted or submitted, whether or not their input still matches, while the run's work is queued anew", async () => {
    // A reference database learns the Overview input that the game's article produces.
    const reference = await authorizedGames();
    await tick(reference.database, providers(), "2026-11-10T03:00:00.000Z");
    const currentSynthesis = reference.database.native.query<{ request_key: string; input_identity: string }, []>("SELECT request_key, input_identity FROM media_processing_jobs WHERE stage = 'synthesis'").get()!;

    const database = openUpgradedTestDatabase("0022_paid_work_queue", (native) => {
      seedApps(native, [CYBERPUNK]);
      insertSources(native, CYBERPUNK, "initial", 1);
      const runId = insertCompletedRun(native, "initial:paid-work:test", [CYBERPUNK]);
      native.prepare("INSERT INTO media_processing_authorizations (run_id, status, affected_source_ids) VALUES (?, 'waiting', '[]')").run(runId);
      // Reservations the retired allowance wrote and never submitted, for every stage.
      const reserve = native.prepare("INSERT INTO media_processing_jobs (run_id, stage, appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'gemini-3.1-flash-lite', 'v1', 1000, 100, ?, 1, 'reserved', '{}')");
      reserve.run(runId, "extraction", CYBERPUNK, null, 1, "extraction:1:retired-identity", "retired-identity", 1_000);
      reserve.run(runId, "synthesis", CYBERPUNK, null, null, `synthesis:${CYBERPUNK}:retired-identity`, "retired-identity", 2_000);
      reserve.run(runId, "synthesis", CYBERPUNK, null, null, currentSynthesis.request_key, currentSynthesis.input_identity, 3_000);
      reserve.run(runId, "embedding", CYBERPUNK, "gameplay", null, `embedding:${CYBERPUNK}:gameplay:${"a".repeat(64)}:retired-identity`, "retired-identity", 4_000);
      reserve.run(runId, "explanation", CYBERPUNK, "gameplay", null, "explanation:retired", "retired-identity", 5_000);
    });
    cleanups.push(database.cleanup);
    const retained = () => database.native.query<{ request_key: string }, []>("SELECT * FROM media_processing_jobs WHERE id <= 5 ORDER BY id").all();
    const before = retained();
    expect(before).toHaveLength(5);
    const apis = providers();

    const last = await tick(database, apis, "2026-11-10T03:00:00.000Z");
    // Retained rows are not queue work: a later tick has no paid work to advance.
    const idle = await tick(database, apis, "2026-11-10T03:15:00.000Z");
    expect(idle.mediaProcessing).toBeUndefined();

    expect(retained()).toEqual(before);
    const retainedKeys = new Set(before.map((row) => row.request_key));
    expect(apis.gemini.calls.filter((call) => call.kind === "submit" && retainedKeys.has(call.key!))).toEqual([]);
    // The authorized run still does its work, under queue items of its own.
    expect(apis.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis"]);
    expect(geminiStages(apis)).toEqual(["embedding"]);
    expect(database.native.query("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE id > 5 AND status = 'succeeded'").get()).toEqual({ count: 3 });
    expect(last.mediaProcessing).toMatchObject({ queued: { gemini: 0, openrouter: 0 } });
  });
});

describe("retained submitted batches", () => {
  test("a retained batch the provider expired ends stale with its recorded values kept, and is never returned to the queue or submitted", async () => {
    const database = openUpgradedTestDatabase("0022_paid_work_queue", (native) => {
      seedApps(native, [CYBERPUNK]);
      insertSources(native, CYBERPUNK, "initial", 1);
      const runId = insertCompletedRun(native, "initial:paid-work:test", [CYBERPUNK]);
      native.prepare("INSERT INTO media_processing_authorizations (run_id, status, affected_source_ids) VALUES (?, 'completed', '[]')").run(runId);
      native.prepare("INSERT INTO media_processing_jobs (run_id, stage, appid, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider_batch_id, usage_json, submitted_at) VALUES (?, 'extraction', ?, 1, 'extraction:1:retired-identity', 'retired-identity', 'gemini-3.1-flash-lite', 'v1', 1000, 100, 1500, 1, 'submitted', 'batches/retired-1', '{}', '2026-10-01T00:00:00.000Z')").run(runId, CYBERPUNK);
    });
    cleanups.push(database.cleanup);
    const apis = providers();
    apis.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_EXPIRED" } } });

    // While automatic media ingestion is disabled, submitted batches are still
    // polled, and the source the retained row took enters no queue.
    await tick(database, apis, "2026-11-10T07:00:00.000Z", { mediaAutomaticIngestion: false });
    await tick(database, apis, "2026-11-10T07:15:00.000Z", { mediaAutomaticIngestion: false });

    expect(database.native.query("SELECT status, provider_batch_id, reserved_microusd, reservation_active, attempt_count, next_attempt_at FROM media_processing_jobs").all()).toEqual([
      { status: "stale", provider_batch_id: "batches/retired-1", reserved_microusd: 1500, reservation_active: 1, attempt_count: 0, next_attempt_at: null },
    ]);
    expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toEqual([]);
    expect(apis.openRouter.requests).toEqual([]);
  });
});

function sourceTexts(database: TestDatabase): Array<string | null> {
  return database.native.query<{ processing_content: string | null }, []>("SELECT processing_content FROM media_sources ORDER BY id").all().map((row) => row.processing_content);
}

describe("missing provider configuration", () => {
  test("a missing OpenRouter key pauses OpenRouter with reason missing_key, fetches no article, fails nothing, and a configured key resumes the queue", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    const fetched: string[] = [];

    const missing = await tick(database, apis, "2026-11-10T03:00:00.000Z", { openRouterApiKey: "", fetched });

    expect(missing.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "missing_key", pausedAt: "2026-11-10T03:00:00.000Z" });
    expect(missing.mediaProcessing?.providers.gemini.paused).toBe(false);
    expect(missing.mediaProcessing?.status).toBe("waiting");
    expect(missing.mediaProcessing?.stopReasons).toContain("provider_paused:openrouter:missing_key");
    expect(fetched).toEqual([]);
    expect(apis.openRouter.calls).toEqual([]);
    expect(jobs(database).map(({ stage, status, attempt_count, error }) => ({ stage, status, attempt_count, error }))).toEqual([{ stage: "extraction", status: "queued", attempt_count: 0, error: null }]);

    const configured = await tick(database, apis, "2026-11-10T03:15:00.000Z", { fetched });

    expect(configured.mediaProcessing?.providers.openrouter.paused).toBe(false);
    expect(apis.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis"]);
  });

  test("a missing Gemini key pauses Gemini with reason missing_key while text generation continues, and a configured key resumes its embeddings", async () => {
    const { database } = await authorizedGames();
    const apis = providers();

    const missing = await tick(database, apis, "2026-11-10T03:00:00.000Z", { geminiApiKey: "" });

    expect(missing.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "missing_key", pausedAt: "2026-11-10T03:00:00.000Z" });
    expect(missing.mediaProcessing?.providers.openrouter.paused).toBe(false);
    expect(apis.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis"]);
    expect(apis.gemini.calls).toEqual([]);
    expect(embeddingJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual([{ status: "queued", attempt_count: 0, error: null }]);

    const configured = await tick(database, apis, "2026-11-10T03:15:00.000Z");

    expect(configured.mediaProcessing?.providers.gemini.paused).toBe(false);
    expect(geminiStages(apis)).toEqual(["embedding"]);
  });
});

describe("project-level provider errors", () => {
  const projectErrors: Array<[string, GeminiReply, string]> = [
    ["an invalid API key", GEMINI_KEY_INVALID, "rejected_key"],
    ["billing that is not enabled", GEMINI_BILLING_DISABLED, "failed_precondition"],
    ["a retired or unknown model", GEMINI_MODEL_NOT_FOUND, "model_unavailable"],
  ];
  const calls: GeminiCall[] = ["count", "submit"];

  for (const [name, reply, reason] of projectErrors) {
    for (const kind of calls) {
      test(`${name} at the ${kind} call pauses Gemini with reason ${reason}, refuses and fails nothing, and the daily check resumes the queue`, async () => {
        const { database } = await authorizedGames({ [CYBERPUNK]: 2, [BALDURS_GATE]: 1 });
        const apis = providers();
        apis.gemini.reply(kind, reply);

        const paused = await tick(database, apis, "2026-11-10T07:00:00.000Z");

        expect(paused.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason, pausedAt: "2026-11-10T07:00:00.000Z" });
        expect(embeddingJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual(Array(2).fill({ status: "queued", attempt_count: 0, error: null }));
        expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
        expect(paused.mediaProcessing?.status).toBe("waiting");
        expect(paused.mediaProcessing?.stopReasons).toContain(`provider_paused:gemini:${reason}`);
        expect(paused.mediaProcessing?.stopReasons).not.toContain("provider_refusal");

        const callsWhilePaused = apis.gemini.calls.length;
        const later = await tick(database, apis, "2026-11-10T07:15:00.000Z");
        expect(later.mediaProcessing?.providers.gemini.paused).toBe(true);
        expect(apis.gemini.calls).toHaveLength(callsWhilePaused);

        const resumed = await tick(database, apis, "2026-11-11T06:00:00.000Z");
        expect(resumed.mediaProcessing?.providers.gemini.paused).toBe(false);
        expect(embeddingJobs(database).every((job) => job.status === "succeeded")).toBe(true);
      });
    }
  }

  // #80 (2026-11-18): an unrecognized 4xx is a configuration problem on the project side.
  for (const status of [405, 409, 410, 413, 422]) {
    test(`an unrecognized ${status} pauses Gemini with reason unrecognized_client_error, refuses nothing, keeps the queue intact with only the triggering item backed off, and lifts at the daily check`, async () => {
      const { database } = await authorizedGames({ [CYBERPUNK]: 1, [BALDURS_GATE]: 1 });
      const apis = providers();
      apis.gemini.reply("submit", { status, body: { error: { code: status, message: "Unrecognized" } } });

      const paused = await tick(database, apis, "2026-11-10T07:00:00.000Z");

      expect(paused.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "unrecognized_client_error", pausedAt: "2026-11-10T07:00:00.000Z" });
      expect(paused.mediaProcessing?.providers.openrouter.paused).toBe(false);
      expect(embeddingJobs(database).map(({ status: state, attempt_count, error }) => ({ state, attempt_count, error }))).toEqual([
        { state: "queued", attempt_count: 1, error: "client_error:unrecognized_client_error" },
        { state: "queued", attempt_count: 0, error: null },
      ]);
      expect(jobs(database).some((job) => job.status === "refused")).toBe(false);
      expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
      expect(paused.mediaProcessing?.stopReasons).toContain("provider_paused:gemini:unrecognized_client_error");

      const submits = apis.gemini.calls.filter((call) => call.kind === "submit").length;
      expect((await tick(database, apis, "2026-11-11T05:45:00.000Z")).mediaProcessing?.providers.gemini.paused).toBe(true);
      expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(submits);

      const resumed = await tick(database, apis, "2026-11-11T06:00:00.000Z");
      expect(resumed.mediaProcessing?.providers.gemini.paused).toBe(false);
      expect(embeddingJobs(database).map(({ status: state }) => state)).toEqual(["succeeded", "succeeded"]);
    });

    test(`an unrecognized ${status} pauses OpenRouter with reason unrecognized_client_error, refuses nothing, keeps the queue intact with only the triggering item backed off, and lifts at the daily check`, async () => {
      const { database } = await authorizedGames({ [CYBERPUNK]: 1, [BALDURS_GATE]: 1 });
      const apis = providers();
      apis.openRouter.reply("chat", { status, body: { error: { code: status, message: "Unrecognized" } } });

      const paused = await tick(database, apis, "2026-11-10T07:00:00.000Z");

      expect(paused.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "unrecognized_client_error", pausedAt: "2026-11-10T07:00:00.000Z" });
      expect(jobs(database).map(({ stage, status: state, attempt_count, error }) => ({ stage, state, attempt_count, error }))).toEqual([
        { stage: "extraction", state: "queued", attempt_count: 1, error: "client_error:unrecognized_client_error" },
        { stage: "extraction", state: "queued", attempt_count: 0, error: null },
      ]);
      expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
      expect(paused.mediaProcessing?.stopReasons).toContain("provider_paused:openrouter:unrecognized_client_error");

      expect((await tick(database, apis, "2026-11-11T05:45:00.000Z")).mediaProcessing?.providers.openrouter.paused).toBe(true);
      expect(apis.openRouter.requests).toHaveLength(1);

      const resumed = await tick(database, apis, "2026-11-11T06:00:00.000Z");
      expect(resumed.mediaProcessing?.providers.openrouter.paused).toBe(false);
      expect(jobs(database).filter((job) => job.stage !== "embedding").map(({ status: state }) => state)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    });
  }

  test("an invalid API key at a poll pauses Gemini and keeps the batch submitted, not uncertain", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    apis.gemini.reply("poll", GEMINI_KEY_INVALID);

    const paused = await tick(database, apis, "2026-11-10T07:00:00.000Z");

    expect(paused.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "rejected_key" });
    expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["submitted"]);
    expect(paused.mediaProcessing?.cost.uncertain).toBe(0);

    // Polls are free and continue while paused; the batch settles.
    await tick(database, apis, "2026-11-10T07:15:00.000Z");
    expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["succeeded"]);
  });

  test("a poll for a batch the provider no longer knows makes its item uncertain: it pauses nothing, returns to the queue with backoff, and is submitted again", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    apis.gemini.reply("poll", { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } } });

    const polled = await tick(database, apis, "2026-11-10T07:00:00.000Z");

    expect(polled.mediaProcessing?.providers.gemini.paused).toBe(false);
    expect(embeddingJobs(database).map(({ status, attempt_count, next_attempt_at, error }) => ({ status, attempt_count, next_attempt_at, error }))).toEqual([
      { status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T07:15:00.000Z", error: "uncertain:http_404" },
    ]);
    expect(polled.mediaProcessing?.cost.uncertain).toBe(1);

    await tick(database, apis, "2026-11-10T07:15:00.000Z");
    expect(geminiStages(apis)).toEqual(["embedding", "embedding"]);
    expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["succeeded"]);
    expect(geminiAttempts(database)).toEqual([
      { attempt: 1, outcome: "uncertain", provider_batch_id: "batches/controlled-1" },
      { attempt: 2, outcome: "succeeded", provider_batch_id: "batches/controlled-2" },
    ]);
  });

  test("a batch Gemini accepted and then reported as BATCH_STATE_FAILED with a generic error is uncertain, not a refusal: its usage is recorded and it is submitted again", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    apis.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_FAILED" }, error: { message: "Internal error encountered." }, usageMetadata: { promptTokenCount: 500 } } });

    const failed = await tick(database, apis, "2026-11-10T07:00:00.000Z");

    expect(embeddingJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "queued", error: "uncertain:batch_failed" }]);
    expect(failed.mediaProcessing?.outputs.skipped).toBe(0);
    expect(failed.mediaProcessing?.stopReasons).not.toContain("provider_refusal");

    const resent = await tick(database, apis, "2026-11-10T07:15:00.000Z");
    expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["succeeded"]);
    // 500 tokens for the failed batch and 1,000 for the one that succeeded, at US$0.10 per million.
    expect(database.native.query("SELECT a.attempt, a.outcome, a.charged_microusd FROM media_processing_attempts AS a JOIN media_processing_jobs AS j ON j.id = a.job_id WHERE j.stage = 'embedding' ORDER BY a.attempt").all()).toEqual([
      { attempt: 1, outcome: "uncertain", charged_microusd: 50 },
      { attempt: 2, outcome: "succeeded", charged_microusd: 100 },
    ]);
    expect(resent.mediaProcessing?.cost.providers.gemini.allTimeMicrousd).toBe(150);
  });

  for (const state of ["BATCH_STATE_EXPIRED", "BATCH_STATE_CANCELLED"]) {
    test(`a batch the provider reports as ${state} returns its item to the queue, refuses nothing, and is submitted again`, async () => {
      const { database } = await authorizedGames();
      const apis = providers();
      apis.gemini.reply("poll", { status: 200, body: { metadata: { state } } });

      const returned = await tick(database, apis, "2026-11-10T07:00:00.000Z");

      expect(embeddingJobs(database).map(({ status, attempt_count, next_attempt_at }) => ({ status, attempt_count, next_attempt_at }))).toEqual([
        { status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T07:15:00.000Z" },
      ]);
      expect(returned.mediaProcessing?.outputs.skipped).toBe(0);
      expect(returned.mediaProcessing?.providers.gemini.paused).toBe(false);

      await tick(database, apis, "2026-11-10T07:15:00.000Z");
      expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(2);
      expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["succeeded"]);
    });
  }
});

describe("Gemini Credit pause", () => {
  test("depleted Prepay credits pause Gemini with its reason and time, keep every Gemini item queued without an attempt, and leave OpenRouter running", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 2, [BALDURS_GATE]: 1 });
    const apis = providers();
    apis.gemini.reply("submit", GEMINI_PREPAY_DEPLETED);

    const paused = await tick(database, apis, "2026-11-10T07:00:00.000Z");

    expect(paused.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "prepay_depleted", pausedAt: "2026-11-10T07:00:00.000Z" });
    expect(paused.mediaProcessing?.providers.openrouter.paused).toBe(false);
    expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(embeddingJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual(Array(2).fill({ status: "queued", attempt_count: 0, error: null }));
    expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
    expect(paused.mediaProcessing?.stopReasons).toContain("provider_paused:gemini:prepay_depleted");
    expect(sourceTexts(database)).toEqual([null, null, null]);

    // A pause lasts until the next daily credit check, not the next tick.
    for (const at of ["2026-11-10T07:15:00.000Z", "2026-11-10T23:45:00.000Z", "2026-11-11T05:45:00.000Z"]) {
      const later = await tick(database, apis, at);
      expect(later.mediaProcessing?.providers.gemini.paused).toBe(true);
    }
    expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(embeddingJobs(database).every(({ status, attempt_count }) => status === "queued" && attempt_count === 0)).toBe(true);
  });

  test("a 429 that reports an exceeded spending cap pauses Gemini, while a 429 rate limit is transient", async () => {
    const capped = await authorizedGames();
    const capApis = providers();
    capApis.gemini.reply("submit", GEMINI_SPEND_CAP);
    const cap = await tick(capped.database, capApis, "2026-11-10T07:00:00.000Z");
    expect(cap.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "spend_cap" });
    expect(embeddingJobs(capped.database).map(({ status, attempt_count }) => ({ status, attempt_count }))).toEqual([{ status: "queued", attempt_count: 0 }]);

    const limited = await authorizedGames();
    const limitApis = providers();
    limitApis.gemini.reply("submit", GEMINI_RATE_LIMIT);
    const limit = await tick(limited.database, limitApis, "2026-11-10T07:00:00.000Z");
    expect(limit.mediaProcessing?.providers.gemini.paused).toBe(false);
    expect(embeddingJobs(limited.database).map(({ status, attempt_count, next_attempt_at }) => ({ status, attempt_count, next_attempt_at }))).toEqual([{ status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T07:15:00.000Z" }]);
  });

  // Since 2026-11-18 a restart rechecks paused providers under the daily
  // check's rules: Gemini, which has no credit endpoint, is probed. Prepay
  // still depleted pauses it again after one probe, and every item waits.
  test("a restart with the database reopened while paused probes Gemini once, which pauses it again while Prepay is still depleted, and keeps every queued item", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 1, [BALDURS_GATE]: 1 });
    const apis = providers();
    apis.gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    await tick(database, apis, "2026-11-10T07:00:00.000Z");
    const before = jobs(database);

    database.reopen();
    apis.gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    const restarted = await tick(database, apis, "2026-11-10T07:15:00.000Z");

    expect(restarted.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "prepay_depleted", pausedAt: "2026-11-10T07:15:00.000Z", checkOutcome: "probe" });
    expect(jobs(database)).toEqual(before);
    expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(2);
  });
});

describe("daily credit check", () => {
  test("runs in the first tick at or after 06:00 UTC, once per UTC day, probing Gemini with the oldest ready embedding item", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    // The game's Overview settles; its embedding is refused for credit, which pauses Gemini.
    apis.gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    const paused = await tick(database, apis, "2026-11-10T03:00:00.000Z");
    expect(paused.mediaProcessing?.providers.gemini.reason).toBe("prepay_depleted");
    // New work for another game: its text runs on OpenRouter, and its embedding waits behind the pause.
    seedApps(database.native, [BALDURS_GATE]);
    insertSources(database.native, BALDURS_GATE, "initial", 2);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:paid-work:later", [BALDURS_GATE]));
    await tick(database, apis, "2026-11-10T04:00:00.000Z");
    const appidOf = (key: string) => Number(key.split(":")[1]);
    const submissions = () => apis.gemini.calls.filter((call) => call.kind === "submit").map((call) => appidOf(call.key!));
    expect(submissions()).toEqual([CYBERPUNK]);
    expect(apis.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis", "extraction", "extraction", "synthesis"]);

    // Before 06:00 nothing is checked. The first tick after 06:00 (here after
    // downtime) lifts the pause and probes with the oldest embedding first;
    // its Credit pause answer pauses Gemini again until the next day.
    await tick(database, apis, "2026-11-11T05:45:00.000Z");
    expect(submissions()).toHaveLength(1);
    apis.gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    const probed = await tick(database, apis, "2026-11-11T09:30:00.000Z");
    expect(submissions()).toEqual([CYBERPUNK, CYBERPUNK]);
    expect(probed.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "prepay_depleted", pausedAt: "2026-11-11T09:30:00.000Z", checkedAt: "2026-11-11T09:30:00.000Z", checkOutcome: "probe" });

    // It never runs twice on one UTC day.
    await tick(database, apis, "2026-11-11T23:45:00.000Z");
    expect(submissions()).toHaveLength(2);
    // A missed day is not made up: no tick ran on 2026-11-12, and the 13th
    // checks only from 06:00.
    await tick(database, apis, "2026-11-13T05:45:00.000Z");
    expect(submissions()).toHaveLength(2);

    const resumed = await tick(database, apis, "2026-11-13T06:00:00.000Z");
    expect(resumed.mediaProcessing?.providers.gemini).toMatchObject({ paused: false, reason: null, checkedAt: "2026-11-13T06:00:00.000Z" });
    // After the probe succeeds, the waiting embedding work runs.
    expect(submissions().slice(2)).toEqual([CYBERPUNK, BALDURS_GATE]);
  });
});

describe("daily credit check without paid work", () => {
  test("runs in the first tick at or after 06:00 UTC even when no paid work waits, so a later day's new work is not held by an old pause", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    // The only batch's first poll rejects the key, pausing Gemini; its next
    // poll settles it as invalid output, which leaves no paid work at all.
    apis.gemini.reply("poll", GEMINI_KEY_INVALID, { status: 200, body: { metadata: { state: "BATCH_STATE_SUCCEEDED" }, response: { inlinedResponses: { inlinedResponses: [{ response: { embedding: { values: [] } } }] } } } });
    await tick(database, apis, "2026-11-10T07:00:00.000Z");
    const settled = await tick(database, apis, "2026-11-10T07:15:00.000Z");
    expect(settled.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "rejected_key" });
    const idle = await tick(database, apis, "2026-11-10T07:30:00.000Z");
    expect(idle.mediaProcessing).toMatchObject({ submitted: 0, queued: { gemini: 0, openrouter: 0 } });

    // The next day's first tick after 06:00 has no paid work, and still checks.
    await tick(database, apis, "2026-11-11T06:30:00.000Z");

    // New work authorized the day after, before that day's check, is not
    // held by the pause the earlier check already lifted.
    seedApps(database.native, [BALDURS_GATE]);
    insertSources(database.native, BALDURS_GATE, "initial", 1);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:paid-work:later", [BALDURS_GATE]));
    const resumed = await tick(database, apis, "2026-11-12T05:00:00.000Z");

    expect(resumed.mediaProcessing?.providers.gemini).toMatchObject({ paused: false, reason: null, checkedAt: "2026-11-11T06:30:00.000Z" });
    expect(apis.gemini.submitted.filter((key) => key.startsWith(`embedding:${BALDURS_GATE}:`))).toHaveLength(1);
  });
});

describe("transient failures", () => {
  test("keep the item queued, retry at the next tick, then back off doubling and honoring Retry-After, and never fail it", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    apis.gemini.reply("submit", { status: 503, body: { error: { message: "unavailable" } } }, { status: 503 }, { status: 429, body: { error: { message: "rate limited" } }, headers: { "Retry-After": "7200" } });
    const embedding = () => embeddingJobs(database)[0]!;
    const submits = () => apis.gemini.calls.filter((call) => call.kind === "submit").length;

    await tick(database, apis, "2026-11-10T03:00:00.000Z");
    expect(embedding()).toMatchObject({ status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T03:15:00.000Z" });
    await tick(database, apis, "2026-11-10T03:15:00.000Z");
    expect(embedding()).toMatchObject({ status: "queued", attempt_count: 2, next_attempt_at: "2026-11-10T03:45:00.000Z" });
    await tick(database, apis, "2026-11-10T03:30:00.000Z");
    expect(submits()).toBe(2);
    await tick(database, apis, "2026-11-10T03:45:00.000Z");
    // Doubling would retry after an hour; the provider asked for two.
    expect(embedding()).toMatchObject({ status: "queued", attempt_count: 3, next_attempt_at: "2026-11-10T05:45:00.000Z" });
    await tick(database, apis, "2026-11-10T05:30:00.000Z");
    expect(submits()).toBe(3);

    const recovered = await tick(database, apis, "2026-11-10T05:45:00.000Z");
    expect(embedding().status).toBe("succeeded");
    expect(recovered.mediaProcessing?.outputs.skipped).toBe(0);
    expect(jobs(database).some((job) => job.status === "failed" || job.status === "refused")).toBe(false);
  });

  test("backoff is capped at 24 hours", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    apis.gemini.reply("submit", { status: 500 });
    await tick(database, apis, "2026-11-10T03:00:00.000Z");
    database.native.prepare("UPDATE media_processing_jobs SET attempt_count = 20, next_attempt_at = NULL WHERE stage = 'embedding'").run();
    apis.gemini.reply("submit", { status: 500 });
    await tick(database, apis, "2026-11-10T03:15:00.000Z");
    expect(embeddingJobs(database)[0]).toMatchObject({ status: "queued", attempt_count: 21, next_attempt_at: "2026-11-11T03:15:00.000Z" });
  });
});

describe("an unrecognized client error tied to one item", () => {
  type Where = "gemini count" | "gemini submit" | "openrouter chat";
  const BAD = BALDURS_GATE;
  const GOOD = CYBERPUNK;
  const MARKER = "Unrecognized marker input";

  /** Providers that answer `status` to every request of `where` for Baldur's Gate 3, and normally to everything else. */
  function badItemProviders(where: Where, status: number) {
    const apis = providers();
    const gemini = apis.gemini;
    let triggered = 0;
    const unrecognized = () => { triggered += 1; return { status, body: { error: { code: status, message: "Unrecognized" } } }; };
    apis.openRouter.onChat = (record) => {
      if (where === "openrouter chat" && record.stage === "extraction" && JSON.stringify(record.body.messages).includes(`Steam app ${BAD}`)) apis.openRouter.reply("chat", unrecognized());
      // Baldur's Gate 3's Overview gets its own similarity input, so its embedding's token count can be told apart.
      if (record.stage === "synthesis" && record.urls.some((url) => url.includes(`/${BAD}-`))) apis.openRouter.output("synthesis", { ...overviewOutputForUrls(record.urls), similarityInputs: { gameplay: [MARKER] } });
    };
    const wrapped = {
      ...gemini,
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = String(init?.body ?? "");
        const hit = (where === "gemini count" && url.endsWith(":countTokens") && body.includes(MARKER))
          || (where === "gemini submit" && url.endsWith(":asyncBatchEmbedContent") && body.includes(`embedding:${BAD}:`));
        if (hit) return Response.json(unrecognized().body, { status });
        return gemini.fetchFn(input, init);
      },
    };
    return { apis: { gemini: wrapped, openRouter: apis.openRouter }, triggered: () => triggered };
  }

  const stageOf = (where: Where) => (where === "openrouter chat" ? "extraction" : "embedding");
  const providerOf = (where: Where) => (where === "openrouter chat" ? "openrouter" : "gemini");
  const item = (database: TestDatabase, where: Where, appid: number) => database.native.query<{ status: string; attempt_count: number; next_attempt_at: string | null }, [string, number]>(
    "SELECT status, attempt_count, next_attempt_at FROM media_processing_jobs WHERE stage = ? AND appid = ? ORDER BY id LIMIT 1",
  ).get(stageOf(where), appid);

  for (const where of ["gemini count", "gemini submit", "openrouter chat"] as const) {
    for (const status of [405, 409, 410, 413, 422]) {
      test(`a ${status} at the ${where} of one item backs that item off, lets other games' items progress the day the pause lifts, and after three pauses stops it as client_error_exhausted`, async () => {
        const { database } = await authorizedGames({ [BAD]: 1, [GOOD]: 1 });
        const { apis, triggered } = badItemProviders(where, status);
        const provider = providerOf(where);

        const first = await tick(database, apis, "2026-11-10T07:00:00.000Z");
        expect(first.mediaProcessing?.providers[provider]).toMatchObject({ paused: true, reason: "unrecognized_client_error" });
        expect(item(database, where, BAD)).toEqual({ status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T07:15:00.000Z" });
        expect(triggered()).toBe(1);

        // The pause lifts at the daily check; the other game's item goes first and settles that day.
        await tick(database, apis, "2026-11-11T06:00:00.000Z");
        expect(item(database, where, GOOD)?.status).toBe("succeeded");
        expect(triggered()).toBe(2);
        expect(item(database, where, BAD)).toMatchObject({ status: "queued", attempt_count: 2 });

        await tick(database, apis, "2026-11-12T06:00:00.000Z");
        expect(triggered()).toBe(3);
        expect(item(database, where, BAD)?.status).toBe("client_error_exhausted");
        expect(jobs(database).some((job) => job.status === "refused")).toBe(false);

        // It no longer triggers pauses; the other game finishes its work.
        const after = await tick(database, apis, "2026-11-13T06:00:00.000Z");
        await tick(database, apis, "2026-11-13T06:15:00.000Z");
        expect(triggered()).toBe(3);
        expect(after.mediaProcessing?.providers[provider].paused).toBe(false);
        expect(database.native.query(`SELECT stage, status FROM media_processing_jobs WHERE appid = ${GOOD} ORDER BY id`).all()).toEqual([
          { stage: "extraction", status: "succeeded" },
          { stage: "synthesis", status: "succeeded" },
          { stage: "embedding", status: "succeeded" },
        ]);
      });
    }
  }
});

// The first live run (2026-11-18): an answer cut off at the output cap is a
// configuration problem on the project side. Like an unrecognized client
// error it pauses OpenRouter, backs the item off, keeps its cost, and never
// refuses it; the two share one per-item count, and the third of either ends
// the item `client_error_exhausted`.
describe("an answer cut off at the output cap", () => {
  const BAD = BALDURS_GATE;
  const GOOD = CYBERPUNK;
  const UNRECOGNIZED = { status: 422, body: { error: { code: 422, message: "Unrecognized" } } };

  /** Providers that answer Baldur's Gate 3's extraction with each of `answers` in turn, and everything else normally. */
  function cutOffProviders(...answers: Array<typeof OPENROUTER_TRUNCATED | typeof UNRECOGNIZED>) {
    const apis = providers();
    let sent = 0;
    apis.openRouter.onChat = (record) => {
      if (record.stage !== "extraction" || !JSON.stringify(record.body.messages).includes(`Steam app ${BAD}`)) return;
      sent += 1;
      const answer = answers.shift();
      if (answer) apis.openRouter.reply("chat", answer);
    };
    return { apis, sent: () => sent };
  }

  const item = (database: TestDatabase, appid: number) => database.native.query<{ status: string; attempt_count: number; next_attempt_at: string | null; error: string | null; charged_microusd: number | null; usage_json: string }, [number]>(
    "SELECT status, attempt_count, next_attempt_at, error, charged_microusd, usage_json FROM media_processing_jobs WHERE stage = 'extraction' AND appid = ? ORDER BY id LIMIT 1",
  ).get(appid);

  test("pauses OpenRouter with output_truncated, backs only that item off with its cost and reasoning usage recorded, refuses nothing, and the item settles after the daily check", async () => {
    const { database } = await authorizedGames({ [BAD]: 1, [GOOD]: 1 });
    const { apis, sent } = cutOffProviders(OPENROUTER_TRUNCATED);

    const paused = await tick(database, apis, "2026-11-10T07:00:00.000Z");

    expect(paused.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "output_truncated", pausedAt: "2026-11-10T07:00:00.000Z" });
    expect(paused.mediaProcessing?.stopReasons).toContain("provider_paused:openrouter:output_truncated");
    expect(item(database, BAD)).toEqual({
      status: "queued",
      attempt_count: 1,
      next_attempt_at: "2026-11-10T07:15:00.000Z",
      error: "client_error:output_truncated",
      charged_microusd: 900,
      usage_json: JSON.stringify({ promptTokens: 3_081, completionTokens: 1_200, reasoningTokens: 1_078 }),
    });
    expect(jobs(database).some((job) => job.status === "refused")).toBe(false);
    expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
    expect(database.native.query("SELECT outcome, error, charged_microusd, generation_id FROM media_processing_attempts ORDER BY id").all()).toEqual([
      { outcome: "missing_configuration", error: "output_truncated", charged_microusd: 900, generation_id: "gen-truncated" },
    ]);

    // Paused until the daily check, which lifts it; the item is then sent once more and settles.
    await tick(database, apis, "2026-11-11T05:45:00.000Z");
    expect(sent()).toBe(1);
    await tick(database, apis, "2026-11-11T06:00:00.000Z");
    await tick(database, apis, "2026-11-11T06:15:00.000Z");
    expect(sent()).toBe(2);
    expect(item(database, BAD)).toMatchObject({ status: "succeeded", charged_microusd: 1_050 });
  });

  test("the third cut-off answer for one input identity ends the item client_error_exhausted, never refused, and it is sent no more", async () => {
    const { database } = await authorizedGames({ [BAD]: 1, [GOOD]: 1 });
    const { apis, sent } = cutOffProviders(OPENROUTER_TRUNCATED, OPENROUTER_TRUNCATED, OPENROUTER_TRUNCATED);

    await tick(database, apis, "2026-11-10T07:00:00.000Z");
    await tick(database, apis, "2026-11-11T06:00:00.000Z");
    expect(item(database, BAD)).toMatchObject({ status: "queued", attempt_count: 2 });
    await tick(database, apis, "2026-11-12T06:00:00.000Z");

    expect(sent()).toBe(3);
    expect(item(database, BAD)).toMatchObject({ status: "client_error_exhausted", error: "client_error_exhausted:output_truncated", charged_microusd: 2_700 });
    expect(jobs(database).some((job) => job.status === "refused")).toBe(false);
    await tick(database, apis, "2026-11-13T06:00:00.000Z");
    await tick(database, apis, "2026-11-13T06:15:00.000Z");
    expect(sent()).toBe(3);
    expect(item(database, GOOD)?.status).toBe("succeeded");
  });

  test("cut-off answers and unrecognized client errors share one count: three of either, mixed, end the item client_error_exhausted", async () => {
    const { database } = await authorizedGames({ [BAD]: 1, [GOOD]: 1 });
    const { apis, sent } = cutOffProviders(UNRECOGNIZED, OPENROUTER_TRUNCATED, UNRECOGNIZED);

    await tick(database, apis, "2026-11-10T07:00:00.000Z");
    expect(item(database, BAD)).toMatchObject({ status: "queued", error: "client_error:unrecognized_client_error" });
    await tick(database, apis, "2026-11-11T06:00:00.000Z");
    expect(item(database, BAD)).toMatchObject({ status: "queued", error: "client_error:output_truncated" });
    await tick(database, apis, "2026-11-12T06:00:00.000Z");

    expect(sent()).toBe(3);
    expect(item(database, BAD)).toMatchObject({ status: "client_error_exhausted", error: "client_error_exhausted:unrecognized_client_error" });
  });
});

// Decided 2026-11-18, after a deployed fix for a cut-off Overview still waited
// for the next daily check: on the first tick after the application starts,
// every paused provider gets the check the daily credit check runs. A pause
// whose cause is gone lifts; otherwise it stays. It runs no daily media run,
// leaves the daily checkpoint as it is, and leaves each item's client-error
// count unchanged. A restart is modeled by reopening the database.
describe("recheck of paused providers when the application starts", () => {
  const DAILY_CHECKPOINT = "SELECT value FROM checkpoints WHERE key = 'media:daily-credit-check'";
  const keyChecks = (apis: Providers) => apis.openRouter.calls.filter((call) => call.kind === "key").length;
  const extraction = (database: TestDatabase, appid: number) => database.native.query<{ status: string; error: string | null; client_error_pauses: number }, [number]>(
    "SELECT status, error, client_error_pauses FROM media_processing_jobs WHERE stage = 'extraction' AND appid = ? ORDER BY id LIMIT 1",
  ).get(appid);

  test("an output_truncated pause stays through later ticks of the same process, and lifts on the first tick after a restart when the key check finds credit, without a daily run or a daily checkpoint change, keeping the item's one strike", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 1 });
    const apis = providers();
    apis.openRouter.reply("chat", OPENROUTER_TRUNCATED);

    await tick(database, apis, "2026-11-10T19:45:00.000Z");
    expect((await tick(database, apis, "2026-11-10T20:00:00.000Z")).mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "output_truncated" });
    const checkpoint = database.native.query(DAILY_CHECKPOINT).get();
    const checksBefore = keyChecks(apis);
    expect(apis.openRouter.requests).toHaveLength(1);

    database.reopen();
    const restarted = await tick(database, apis, "2026-11-10T20:15:00.000Z");

    expect(keyChecks(apis)).toBe(checksBefore + 1);
    expect(restarted.mediaDailyRun).toBeUndefined();
    expect(database.native.query(DAILY_CHECKPOINT).get()).toEqual(checkpoint);
    expect(restarted.mediaProcessing?.providers.openrouter).toMatchObject({ paused: false, reason: null, checkedAt: "2026-11-10T20:15:00.000Z", checkOutcome: "credit_remaining" });
    // The item, past its backoff, is sent again in the same tick and settles; its strike stays.
    expect(apis.openRouter.requests.filter((request) => request.stage === "extraction")).toHaveLength(2);
    expect(extraction(database, CYBERPUNK)).toEqual({ status: "succeeded", error: null, client_error_pauses: 1 });

    // Later ticks of the restarted process check nothing more.
    await tick(database, apis, "2026-11-10T20:30:00.000Z");
    expect(keyChecks(apis)).toBe(checksBefore + 1);
  });

  test("a Credit pause whose key still has no credit stays paused after a restart, and nothing is sent", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 1 });
    const apis = providers();
    apis.openRouter.reply("chat", openRouterKeyLimit(402));
    await tick(database, apis, "2026-11-10T19:45:00.000Z");
    const checkpoint = database.native.query(DAILY_CHECKPOINT).get();

    database.reopen();
    apis.openRouter.reply("key", { status: 200, body: { data: { label: "test", limit: 5, limit_remaining: 0, budgets: [], effective_budget: null, usage: 5 } } });
    const restarted = await tick(database, apis, "2026-11-10T20:15:00.000Z");

    expect(restarted.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "key_limit", pausedAt: "2026-11-10T19:45:00.000Z", checkOutcome: "key_limit" });
    expect(apis.openRouter.requests).toHaveLength(1);
    expect(restarted.mediaDailyRun).toBeUndefined();
    expect(database.native.query(DAILY_CHECKPOINT).get()).toEqual(checkpoint);
    expect(extraction(database, CYBERPUNK)?.status).toBe("queued");
  });

  test("an unrecognized_client_error pause of OpenRouter lifts after a restart when the key check finds credit, and the item keeps its strike", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 1 });
    const apis = providers();
    apis.openRouter.reply("chat", { status: 422, body: { error: { code: 422, message: "Unrecognized" } } });
    await tick(database, apis, "2026-11-10T19:45:00.000Z");
    expect(extraction(database, CYBERPUNK)).toMatchObject({ status: "queued", client_error_pauses: 1 });

    database.reopen();
    const restarted = await tick(database, apis, "2026-11-10T20:15:00.000Z");

    expect(restarted.mediaProcessing?.providers.openrouter).toMatchObject({ paused: false, checkOutcome: "credit_remaining" });
    expect(extraction(database, CYBERPUNK)).toEqual({ status: "succeeded", error: null, client_error_pauses: 1 });
  });

  test("an unrecognized_client_error pause of Gemini lifts after a restart under the daily probe rule, and the next submission probes", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 1 });
    const apis = providers();
    apis.gemini.reply("submit", { status: 422, body: { error: { code: 422, message: "Unrecognized" } } });
    await tick(database, apis, "2026-11-10T19:45:00.000Z");
    expect((await tick(database, apis, "2026-11-10T20:00:00.000Z")).mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "unrecognized_client_error" });
    const checkpoint = database.native.query(DAILY_CHECKPOINT).get();

    database.reopen();
    const restarted = await tick(database, apis, "2026-11-10T20:15:00.000Z");

    expect(restarted.mediaProcessing?.providers.gemini).toMatchObject({ paused: false, checkedAt: "2026-11-10T20:15:00.000Z", checkOutcome: "probe" });
    expect(database.native.query(DAILY_CHECKPOINT).get()).toEqual(checkpoint);
    // The item that triggered the pause is past its backoff, so it is the probe; it is submitted and settles.
    expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["succeeded"]);
  });

  test("a Gemini pause for a missing key stays after a restart, as at the daily check", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 1 });
    const apis = providers();
    await tick(database, apis, "2026-11-10T19:45:00.000Z", { geminiApiKey: "" });
    database.reopen();
    const restarted = await tick(database, apis, "2026-11-10T20:15:00.000Z", { geminiApiKey: "" });
    expect(restarted.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "missing_key" });
  });
});

describe("embedding order", () => {
  test("a queued embedding waits while its game's Overview rebuild is pending, and only the replacement Overview is embedded", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    // Gemini has no key: the first Overview's embedding waits in the queue.
    await tick(database, apis, "2026-11-10T03:00:00.000Z", { geminiApiKey: "" });
    const waiting = embeddingJobs(database);
    expect(waiting.map(({ status }) => status)).toEqual(["queued"]);

    // A new article arrives; its extraction meets a transient failure, so the Overview rebuild is pending.
    insertSources(database.native, CYBERPUNK, "initial", 1, MEDIA_OUTLETS[1]);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:paid-work:new-article", [CYBERPUNK]));
    apis.openRouter.reply("chat", { status: 503, body: { error: { code: 503, message: "Unavailable" } } });
    await tick(database, apis, "2026-11-10T03:15:00.000Z");

    expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toEqual([]);
    expect(embeddingJobs(database).map(({ request_key, status }) => ({ request_key, status }))).toEqual([{ request_key: waiting[0]!.request_key, status: "queued" }]);

    await tick(database, apis, "2026-11-10T03:30:00.000Z");

    const overview = database.native.query<{ input_identity: string }, []>(`SELECT input_identity FROM media_game_overviews WHERE appid = ${CYBERPUNK} AND active = 1`).get()!;
    expect(apis.gemini.submitted).toHaveLength(1);
    expect(apis.gemini.submitted[0]).toContain(`:${overview.input_identity}:`);
    expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["succeeded"]);
  });
});

describe("definite refusals and uncertain submissions", () => {
  test("an invalid request is refused for its input identity and not retried, unlike a transient failure", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    apis.gemini.reply("submit", { status: 400, body: { error: { status: "INVALID_ARGUMENT", message: "invalid request" } } });

    const refused = await tick(database, apis, "2026-11-10T03:00:00.000Z");
    await tick(database, apis, "2026-11-10T03:15:00.000Z");
    await tick(database, apis, "2026-11-11T06:00:00.000Z");

    expect(embeddingJobs(database).map(({ status }) => status)).toEqual(["refused"]);
    expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(refused.mediaProcessing?.outputs.skipped).toBe(1);
    expect(refused.mediaProcessing?.providers.gemini.paused).toBe(false);
  });

  test("output that fails validation is refused, and the game's earlier still-supported Overview stays active", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    await tick(database, apis, "2026-11-10T03:00:00.000Z");
    expect(await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();
    // A correction run re-extracts a changed article, then extraction returns no supported contributions.
    const sourceId = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").get()!.id;
    const correction = insertCompletedRun(database.native, "initial:paid-work:correction", [CYBERPUNK]);
    await authorizeMediaProcessing(database.db, correction, { affectedSourceIds: [sourceId] });
    apis.openRouter.output("extraction", "{}");

    await tick(database, apis, "2026-11-10T04:00:00.000Z", { outlet: () => new Response(processingArticleHtml(CYBERPUNK).replace("flexible combat", "deliberate tactical combat")) });

    const extraction = jobs(database).filter((job) => job.stage === "extraction").at(-1)!;
    expect(extraction).toMatchObject({ status: "refused", error: "invalid_output: no supported contributions" });
  });

  test("a submission sent without a response is uncertain: reported in the uncertain count, resubmitted with backoff at most three consecutive times, then ended uncertain_exhausted", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    const lost = { network: "socket closed before the response" };
    apis.gemini.reply("submit", lost, lost, lost);

    const sent = await tick(database, apis, "2026-11-10T03:00:00.000Z");
    expect(embeddingJobs(database).map(({ status, next_attempt_at, error }) => ({ status, next_attempt_at, error }))).toEqual([{ status: "queued", next_attempt_at: "2026-11-10T03:15:00.000Z", error: "uncertain:no_response" }]);
    expect(sent.mediaProcessing?.cost.uncertain).toBe(1);
    await tick(database, apis, "2026-11-10T03:15:00.000Z");
    const exhausted = await tick(database, apis, "2026-11-10T03:45:00.000Z");
    const later = await tick(database, apis, "2026-11-11T06:00:00.000Z");

    expect(embeddingJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "uncertain_exhausted", error: "uncertain_exhausted:no_response" }]);
    expect(apis.gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(3);
    expect(exhausted.mediaProcessing?.cost.uncertain).toBe(1);
    expect(later.mediaProcessing?.cost.uncertain).toBe(1);
  });

  for (const code of ["ECONNREFUSED", ...TLS_FAILURE_CODES]) {
    test(`a submission that failed with ${code} before sending is transient`, async () => {
      const { database } = await authorizedGames();
      const apis = providers();
      apis.gemini.reply("submit", { network: "failed before sending", code });

      await tick(database, apis, "2026-11-10T03:00:00.000Z");

      expect(embeddingJobs(database)[0]).toMatchObject({ status: "queued", attempt_count: 1 });
    });
  }
});

/** The entity of every OpenRouter extraction request from index `from`, in request order, by the generation id each answer recorded. */
function extractionAppids(database: TestDatabase, apis: Providers, from = 0): number[] {
  const byGeneration = new Map(database.native.query<{ generation_id: string; appid: number }, []>("SELECT generation_id, appid FROM media_processing_jobs WHERE stage = 'extraction' AND generation_id IS NOT NULL").all().map((row) => [row.generation_id, row.appid]));
  return apis.openRouter.requests.map((request, index) => ({ request, generation: `gen-${index + 1}` }))
    .slice(from)
    .filter(({ request }) => request.stage === "extraction")
    .map(({ generation }) => byGeneration.get(generation)!);
}

describe("fair selection", () => {
  test("every entity with waiting work progresses each round, and the busy entity's items all progress", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 6, [BALDURS_GATE]: 2, [HADES_II]: 2 });
    const apis = providers();
    const extractionsByTick: number[][] = [];

    for (let index = 0; index < 6; index += 1) {
      const before = apis.openRouter.requests.length;
      await tick(database, apis, `2026-11-10T0${3 + Math.floor(index / 4)}:${String((index % 4) * 15).padStart(2, "0")}:00.000Z`, { paidSubmissionsPerTick: 3 });
      extractionsByTick.push(extractionAppids(database, apis, before));
      // No Overview is queued for a game while its extraction work waits.
      const early = database.native.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM media_processing_jobs AS s WHERE s.stage = 'synthesis' AND EXISTS (SELECT 1 FROM media_processing_jobs AS e WHERE e.appid = s.appid AND e.stage = 'extraction' AND e.status = 'queued' AND e.id < s.id)").get()!;
      expect(early.count).toBe(0);
    }

    // Entities with equal enqueue times are ordered by entity.
    expect(extractionsByTick.slice(0, 2)).toEqual([[BALDURS_GATE, CYBERPUNK, HADES_II], [BALDURS_GATE, CYBERPUNK, HADES_II]]);
    expect(extractionsByTick.flat().filter((appid) => appid === CYBERPUNK)).toHaveLength(6);
    expect(jobs(database).filter((job) => job.stage === "extraction").every((job) => job.status === "succeeded")).toBe(true);
  });
});

describe("fair selection across ticks", () => {
  test("with more entities holding ready work than the per-tick cap, every entity takes a turn within a bounded number of ticks", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 4, [BALDURS_GATE]: 4, [HADES_II]: 4 });
    const apis = providers();
    const turns: number[][] = [];

    for (const at of ["03:00", "03:15", "03:30", "03:45"]) {
      const before = apis.openRouter.requests.length;
      await tick(database, apis, `2026-11-10T${at}:00.000Z`, { paidSubmissionsPerTick: 2 });
      turns.push(extractionAppids(database, apis, before));
    }

    // Every item was queued at once, so the first tick orders entities by
    // entity; later ticks start with the entity whose last turn is oldest.
    expect(turns).toEqual([
      [BALDURS_GATE, CYBERPUNK],
      [HADES_II, BALDURS_GATE],
      [CYBERPUNK, HADES_II],
      [BALDURS_GATE, CYBERPUNK],
    ]);
    // With three entities and two turns per tick, any two consecutive ticks serve every entity.
    for (let index = 1; index < turns.length; index += 1) {
      expect(new Set([...turns[index - 1]!, ...turns[index]!]).size).toBe(3);
    }
  });
});

describe("article text", () => {
  test("an Outlet day stop at the article fetch keeps the extraction waiting, reports it, and the next UTC day fetches it", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    let limited = true;
    const outlet = () => (limited ? new Response(null, { status: 429 }) : undefined);

    const stopped = await tick(database, apis, "2026-11-10T03:00:00.000Z", { outlet });
    expect(stopped.mediaProcessing?.stopReasons).toContain("IGN:fetch_http_429");
    expect(jobs(database)[0]).toMatchObject({ stage: "extraction", status: "queued", attempt_count: 0 });
    limited = false;
    await tick(database, apis, "2026-11-10T03:15:00.000Z", { outlet });
    expect(jobs(database)[0]).toMatchObject({ status: "queued" });

    await tick(database, apis, "2026-11-11T00:00:00.000Z", { outlet });
    expect(jobs(database)[0]!.status).toBe("succeeded");
    expect(sourceTexts(database)).toEqual([null]);
  });
});

describe("cost reporting", () => {
  test("a refused batch without provider usage records zero cost marked unknown, not an estimate from its token caps", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    apis.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_SUCCEEDED" }, response: { inlinedResponses: { inlinedResponses: [{ error: { code: 400, message: "Invalid content." } }] } } } });

    const refused = await tick(database, apis, "2026-11-10T07:00:00.000Z");

    expect(database.native.query("SELECT stage, status, charged_microusd, cost_source FROM media_processing_jobs WHERE stage = 'embedding'").all()).toEqual([
      { stage: "embedding", status: "refused", charged_microusd: 0, cost_source: "unknown" },
    ]);
    expect(refused.mediaProcessing?.cost.providers.gemini).toEqual({ monthToDateMicrousd: 0, allTimeMicrousd: 0 });
  });

  test("a retained batch that failed after acceptance without provider usage stays uncertain history, keeps its reservation, and reports no spend", async () => {
    const database = openUpgradedTestDatabase("0022_paid_work_queue", (native) => {
      seedApps(native, [CYBERPUNK]);
      const runId = insertCompletedRun(native, "initial:paid-work:test", [CYBERPUNK]);
      native.prepare("INSERT INTO media_processing_authorizations (run_id, status, affected_source_ids) VALUES (?, 'completed', '[]')").run(runId);
      native.prepare("INSERT INTO media_processing_jobs (run_id, stage, appid, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider_batch_id, usage_json, submitted_at) VALUES (?, 'synthesis', ?, 'synthesis:retired', 'retired-identity', 'gemini-3.1-flash-lite', 'v1', 20000, 3200, 4900000, 1, 'submitted', 'batches/retired-1', '{}', '2026-10-01T00:00:00.000Z')").run(runId, CYBERPUNK);
    });
    cleanups.push(database.cleanup);
    const apis = providers();
    apis.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_FAILED" }, error: { message: "internal batch error" } } });

    const settled = await tick(database, apis, "2026-11-10T07:00:00.000Z");

    expect(database.native.query("SELECT status, reserved_microusd, reservation_active, charged_microusd, cost_source FROM media_processing_jobs").all()).toEqual([
      { status: "uncertain", reserved_microusd: 4_900_000, reservation_active: 1, charged_microusd: 0, cost_source: "unknown" },
    ]);
    expect(settled.mediaProcessing?.cost.providers.gemini).toEqual({ monthToDateMicrousd: 0, allTimeMicrousd: 0 });
  });

  test("settled items record their cost, reported month-to-date by UTC calendar month and all-time per provider, as reporting-only", async () => {
    const { database } = await authorizedGames();
    const apis = providers();
    // The embedding batch is still running at its first poll, so it settles in November.
    apis.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_RUNNING" } } });
    const logged: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
    try {
      await tick(database, apis, "2026-10-31T23:45:00.000Z");
      const november = await tick(database, apis, "2026-11-01T00:00:00.000Z");

      const costs = database.native.query<{ stage: string; charged_microusd: number; cost_source: string; completed_at: string }, []>("SELECT stage, charged_microusd, cost_source, completed_at FROM media_processing_jobs ORDER BY id").all();
      // Text cost is the usage.cost OpenRouter reports (US$0.00015 a request);
      // Gemini embedding cost is 1,000 tokens at US$0.10 per million, estimated.
      expect(costs).toEqual([
        { stage: "extraction", charged_microusd: 150, cost_source: "provider_reported", completed_at: "2026-10-31T23:45:00.000Z" },
        { stage: "synthesis", charged_microusd: 150, cost_source: "provider_reported", completed_at: "2026-10-31T23:45:00.000Z" },
        { stage: "embedding", charged_microusd: 100, cost_source: "estimated", completed_at: "2026-11-01T00:00:00.000Z" },
      ]);
      const expected = {
        reportingOnly: true as const,
        month: "2026-11",
        providers: { gemini: { monthToDateMicrousd: 100, allTimeMicrousd: 100 }, openrouter: { monthToDateMicrousd: 0, allTimeMicrousd: 300 } },
        uncertain: 0,
      };
      expect(november.mediaProcessing?.cost).toEqual(expected);
      const lastLog = JSON.parse(logged.filter((line) => line.includes("\"ingestion_completion\"")).at(-1)!) as { mediaProcessing: { cost: unknown } };
      expect(lastLog.mediaProcessing.cost).toEqual(expected);
    } finally {
      console.log = log;
    }
  });
});
