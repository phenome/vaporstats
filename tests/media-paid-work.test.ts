import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { getMediaOverview } from "../src/lib/media-overview";
import { runIngestionTick, type IngestionTickOptions } from "../workers/ingestion";
import { openTestDatabase, openUpgradedTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  CYBERPUNK,
  HADES_II,
  controlledGeminiApi,
  GEMINI_BILLING_DISABLED,
  GEMINI_KEY_INVALID,
  GEMINI_MODEL_NOT_FOUND,
  GEMINI_PREPAY_DEPLETED,
  GEMINI_RATE_LIMIT,
  GEMINI_SPEND_CAP,
  insertCompletedRun,
  insertSources,
  processingArticleHtml,
  seedApps,
  type GeminiCall,
  type GeminiReply,
} from "./support/media";

const cleanups: Array<() => void> = [];
const artifactDirectory = process.env.RECEPTION_ARTIFACT_DIR;
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (artifactDirectory === undefined) delete process.env.RECEPTION_ARTIFACT_DIR;
  else process.env.RECEPTION_ARTIFACT_DIR = artifactDirectory;
});

type Gemini = ReturnType<typeof controlledGeminiApi>;

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

/**
 * Article pages served for every outlet URL unless `outlet` answers first;
 * Gemini requests go to `gemini`; anything else is unavailable.
 */
