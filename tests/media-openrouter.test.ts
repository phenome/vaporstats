import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { MAX_UNCERTAIN_OUTCOMES_PER_JOB } from "../src/lib/media-paid-providers";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { createHash } from "node:crypto";
import { openTestDatabase, openUpgradedTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  CYBERPUNK,
  controlledGeminiApi,
  mediaObservation,
  controlledOpenRouterApi,
  HADES_II,
  insertCompletedRun,
  insertSources,
  insertSubmittedGeminiExtraction,
  manualProcessingOutcome,
  OPENROUTER_CREDITS,
  OPENROUTER_GUARDRAIL_BUDGET,
  OPENROUTER_IN_FLIGHT_BUDGET,
  OPENROUTER_INVALID_KEY,
  OPENROUTER_MODERATION,
  OPENROUTER_PERMISSION_DENIED,
  OPENROUTER_WORKSPACE_BUDGET,
  openRouterKeyLimit,
  oversizedArticleHtml,
  processingArticleHtml,
  overviewOutputForUrls,
  type OpenRouterRequestRecord,
  runMediaTick,
  seedApps,
  stableJson,
  synthesisEvidence,
  synthesisSelectionId,
  emptySynthesisSelection,
  TLS_FAILURE_CODES,
  type GeminiReply,
  type MediaTickOptions,
  type OpenRouterReply,
} from "./support/media";
import { MEDIA_OUTLETS } from "../src/lib/media-discovery";

const HAIKU = "anthropic/claude-haiku-5.5";
const cleanups: Array<() => void> = [];
const environment = { artifacts: process.env.RECEPTION_ARTIFACT_DIR, overviewPublic: process.env.MEDIA_OVERVIEW_PUBLIC };
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (environment.artifacts === undefined) delete process.env.RECEPTION_ARTIFACT_DIR;
  else process.env.RECEPTION_ARTIFACT_DIR = environment.artifacts;
  if (environment.overviewPublic === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
  else process.env.MEDIA_OVERVIEW_PUBLIC = environment.overviewPublic;
});

type Apis = { gemini: ReturnType<typeof controlledGeminiApi>; openRouter: ReturnType<typeof controlledOpenRouterApi> };

function apis(): Apis {
  return { gemini: controlledGeminiApi(), openRouter: controlledOpenRouterApi() };
}

/** A database holding the given games with `sourcesPerGame` initial articles each, and an authorized initial run covering them. */
async function authorizedGames(sourcesPerGame: Partial<Record<number, number>> = { [CYBERPUNK]: 1 }): Promise<{ database: TestDatabase; runId: number }> {
  const database = openTestDatabase("vaporstats-openrouter-");
  cleanups.push(database.cleanup);
  const games = Object.keys(sourcesPerGame).map(Number);
  seedApps(database.native, games);
  for (const appid of games) insertSources(database.native, appid, "initial", sourcesPerGame[appid]!);
  const runId = insertCompletedRun(database.native, "initial:openrouter:test", games);
  await authorizeMediaProcessing(database.db, runId);
  return { database, runId };
}

function tick(database: TestDatabase, providers: Apis, at: string, options: MediaTickOptions = {}) {
  return runMediaTick(database, providers, at, options);
}

function textJobs(database: TestDatabase) {
  return database.native.query<{ stage: string; provider: string; model: string; status: string; attempt_count: number; next_attempt_at: string | null; error: string | null }, []>(
    "SELECT stage, provider, model, status, attempt_count, next_attempt_at, error FROM media_processing_jobs WHERE stage IN ('extraction', 'synthesis') ORDER BY id",
  ).all();
}

/** Every recorded paid-work attempt, in order, with its item's stage. */
function attempts(database: TestDatabase) {
  return database.native.query<{ stage: string; attempt: number; provider: string; outcome: string | null; generation_id: string | null; charged_microusd: number | null; error: string | null }, []>(
    "SELECT j.stage, a.attempt, a.provider, a.outcome, a.generation_id, a.charged_microusd, a.error FROM media_processing_attempts AS a JOIN media_processing_jobs AS j ON j.id = a.job_id ORDER BY a.id",
  ).all();
}

async function detailOverview(database: TestDatabase, appid: number) {
  process.env.MEDIA_OVERVIEW_PUBLIC = "true";
  const response = await handleGameDetailRequest(new Request(`https://vaporstats.test/api/games/${appid}/detail`), database.db, appid);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { mediaOverview: { statements: Array<{ text: string; sourceUrls: string[] }>; tags: Array<{ slug: string }> } | null } };
  return body.data.mediaOverview;
}

describe("text generation through OpenRouter", () => {
  test("an article's extraction and its game's Overview are each one chat completion for Claude Haiku 5.5, recorded with cost, generation and routed provider, and the Overview reaches the Internal website API", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    const url = database.native.query<{ original_url: string }, []>("SELECT original_url FROM media_sources").get()!.original_url;

    const first = await tick(database, providers, "2026-11-18T03:00:00.000Z");

    expect(providers.openRouter.requests.map(({ stage, model }) => ({ stage, model }))).toEqual([
      { stage: "extraction", model: HAIKU },
      { stage: "synthesis", model: HAIKU },
    ]);
    for (const request of providers.openRouter.requests) {
      expect(request.authorization).toBe("Bearer test-openrouter-key");
      expect(request.body.max_tokens).toBeGreaterThan(0);
    }
    const [extraction, synthesis] = providers.openRouter.requests;
    expect(extraction!.body.messages[0]!.content).toContain("choose a verbatim excerpt that includes both the problem and that timing");
    expect(extraction!.body.messages[0]!.content).toContain("Publication dates, metadata and timing mentioned elsewhere do not establish when this problem occurred");
    expect(synthesis!.body.messages[0]!.content).toContain('say "during review" explicitly');
    expect(synthesis!.body.messages[0]!.content).toContain("‘Joy-Con aiming’ when the article describes Joy-Con mouse-style aiming");
    expect(synthesis!.body.messages[0]!.content).toContain("‘Joy-Con support’ only when the article establishes compatibility");
    expect(synthesis!.body.messages[0]!.content).toContain("A controller mapping does not establish a genre, a game-wide mechanic, another input mode, or support on another platform.");
    expect(synthesis!.body.messages[0]!.content).toContain("only if every citation establishes launch timing");
    expect(extraction!.body.response_format).toEqual({ type: "json_object" });
    expect(extraction!.body).not.toHaveProperty("provider");
    expect(synthesis!.body).toMatchObject({
      provider: { require_parameters: true },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "media_overview",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["tags", "statements", "categories", "prosCons"],
            properties: {
              statements: { type: "array", items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "observationIds"],
                properties: {
                  text: { type: "string" },
                  observationIds: { type: "array", items: { type: "string", enum: ["o1", "o3"] } },
                },
              } },
              categories: {
                type: "object",
                additionalProperties: false,
                required: ["Gameplay & systems"],
                properties: {
                  "Gameplay & systems": { type: "array", items: {
                    additionalProperties: false,
                    required: ["text", "observationIds"],
                    properties: {
                      observationIds: { type: "array", items: { type: "string", enum: ["o1"] } },
                      text: { type: "string" },
                    },
                  } },
                },
              },
              prosCons: { additionalProperties: false, required: ["pros", "cons"], properties: { pros: { type: "null" }, cons: { type: "null" } } },
              tags: { type: "array", items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "observationIds"],
                properties: {
                  label: { type: "string" },
                  observationIds: { type: "array", items: { type: "string", enum: ["o1", "o2"] } },
                },
              } },
            },
          },
        },
      },
    });
    expect(database.native.query("SELECT stage, config_version FROM media_processing_jobs WHERE stage IN ('extraction', 'synthesis') ORDER BY id").all()).toEqual([
      { stage: "extraction", config_version: "media-extraction-2026-11-26-v10" },
      { stage: "synthesis", config_version: "media-synthesis-2026-11-26-v29" },
    ]);
    // Embeddings stay on Gemini Batch; no text is submitted to Gemini.
    expect(providers.gemini.submitted.map((key) => key.split(":")[0])).toEqual(["embedding"]);
    expect(textJobs(database).map(({ stage, provider, model, status }) => ({ stage, provider, model, status }))).toEqual([
      { stage: "extraction", provider: "openrouter", model: HAIKU, status: "succeeded" },
      { stage: "synthesis", provider: "openrouter", model: HAIKU, status: "succeeded" },
    ]);
    expect(database.native.query("SELECT charged_microusd, cost_source, generation_id, routed_provider, routed_model FROM media_processing_jobs WHERE stage IN ('extraction', 'synthesis') ORDER BY id").all()).toEqual([
      { charged_microusd: 150, cost_source: "provider_reported", generation_id: "gen-1", routed_provider: "Anthropic", routed_model: HAIKU },
      { charged_microusd: 150, cost_source: "provider_reported", generation_id: "gen-2", routed_provider: "Anthropic", routed_model: HAIKU },
    ]);
    expect(first.mediaProcessing?.cost.providers.openrouter).toEqual({ monthToDateMicrousd: 300, allTimeMicrousd: 300 });

    const overview = await detailOverview(database, CYBERPUNK);
    expect(overview?.statements[0]?.sourceUrls).toEqual([url]);
    expect(overview?.tags.map(({ slug }) => slug)).toEqual(["build-experimentation"]);
  });
});

test("the OpenRouter extraction passes quote-supported timing to synthesis and review-only timing reaches the API", async () => {
  const { database } = await authorizedGames();
  const providers = apis();
  const category = "Technical experience & accessibility";
  const launchQuote = "At launch, animation glitches interrupted cutscenes.";
  const reviewQuote = "I saw frame-rate drops in crowded markets.";
  const untimed = "Frame-rate drops affected crowded markets during review.";
  providers.openRouter.output("extraction", { observations: [
    { ...mediaObservation(CYBERPUNK, "animation", "finding", launchQuote, launchQuote, category), qualifiers: ["At launch"] },
    mediaObservation(CYBERPUNK, "rates", "finding", "Frame-rate drops affected crowded markets.", reviewQuote, category),
  ] });
  providers.openRouter.output("synthesis", ({ body }: OpenRouterRequestRecord) => {
    const sources = synthesisEvidence(body);
    const [source] = sources;
    return {
      ...emptySynthesisSelection(sources),
      statements: [
        { text: launchQuote, observationIds: [synthesisSelectionId(source!, "animation")] },
        { text: untimed, observationIds: [synthesisSelectionId(source!, "rates")] },
      ],
    };
  });

  await tick(database, providers, "2026-11-18T03:00:00.000Z", {
    outlet: () => new Response(`<article><p>${launchQuote} ${reviewQuote} A long review examines how different build choices shape close encounters in the city.</p></article>`),
  });

  const synthesis = providers.openRouter.requests.find(({ stage }) => stage === "synthesis")!;
  const [source] = synthesisEvidence(synthesis.body);
  expect(source!.extraction.observations).toMatchObject([
    { id: "animation", technicalTiming: ["At launch"] },
    { id: "rates", technicalTiming: ["during review"] },
  ]);
  expect((await detailOverview(database, CYBERPUNK))?.statements.map(({ text }) => text)).toEqual([launchQuote, untimed]);
});

