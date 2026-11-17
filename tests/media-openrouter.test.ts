import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  CYBERPUNK,
  controlledGeminiApi,
  controlledOpenRouterApi,
  insertCompletedRun,
  insertSources,
  OPENROUTER_CREDITS,
  OPENROUTER_GUARDRAIL_BUDGET,
  OPENROUTER_IN_FLIGHT_BUDGET,
  OPENROUTER_INVALID_KEY,
  OPENROUTER_MODERATION,
  OPENROUTER_WORKSPACE_BUDGET,
  openRouterKeyLimit,
  runMediaTick,
  seedApps,
  type MediaTickOptions,
  type OpenRouterReply,
} from "./support/media";

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
      expect(request.body.response_format).toEqual({ type: "json_object" });
      expect(request.body.max_tokens).toBeGreaterThan(0);
    }
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
      expect(paused.mediaProcessing?.outputs.skipped).toBe(0);
      expect(paused.mediaProcessing?.status).toBe("waiting");
      expect(paused.mediaProcessing?.stopReasons).toContain(`provider_paused:openrouter:${reason}`);
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
      expect(waiting.mediaProcessing?.outputs.skipped).toBe(0);
      expect(textJobs(database).map(({ status: state, attempt_count, next_attempt_at }) => ({ state, attempt_count, next_attempt_at }))).toEqual([
        { state: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T07:15:00.000Z" },
      ]);
      await tick(database, providers, "2026-11-18T07:15:00.000Z");
      expect(textJobs(database).map(({ status: state }) => state)).toEqual(["succeeded", "succeeded"]);
    });
  }

  test("a 200 whose body holds only an error is classified by the error's code", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { status: 200, body: { id: "gen-error", error: { code: 502, message: "Provider returned error", metadata: { error_type: "provider_unavailable" } } } });

    await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(textJobs(database).map(({ status, attempt_count, error }) => ({ status, attempt_count, error }))).toEqual([{ status: "queued", attempt_count: 1, error: "transient:http_502" }]);
  });

  const refusals: Array<[string, OpenRouterReply]> = [
    ["a 400 invalid request", { status: 400, body: { error: { code: 400, message: "Invalid request", metadata: { error_type: "invalid_request" } } } }],
    ["a 403 moderation flag", OPENROUTER_MODERATION],
    ["a 403 guardrail content block", { status: 403, body: { error: { code: 403, message: "Request blocked: prompt injection patterns detected", metadata: { patterns: ["ignore all previous instructions"] } } } }],
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
      expect(refused.mediaProcessing?.outputs.skipped).toBe(1);
      expect(refused.mediaProcessing?.providers.openrouter.paused).toBe(false);
      expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "synthesis"]);
      // The Overview is built from the article that succeeded.
      const urls = database.native.query<{ original_url: string }, []>("SELECT original_url FROM media_sources ORDER BY id").all().map((row) => row.original_url);
      expect((await detailOverview(database, CYBERPUNK))?.statements[0]?.sourceUrls).toEqual([urls[1]]);
    });
  }

  test("output that fails the existing parsers is a definite refusal", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.output("extraction", "not json at all");

    const refused = await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(textJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "refused", error: "invalid_output: no supported contributions" }]);
    expect(refused.mediaProcessing?.outputs.skipped).toBe(1);
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
    expect(paused.mediaProcessing?.stopReasons).toContain("provider_paused:openrouter:invalid_key");

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

  test("a client timeout after the request was sent leaves the item uncertain: reported, never resent automatically, and resent through a correction set", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { hang: true });

    const sent = await tick(database, providers, "2026-11-18T07:00:00.000Z", { openRouterTimeoutMs: 20 });

    expect(textJobs(database).map(({ stage, status, error }) => ({ stage, status, error }))).toEqual([{ stage: "extraction", status: "uncertain", error: "uncertain:timeout" }]);
    expect(sent.mediaProcessing?.cost.uncertain).toBe(1);
    expect(sent.mediaProcessing?.stopReasons).toContain("uncertain_submission");
    for (const at of ["2026-11-18T07:15:00.000Z", "2026-11-19T06:00:00.000Z"]) {
      const later = await tick(database, providers, at);
      expect(later.mediaProcessing?.cost.uncertain).toBe(1);
    }
    expect(providers.openRouter.requests).toHaveLength(1);

    // An authorized correction set covering the article resends it.
    const sourceId = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").get()!.id;
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:correction", [CYBERPUNK]), { affectedSourceIds: [sourceId] });
    await tick(database, providers, "2026-11-19T07:00:00.000Z");
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "extraction", "synthesis"]);
    expect(textJobs(database).map(({ status }) => status)).toEqual(["uncertain", "succeeded", "succeeded"]);
  });

  test("an uncertain Overview request is never resent automatically, and is resent through a correction set covering its game", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { status: 200, body: { id: "gen-ok", provider: "Anthropic", model: HAIKU, choices: [{ message: { content: JSON.stringify({ contributions: [{ text: "The combat supports flexible builds", category: "Gameplay & systems" }], traits: ["build experimentation"], qualifications: [], provenance: [] }) } }], usage: { cost: 0.0001 } } }, { hang: true });

    await tick(database, providers, "2026-11-18T07:00:00.000Z", { openRouterTimeoutMs: 20 });
    await tick(database, providers, "2026-11-19T06:00:00.000Z");
    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([{ stage: "extraction", status: "succeeded" }, { stage: "synthesis", status: "uncertain" }]);
    expect(providers.openRouter.requests).toHaveLength(2);

    const sourceId = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").get()!.id;
    await authorizeMediaProcessing(database.db, insertCompletedRun(database.native, "initial:openrouter:correction", [CYBERPUNK]), { affectedSourceIds: [sourceId] });
    await tick(database, providers, "2026-11-19T07:00:00.000Z");

    // The unchanged article keeps its extraction; only the Overview is resent.
    expect(providers.openRouter.requests.map((request) => request.stage)).toEqual(["extraction", "synthesis", "synthesis"]);
    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: "extraction", status: "succeeded" },
      { stage: "synthesis", status: "uncertain" },
      { stage: "synthesis", status: "succeeded" },
    ]);
    expect(await detailOverview(database, CYBERPUNK)).not.toBeNull();
  });

  test("a connection lost after the request was sent leaves the item uncertain", async () => {
    const { database } = await authorizedGames();
    const providers = apis();
    providers.openRouter.reply("chat", { network: "socket closed before the response" });

    await tick(database, providers, "2026-11-18T07:00:00.000Z");
    await tick(database, providers, "2026-11-18T07:15:00.000Z");

    expect(textJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "uncertain", error: "uncertain:no_response" }]);
    expect(providers.openRouter.requests).toHaveLength(1);
  });

  for (const [name, code] of [["DNS", "ENOTFOUND"], ["connect", "ECONNREFUSED"], ["TLS", "ERR_TLS_CERT_ALTNAME_INVALID"]] as const) {
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

  test("a restart with the database reopened while a request is in flight leaves the item uncertain and sends no second request", async () => {
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

    const restarted = await tick(database, providers, "2026-11-18T07:15:00.000Z");
    await tick(database, providers, "2026-11-19T06:00:00.000Z");

    expect(providers.openRouter.requests).toHaveLength(1);
    expect(textJobs(database).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "uncertain", error: "uncertain:in_flight_at_startup" }]);
    expect(restarted.mediaProcessing?.cost.uncertain).toBe(1);
  });

  test("an uncertain extraction does not block its game's Overview, which is built from the other current articles", async () => {
    const { database } = await authorizedGames({ [CYBERPUNK]: 2 });
    const providers = apis();
    providers.openRouter.reply("chat", { network: "socket closed before the response" });
    const [uncertainUrl, settledUrl] = sourceUrls(database);

    const result = await tick(database, providers, "2026-11-18T07:00:00.000Z");

    expect(textJobs(database).map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: "extraction", status: "uncertain" },
      { stage: "extraction", status: "succeeded" },
      { stage: "synthesis", status: "succeeded" },
    ]);
    const synthesis = providers.openRouter.requests.find((request) => request.stage === "synthesis")!;
    expect(synthesis.urls).toEqual([settledUrl]);
    expect(JSON.stringify(synthesis.body)).not.toContain(uncertainUrl);
    expect((await detailOverview(database, CYBERPUNK))?.statements[0]?.sourceUrls).toEqual([settledUrl]);
    expect(result.mediaProcessing?.cost.uncertain).toBe(1);
  });
});