function tickFetch(gemini: Gemini, fetched: string[] = [], outlet?: (url: string) => Response | undefined): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (gemini.isGeminiRequest(url)) return gemini.fetchFn(input, init);
    if (url.includes("/articles/")) {
      fetched.push(url);
      const answer = outlet?.(url);
      if (answer) return answer;
      const appid = [BALDURS_GATE, HADES_II].find((id) => url.includes(String(id))) ?? CYBERPUNK;
      return new Response(processingArticleHtml(appid));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

/**
 * Runs one ingestion tick at `at` with the controlled Gemini API and outlets.
 * The tick's daily player cycle is marked done, so it writes no snapshot.
 */
function tick(database: TestDatabase, gemini: Gemini, at: string, options: Partial<IngestionTickOptions> & { fetched?: string[]; outlet?: (url: string) => Response | undefined } = {}) {
  const { fetched, outlet, ...rest } = options;
  const anchorTime = new Date(at);
  const previousDay = new Date(Date.UTC(anchorTime.getUTCFullYear(), anchorTime.getUTCMonth(), anchorTime.getUTCDate() - 1)).toISOString().slice(0, 10);
  database.native.prepare("INSERT INTO checkpoints (key, value) VALUES ('ingestion:last-daily-cycle', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").run(previousDay);
  // Reception artifacts the tick writes stay inside the temporary database directory.
  process.env.RECEPTION_ARTIFACT_DIR = database.directory;
  return runIngestionTick({ db: database.db, anchorTime, customFetch: tickFetch(gemini, fetched, outlet), geminiApiKey: "test-gemini-key", ...rest });
}

function jobs(database: TestDatabase) {
  return database.native.query<{ request_key: string; stage: string; status: string; attempt_count: number; next_attempt_at: string | null; error: string | null }, []>(
    "SELECT request_key, stage, status, attempt_count, next_attempt_at, error FROM media_processing_jobs ORDER BY id",
  ).all();
}

describe("retired lifetime allowance", () => {
  test("a database whose charges and reservations already exceed US$5 still submits new paid work, and keeps its old rows unchanged", async () => {
    const { database } = await authorizedGames();
    const history = insertCompletedRun(database.native, "initial:history:test", [CYBERPUNK]);
    database.native.prepare(
      `INSERT INTO media_processing_jobs (run_id, stage, appid, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, enqueued_at, completed_at)
       VALUES (?1, 'synthesis', ?2, 'history-settled', 'history-settled', 'gemini-3.1-flash-lite', 'v1', 100, 10, 3000000, 3000000, 0, 'succeeded', '2026-10-01T00:00:00.000Z', '2026-10-01T00:10:00.000Z'),
              (?1, 'synthesis', ?2, 'history-uncertain', 'history-uncertain', 'gemini-3.1-flash-lite', 'v1', 100, 10, 2500000, NULL, 1, 'uncertain', '2026-10-01T00:00:00.000Z', NULL)`,
    ).run(history, CYBERPUNK);
    const historyRows = () => database.native.query("SELECT * FROM media_processing_jobs WHERE request_key LIKE 'history-%' ORDER BY id").all();
    const before = historyRows();
    const gemini = controlledGeminiApi();

    const result = await tick(database, gemini, "2026-11-10T03:00:00.000Z");

    expect(gemini.submitted.map((key) => key.split(":")[0])).toEqual(["extraction", "synthesis"]);
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
    await tick(reference.database, controlledGeminiApi(), "2026-11-10T03:00:00.000Z");
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
    const gemini = controlledGeminiApi();

    await tick(database, gemini, "2026-11-10T03:00:00.000Z");
    const last = await tick(database, gemini, "2026-11-10T03:15:00.000Z");
    // Retained rows are not queue work: a later tick has no paid work to advance.
    const idle = await tick(database, gemini, "2026-11-10T03:30:00.000Z");
    expect(idle.mediaProcessing).toBeUndefined();

    expect(retained()).toEqual(before);
    const retainedKeys = new Set(before.map((row) => row.request_key));
    expect(gemini.calls.filter((call) => call.kind === "submit" && retainedKeys.has(call.key!))).toEqual([]);
    // The authorized run still does its work, under queue items of its own.
    expect(gemini.submitted.map((key) => key.split(":")[0])).toEqual(["extraction", "synthesis", "embedding"]);
    expect(last.mediaProcessing).toMatchObject({ status: "completed", queued: { gemini: 0 } });
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
    const gemini = controlledGeminiApi();
    gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_EXPIRED" } } });

    await tick(database, gemini, "2026-11-10T07:00:00.000Z");
    await tick(database, gemini, "2026-11-10T07:15:00.000Z");

    expect(database.native.query("SELECT status, provider_batch_id, reserved_microusd, reservation_active, attempt_count, next_attempt_at FROM media_processing_jobs").all()).toEqual([
      { status: "stale", provider_batch_id: "batches/retired-1", reserved_microusd: 1500, reservation_active: 1, attempt_count: 0, next_attempt_at: null },
    ]);
    expect(gemini.calls.filter((call) => call.kind === "submit")).toEqual([]);
  });
});

function sourceTexts(database: TestDatabase): Array<string | null> {
  return database.native.query<{ processing_content: string | null }, []>("SELECT processing_content FROM media_sources ORDER BY id").all().map((row) => row.processing_content);
}

/** Processes Cyberpunk's single article to an active Overview whose embedding is queued, at 03:00 and 03:15 on 2026-11-10. */
async function overviewWithQueuedEmbedding(gemini: Gemini, sourcesPerGame: Partial<Record<number, number>> = { [CYBERPUNK]: 1 }) {
  const setup = await authorizedGames(sourcesPerGame);
  await tick(setup.database, gemini, "2026-11-10T03:00:00.000Z");
  return setup;
}

describe("missing provider configuration", () => {
  test("a missing key pauses Gemini with reason missing_key, fetches no article, fails nothing, and a configured key resumes the queue", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    const fetched: string[] = [];

    const missing = await tick(database, gemini, "2026-11-10T03:00:00.000Z", { geminiApiKey: "", fetched });

    expect(missing.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "missing_key", pausedAt: "2026-11-10T03:00:00.000Z" });
    expect(missing.mediaProcessing?.status).toBe("waiting");
    expect(fetched).toEqual([]);
    expect(gemini.calls).toEqual([]);
    expect(jobs(database).map(({ stage, status, attempt_count, error }) => ({ stage, status, attempt_count, error }))).toEqual([{ stage: "extraction", status: "queued", attempt_count: 0, error: null }]);

    const configured = await tick(database, gemini, "2026-11-10T03:15:00.000Z", { fetched });

    expect(configured.mediaProcessing?.providers.gemini.paused).toBe(false);
    expect(gemini.submitted.map((key) => key.split(":")[0])).toEqual(["extraction", "synthesis"]);
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
        const gemini = controlledGeminiApi();
        gemini.reply(kind, reply);

        const paused = await tick(database, gemini, "2026-11-10T07:00:00.000Z");

        expect(paused.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason, pausedAt: "2026-11-10T07:00:00.000Z" });
        expect(jobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual(Array(3).fill({ status: "queued", attempt_count: 0, error: null }));
        expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
        expect(paused.mediaProcessing?.status).toBe("waiting");
        expect(paused.mediaProcessing?.stopReasons).toContain(`provider_paused:gemini:${reason}`);
        expect(paused.mediaProcessing?.stopReasons).not.toContain("provider_refusal");

        const callsWhilePaused = gemini.calls.length;
        const later = await tick(database, gemini, "2026-11-10T07:15:00.000Z");
        expect(later.mediaProcessing?.providers.gemini.paused).toBe(true);
        expect(gemini.calls).toHaveLength(callsWhilePaused);

        const resumed = await tick(database, gemini, "2026-11-11T06:00:00.000Z");
        expect(resumed.mediaProcessing?.providers.gemini.paused).toBe(false);
        expect(jobs(database).filter((job) => job.stage === "extraction").every((job) => job.status === "succeeded")).toBe(true);
      });
    }
  }

  test("an invalid API key at a poll pauses Gemini and keeps the batch submitted, not uncertain", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("poll", GEMINI_KEY_INVALID);

    const paused = await tick(database, gemini, "2026-11-10T07:00:00.000Z");

    expect(paused.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "rejected_key" });
    expect(jobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([{ stage: "extraction", status: "submitted" }]);
    expect(paused.mediaProcessing?.cost.uncertain).toBe(0);

    // Polls are free and continue while paused; the batch settles.
    await tick(database, gemini, "2026-11-10T07:15:00.000Z");
    expect(jobs(database)[0]).toMatchObject({ stage: "extraction", status: "succeeded" });
  });

  test("a poll for a batch the provider no longer knows leaves its item uncertain and pauses nothing", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("poll", { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } } });

    const polled = await tick(database, gemini, "2026-11-10T07:00:00.000Z");

    expect(polled.mediaProcessing?.providers.gemini.paused).toBe(false);
    expect(jobs(database).map(({ status }) => status)).toEqual(["uncertain"]);
    expect(polled.mediaProcessing?.cost.uncertain).toBe(1);
  });

  for (const state of ["BATCH_STATE_EXPIRED", "BATCH_STATE_CANCELLED"]) {
    test(`a batch the provider reports as ${state} returns its item to the queue, refuses nothing, and is submitted again`, async () => {
      const { database } = await authorizedGames();
      const gemini = controlledGeminiApi();
      gemini.reply("poll", { status: 200, body: { metadata: { state } } });

      const returned = await tick(database, gemini, "2026-11-10T07:00:00.000Z");

      expect(jobs(database).map(({ stage, status, attempt_count, next_attempt_at }) => ({ stage, status, attempt_count, next_attempt_at }))).toEqual([
        { stage: "extraction", status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T07:15:00.000Z" },
      ]);
      expect(returned.mediaProcessing?.outputs.skipped).toBe(0);
      expect(returned.mediaProcessing?.providers.gemini.paused).toBe(false);

      await tick(database, gemini, "2026-11-10T07:15:00.000Z");
      expect(gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(3);
      expect(jobs(database)[0]).toMatchObject({ stage: "extraction", status: "succeeded" });
    });
  }
});