// The first live run (2026-11-18) showed Claude Haiku 5.5 reasoning by default,
// with reasoning tokens counted against the output cap: an extraction capped at
// 1,200 tokens spent 1,078 on reasoning and lost its answer. The run after the
// fix reasoned zero tokens at low effort, but an extraction needed 1,240 answer
// tokens and a four-source Overview was cut off at 5,200. ADR 0018 (amended
// 2026-11-18) sets reasoning explicitly and makes each cap a runaway guard,
// not an answer budget: 8,000 tokens for an extraction, 16,000 for an Overview.
describe("reasoning and output caps", () => {
  test("every text request sets reasoning explicitly at low effort, with a cap of 8,000 tokens for an extraction and 16,000 for an Overview, and records the cap it sent", async () => {
    const { database } = await authorizedGames();
    const providers = apis();

    await tick(database, providers, "2026-11-18T03:00:00.000Z");

    expect(providers.openRouter.requests.map(({ stage, body }) => ({ stage, reasoning: body.reasoning, max_tokens: body.max_tokens }))).toEqual([
      { stage: "extraction", reasoning: { effort: "low" }, max_tokens: 8_000 },
      { stage: "synthesis", reasoning: { effort: "low" }, max_tokens: 16_000 },
    ]);
    expect(database.native.query("SELECT stage, max_output_tokens FROM media_processing_jobs WHERE stage IN ('extraction', 'synthesis') ORDER BY id").all()).toEqual([
      { stage: "extraction", max_output_tokens: 8_000 },
      { stage: "synthesis", max_output_tokens: 16_000 },
    ]);
  });

  test("a waiting item queued under an earlier cap is sent with the current cap, and records the cap it was sent with", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    await tick(database, providers, "2026-11-18T03:00:00.000Z", { openRouterApiKey: "" });
    database.native.run("UPDATE media_processing_jobs SET max_output_tokens = 1200 WHERE stage = 'extraction'");

    await tick(database, providers, "2026-11-18T03:15:00.000Z");

    expect(providers.openRouter.requests[0]?.body.max_tokens).toBe(8_000);
    expect(database.native.query("SELECT max_output_tokens FROM media_processing_jobs WHERE stage = 'extraction'").get()).toEqual({ max_output_tokens: 8_000 });
  });

  test("reasoning tokens the provider reports are recorded in the stored usage", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.usage({ prompt_tokens: 3_081, completion_tokens: 1_400, completion_tokens_details: { reasoning_tokens: 600 }, cost: 0.0009 });

    await tick(database, providers, "2026-11-18T03:00:00.000Z");

    const usage = (stage: string) => database.native.query<{ usage_json: string }, [string]>("SELECT usage_json FROM media_processing_jobs WHERE stage = ?").get(stage)!.usage_json;
    expect(JSON.parse(usage("extraction"))).toEqual({ promptTokens: 3_081, completionTokens: 1_400, reasoningTokens: 600 });
    // Without a reported breakdown, the usage has no reasoning count.
    expect(JSON.parse(usage("synthesis"))).toEqual({ promptTokens: 1_000, completionTokens: 100 });
  });
});

describe("applying answers", () => {
  test("an answer is applied under the current-input and stale-write checks: one whose input stopped being current while in flight is recorded stale, with its cost", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    // While the extraction is in flight, the article's processing input changes.
    providers.openRouter.onChat = (request) => {
      if (request.stage === "extraction") database.native.prepare("UPDATE media_sources SET processing_input_identity = 'changed-while-in-flight'").run();
    };

    await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([{ stage: "extraction", status: "stale" }]);
    expect(database.native.query("SELECT COUNT(*) AS count FROM media_article_extractions").get()).toEqual({ count: 0 });
    expect(database.native.query("SELECT charged_microusd, cost_source, generation_id FROM media_processing_jobs").get()).toEqual({ charged_microusd: 150, cost_source: "provider_reported", generation_id: "gen-1" });
    expect(manualProcessingOutcome(database).skipped).toBe(1);
  });
});

