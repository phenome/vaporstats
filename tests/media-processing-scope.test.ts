import { afterEach, describe, expect, test } from "bun:test";
import {
  GEMINI_BATCH_CAPABILITY_VERSION,
  GEMINI_BATCH_PRICING_VERSION,
  advanceMediaProcessing,
  authorizeMediaProcessing,
  type ArticleFetch,
} from "../src/lib/media-processing";
import { listPlayableGames } from "../src/lib/catalog";
import { getMediaOverview } from "../src/lib/media-overview";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  CYBERPUNK,
  ControlledGeminiTransport,
  extractionOutput,
  insertCompletedRun,
  insertSources,
  overviewOutputForUrls,
  processingArticleHtml,
  seedApps,
} from "./support/media";

const PAID = { pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION };
const SUCCEEDED_USAGE = { inputTokens: 100, outputTokens: 20 };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

/** Lists games carrying `tag` with public Media Discovery enabled. */
async function gamesTagged(database: TestDatabase, tag: string): Promise<number[]> {
  const previous = process.env.MEDIA_OVERVIEW_PUBLIC;
  process.env.MEDIA_OVERVIEW_PUBLIC = "true";
  try {
    return (await listPlayableGames(database.db, { mediaTag: tag })).map((game) => game.appid);
  } finally {
    if (previous === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
    else process.env.MEDIA_OVERVIEW_PUBLIC = previous;
  }
}

function sourceIds(database: TestDatabase): number[] {
  return database.native.query<{ id: number }, []>("SELECT id FROM media_sources ORDER BY id").all().map(({ id }) => id);
}

/** Authorizes a fresh run for the game with `affectedSourceIds` and returns its id. */
async function authorizeRun(database: TestDatabase, key: string, affectedSourceIds: readonly number[] = []): Promise<number> {
  const runId = insertCompletedRun(database.native, `initial:${key}:test`, [CYBERPUNK]);
  await authorizeMediaProcessing(database.db, runId, { affectedSourceIds });
  return runId;
}

/** Counts outlet article fetches; `pages` overrides the article served for a URL. */
function outletArticles(pages: Record<string, string> = {}) {
  const fetched: string[] = [];
  const articleFetch: ArticleFetch = async (url) => {
    fetched.push(url);
    return pages[url] ?? processingArticleHtml(CYBERPUNK);
  };
  return { fetched, articleFetch };
}

function sourceUrls(database: TestDatabase): string[] {
  return database.native.query<{ original_url: string }, []>("SELECT original_url FROM media_sources ORDER BY id").all().map((row) => row.original_url);
}

/** A game whose `sourceCount` initial sources were extracted and synthesized by a completed first run. */
async function processedGame(sourceCount = 1) {
  const database = openTestDatabase("vaporstats-media-scope-");
  cleanups.push(database.cleanup);
  seedApps(database.native, [CYBERPUNK]);
  insertSources(database.native, CYBERPUNK, "initial", sourceCount);
  const firstRun = insertCompletedRun(database.native, "initial:first:test", [CYBERPUNK]);
  await authorizeMediaProcessing(database.db, firstRun);
  const transport = new ControlledGeminiTransport();
  for (let index = 0; index < sourceCount; index += 1) {
    transport.nextPolls.push({ state: "succeeded", output: extractionOutput(), usage: SUCCEEDED_USAGE });
  }
  transport.nextPolls.push({ state: "succeeded", output: overviewOutputForUrls(sourceUrls(database)), usage: SUCCEEDED_USAGE });
  const { articleFetch } = outletArticles();
  await advanceMediaProcessing(database.db, { runId: firstRun, transport, articleFetch, now: new Date("2026-11-01T00:00:00.000Z"), ...PAID });
  const settled = await advanceMediaProcessing(database.db, { runId: firstRun, transport, articleFetch, now: new Date("2026-11-01T00:01:00.000Z"), ...PAID });
  expect(settled.status).toBe("completed");
  return { database, transport, firstRun };
}

describe("processing scope", () => {
  test("an unchanged rerun with an empty affected set fetches no article and submits no paid work", async () => {
    const { database, transport } = await processedGame();
    const submissionsBefore = transport.submissions.length;
    const countsBefore = transport.counts.length;
    const rerun = insertCompletedRun(database.native, "initial:rerun:test", [CYBERPUNK]);
    await authorizeMediaProcessing(database.db, rerun);
    const outlet = outletArticles();

    const summary = await advanceMediaProcessing(database.db, { runId: rerun, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });

    expect(outlet.fetched).toEqual([]);
    expect(transport.submissions.length).toBe(submissionsBefore);
    expect(transport.counts.length).toBe(countsBefore);
    expect(summary.status).toBe("completed");
    expect(await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();
  });

  test("a changed affected article withdraws the game's Overview from tag results until it is rebuilt", async () => {
    const { database, transport } = await processedGame(2);
    expect(await gamesTagged(database, "build experimentation")).toEqual([CYBERPUNK]);
    const [unchanged, changed] = sourceUrls(database);
    const correction = await authorizeRun(database, "correction", [sourceIds(database)[1]!]);
    const outlet = outletArticles({ [changed!]: processingArticleHtml(CYBERPUNK).replace("flexible combat", "deliberate tactical combat") });
    transport.nextPolls.push({ state: "pending" });

    const pending = await advanceMediaProcessing(database.db, { runId: correction, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });

    expect(outlet.fetched).toEqual([changed]);
    expect(pending.outputs.invalidated).toBe(2);
    expect(await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true })).toBeNull();
    expect(await gamesTagged(database, "build experimentation")).toEqual([]);

    transport.polls.set(`batches/test-${transport.submissions.length}`, { state: "succeeded", output: extractionOutput(), usage: SUCCEEDED_USAGE });
    transport.nextPolls.push({ state: "succeeded", output: overviewOutputForUrls([unchanged!, changed!]), usage: SUCCEEDED_USAGE });
    await advanceMediaProcessing(database.db, { runId: correction, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:01:00.000Z"), ...PAID });
    const rebuilt = await advanceMediaProcessing(database.db, { runId: correction, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:02:00.000Z"), ...PAID });

    expect(rebuilt.status).toBe("completed");
    expect(rebuilt.outputs).toEqual({ new: 0, reused: 1, replaced: 2, invalidated: 2, skipped: 0 });
    expect(await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();
    expect(await gamesTagged(database, "build experimentation")).toEqual([CYBERPUNK]);
    expect(outlet.fetched).toEqual([changed]);
  });
});