describe("Gemini Credit pause", () => {
  test("depleted Prepay credits pause Gemini with its reason and time, keep every Gemini item queued without an attempt, and hold no article text", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 2, [BALDURS_GATE]: 1 });
    const gemini = controlledGeminiApi();
    gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    const fetched: string[] = [];

    const paused = await tick(database, gemini, "2026-11-10T07:00:00.000Z", { fetched });

    expect(paused.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "prepay_depleted", pausedAt: "2026-11-10T07:00:00.000Z" });
    expect(gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect(jobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual(Array(3).fill({ status: "queued", attempt_count: 0, error: null }));
    expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
    expect(paused.mediaProcessing?.stopReasons).toContain("provider_paused:gemini:prepay_depleted");
    expect(sourceTexts(database)).toEqual([null, null, null]);

    // A pause lasts until the next daily credit check, not the next tick.
    for (const at of ["2026-11-10T07:15:00.000Z", "2026-11-10T23:45:00.000Z", "2026-11-11T05:45:00.000Z"]) {
      const later = await tick(database, gemini, at, { fetched });
      expect(later.mediaProcessing?.providers.gemini.paused).toBe(true);
    }
    expect(gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect(jobs(database).every(({ status, attempt_count }) => status === "queued" && attempt_count === 0)).toBe(true);
  });

  test("a 429 that reports an exceeded spending cap pauses Gemini, while a 429 rate limit is transient", async () => {
    const capped = await authorizedGames();
    const capGemini = controlledGeminiApi();
    capGemini.reply("submit", GEMINI_SPEND_CAP);
    const cap = await tick(capped.database, capGemini, "2026-11-10T07:00:00.000Z");
    expect(cap.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "spend_cap" });
    expect(jobs(capped.database).map(({ status, attempt_count }) => ({ status, attempt_count }))).toEqual([{ status: "queued", attempt_count: 0 }]);

    const limited = await authorizedGames();
    const limitGemini = controlledGeminiApi();
    limitGemini.reply("submit", GEMINI_RATE_LIMIT);
    const limit = await tick(limited.database, limitGemini, "2026-11-10T07:00:00.000Z");
    expect(limit.mediaProcessing?.providers.gemini.paused).toBe(false);
    expect(jobs(limited.database).map(({ status, attempt_count, next_attempt_at }) => ({ status, attempt_count, next_attempt_at }))).toEqual([{ status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T07:15:00.000Z" }]);
  });

  test("a restart with the database reopened while paused keeps the pause and every queued item", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 2 });
    const gemini = controlledGeminiApi();
    gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    await tick(database, gemini, "2026-11-10T07:00:00.000Z");
    const before = jobs(database);

    database.reopen();
    const restarted = await tick(database, gemini, "2026-11-10T07:15:00.000Z");

    expect(restarted.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "prepay_depleted", pausedAt: "2026-11-10T07:00:00.000Z" });
    expect(jobs(database)).toEqual(before);
    expect(gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
  });
});