describe("OpenRouter classifier", () => {
  const creditPauses: Array<[string, OpenRouterReply, string]> = [
    ["a 402 for the key limit", openRouterKeyLimit(402), "key_limit"],
    ["a 403 for the key limit", openRouterKeyLimit(403), "key_limit"],
    ["a 402 for account credits", OPENROUTER_CREDITS, "credits"],
    ["a 402 without a limit source", { status: 402, body: { error: { code: 402, message: "Insufficient credits" } } }, "credits"],
    ["a 403 for a spent guardrail budget", OPENROUTER_GUARDRAIL_BUDGET, "guardrail_budget"],
    ["a 403 for a spent workspace budget", OPENROUTER_WORKSPACE_BUDGET, "workspace_budget"],
  ];
  for (const [name, reply, reason] of creditPauses) {
    test(`${name} is a Credit pause: OpenRouter pauses with reason ${reason}, every text item stays queued with no attempt or failure, and no article text is held`, async () => {
      const { database } = await authorizedGames({ [CYBERPUNK]: 2, [BALDURS_GATE]: 1 });
      const providers = apis();
      providers.openRouter.reply("chat", reply);
      const fetched: string[] = [];

      const paused = await tick(database, providers, "2026-11-18T07:00:00.000Z", { fetched });

      expect(paused.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason, pausedAt: "2026-11-18T07:00:00.000Z" });
      expect(paused.mediaProcessing?.providers.gemini.paused).toBe(false);
      expect(providers.openRouter.requests).toHaveLength(1);
      expect(fetched).toHaveLength(1);
      expect(textJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual(Array(3).fill({ status: "queued", attempt_count: 0, error: null }));
      expect(manualProcessingOutcome(database).skipped).toBe(0);
      expect(manualProcessingOutcome(database).status).toBe("waiting");
      expect(manualProcessingOutcome(database).stopReasons).toContain(`provider_paused:openrouter:${reason}`);
      expect(database.native.query("SELECT processing_content FROM media_sources WHERE processing_content IS NOT NULL").all()).toEqual([]);

      // The pause lasts until the next daily credit check.
      for (const at of ["2026-11-18T07:15:00.000Z", "2026-11-19T05:45:00.000Z"]) {
        expect((await tick(database, providers, at)).mediaProcessing?.providers.openrouter.paused).toBe(true);
      }
      expect(providers.openRouter.requests).toHaveLength(1);
    });
  }

  test("a 402 for the in-flight budget is transient and honors Retry-After", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", OPENROUTER_IN_FLIGHT_BUDGET);

    const waiting = await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(waiting.mediaProcessing?.providers.openrouter.paused).toBe(false);
    // The next tick would be 07:15; the provider asked for an hour.
    expect(textJobs(database).map(({ status, attempt_count, next_attempt_at, error }) => ({ status, attempt_count, next_attempt_at, error }))).toEqual([
      { status: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T08:00:00.000Z", error: "transient:in_flight_budget" },
    ]);
    await tick(database, providers, "2026-11-18T07:45:00.000Z");
    expect(providers.openRouter.requests).toHaveLength(1);
    await tick(database, providers, "2026-11-18T08:00:00.000Z");
    expect(textJobs(database).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
  });

  for (const status of [408, 429, 500, 502, 503]) {
    test(`a ${status} is transient: the item stays queued with backoff, is never failed, and is retried`, async () => {
      const { database } = await authorizedGames();
      const providers = apis();
      providers.openRouter.reply("chat", { status, body: { error: { code: status, message: "try again" } } });

      const waiting = await tick(database, providers, "2026-11-18T07:00:00.000Z");

      expect(waiting.mediaProcessing?.providers.openrouter.paused).toBe(false);
      expect(manualProcessingOutcome(database).skipped).toBe(0);
      expect(textJobs(database).map(({ status: state, attempt_count, next_attempt_at }) => ({ state, attempt_count, next_attempt_at }))).toEqual([
        { state: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T07:15:00.000Z" },
      ]);
      await tick(database, providers, "2026-11-18T07:15:00.000Z");
      expect(textJobs(database).map(({ status: state }) => state)).toEqual(["succeeded", "succeeded"]);
    });
  }

  /** A 200 that OpenRouter sent once a provider accepted the request, whose body then reports only an error with `code`, the answer's id and its charged usage. */
  const acceptedError = (code: number, extra: Record<string, unknown> = {}): OpenRouterReply => ({
    status: 200,
    body: { id: "gen-accepted", usage: { prompt_tokens: 1_000, completion_tokens: 0, cost: 0.0001 }, error: { code, message: "Provider returned error", ...extra } },
  });
  const answerRecord = (database: TestDatabase) => database.native.query<{ status: string; error: string | null; generation_id: string | null; charged_microusd: number | null; cost_source: string | null; usage_json: string }, []>(
    "SELECT status, error, generation_id, charged_microusd, cost_source, usage_json FROM media_processing_jobs WHERE stage = 'extraction' ORDER BY id LIMIT 1",
  ).get();

  for (const code of [408, 500, 502, 524]) {
    test(`a 200 whose body reports a ${code} after the provider accepted the request is uncertain: the attempt records its generation id, usage and cost, and the item is resent with backoff`, async () => {
      const { database } = await authorizedGames();
      const providers = apis();
      providers.openRouter.reply("chat", acceptedError(code));

      const uncertain = await tick(database, providers, "2026-11-18T07:00:00.000Z");

      expect(answerRecord(database)).toEqual({ status: "queued", error: `uncertain:accepted_http_${code}`, generation_id: "gen-accepted", charged_microusd: 100, cost_source: "provider_reported", usage_json: JSON.stringify({ promptTokens: 1_000, completionTokens: 0 }) });
      expect(attempts(database)).toEqual([{ stage: "extraction", attempt: 1, provider: "openrouter", outcome: "uncertain", generation_id: "gen-accepted", charged_microusd: 100, error: `uncertain:accepted_http_${code}` }]);
      expect(uncertain.mediaProcessing?.cost.uncertain).toBe(1);
      expect(uncertain.mediaProcessing?.cost.providers.openrouter.allTimeMicrousd).toBe(100);

      const resent = await tick(database, providers, "2026-11-18T07:15:00.000Z");
      expect(providers.openRouter.requests.filter((request) => request.stage === "extraction")).toHaveLength(2);
      expect(answerRecord(database)).toMatchObject({ status: "succeeded", generation_id: "gen-2", charged_microusd: 250 });
      expect(attempts(database).filter(({ stage }) => stage === "extraction").map(({ generation_id, charged_microusd }) => ({ generation_id, charged_microusd }))).toEqual([
        { generation_id: "gen-accepted", charged_microusd: 100 },
        { generation_id: "gen-2", charged_microusd: 150 },
      ]);
      // Cost reporting sums every attempt: both extraction attempts and the Overview.
      expect(resent.mediaProcessing?.cost.providers.openrouter).toEqual({ monthToDateMicrousd: 400, allTimeMicrousd: 400 });
    });
  }

  test("month-to-date cost counts each attempt in the UTC month its cost was recorded, and all-time cost counts every attempt", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", acceptedError(502));

    await tick(database, providers, "2026-11-30T23:50:00.000Z");
    const december = await tick(database, providers, "2026-12-01T00:05:00.000Z");

    expect(attempts(database).filter(({ provider }) => provider === "openrouter").map(({ charged_microusd }) => charged_microusd)).toEqual([100, 150, 150]);
    expect(december.mediaProcessing?.cost).toMatchObject({ month: "2026-12", providers: { openrouter: { monthToDateMicrousd: 300, allTimeMicrousd: 400 } } });
  });

  test("a 200 whose body reports another code keeps that code's class, and its generation id and cost are recorded", async () => {
    const refused = await authorizedGames();
    const refusing = apis();
    refusing.openRouter.reply("chat", acceptedError(400));
    await tick(refused.database, refusing, "2026-11-18T07:00:00.000Z");
    expect(answerRecord(refused.database)).toMatchObject({ status: "refused", generation_id: "gen-accepted", charged_microusd: 100, cost_source: "provider_reported" });

    const paused = await authorizedGames();
    const pausing = apis();
    pausing.openRouter.reply("chat", acceptedError(402, { metadata: { limit_source: "openrouter_credits" } }));
    const credit = await tick(paused.database, pausing, "2026-11-18T07:00:00.000Z");
    expect(credit.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "credits" });
    expect(answerRecord(paused.database)).toMatchObject({ status: "queued", error: null, generation_id: "gen-accepted", charged_microusd: 100 });

    // A retried item adds the cost of its later answer to the cost already recorded.
    const retried = await authorizedGames();
    const retrying = apis();
    retrying.openRouter.reply("chat", acceptedError(429));
    await tick(retried.database, retrying, "2026-11-18T07:00:00.000Z");
    expect(answerRecord(retried.database)).toMatchObject({ status: "queued", error: "transient:http_429", generation_id: "gen-accepted", charged_microusd: 100 });
    await tick(retried.database, retrying, "2026-11-18T07:15:00.000Z");
    expect(answerRecord(retried.database)).toMatchObject({ status: "succeeded", charged_microusd: 250, cost_source: "provider_reported" });
  });

  /** A 200 whose first choice ended with an error of `code`, after the provider accepted the request. */
  const choiceError = (code: number): OpenRouterReply => ({
    status: 200,
    body: { id: "gen-accepted", model: HAIKU, provider: "Anthropic", usage: { prompt_tokens: 1_000, completion_tokens: 0, cost: 0.0001 }, choices: [{ index: 0, finish_reason: "error", message: { role: "assistant", content: "" }, error: { code, message: "Provider returned error" } }] },
  });

  test("an error inside the first choice is classified like a top-level error, and its generation id and cost are recorded", async () => {
    const failed = await authorizedGames();
    const failing = apis();
    failing.openRouter.reply("chat", choiceError(502));
    await tick(failed.database, failing, "2026-11-18T07:00:00.000Z");
    expect(answerRecord(failed.database)).toMatchObject({ status: "queued", error: "uncertain:accepted_http_502", generation_id: "gen-accepted", charged_microusd: 100 });

    const refused = await authorizedGames();
    const refusing = apis();
    refusing.openRouter.reply("chat", choiceError(400));
    await tick(refused.database, refusing, "2026-11-18T07:00:00.000Z");
    expect(answerRecord(refused.database)).toMatchObject({ status: "refused", error: "http_400", generation_id: "gen-accepted", charged_microusd: 100 });
  });

  for (const [name, reply] of [
    ["a body that is not JSON", { status: 200, raw: "<html><body>upstream reset</body></html>" }],
    ["a JSON body without choices", { status: 200, body: { id: "gen-empty", object: "chat.completion" } }],
  ] as Array<[string, OpenRouterReply]>) {
    test(`a 200 with ${name} came after the provider accepted the request, so the item is uncertain and resent with backoff`, async () => {
      const { database } = await authorizedGames();
      const providers = apis();
      providers.openRouter.reply("chat", reply);

      await tick(database, providers, "2026-11-18T07:00:00.000Z");

      expect(answerRecord(database)).toMatchObject({ status: "queued", error: "uncertain:accepted_without_answer" });
      expect(manualProcessingOutcome(database).skipped).toBe(0);
      await tick(database, providers, "2026-11-18T07:15:00.000Z");
      expect(providers.openRouter.requests.filter((request) => request.stage === "extraction")).toHaveLength(2);
      expect(answerRecord(database)).toMatchObject({ status: "succeeded" });
    });
  }

  const refusals: Array<[string, OpenRouterReply]> = [
    ["a 400 invalid request", { status: 400, body: { error: { code: 400, message: "Invalid request", metadata: { error_type: "invalid_request" } } } }],
    ["a 403 moderation flag", OPENROUTER_MODERATION],
    ["a 403 guardrail content block", { status: 403, body: { error: { code: 403, message: "Request blocked: prompt injection patterns detected", metadata: { error_type: "content_policy", patterns: ["ignore all previous instructions"] } } } }],
    ["a 403 provider refusal", { status: 403, body: { error: { code: 403, message: "The provider refused the request", metadata: { error_type: "refusal" } } } }],
  ];
  for (const [name, reply] of refusals) {
    test(`${name} is a definite refusal for the item's input identity, never retried outside a correction set, and leaves other items' results`, async () => {
      const { database } = await authorizedGames({ [CYBERPUNK]: 2 });
      const providers = apis();
      providers.openRouter.reply("chat", reply);

      const refused = await tick(database, providers, "2026-11-18T07:00:00.000Z");
      await tick(database, providers, "2026-11-19T06:00:00.000Z");

      expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([
        { stage: "extraction", status: "refused" },
        { stage: "extraction", status: "succeeded" },
        { stage: "synthesis", status: "succeeded" },
      ]);
      expect(manualProcessingOutcome(database).skipped).toBe(1);
      expect(refused.mediaProcessing?.providers.openrouter.paused).toBe(false);
      expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "synthesis"]);
      // The Overview is built from the article that succeeded.
      const urls = database.native.query<{ original_url: string }, []>("SELECT original_url FROM media_sources ORDER BY id").all().map((row) => row.original_url);
      expect((await detailOverview(database, CYBERPUNK))?.statements[0]?.sourceUrls).toEqual([urls[1]]);
    });
  }

  const forbidden: Array<[string, OpenRouterReply, string]> = [
    ["a 403 for a key without permission", OPENROUTER_PERMISSION_DENIED, "permission_denied"],
    ["a 403 without a budget source, moderation or a content type", { status: 403, body: { error: { code: 403, message: "Forbidden" } } }, "forbidden"],
  ];
  for (const [name, reply, reason] of forbidden) {
    test(`${name} is a configuration pause with reason ${reason}: no item is refused or charged an attempt, and the daily key check lifts it`, async () => {
      const { database } = await authorizedGames({ [CYBERPUNK]: 2 });
      const providers = apis();
      providers.openRouter.reply("chat", reply);

      const paused = await tick(database, providers, "2026-11-18T07:00:00.000Z");

      expect(paused.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason });
      expect(manualProcessingOutcome(database).skipped).toBe(0);
      expect(textJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual(Array(2).fill({ status: "queued", attempt_count: 0, error: null }));
      expect(providers.openRouter.requests).toHaveLength(1);

      const resumed = await tick(database, providers, "2026-11-19T06:00:00.000Z");
      expect(resumed.mediaProcessing?.providers.openrouter).toMatchObject({ paused: false, checkOutcome: "credit_remaining" });
      expect(textJobs(database).map(({ status }) => status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    });
  }

  test("output that fails the existing parsers is a definite refusal", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.output("extraction", "not json at all");

    const refused = await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(textJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "refused", error: "invalid_output: no supported contributions" }]);
    expect(manualProcessingOutcome(database).skipped).toBe(1);
    // The answer was charged, so its reported cost is recorded.
    expect(refused.mediaProcessing?.cost.providers.openrouter.allTimeMicrousd).toBe(150);
  });

  test("a 401 pauses OpenRouter with reason invalid_key, refuses and fails nothing, and the daily check resumes it", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", OPENROUTER_INVALID_KEY);

    const paused = await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(paused.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "invalid_key" });
    expect(textJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual([{ status: "queued", attempt_count: 0, error: null }]);
    expect(manualProcessingOutcome(database).stopReasons).toContain("provider_paused:openrouter:invalid_key");

    const resumed = await tick(database, providers, "2026-11-19T06:00:00.000Z");
    expect(resumed.mediaProcessing?.providers.openrouter).toMatchObject({ paused: false, checkOutcome: "credit_remaining" });
    expect(textJobs(database).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
  });
});

/** The row of the item whose request is in flight, read through a second connection, so only committed writes are visible. */
function committedInFlight(database: TestDatabase) {
  const reader = new Database(database.databasePath, { readonly: true });
  try {
    return reader.query<{ stage: string; status: string; error: string | null; submitted_at: string | null; input_identity: string }, []>(
      "SELECT stage, status, error, submitted_at, input_identity FROM media_processing_jobs WHERE status = 'uncertain'",
    ).all();
  } finally {
    reader.close();
  }
}

