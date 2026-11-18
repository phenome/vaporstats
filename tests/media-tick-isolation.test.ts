import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaProcessing } from "../src/lib/media-processing";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  CYBERPUNK,
  controlledGeminiApi,
  experimentWorld,
  controlledOpenRouterApi,
  HADES_II,
  insertCompletedRun,
  insertSources,
  MALFORMED_ARTICLE_BODIES,
  runMediaTick,
  seedApps,
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