describe("daily credit check", () => {
  test("runs in the first tick at or after 06:00 UTC, once per UTC day, probing with the oldest ready embedding item", async () => {
    const gemini = controlledGeminiApi();
    const { database } = await overviewWithQueuedEmbedding(gemini);
    // The Overview settles; its embedding is refused for credit, which pauses Gemini.
    gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    const paused = await tick(database, gemini, "2026-11-10T03:15:00.000Z");
    expect(paused.mediaProcessing?.providers.gemini.reason).toBe("prepay_depleted");
    // New work for another game waits behind the pause.
    seedApps(database.native, [BALDURS_GATE]);
    insertSources(database.native, BALDURS_GATE, "initial", 2);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:paid-work:later", [BALDURS_GATE]));
    await tick(database, gemini, "2026-11-10T04:00:00.000Z");
    const submissions = () => gemini.calls.filter((call) => call.kind === "submit").map((call) => call.key!.split(":")[0]);
    expect(submissions()).toEqual(["extraction", "synthesis", "embedding"]);

    // Before 06:00 nothing is checked. The first tick after 06:00 (here after
    // downtime) lifts the pause and probes with the embedding first; its
    // Credit pause answer pauses Gemini again until the next day.
    await tick(database, gemini, "2026-11-11T05:45:00.000Z");
    expect(submissions()).toHaveLength(3);
    gemini.reply("submit", GEMINI_PREPAY_DEPLETED);
    const probed = await tick(database, gemini, "2026-11-11T09:30:00.000Z");
    expect(submissions()).toEqual(["extraction", "synthesis", "embedding", "embedding"]);
    expect(probed.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "prepay_depleted", pausedAt: "2026-11-11T09:30:00.000Z", checkedAt: "2026-11-11T09:30:00.000Z" });

    // It never runs twice on one UTC day.
    await tick(database, gemini, "2026-11-11T23:45:00.000Z");
    expect(submissions()).toHaveLength(4);
    // A missed day is not made up: no tick ran on 2026-11-12, and the 13th
    // checks only from 06:00.
    await tick(database, gemini, "2026-11-13T05:45:00.000Z");
    expect(submissions()).toHaveLength(4);

    const resumed = await tick(database, gemini, "2026-11-13T06:00:00.000Z");
    expect(resumed.mediaProcessing?.providers.gemini).toMatchObject({ paused: false, reason: null, checkedAt: "2026-11-13T06:00:00.000Z" });
    // After the probe succeeds, the waiting work runs; its extractions settle
    // within the tick, which lets their Overview be queued and submitted.
    expect(submissions().slice(4)).toEqual(["embedding", "extraction", "extraction", "synthesis"]);
  });
});