function sourceUrls(database: TestDatabase): string[] {
  return database.native.query<{ original_url: string }, []>("SELECT original_url FROM media_sources ORDER BY id").all().map((row) => row.original_url);
}

describe("request lifecycle", () => {
  test.each(["media-extraction-2026-11-25-v8", "media-extraction-2026-11-26-v9"])("a retained %s extraction sends and retries its original prompt and identity", async (configVersion) => {
    const { database } = await authorizedGames();
    const providers = apis();
    await tick(database, providers, "2026-11-18T06:45:00.000Z", { openRouterApiKey: "" });
    expect(database.native.prepare("UPDATE media_processing_jobs SET config_version = ? WHERE stage = 'extraction' AND status = 'queued'").run(configVersion).changes).toBe(1);
    const item = () => database.native.query<{ config_version: string; input_identity: string; request_key: string }, []>(
      "SELECT config_version, input_identity, request_key FROM media_processing_jobs WHERE stage = 'extraction'",
    ).get()!;
    const key = item().request_key;
    providers.openRouter.reply("chat", { hang: true });
    const sent: Array<ReturnType<typeof item>> = [];
    providers.openRouter.onChat = (request) => {
      if (request.stage === "extraction") sent.push(item());
    };

    await tick(database, providers, "2026-11-18T07:00:00.000Z", { openRouterTimeoutMs: 20 });
    const first = item();
    expect(first).toEqual({ config_version: configVersion, input_identity: expect.stringMatching(/^[a-f0-9]{64}$/), request_key: key });
    await tick(database, providers, "2026-11-18T07:15:00.000Z");

    expect(sent).toEqual([first, first]);
    const [original, retry] = providers.openRouter.requests;
    expect(original!.body.messages[0]!.content.includes("choose a verbatim excerpt that includes both the problem and that timing")).toBe(configVersion.endsWith("v9"));
    expect(original!.body.messages[0]!.content).not.toContain("browsable label");
    expect(retry!.body).toEqual(original!.body);
    expect(database.native.query("SELECT config_version, input_identity FROM media_article_extractions").all()).toEqual([
      { config_version: configVersion, input_identity: first.input_identity },
    ]);
  });

  test("each item is recorded in flight with its input identity and send time in a committed write before it is sent, and no write transaction is open during the request", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    const observed: Array<{ inTransaction: boolean; rows: ReturnType<typeof committedInFlight> }> = [];
    providers.openRouter.onChat = () => { observed.push({ inTransaction: database.native.inTransaction, rows: committedInFlight(database) }); };

    await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(observed.map(({ inTransaction }) => inTransaction)).toEqual([false, false]);
    expect(observed.map(({ rows }) => rows.map(({ stage, status, error, submitted_at }) => ({ stage, status, error, submitted_at })))).toEqual([
      [{ stage: "extraction", status: "uncertain", error: "submission in progress", submitted_at: "2026-11-18T07:00:00.000Z" }],
      [{ stage: "synthesis", status: "uncertain", error: "submission in progress", submitted_at: "2026-11-18T07:00:00.000Z" }],
    ]);
    for (const { rows } of observed) expect(rows[0]!.input_identity).toMatch(/^[0-9a-f]{64}$/);
    expect(textJobs(database).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
  });

  test("a client timeout after the request was sent is uncertain: the item returns to the queue, is resent with backoff, settles, and each attempt keeps its own record", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { hang: true });

    const sent = await tick(database, providers, "2026-11-18T07:00:00.000Z", { openRouterTimeoutMs: 20 });

    expect(textJobs(database).map(({ stage, status, attempt_count, next_attempt_at, error }) => ({ stage, status, attempt_count, next_attempt_at, error }))).toEqual([
      { stage: "extraction", status: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T07:15:00.000Z", error: "uncertain:timeout" },
    ]);
    expect(sent.mediaProcessing?.cost.uncertain).toBe(1);
    expect(manualProcessingOutcome(database).stopReasons).toContain("uncertain_submission");
    expect(manualProcessingOutcome(database).skipped).toBe(0);

    const resent = await tick(database, providers, "2026-11-18T07:15:00.000Z");

    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "synthesis"]);
    expect(textJobs(database).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    expect(resent.mediaProcessing?.cost.uncertain).toBe(0);
    expect(attempts(database).filter(({ provider }) => provider === "openrouter")).toEqual([
      { stage: "extraction", attempt: 1, provider: "openrouter", outcome: "uncertain", generation_id: null, charged_microusd: null, error: "uncertain:timeout" },
      { stage: "extraction", attempt: 2, provider: "openrouter", outcome: "succeeded", generation_id: "gen-2", charged_microusd: 150, error: null },
      { stage: "synthesis", attempt: 1, provider: "openrouter", outcome: "succeeded", generation_id: "gen-3", charged_microusd: 150, error: null },
    ]);
  });

  test("an uncertain Overview request is resent automatically with backoff", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { status: 200, body: { id: "gen-ok", provider: "Anthropic", model: HAIKU, choices: [{ message: { content: JSON.stringify({ observations: [mediaObservation(CYBERPUNK, "combat", "finding", "Builds reward experimentation", "Builds reward experimentation")] }) } }], usage: { cost: 0.0001 } } }, { hang: true });

    await tick(database, providers, "2026-11-18T07:00:00.000Z", { openRouterTimeoutMs: 20 });
    expect(textJobs(database).map(({ stage, status, next_attempt_at }) => ({ stage, status, next_attempt_at }))).toEqual([
      { stage: "extraction", status: "succeeded", next_attempt_at: null },
      { stage: "synthesis", status: "queued", next_attempt_at: "2026-11-18T07:15:00.000Z" },
    ]);
    await tick(database, providers, "2026-11-18T07:15:00.000Z");

    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis", "synthesis"]);
    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([{ stage: "extraction", status: "succeeded" }, { stage: "synthesis", status: "succeeded" }]);
    expect(await detailOverview(database, CYBERPUNK)).not.toBeNull();
  });

  test("a resent item whose work no longer needs a provider ends stale and keeps its attempts and their cost", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    const extracted = { status: 200, body: { id: "gen-ok", provider: "Anthropic", model: HAIKU, choices: [{ message: { content: JSON.stringify({ observations: [mediaObservation(CYBERPUNK, "combat", "finding", "Builds reward experimentation", "Builds reward experimentation")] }) } }], usage: { cost: 0.00015 } } };
    providers.openRouter.reply("chat", extracted, { status: 200, body: { id: "gen-overview", usage: { prompt_tokens: 1_000, completion_tokens: 0, cost: 0.0001 }, error: { code: 502, message: "Provider returned error" } } });
    await tick(database, providers, "2026-11-18T07:00:00.000Z");
    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([{ stage: "extraction", status: "succeeded" }, { stage: "synthesis", status: "queued" }]);

    // A new article changes the game's contributions before the Overview is resent.
    insertSources(database.native, CYBERPUNK, "initial", 1, MEDIA_OUTLETS[1]);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:new-article", [CYBERPUNK]));
    const settled = await tick(database, providers, "2026-11-18T07:15:00.000Z");

    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: "extraction", status: "succeeded" },
      { stage: "synthesis", status: "stale" },
      { stage: "extraction", status: "succeeded" },
      { stage: "synthesis", status: "succeeded" },
    ]);
    expect(attempts(database).filter(({ stage }) => stage === "synthesis").map(({ attempt, outcome, generation_id, charged_microusd }) => ({ attempt, outcome, generation_id, charged_microusd }))).toEqual([
      { attempt: 1, outcome: "uncertain", generation_id: "gen-overview", charged_microusd: 100 },
      { attempt: 1, outcome: "succeeded", generation_id: "gen-4", charged_microusd: 150 },
    ]);
    expect(settled.mediaProcessing?.cost.providers.openrouter.allTimeMicrousd).toBe(150 + 100 + 150 + 150);
  });

  test("a connection lost after the request was sent is uncertain and the item returns to the queue with backoff", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { network: "socket closed before the response" });

    await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(textJobs(database).map(({ status, attempt_count, next_attempt_at, error }) => ({ status, attempt_count, next_attempt_at, error }))).toEqual([
      { status: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T07:15:00.000Z", error: "uncertain:no_response" },
    ]);
    expect(providers.openRouter.requests).toHaveLength(1);
  });

  test("three consecutive uncertain outcomes for one input identity end the item as uncertain_exhausted: never resent automatically, and resent through a correction set", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { hang: true }, { hang: true }, { hang: true });
    const options = { openRouterTimeoutMs: 20 };

    // Backoff doubles from one tick: 07:15, then 07:45.
    await tick(database, providers, "2026-11-18T07:00:00.000Z", options);
    await tick(database, providers, "2026-11-18T07:15:00.000Z", options);
    expect(textJobs(database).map(({ status, attempt_count, next_attempt_at }) => ({ status, attempt_count, next_attempt_at }))).toEqual([{ status: "queued", attempt_count: 2, next_attempt_at: "2026-11-18T07:45:00.000Z" }]);
    await tick(database, providers, "2026-11-18T07:30:00.000Z", options);
    expect(providers.openRouter.requests).toHaveLength(2);
    const exhausted = await tick(database, providers, "2026-11-18T07:45:00.000Z", options);

    expect(textJobs(database).map(({ status, next_attempt_at, error }) => ({ status, next_attempt_at, error }))).toEqual([{ status: "uncertain_exhausted", next_attempt_at: null, error: "uncertain_exhausted:timeout" }]);
    expect(exhausted.mediaProcessing?.cost.uncertain).toBe(1);
    expect(manualProcessingOutcome(database).skipped).toBe(1);
    for (const at of ["2026-11-18T09:00:00.000Z", "2026-11-19T06:00:00.000Z", "2026-11-20T06:00:00.000Z"]) await tick(database, providers, at);
    expect(providers.openRouter.requests).toHaveLength(3);
    expect(attempts(database).map(({ attempt, outcome }) => ({ attempt, outcome }))).toEqual([1, 2, 3].map((attempt) => ({ attempt, outcome: "uncertain" })));

    // Only an authorized correction set covering the article resends it.
    const sourceId = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").get()!.id;
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:correction", [CYBERPUNK]), { affectedSourceIds: [sourceId] });
    await tick(database, providers, "2026-11-20T07:00:00.000Z");
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "extraction", "extraction", "synthesis"]);
    expect(textJobs(database).map(({ status }) => status)).toEqual(["uncertain_exhausted", "succeeded", "succeeded"]);
  });

  test("a new input identity starts a fresh uncertain count, and a transient outcome does not end the streak", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    const options = { openRouterTimeoutMs: 20 };
    providers.openRouter.reply("chat", { hang: true }, { hang: true });
    await tick(database, providers, "2026-11-18T07:00:00.000Z", options);
    await tick(database, providers, "2026-11-18T07:15:00.000Z", options);

    // The article's cleaned text changes: the next send has a new input identity.
    providers.openRouter.reply("chat", { hang: true }, { status: 503, body: { error: { code: 503, message: "Unavailable" } } }, { hang: true }, { hang: true });
    const changed = { ...options, outlet: () => new Response(processingArticleHtml(CYBERPUNK).replace("flexible combat", "deliberate tactical combat")) };
    await tick(database, providers, "2026-11-18T07:45:00.000Z", changed);
    expect(textJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "queued", error: "uncertain:timeout" }]);
    await tick(database, providers, "2026-11-18T09:00:00.000Z", changed);
    await tick(database, providers, "2026-11-18T12:00:00.000Z", changed);
    expect(textJobs(database).map(({ status }) => status)).toEqual(["queued"]);
    // The 503 did not end the streak: this is the new identity's third uncertain outcome.
    await tick(database, providers, "2026-11-19T06:00:00.000Z", changed);
    expect(attempts(database).map(({ outcome }) => outcome)).toEqual(["uncertain", "uncertain", "uncertain", "transient", "uncertain", "uncertain"]);
    expect(textJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "uncertain_exhausted", error: "uncertain_exhausted:timeout" }]);
    await tick(database, providers, "2026-11-20T06:00:00.000Z", changed);
    expect(providers.openRouter.requests).toHaveLength(6);
  });

  test("uncertain outcomes alternating with 503s end the item after the third uncertain one", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    const lost = { network: "socket closed before the response" };
    const unavailable = { status: 503, body: { error: { code: 503, message: "Unavailable" } } };
    providers.openRouter.reply("chat", lost, unavailable, lost, unavailable, lost);

    for (const at of ["07:00", "07:15", "07:45", "08:45", "10:45", "16:00"]) await tick(database, providers, `2026-11-18T${at}:00.000Z`);
    await tick(database, providers, "2026-11-19T06:00:00.000Z");

    expect(attempts(database).map(({ outcome }) => outcome)).toEqual(["uncertain", "transient", "uncertain", "transient", "uncertain"]);
    expect(textJobs(database).map(({ status }) => status)).toEqual(["uncertain_exhausted"]);
    expect(providers.openRouter.requests).toHaveLength(5);
  });

  test("uncertain outcomes alternating with 402 Credit pauses end the item after the third uncertain one", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    const lost = { network: "socket closed before the response" };
    providers.openRouter.reply("chat", lost, OPENROUTER_CREDITS, lost, OPENROUTER_CREDITS, lost);

    for (const at of ["2026-11-18T07:00", "2026-11-18T07:15", "2026-11-19T06:00", "2026-11-19T06:30", "2026-11-20T06:00", "2026-11-21T06:00"]) await tick(database, providers, `${at}:00.000Z`);

    expect(attempts(database).map(({ outcome }) => outcome)).toEqual(["uncertain", "credit_pause", "uncertain", "credit_pause", "uncertain"]);
    expect(textJobs(database).map(({ status }) => status)).toEqual(["uncertain_exhausted"]);
    expect(providers.openRouter.requests).toHaveLength(5);
  });

  test(`input identity churn reaches the per-job ceiling of ${MAX_UNCERTAIN_OUTCOMES_PER_JOB} uncertain outcomes`, async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    const lost = { network: "socket closed before the response" };
    providers.openRouter.reply("chat", lost, lost, lost, lost, lost, lost, lost);
    // Two uncertain outcomes per article text, below the per-identity limit, then the text changes.
    const text = (version: number) => ({ outlet: () => new Response(processingArticleHtml(CYBERPUNK).replace("flexible combat", `combat revision ${version}`)) });
    const ticks: Array<[string, number]> = [
      ["2026-11-18T07:00", 1], ["2026-11-18T08:00", 1],
      ["2026-11-18T10:00", 2], ["2026-11-18T14:00", 2],
      ["2026-11-19T07:00", 3], ["2026-11-20T07:00", 3],
      ["2026-11-21T07:00", 4], ["2026-11-22T07:00", 4],
    ];
    for (const [at, version] of ticks) await tick(database, providers, `${at}:00.000Z`, text(version));

    expect(attempts(database).map(({ outcome }) => outcome)).toEqual(Array(MAX_UNCERTAIN_OUTCOMES_PER_JOB).fill("uncertain"));
    expect(textJobs(database).map(({ status }) => status)).toEqual(["uncertain_exhausted"]);
    expect(providers.openRouter.requests).toHaveLength(MAX_UNCERTAIN_OUTCOMES_PER_JOB);
  });

  for (const [name, code] of [["DNS", "ENOTFOUND"], ["connect", "ECONNREFUSED"], ...TLS_FAILURE_CODES.map((tls) => [`TLS ${tls}`, tls] as const)]) {
    test(`a ${name} failure before the request was fully sent is transient and retried`, async () => {
      const { database } = await authorizedGames();
      const providers = apis();
      providers.openRouter.reply("chat", { network: `${name} failure`, code });

      const failed = await tick(database, providers, "2026-11-18T07:00:00.000Z");

      expect(textJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual([{ status: "queued", attempt_count: 1, error: "transient:network" }]);
      expect(failed.mediaProcessing?.cost.uncertain).toBe(0);
      await tick(database, providers, "2026-11-18T07:15:00.000Z");
      expect(textJobs(database).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    });
  }

  test("a restart with the database reopened while a request is in flight makes the item uncertain: it returns to the queue and is resent once with backoff", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    // The process stops while the request is in flight: its database handle closes before any answer is recorded.
    providers.openRouter.onChat = () => {
      expect(committedInFlight(database).map(({ stage }) => stage)).toEqual(["extraction"]);
      database.reopen();
      throw new Error("process stopped");
    };
    const stopped = await tick(database, providers, "2026-11-18T07:00:00.000Z");
    expect(stopped.status).toBe("error");
    providers.openRouter.onChat = undefined;

    const restarted = await tick(database, providers, "2026-11-18T07:05:00.000Z");

    expect(providers.openRouter.requests).toHaveLength(1);
    expect(textJobs(database).map(({ status, attempt_count, next_attempt_at, error }) => ({ status, attempt_count, next_attempt_at, error }))).toEqual([
      { status: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T07:20:00.000Z", error: "uncertain:in_flight_at_startup" },
    ]);
    expect(restarted.mediaProcessing?.cost.uncertain).toBe(1);

    await tick(database, providers, "2026-11-18T07:20:00.000Z");
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "synthesis"]);
    expect(attempts(database).filter(({ stage }) => stage === "extraction").map(({ attempt, outcome, error }) => ({ attempt, outcome, error }))).toEqual([
      { attempt: 1, outcome: "uncertain", error: "uncertain:in_flight_at_startup" },
      { attempt: 2, outcome: "succeeded", error: null },
    ]);
  });

  test("a game's Overview waits for the resend of an uncertain extraction, then cites every article", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 2 });
    const providers = apis();
    providers.openRouter.reply("chat", { network: "socket closed before the response" });
    const urls = sourceUrls(database);

    await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: "extraction", status: "queued" },
      { stage: "extraction", status: "succeeded" },
    ]);
    await tick(database, providers, "2026-11-18T07:15:00.000Z");
    const synthesis = providers.openRouter.requests.filter((request) => request.stage === "synthesis");
    expect(synthesis).toHaveLength(1);
    expect([...synthesis[0]!.urls].sort()).toEqual([...urls].sort());
    expect([...(await detailOverview(database, CYBERPUNK))!.statements[0]!.sourceUrls].sort()).toEqual([...urls].sort());
  });
});

