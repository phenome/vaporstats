import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  CYBERPUNK,
  controlledGeminiApi,
  controlledOpenRouterApi,
  insertCompletedRun,
  insertSources,
  runMediaTick,
  seedApps,
  type MediaTickOptions,
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