describe("daily credit check without paid work", () => {
  test("runs in the first tick at or after 06:00 UTC even when no paid work waits, so a later day's new work is not held by an old pause", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    // The only batch's first poll rejects the key, pausing Gemini; its next
    // poll settles it as invalid output, which leaves no paid work at all.
    gemini.reply("poll", GEMINI_KEY_INVALID, { status: 200, body: { metadata: { state: "BATCH_STATE_SUCCEEDED" }, response: { inlinedResponses: { inlinedResponses: [{ response: { candidates: [{ content: { parts: [{ text: "{}" }] } }] } }] } } } });
    await tick(database, gemini, "2026-11-10T07:00:00.000Z");
    const settled = await tick(database, gemini, "2026-11-10T07:15:00.000Z");
    expect(settled.mediaProcessing?.providers.gemini).toMatchObject({ paused: true, reason: "rejected_key" });
    expect((await tick(database, gemini, "2026-11-10T07:30:00.000Z")).mediaProcessing).toBeUndefined();

    // The next day's first tick after 06:00 has no paid work, and still checks.
    await tick(database, gemini, "2026-11-11T06:30:00.000Z");

    // New work authorized the day after, before that day's check, is not
    // held by the pause the earlier check already lifted.
    seedApps(database.native, [BALDURS_GATE]);
    insertSources(database.native, BALDURS_GATE, "initial", 1);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:paid-work:later", [BALDURS_GATE]));
    const resumed = await tick(database, gemini, "2026-11-12T05:00:00.000Z");

    expect(resumed.mediaProcessing?.providers.gemini).toMatchObject({ paused: false, reason: null, checkedAt: "2026-11-11T06:30:00.000Z" });
    expect(gemini.submitted.filter((key) => key.startsWith("extraction:"))).toHaveLength(2);
  });
});

describe("transient failures", () => {
  test("keep the item queued, retry at the next tick, then back off doubling and honoring Retry-After, and never fail it", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("submit", { status: 503, body: { error: { message: "unavailable" } } }, { status: 503 }, { status: 429, body: { error: { message: "rate limited" } }, headers: { "Retry-After": "7200" } });
    const extraction = () => jobs(database).find((job) => job.stage === "extraction")!;
    const submits = () => gemini.calls.filter((call) => call.kind === "submit").length;

    await tick(database, gemini, "2026-11-10T03:00:00.000Z");
    expect(extraction()).toMatchObject({ status: "queued", attempt_count: 1, next_attempt_at: "2026-11-10T03:15:00.000Z" });
    await tick(database, gemini, "2026-11-10T03:15:00.000Z");
    expect(extraction()).toMatchObject({ status: "queued", attempt_count: 2, next_attempt_at: "2026-11-10T03:45:00.000Z" });
    await tick(database, gemini, "2026-11-10T03:30:00.000Z");
    expect(submits()).toBe(2);
    await tick(database, gemini, "2026-11-10T03:45:00.000Z");
    // Doubling would retry after an hour; the provider asked for two.
    expect(extraction()).toMatchObject({ status: "queued", attempt_count: 3, next_attempt_at: "2026-11-10T05:45:00.000Z" });
    await tick(database, gemini, "2026-11-10T05:30:00.000Z");
    expect(submits()).toBe(3);

    const recovered = await tick(database, gemini, "2026-11-10T05:45:00.000Z");
    expect(extraction().status).toBe("succeeded");
    expect(recovered.mediaProcessing?.outputs.skipped).toBe(0);
    expect(jobs(database).some((job) => job.status === "failed" || job.status === "refused")).toBe(false);
  });

  test("backoff is capped at 24 hours", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("submit", { status: 500 });
    await tick(database, gemini, "2026-11-10T03:00:00.000Z");
    database.native.prepare("UPDATE media_processing_jobs SET attempt_count = 20, next_attempt_at = NULL").run();
    gemini.reply("submit", { status: 500 });
    await tick(database, gemini, "2026-11-10T03:15:00.000Z");
    expect(jobs(database)[0]).toMatchObject({ status: "queued", attempt_count: 21, next_attempt_at: "2026-11-11T03:15:00.000Z" });
  });
});