/** The source of every extraction request from index `from`, in request order, by the generation id each answer recorded. */
function extractedSources(database: TestDatabase, providers: Apis, from = 0): number[] {
  const byGeneration = new Map(database.native.query<{ generation_id: string; source_id: number }, []>("SELECT generation_id, source_id FROM media_processing_jobs WHERE stage = 'extraction' AND generation_id IS NOT NULL").all().map((row) => [row.generation_id, row.source_id]));
  return providers.openRouter.requests.map((request, index) => ({ request, generation: `gen-${index + 1}` }))
    .slice(from)
    .filter(({ request }) => request.stage === "extraction")
    .map(({ generation }) => byGeneration.get(generation)!);
}

describe("per-tick bound", () => {
  test("a tick sends at most the configured number of requests; the rest wait for the next tick in queue order", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 5 });
    const providers = apis();
    const sources = database.native.query<{ id: number }, []>("SELECT id FROM media_sources ORDER BY id").all().map(({ id }) => id);

    const first = await tick(database, providers, "2026-11-18T07:00:00.000Z", { paidSubmissionsPerTick: 2 });
    expect(extractedSources(database, providers)).toEqual(sources.slice(0, 2));
    expect(first.mediaProcessing?.queued.openrouter).toBe(3);

    await tick(database, providers, "2026-11-18T07:15:00.000Z", { paidSubmissionsPerTick: 2 });
    await tick(database, providers, "2026-11-18T07:30:00.000Z", { paidSubmissionsPerTick: 2 });

    expect(extractedSources(database, providers)).toEqual(sources);
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "extraction", "extraction", "extraction", "synthesis"]);
  });

  test("a tick stops sending once its elapsed-time bound is spent; the rest wait for the next tick in queue order", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 5 });
    const providers = apis();
    const sources = database.native.query<{ id: number }, []>("SELECT id FROM media_sources ORDER BY id").all().map(({ id }) => id);
    // Each request takes a minute; a tick may spend two and a half.
    let elapsed = 0;
    providers.openRouter.onChat = () => { elapsed += 60_000; };
    const options = { paidWorkTimeBudgetMs: 150_000, paidWorkClock: () => elapsed };

    const first = await tick(database, providers, "2026-11-18T07:00:00.000Z", options);
    expect(extractedSources(database, providers)).toEqual(sources.slice(0, 3));
    expect(first.mediaProcessing?.queued.openrouter).toBe(2);
    expect(textJobs(database).filter((job) => job.status === "queued").every((job) => job.attempt_count === 0 && job.next_attempt_at === null)).toBe(true);

    await tick(database, providers, "2026-11-18T07:15:00.000Z", options);
    expect(extractedSources(database, providers)).toEqual(sources);
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "extraction", "extraction", "extraction", "synthesis"]);
  });
});

describe("input cap", () => {
  test("input over the cap by the conservative local estimate is refused before sending, and the output caps are sent with every request", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 2 });
    const providers = apis();
    const [oversized] = sourceUrls(database);

    await tick(database, providers, "2026-11-18T07:00:00.000Z", { outlet: (url) => (url === oversized ? new Response(oversizedArticleHtml(CYBERPUNK)) : undefined) });

    expect(textJobs(database).map(({ stage, status, error }) => ({ stage, status, error }))).toEqual([
      { stage: "extraction", status: "refused", error: "input_token_cap" },
      { stage: "extraction", status: "succeeded", error: null },
      { stage: "synthesis", status: "succeeded", error: null },
    ]);
    expect(manualProcessingOutcome(database).stopReasons).toContain("input_token_cap");
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis"]);
    const caps = database.native.query<{ stage: string; max_output_tokens: number }, []>("SELECT stage, max_output_tokens FROM media_processing_jobs WHERE status = 'succeeded' AND stage IN ('extraction', 'synthesis') ORDER BY id").all();
    expect(providers.openRouter.requests.map((request) => request.body.max_tokens)).toEqual(caps.map((cap) => cap.max_output_tokens));
    // Actual token usage comes from the provider.
    expect(database.native.query("SELECT usage_json FROM media_processing_jobs WHERE status = 'succeeded' AND stage = 'extraction'").get()).toEqual({ usage_json: JSON.stringify({ promptTokens: 1_000, completionTokens: 100 }) });
  });

  /** An article of `characters` characters of plain text, whose last words are `ending`. */
  const longArticle = (characters: number, ending: string) => {
    const sentence = "The campaign rewards careful build experimentation across its systems. ";
    const body = sentence.repeat(Math.ceil(characters / sentence.length)).slice(0, characters - ending.length) + ending;
    return `<!doctype html><html><body><article><h1>Cyberpunk 2077 Review</h1><p>${body}</p></article></body></html>`;
  };

  test("a long article under the cap is sent whole, never cut short", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.output("extraction", { observations: [
      mediaObservation(CYBERPUNK, "builds", "finding", "The campaign rewards careful build experimentation across its systems.", "The campaign rewards careful build experimentation across its systems."),
    ] });

    await tick(database, providers, "2026-11-18T07:00:00.000Z", { outlet: () => new Response(longArticle(150_000, "Closing verdict marker.")) });

    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([{ stage: "extraction", status: "succeeded" }, { stage: "synthesis", status: "succeeded" }]);
    expect(JSON.stringify(providers.openRouter.requests[0]!.body.messages)).toContain("Closing verdict marker.");
  });

  test("an article over the cap is refused as input_token_cap with the reason recorded, never sent cut short", async () => {
    const { database } = await authorizedGames();
    const providers = apis();

    await tick(database, providers, "2026-11-18T07:00:00.000Z", { outlet: () => new Response(longArticle(200_000, "Closing verdict marker.")) });

    expect(textJobs(database).map(({ stage, status, error }) => ({ stage, status, error }))).toEqual([{ stage: "extraction", status: "refused", error: "input_token_cap" }]);
    expect(manualProcessingOutcome(database).stopReasons).toContain("input_token_cap");
    expect(providers.openRouter.requests).toHaveLength(0);
  });
});

/** A current-key answer: the key's remaining limit and its budgets. */
function keyAnswer(limitRemaining: number | null, budgets: Array<{ scope: string; remaining_usd: number }> = []): OpenRouterReply {
  const budget = (entry: { scope: string; remaining_usd: number }) => ({ scope: entry.scope, guardrail_id: null, budget_id: null, limit_usd: 10, spend_usd: 10 - entry.remaining_usd, remaining_usd: entry.remaining_usd, reset_interval: "monthly", resets_at: "2026-12-01T00:00:00.000Z", include_byok: false });
  return { status: 200, body: { data: { label: "vaporstats", limit: limitRemaining === null ? null : 10, limit_remaining: limitRemaining, limit_reset: null, budgets: budgets.map(budget), effective_budget: budgets.length > 0 ? budget(budgets[0]!) : null, usage: 6 } } };
}

/** A database whose text work OpenRouter paused for its key limit at 07:00 on 2026-11-18. */
async function pausedForKeyLimit() {
  const setup = await authorizedGames();
  const providers = apis();
  providers.openRouter.reply("chat", openRouterKeyLimit(402));
  await tick(setup.database, providers, "2026-11-18T07:00:00.000Z");
  return { ...setup, providers };
}

describe("daily OpenRouter credit check", () => {
  for (const [name, answer] of [
    ["limit_remaining above zero and no spent budget", keyAnswer(4.2, [{ scope: "member", remaining_usd: 3 }])],
    ["limit_remaining null, a key without a limit", keyAnswer(null)],
  ] as const) {
    test(`lifts the text-generation pause in the first tick at or after 06:00 UTC when the key reports ${name}`, async () => {
      const { database, providers } = await pausedForKeyLimit();

      // The 18th's check ran in its first tick, at 07:00, before the pause.
      const keyChecks = () => providers.openRouter.calls.filter((call) => call.kind === "key").length;
      const before = await tick(database, providers, "2026-11-19T05:45:00.000Z");
      expect(before.mediaProcessing?.providers.openrouter.paused).toBe(true);
      expect(keyChecks()).toBe(1);

      providers.openRouter.reply("key", answer);
      const checked = await tick(database, providers, "2026-11-19T06:00:00.000Z");

      expect(checked.mediaProcessing?.providers.openrouter).toMatchObject({ paused: false, reason: null, checkedAt: "2026-11-19T06:00:00.000Z", checkOutcome: "credit_remaining" });
      expect(textJobs(database).map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
      await tick(database, providers, "2026-11-19T23:45:00.000Z");
      expect(keyChecks()).toBe(2);
    });
  }

  for (const [name, answer, reason] of [
    ["limit_remaining at zero", keyAnswer(0), "key_limit"],
    ["a spent workspace budget", keyAnswer(null, [{ scope: "workspace", remaining_usd: 0 }]), "workspace_budget"],
    ["a spent guardrail budget", keyAnswer(5, [{ scope: "api_key", remaining_usd: -0.5 }]), "guardrail_budget"],
  ] as const) {
    test(`keeps text generation paused when the key reports ${name}, and records the check`, async () => {
      const { database, providers } = await pausedForKeyLimit();
      providers.openRouter.reply("key", answer);

      const checked = await tick(database, providers, "2026-11-19T06:00:00.000Z");

      expect(checked.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason, checkedAt: "2026-11-19T06:00:00.000Z", checkOutcome: reason });
      expect(providers.openRouter.requests).toHaveLength(1);
      expect(textJobs(database).map(({ status, attempt_count }) => ({ status, attempt_count }))).toEqual([{ status: "queued", attempt_count: 0 }]);
    });
  }

  test("a check without a usable answer keeps the pause and records its outcome", async () => {
    const { database, providers } = await pausedForKeyLimit();
    providers.openRouter.reply("key", { status: 503, body: { error: { code: 503, message: "unavailable" } } });

    const checked = await tick(database, providers, "2026-11-19T06:00:00.000Z");

    expect(checked.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "key_limit", pausedAt: "2026-11-18T07:00:00.000Z", checkedAt: "2026-11-19T06:00:00.000Z", checkOutcome: "check_failed:http_503" });
    expect(providers.openRouter.requests).toHaveLength(1);
  });

  test("malformed HTTP 200 key JSON keeps the pause and records an invalid answer", async () => {
    const { database, providers } = await pausedForKeyLimit();
    providers.openRouter.reply("key", { status: 200, raw: '{"data":' });

    const checked = await tick(database, providers, "2026-11-19T06:00:00.000Z");

    expect(checked.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "key_limit", checkOutcome: "check_failed:invalid_answer" });
  });

  test("a check whose key is rejected pauses text generation with reason invalid_key", async () => {
    const { database, providers } = await pausedForKeyLimit();
    providers.openRouter.reply("key", OPENROUTER_INVALID_KEY);

    const checked = await tick(database, providers, "2026-11-19T06:00:00.000Z");

    expect(checked.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "invalid_key", checkOutcome: "invalid_key" });
  });

  test("a check answered with a 200 that holds only an error is classified by the error's code", async () => {
    const { database, providers } = await pausedForKeyLimit();
    providers.openRouter.reply("key", { status: 200, body: { error: { code: 401, message: "User not found" } } });

    const checked = await tick(database, providers, "2026-11-19T06:00:00.000Z");

    expect(checked.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "invalid_key", checkOutcome: "invalid_key" });
  });

  test("runs in a tick without paid work, and a key reported without credit pauses work queued later until a check finds credit", async () => {
    const database = openTestDatabase("vaporstats-openrouter-");
    cleanups.push(database.cleanup);
    seedApps(database.native, [CYBERPUNK]);
    const providers = apis();
    providers.openRouter.reply("key", keyAnswer(0));

    const idle = await tick(database, providers, "2026-11-18T06:30:00.000Z");
    expect(idle.mediaDailyRun?.day).toBe("2026-11-18");
    expect(idle.mediaProcessing?.submitted ?? 0).toBe(0);
    expect(providers.openRouter.calls).toEqual([{ kind: "key" }]);

    insertSources(database.native, CYBERPUNK, "initial", 1);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:later", [CYBERPUNK]));
    const held = await tick(database, providers, "2026-11-18T07:00:00.000Z");
    expect(held.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "key_limit", pausedAt: "2026-11-18T06:30:00.000Z", checkedAt: "2026-11-18T06:30:00.000Z", checkOutcome: "key_limit" });
    expect(providers.openRouter.requests).toEqual([]);

    const resumed = await tick(database, providers, "2026-11-19T06:00:00.000Z");
    expect(resumed.mediaProcessing?.providers.openrouter).toMatchObject({ paused: false, checkOutcome: "credit_remaining" });
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis"]);
  });
});