describe("definite refusals and uncertain submissions", () => {
  test("an invalid request is refused for its input identity and not retried, unlike a transient failure", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("submit", { status: 400, body: { error: { status: "INVALID_ARGUMENT", message: "invalid request" } } });

    const refused = await tick(database, gemini, "2026-11-10T03:00:00.000Z");
    await tick(database, gemini, "2026-11-10T03:15:00.000Z");
    await tick(database, gemini, "2026-11-11T06:00:00.000Z");

    expect(jobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([{ stage: "extraction", status: "refused" }]);
    expect(gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(refused.mediaProcessing?.outputs.skipped).toBe(1);
    expect(refused.mediaProcessing?.providers.gemini.paused).toBe(false);
  });

  test("output that fails validation is refused, and the game's earlier still-supported Overview stays active", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    await tick(database, gemini, "2026-11-10T03:00:00.000Z");
    await tick(database, gemini, "2026-11-10T03:15:00.000Z");
    expect(await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();
    // A correction run re-extracts a changed article, then synthesis returns no cited statements.
    const sourceId = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").get()!.id;
    const correction = insertCompletedRun(database.native, "initial:paid-work:correction", [CYBERPUNK]);
    await authorizeMediaProcessing(database.db, correction, { affectedSourceIds: [sourceId] });
    gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_SUCCEEDED" }, response: { inlinedResponses: { inlinedResponses: [{ response: { candidates: [{ content: { parts: [{ text: "{}" }] } }] } }] } } } });

    await tick(database, gemini, "2026-11-10T04:00:00.000Z", { outlet: () => new Response(processingArticleHtml(CYBERPUNK).replace("flexible combat", "deliberate tactical combat")) });

    const extraction = jobs(database).filter((job) => job.stage === "extraction").at(-1)!;
    expect(extraction).toMatchObject({ status: "refused", error: "invalid_output: no supported contributions" });
  });

  test("a submission sent without a response is uncertain, never resubmitted, and reported in the uncertain count", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("submit", { network: "socket closed before the response" });

    const sent = await tick(database, gemini, "2026-11-10T03:00:00.000Z");
    const later = await tick(database, gemini, "2026-11-11T06:00:00.000Z");

    expect(jobs(database).map(({ status }) => status)).toEqual(["uncertain"]);
    expect(gemini.calls.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(sent.mediaProcessing?.cost.uncertain).toBe(1);
    expect(later.mediaProcessing?.cost.uncertain).toBe(1);
  });

  test("a submission whose connection was refused before sending is transient", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("submit", { network: "connection refused", code: "ECONNREFUSED" });

    await tick(database, gemini, "2026-11-10T03:00:00.000Z");

    expect(jobs(database)[0]).toMatchObject({ status: "queued", attempt_count: 1 });
  });
});

describe("fair selection", () => {
  test("every entity with waiting work progresses each round, and the busy entity's items all progress", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 6, [BALDURS_GATE]: 2, [HADES_II]: 2 });
    const gemini = controlledGeminiApi();
    const extractionsByTick: number[][] = [];
    const appidOf = (key: string) => database.native.query<{ appid: number }, [string]>("SELECT appid FROM media_processing_jobs WHERE request_key = ?").get(key)!.appid;

    for (let index = 0; index < 6; index += 1) {
      const before = gemini.submitted.length;
      await tick(database, gemini, `2026-11-10T0${3 + Math.floor(index / 4)}:${String((index % 4) * 15).padStart(2, "0")}:00.000Z`, { paidSubmissionsPerTick: 3 });
      extractionsByTick.push(gemini.submitted.slice(before).filter((key) => key.startsWith("extraction:")).map(appidOf));
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

describe("article text", () => {
  test("an Outlet day stop at the article fetch keeps the extraction waiting, reports it, and the next UTC day fetches it", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    let limited = true;
    const outlet = () => (limited ? new Response(null, { status: 429 }) : undefined);

    const stopped = await tick(database, gemini, "2026-11-10T03:00:00.000Z", { outlet });
    expect(stopped.mediaProcessing?.stopReasons).toContain("IGN:fetch_http_429");
    expect(jobs(database)[0]).toMatchObject({ stage: "extraction", status: "queued", attempt_count: 0 });
    limited = false;
    await tick(database, gemini, "2026-11-10T03:15:00.000Z", { outlet });
    expect(jobs(database)[0]).toMatchObject({ status: "queued" });

    await tick(database, gemini, "2026-11-11T00:00:00.000Z", { outlet });
    expect(jobs(database)[0]!.status).toBe("succeeded");
    expect(sourceTexts(database)).toEqual([null]);
  });
});

describe("cost reporting", () => {
  test("a refused batch without provider usage records zero cost marked unknown, not an estimate from its token caps", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_FAILED" }, error: { message: "internal batch error" } } });

    const refused = await tick(database, gemini, "2026-11-10T07:00:00.000Z");

    expect(database.native.query("SELECT stage, status, charged_microusd, cost_source FROM media_processing_jobs").all()).toEqual([
      { stage: "extraction", status: "refused", charged_microusd: 0, cost_source: "unknown" },
    ]);
    expect(refused.mediaProcessing?.cost.providers.gemini).toEqual({ monthToDateMicrousd: 0, allTimeMicrousd: 0 });
  });

  test("a retained batch settled without provider usage keeps its reservation as history and reports no spend", async () => {
    const database = openUpgradedTestDatabase("0022_paid_work_queue", (native) => {
      seedApps(native, [CYBERPUNK]);
      const runId = insertCompletedRun(native, "initial:paid-work:test", [CYBERPUNK]);
      native.prepare("INSERT INTO media_processing_authorizations (run_id, status, affected_source_ids) VALUES (?, 'completed', '[]')").run(runId);
      native.prepare("INSERT INTO media_processing_jobs (run_id, stage, appid, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider_batch_id, usage_json, submitted_at) VALUES (?, 'synthesis', ?, 'synthesis:retired', 'retired-identity', 'gemini-3.1-flash-lite', 'v1', 20000, 3200, 4900000, 1, 'submitted', 'batches/retired-1', '{}', '2026-10-01T00:00:00.000Z')").run(runId, CYBERPUNK);
    });
    cleanups.push(database.cleanup);
    const gemini = controlledGeminiApi();
    gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_FAILED" }, error: { message: "internal batch error" } } });

    const settled = await tick(database, gemini, "2026-11-10T07:00:00.000Z");

    expect(database.native.query("SELECT status, reserved_microusd, reservation_active, charged_microusd, cost_source FROM media_processing_jobs").all()).toEqual([
      { status: "refused", reserved_microusd: 4_900_000, reservation_active: 1, charged_microusd: 0, cost_source: "unknown" },
    ]);
    expect(settled.mediaProcessing?.cost.providers.gemini).toEqual({ monthToDateMicrousd: 0, allTimeMicrousd: 0 });
  });

  test("settled items record estimated cost, reported month-to-date by UTC calendar month and all-time, as reporting-only", async () => {
    const { database } = await authorizedGames();
    const gemini = controlledGeminiApi();
    const logged: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
    try {
      // The extraction settles in October; the Overview and its embedding settle in November.
      await tick(database, gemini, "2026-10-31T23:45:00.000Z");
      const november = await tick(database, gemini, "2026-11-01T00:00:00.000Z");

      const costs = database.native.query<{ stage: string; charged_microusd: number; cost_source: string; completed_at: string }, []>("SELECT stage, charged_microusd, cost_source, completed_at FROM media_processing_jobs ORDER BY id").all();
      // Text cost is token usage at the documented batch prices; Gemini
      // embedding cost is 1,000 tokens at US$0.10 per million.
      expect(costs).toEqual([
        { stage: "extraction", charged_microusd: 200, cost_source: "estimated", completed_at: "2026-10-31T23:45:00.000Z" },
        { stage: "synthesis", charged_microusd: 200, cost_source: "estimated", completed_at: "2026-11-01T00:00:00.000Z" },
        { stage: "embedding", charged_microusd: 100, cost_source: "estimated", completed_at: "2026-11-01T00:00:00.000Z" },
      ]);
      const expected = { reportingOnly: true as const, month: "2026-11", providers: { gemini: { monthToDateMicrousd: 300, allTimeMicrousd: 500 } }, uncertain: 0 };
      expect(november.mediaProcessing?.cost).toEqual(expected);
      const lastLog = JSON.parse(logged.filter((line) => line.includes("\"ingestion_completion\"")).at(-1)!) as { mediaProcessing: { cost: unknown } };
      expect(lastLog.mediaProcessing.cost).toEqual(expected);
    } finally {
      console.log = log;
    }
  });
});