/** The game detail the Internal website API serves for `appid`, with Media Discovery public. */
async function gameDetail(database: TestDatabase, appid: number) {
  process.env.MEDIA_OVERVIEW_PUBLIC = "true";
  const response = await handleGameDetailRequest(new Request(`https://vaporstats.test/api/games/${appid}/detail`), database.db, appid);
  expect(response.status).toBe(200);
  return (await response.json() as { data: { mediaOverview: { statements: Array<{ sourceUrls: string[] }> } | null; mediaMatches: Array<{ dimension: string; matchedGame: { appid: number } }> } }).data;
}

const GEMINI_TEXT_MODEL = "gemini-3.1-flash-lite";

/**
 * Rewrites `appid`'s active extractions and Overview, and the links of its
 * embeddings, as Gemini built them before text generation moved to
 * OpenRouter: the Gemini model, with every stored identity consistent with it.
 */
function builtByGemini(database: TestDatabase, appid: number): void {
  const extractions = database.native.query<{ id: number; source_id: number }, [number]>("SELECT e.id, e.source_id FROM media_article_extractions AS e JOIN media_sources AS s ON s.id = e.source_id WHERE s.appid = ? AND e.active = 1 ORDER BY e.source_id").all(appid);
  for (const extraction of extractions) {
    const identity = `gemini-extraction-${extraction.source_id}`;
    database.native.prepare("UPDATE media_article_extractions SET model = ?, input_identity = ? WHERE id = ?").run(GEMINI_TEXT_MODEL, identity, extraction.id);
    database.native.prepare("UPDATE media_sources SET processing_input_identity = ? WHERE id = ?").run(identity, extraction.source_id);
    database.native.prepare("UPDATE media_tag_memberships SET extraction_input_identity = ? WHERE source_id = ?").run(identity, extraction.source_id);
  }
  const overview = database.native.query<{ id: number; input_identity: string; config_version: string }, [number]>("SELECT id, input_identity, config_version FROM media_game_overviews WHERE appid = ? AND active = 1").get(appid)!;
  const overviewIdentity = createHash("sha256").update(stableJson({
    stage: "synthesis",
    appid,
    model: GEMINI_TEXT_MODEL,
    configVersion: overview.config_version,
    extractions: extractions.map((extraction) => ({ sourceId: extraction.source_id, inputIdentity: `gemini-extraction-${extraction.source_id}` })),
  })).digest("hex");
  database.native.prepare("UPDATE media_game_overviews SET model = ?, input_identity = ? WHERE id = ?").run(GEMINI_TEXT_MODEL, overviewIdentity, overview.id);
  database.native.prepare("UPDATE media_game_embeddings SET overview_input_identity = ? WHERE appid = ? AND overview_input_identity = ?").run(overviewIdentity, appid, overview.input_identity);
  database.native.prepare("UPDATE media_processing_jobs SET model = ? WHERE appid = ? AND stage IN ('extraction', 'synthesis')").run(GEMINI_TEXT_MODEL, appid);
}

/** A database where Gemini built Cyberpunk 2077's extraction, Overview and embedding before the move to OpenRouter. */
async function geminiBuiltGame() {
  const setup = await authorizedGames();
  const providers = apis();
  await tick(setup.database, providers, "2026-11-18T03:00:00.000Z");
  builtByGemini(setup.database, CYBERPUNK);
  return { ...setup, providers, requestsBefore: providers.openRouter.requests.length, submissionsBefore: providers.gemini.submitted.length };
}

describe("cutover from Gemini text generation", () => {
  test("Gemini text batches submitted before the move keep being polled and applied, or rejected as stale, while waiting Gemini text items move to OpenRouter", async () => {
    const database = openUpgradedTestDatabase("0023_openrouter_text_generation", (native) => {
      seedApps(native, [CYBERPUNK, BALDURS_GATE, HADES_II]);
      for (const appid of [CYBERPUNK, BALDURS_GATE, HADES_II]) insertSources(native, appid, "initial", 1);
      const runId = insertCompletedRun(native, "initial:cutover:test", [CYBERPUNK, BALDURS_GATE, HADES_II]);
      native.prepare("INSERT INTO media_processing_authorizations (run_id, status, affected_source_ids) VALUES (?, 'waiting', '[]')").run(runId);
      const [cyberpunk, baldursGate, hades] = native.query<{ id: number }, []>("SELECT id FROM media_sources ORDER BY id").all().map(({ id }) => id);
      // Cyberpunk's batch still describes its article; Baldur's Gate's article changed after its batch was submitted.
      insertSubmittedGeminiExtraction(native, { runId, sourceId: cyberpunk!, batch: "batches/pre-1" });
      insertSubmittedGeminiExtraction(native, { runId, sourceId: baldursGate!, batch: "batches/pre-2" });
      native.prepare("UPDATE media_sources SET processing_input_identity = 'changed-since-submission' WHERE id = ?").run(baldursGate!);
      // Hades II's extraction waited in the Gemini queue, with Gemini backoff.
      native.prepare(
        `INSERT INTO media_processing_jobs (run_id, stage, appid, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider, enqueued_at, attempt_count, next_attempt_at, error, usage_json)
         VALUES (?, 'extraction', ?, ?, ?, ?, 'gemini-3.1-flash-lite', 'media-extraction-2026-09-13-v3', 0, 1200, 0, 0, 'queued', 'gemini', '2026-11-10T00:00:00.000Z', 3, '2026-11-30T00:00:00.000Z', 'transient:http_503', '{}')`,
      ).run(runId, HADES_II, hades!, `extraction:${hades}:run:${runId}`, `source:${hades}`);
      native.prepare("UPDATE media_sources SET processing_run_id = ? WHERE id = ?").run(runId, hades!);
    });
    cleanups.push(database.cleanup);
    expect(database.native.query("SELECT stage, provider, model, status, attempt_count, next_attempt_at, error FROM media_processing_jobs ORDER BY id").all()).toEqual([
      { stage: "extraction", provider: "gemini", model: GEMINI_TEXT_MODEL, status: "submitted", attempt_count: 0, next_attempt_at: null, error: null },
      { stage: "extraction", provider: "gemini", model: GEMINI_TEXT_MODEL, status: "submitted", attempt_count: 0, next_attempt_at: null, error: null },
      { stage: "extraction", provider: "openrouter", model: HAIKU, status: "queued", attempt_count: 0, next_attempt_at: null, error: null },
    ]);
    const providers = apis();
    providers.gemini.batch("batches/pre-1", "extraction");
    providers.gemini.batch("batches/pre-2", "extraction");
    providers.openRouter.output("synthesis", (request: OpenRouterRequestRecord) => {
      const reply = overviewOutputForUrls(request.urls)(request) as { statements: Array<{ text: string }> };
      reply.statements[0]!.text = "Combat supports flexible builds.";
      return reply;
    });


    const drained = await tick(database, providers, "2026-11-18T03:00:00.000Z");

    expect(database.native.query("SELECT appid, stage, provider, model, status FROM media_processing_jobs WHERE stage IN ('extraction', 'synthesis') ORDER BY id").all()).toEqual([
      { appid: CYBERPUNK, stage: "extraction", provider: "gemini", model: GEMINI_TEXT_MODEL, status: "succeeded" },
      { appid: BALDURS_GATE, stage: "extraction", provider: "gemini", model: GEMINI_TEXT_MODEL, status: "stale" },
      { appid: HADES_II, stage: "extraction", provider: "openrouter", model: HAIKU, status: "succeeded" },
      { appid: CYBERPUNK, stage: "synthesis", provider: "openrouter", model: HAIKU, status: "succeeded" },
      { appid: HADES_II, stage: "synthesis", provider: "openrouter", model: HAIKU, status: "succeeded" },
    ]);
    expect(database.native.query("SELECT s.appid, e.model FROM media_article_extractions AS e JOIN media_sources AS s ON s.id = e.source_id WHERE e.active = 1 ORDER BY s.appid").all()).toEqual([
      { appid: CYBERPUNK, model: GEMINI_TEXT_MODEL },
      { appid: HADES_II, model: HAIKU },
    ]);
    // No text is submitted to Gemini; only embeddings are.
    expect(providers.gemini.submitted.every((key) => key.startsWith("embedding:"))).toBe(true);
    expect(providers.openRouter.requests.map((request) => request.stage).sort()).toEqual(["extraction", "synthesis", "synthesis"]);
    expect(database.native.query("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE status = 'submitted' AND stage IN ('extraction', 'synthesis')").get()).toEqual({ count: 0 });
    expect(drained.mediaProcessing?.outputs.skipped).toBe(1);
    expect((await gameDetail(database, CYBERPUNK)).mediaOverview).not.toBeNull();
  });

  /** A database holding Cyberpunk 2077's one article, whose extraction Gemini Batch accepted as `batches/pre-1` before the move to OpenRouter. */
  function submittedGeminiExtraction() {
    const database = openTestDatabase("vaporstats-openrouter-");
    cleanups.push(database.cleanup);
    seedApps(database.native, [CYBERPUNK]);
    insertSources(database.native, CYBERPUNK, "initial", 1);
    const runId = insertCompletedRun(database.native, "initial:cutover:returned", [CYBERPUNK]);
    database.native.prepare("INSERT INTO media_processing_authorizations (run_id, status, affected_source_ids) VALUES (?, 'waiting', '[]')").run(runId);
    const source = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").get()!;
    insertSubmittedGeminiExtraction(database.native, { runId, sourceId: source.id, batch: "batches/pre-1" });
    return database;
  }
  const extractionItem = (database: TestDatabase) => database.native.query<{ provider: string; model: string; status: string; attempt_count: number }, []>(
    "SELECT provider, model, status, attempt_count FROM media_processing_jobs WHERE stage = 'extraction'",
  ).get();

  const returned: Array<[string, GeminiReply, { attempt_count: number; geminiPause: "prepay_depleted" | null }]> = [
    ["expired", { status: 200, body: { metadata: { state: "BATCH_STATE_EXPIRED" } } }, { attempt_count: 1, geminiPause: null }],
    ["ended for depleted Prepay credits", { status: 200, body: { metadata: { state: "BATCH_STATE_FAILED" }, error: { message: "Your prepayment credits are depleted." } } }, { attempt_count: 0, geminiPause: "prepay_depleted" }],
  ];
  for (const [name, poll, expected] of returned) {
    test(`a Gemini text batch ${name} after the move returns its item to the OpenRouter queue for Claude Haiku 5.5, and its cost and model are OpenRouter's`, async () => {
      const database = submittedGeminiExtraction();
      const providers = apis();
      providers.gemini.reply("poll", poll);

      const first = await tick(database, providers, "2026-11-18T03:00:00.000Z");

      expect(first.mediaProcessing?.providers.gemini.reason ?? null).toBe(expected.geminiPause);
      expect(extractionItem(database)).toMatchObject({ provider: "openrouter", model: HAIKU, attempt_count: expected.attempt_count });
      await tick(database, providers, "2026-11-18T03:15:00.000Z");

      expect(extractionItem(database)).toMatchObject({ provider: "openrouter", model: HAIKU, status: "succeeded" });
      expect(database.native.query("SELECT model FROM media_article_extractions WHERE active = 1").all()).toEqual([{ model: HAIKU }]);
      expect(providers.openRouter.requests.filter((request) => request.stage === "extraction")).toHaveLength(1);
      expect(providers.gemini.submitted.every((key) => key.startsWith("embedding:"))).toBe(true);
      const cost = database.native.query<{ provider: string; charged: number }, []>("SELECT provider, SUM(charged_microusd) AS charged FROM media_processing_jobs WHERE stage = 'extraction' GROUP BY provider").all();
      expect(cost).toEqual([{ provider: "openrouter", charged: 150 }]);
    });
  }

  test("a Gemini text batch returned after the move while no OpenRouter key is configured waits paused for missing_key, never uncertain", async () => {
    const database = submittedGeminiExtraction();
    const providers = apis();
    providers.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_EXPIRED" } } });

    await tick(database, providers, "2026-11-18T03:00:00.000Z", { openRouterApiKey: undefined });
    const waiting = await tick(database, providers, "2026-11-18T03:15:00.000Z", { openRouterApiKey: undefined });

    expect(extractionItem(database)).toMatchObject({ provider: "openrouter", model: HAIKU, status: "queued" });
    expect(waiting.mediaProcessing?.providers.openrouter).toMatchObject({ paused: true, reason: "missing_key" });
    expect(waiting.mediaProcessing?.cost.uncertain).toBe(0);
    expect(providers.openRouter.requests).toHaveLength(0);
  });

  test("a Gemini Overview batch expired after the move returns to the OpenRouter queue with its Claude Haiku 5.5 identity, and builds the Overview", async () => {
    const { database, runId, providers } = await geminiBuiltGame();
    const overview = database.native.query<{ input_identity: string; config_version: string }, []>("SELECT input_identity, config_version FROM media_game_overviews WHERE active = 1").get()!;
    database.native.prepare("UPDATE media_game_overviews SET active = 0").run();
    database.native.prepare(
      `INSERT INTO media_processing_jobs (run_id, stage, appid, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider, enqueued_at, provider_batch_id, usage_json, submitted_at)
       VALUES (?, 'synthesis', ?, NULL, 'synthesis:pre-cutover', ?, ?, ?, 100, 3200, 0, 0, 'submitted', 'gemini', '2026-11-10T00:00:00.000Z', 'batches/pre-synthesis', '{}', '2026-11-10T00:00:00.000Z')`,
    ).run(runId, CYBERPUNK, overview.input_identity, GEMINI_TEXT_MODEL, overview.config_version);
    const extraction = database.native.query<{ source_id: number; input_identity: string }, []>("SELECT source_id, input_identity FROM media_article_extractions WHERE active = 1").get()!;
    const haikuIdentity = createHash("sha256").update(stableJson({ stage: "synthesis", appid: CYBERPUNK, model: HAIKU, configVersion: overview.config_version, extractions: [{ sourceId: extraction.source_id, inputIdentity: extraction.input_identity }] })).digest("hex");
    const synthesisRequestsBefore = providers.openRouter.requests.filter((request) => request.stage === "synthesis").length;
    providers.gemini.reply("poll", { status: 200, body: { metadata: { state: "BATCH_STATE_EXPIRED" } } });

    await tick(database, providers, "2026-11-18T05:00:00.000Z");
    const item = () => database.native.query("SELECT provider, model, input_identity, status FROM media_processing_jobs WHERE request_key = 'synthesis:pre-cutover'").get();
    expect(item()).toEqual({ provider: "openrouter", model: HAIKU, input_identity: haikuIdentity, status: "queued" });
    await tick(database, providers, "2026-11-18T05:15:00.000Z");

    expect(item()).toEqual({ provider: "openrouter", model: HAIKU, input_identity: haikuIdentity, status: "succeeded" });
    expect(database.native.query("SELECT model, input_identity FROM media_game_overviews WHERE active = 1").all()).toEqual([{ model: HAIKU, input_identity: haikuIdentity }]);
    expect(providers.openRouter.requests.filter((request) => request.stage === "synthesis")).toHaveLength(synthesisRequestsBefore + 1);
  });

  test("existing Gemini extractions and Overviews stay active, and the model change queues no work, even for a correction set", async () => {
    const { database, providers, requestsBefore, submissionsBefore } = await geminiBuiltGame();
    const overviewBefore = database.native.query("SELECT id, model, input_identity FROM media_game_overviews WHERE active = 1").all();

    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:rerun", [CYBERPUNK]));
    await tick(database, providers, "2026-11-18T04:00:00.000Z");
    const sourceIds = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").all().map(({ id }) => id);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:correction", [CYBERPUNK]), { affectedSourceIds: sourceIds });
    const corrected = await tick(database, providers, "2026-11-18T04:15:00.000Z");

    expect(providers.openRouter.requests).toHaveLength(requestsBefore);
    expect(providers.gemini.submitted).toHaveLength(submissionsBefore);
    expect(corrected.mediaProcessing?.queued).toEqual({ gemini: 0, openrouter: 0 });
    expect(database.native.query("SELECT id, model, input_identity FROM media_game_overviews WHERE active = 1").all()).toEqual(overviewBefore);
    expect(database.native.query("SELECT model FROM media_article_extractions WHERE active = 1").all()).toEqual([{ model: GEMINI_TEXT_MODEL }]);
    expect((await gameDetail(database, CYBERPUNK)).mediaOverview?.statements[0]?.sourceUrls).toEqual(sourceUrls(database));
  });

  test("an Overview built from a mix of Gemini and Haiku extractions synthesizes and serves correctly", async () => {
    const { database, providers, requestsBefore } = await geminiBuiltGame();
    insertSources(database.native, CYBERPUNK, "initial", 1, MEDIA_OUTLETS[1]);
    const [geminiUrl, haikuUrl] = sourceUrls(database);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:new-source", [CYBERPUNK]));

    await tick(database, providers, "2026-11-18T04:00:00.000Z");

    expect(providers.openRouter.requests.slice(requestsBefore).map((request) => request.stage)).toEqual(["extraction", "synthesis"]);
    expect(providers.openRouter.requests.at(-1)!.urls.sort()).toEqual([geminiUrl!, haikuUrl!].sort());
    expect(database.native.query("SELECT s.original_url, e.model FROM media_article_extractions AS e JOIN media_sources AS s ON s.id = e.source_id WHERE e.active = 1 ORDER BY s.id").all()).toEqual([
      { original_url: geminiUrl, model: GEMINI_TEXT_MODEL },
      { original_url: haikuUrl, model: HAIKU },
    ]);
    expect(database.native.query("SELECT model FROM media_game_overviews WHERE active = 1").all()).toEqual([{ model: HAIKU }]);
    expect((await gameDetail(database, CYBERPUNK)).mediaOverview?.statements[0]?.sourceUrls.sort()).toEqual([geminiUrl!, haikuUrl!].sort());
  });

  test("embeddings stay on gemini-embedding-2 at 3,072 dimensions, and a vector stored before the move and a new one match in live matching", async () => {
    const { database, providers } = await geminiBuiltGame();
    seedApps(database.native, [BALDURS_GATE]);
    insertSources(database.native, BALDURS_GATE, "initial", 1);
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:second-game", [BALDURS_GATE]));

    await tick(database, providers, "2026-11-18T04:00:00.000Z");

    expect(database.native.query("SELECT appid, model, dimensions, length(vector) AS bytes FROM media_game_embeddings WHERE active = 1 ORDER BY appid").all()).toEqual([
      { appid: BALDURS_GATE, model: "gemini-embedding-2", dimensions: 3072, bytes: 3072 * 4 },
      { appid: CYBERPUNK, model: "gemini-embedding-2", dimensions: 3072, bytes: 3072 * 4 },
    ]);
    expect((await gameDetail(database, BALDURS_GATE)).mediaMatches.map((match) => match.matchedGame.appid)).toEqual([CYBERPUNK]);
    expect((await gameDetail(database, CYBERPUNK)).mediaMatches.map((match) => match.matchedGame.appid)).toEqual([BALDURS_GATE]);
  });
});

describe("credentials and private details", () => {
  test("the OpenRouter key, host addresses and article bodies stay out of logs, summaries and recorded errors", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 3 });
    const providers = apis();
    const leak = "for key test-openrouter-key at openrouter.ai (104.18.2.115)";
    providers.openRouter.reply(
      "chat",
      { network: `connect ECONNREFUSED ${leak}`, code: "ECONNREFUSED" },
      { network: `socket hang up ${leak}` },
      { status: 400, body: { error: { code: 400, message: `Invalid request ${leak}` } } },
      { status: 401, body: { error: { code: 401, message: `User not found ${leak}` } } },
    );
    providers.openRouter.reply("key", { status: 503, body: { error: { code: 503, message: `unavailable ${leak}` } } });
    const logged: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
    console.error = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
    const results: unknown[] = [];
    try {
      for (const at of ["2026-11-18T07:00:00.000Z", "2026-11-18T07:15:00.000Z"]) results.push(await tick(database, providers, at));
    } finally {
      console.log = log;
      console.error = error;
    }

    // Every failure class above was recorded.
    expect(textJobs(database).map(({ status }) => status).sort()).toEqual(["queued", "queued", "refused"]);
    expect(textJobs(database).map(({ error }) => error)).toContain("uncertain:no_response");
    expect((results[1] as { mediaProcessing: { providers: { openrouter: { reason: string } } } }).mediaProcessing.providers.openrouter.reason).toBe("invalid_key");
    const recorded = JSON.stringify([
      logged,
      results,
      database.native.query("SELECT error, usage_json, output_json FROM media_processing_jobs").all(),
      database.native.query("SELECT value FROM checkpoints WHERE key LIKE 'media:%'").all(),
    ]);
    for (const secret of ["test-openrouter-key", "openrouter.ai", "104.18.2.115", "flexible combat and memorable encounters"]) {
      expect(recorded).not.toContain(secret);
    }
  });
});
