import { createHash } from "node:crypto";
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
import { MEDIA_OUTLETS } from "../src/lib/media-discovery";
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
  stableJson,
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

type VersionChange = "extraction" | "synthesis" | "cleanup";

/**
 * Rewrites the game's stored output as if an earlier `change` version built
 * it, keeping the stored identities consistent with those versions, so the
 * current code runs with a newer version than its output.
 */
function builtUnderEarlierVersion(database: TestDatabase, change: VersionChange): void {
  const extraction = database.native.query<{ id: number; source_id: number; input_identity: string; model: string }, []>("SELECT id, source_id, input_identity, model FROM media_article_extractions WHERE active = 1").get()!;
  const extractionIdentity = change === "synthesis" ? extraction.input_identity : `earlier-${change}-extraction`;
  if (change === "extraction") database.native.prepare("UPDATE media_article_extractions SET config_version = 'media-extraction-earlier', input_identity = ? WHERE id = ?").run(extractionIdentity, extraction.id);
  if (change === "cleanup") {
    database.native.prepare("UPDATE media_article_extractions SET cleanup_version = 'media-cleanup-earlier', input_identity = ? WHERE id = ?").run(extractionIdentity, extraction.id);
    database.native.prepare("UPDATE media_sources SET cleanup_version = 'media-cleanup-earlier' WHERE id = ?").run(extraction.source_id);
  }
  database.native.prepare("UPDATE media_tag_memberships SET extraction_input_identity = ? WHERE source_id = ?").run(extractionIdentity, extraction.source_id);
  const overview = database.native.query<{ id: number; config_version: string }, []>("SELECT id, config_version FROM media_game_overviews WHERE active = 1").get()!;
  const configVersion = change === "synthesis" ? "media-synthesis-earlier" : overview.config_version;
  const overviewIdentity = createHash("sha256").update(stableJson({ stage: "synthesis", appid: CYBERPUNK, model: extraction.model, configVersion, extractions: [{ sourceId: extraction.source_id, inputIdentity: extractionIdentity }] })).digest("hex");
  database.native.prepare("UPDATE media_game_overviews SET config_version = ?, input_identity = ? WHERE id = ?").run(configVersion, overviewIdentity, overview.id);
  database.native.prepare("UPDATE media_processing_jobs SET input_identity = ?, request_key = 'extraction:' || source_id || ':' || ? WHERE stage = 'extraction'").run(extractionIdentity, extractionIdentity);
  database.native.prepare("UPDATE media_processing_jobs SET input_identity = ?, request_key = 'synthesis:' || appid || ':' || ? WHERE stage = 'synthesis'").run(overviewIdentity, overviewIdentity);
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

/** A game with `sourceCount` initial sources that no run has processed yet. */
function unprocessedGame(sourceCount = 1): TestDatabase {
  const database = openTestDatabase("vaporstats-media-scope-");
  cleanups.push(database.cleanup);
  seedApps(database.native, [CYBERPUNK]);
  insertSources(database.native, CYBERPUNK, "initial", sourceCount);
  return database;
}

/** A game whose `sourceCount` initial sources were extracted and synthesized by a completed first run. */
async function processedGame(sourceCount = 1) {
  const database = unprocessedGame(sourceCount);
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
    expect(summary.outputs).toEqual({ new: 0, reused: 2, replaced: 0, invalidated: 0, skipped: 0 });
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

  test.each<VersionChange>(["extraction", "synthesis", "cleanup"])("a %s version change keeps the prior output active and submits nothing, with or without an affected set", async (change) => {
    const { database, transport } = await processedGame();
    builtUnderEarlierVersion(database, change);
    const submissionsBefore = transport.submissions.length;

    const unaffected = outletArticles();
    const rerun = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, `${change}-rerun`), transport, articleFetch: unaffected.articleFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });
    const affected = outletArticles();
    const refetch = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, `${change}-affected`, sourceIds(database)), transport, articleFetch: affected.articleFetch, now: new Date("2026-11-02T00:01:00.000Z"), ...PAID });

    expect(unaffected.fetched).toEqual([]);
    expect(affected.fetched).toEqual(sourceUrls(database));
    expect(transport.submissions.length).toBe(submissionsBefore);
    for (const summary of [rerun, refetch]) {
      expect(summary.status).toBe("completed");
      expect(summary.outputs).toEqual({ new: 0, reused: 2, replaced: 0, invalidated: 0, skipped: 0 });
    }
    expect(await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();
    expect(await gamesTagged(database, "build experimentation")).toEqual([CYBERPUNK]);
  });

  test("an updatedAt-only change keeps the extraction active and submits no paid work", async () => {
    const { database, transport } = await processedGame();
    const submissionsBefore = transport.submissions.length;
    database.native.prepare("UPDATE media_sources SET updated_at = '2026-11-01T12:00:00.000Z'").run();

    const unaffected = outletArticles();
    const rerun = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "updated-rerun"), transport, articleFetch: unaffected.articleFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });
    const affected = outletArticles();
    const refetch = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "updated-affected", sourceIds(database)), transport, articleFetch: affected.articleFetch, now: new Date("2026-11-02T00:01:00.000Z"), ...PAID });

    expect(unaffected.fetched).toEqual([]);
    expect(affected.fetched).toEqual(sourceUrls(database));
    expect(transport.submissions.length).toBe(submissionsBefore);
    expect(rerun.outputs).toEqual({ new: 0, reused: 2, replaced: 0, invalidated: 0, skipped: 0 });
    expect(refetch.outputs).toEqual({ new: 0, reused: 2, replaced: 0, invalidated: 0, skipped: 0 });
    expect(await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();
    expect(await gamesTagged(database, "build experimentation")).toEqual([CYBERPUNK]);
  });

  test("a new source is processed alongside reused output, which stays served until the Overview is rebuilt", async () => {
    const { database, transport } = await processedGame();
    const [reusedUrl] = sourceUrls(database);
    insertSources(database.native, CYBERPUNK, "initial", 1, MEDIA_OUTLETS[1]);
    const newUrl = sourceUrls(database)[1]!;
    const submissionsBefore = transport.submissions.length;
    const runId = await authorizeRun(database, "new-source");
    const outlet = outletArticles();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: SUCCEEDED_USAGE },
      { state: "succeeded", output: overviewOutputForUrls([reusedUrl!, newUrl]), usage: SUCCEEDED_USAGE },
    );

    const first = await advanceMediaProcessing(database.db, { runId, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });
    const served = await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true });
    const rebuilt = await advanceMediaProcessing(database.db, { runId, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:01:00.000Z"), ...PAID });

    expect(outlet.fetched).toEqual([newUrl]);
    expect(first.status).toBe("waiting");
    expect(served?.statements[0]?.sourceUrls).toEqual([reusedUrl]);
    expect(transport.submissions.length - submissionsBefore).toBe(2);
    expect(rebuilt.status).toBe("completed");
    expect(rebuilt.outputs).toEqual({ new: 1, reused: 1, replaced: 1, invalidated: 0, skipped: 0 });
    expect((await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true }))?.statements[0]?.sourceUrls).toEqual([reusedUrl, newUrl]);
  });

  test("a failed token count discards the article text, and only an affected set retries the source", async () => {
    const database = unprocessedGame();
    const failing = new ControlledGeminiTransport();
    failing.countTokens = async () => { throw new Error("token counting unavailable"); };
    const first = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "count-failure"), transport: failing, articleFetch: outletArticles().articleFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });
    const retained = database.native.query<{ processing_content: string | null }, []>("SELECT processing_content FROM media_sources").get();

    expect(first.stopReasons[0]).toStartWith("count_tokens:");
    expect(first.outputs.skipped).toBe(1);
    expect(retained?.processing_content).toBeNull();

    const transport = new ControlledGeminiTransport();
    transport.nextPolls.push({ state: "pending" });
    const unaffected = outletArticles();
    await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "count-rerun"), transport, articleFetch: unaffected.articleFetch, now: new Date("2026-11-02T00:01:00.000Z"), ...PAID });
    const affected = outletArticles();
    const retry = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "count-retry", sourceIds(database)), transport, articleFetch: affected.articleFetch, now: new Date("2026-11-02T00:02:00.000Z"), ...PAID });

    expect(unaffected.fetched).toEqual([]);
    expect(affected.fetched).toEqual(sourceUrls(database));
    expect(retry.submitted).toBe(1);
  });

  test("an article that failed to load is retried only within an affected set", async () => {
    const database = unprocessedGame();
    const [url] = sourceUrls(database);
    const transport = new ControlledGeminiTransport();
    const unavailable = outletArticles();
    const failedFetch: ArticleFetch = async (input) => {
      await unavailable.articleFetch(input);
      return new Response("unavailable", { status: 503 });
    };
    const first = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "fetch-failure"), transport, articleFetch: failedFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });
    const unaffected = outletArticles();
    const rerun = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "fetch-rerun"), transport, articleFetch: unaffected.articleFetch, now: new Date("2026-11-02T00:01:00.000Z"), ...PAID });
    transport.nextPolls.push({ state: "pending" });
    const affected = outletArticles();
    const retry = await advanceMediaProcessing(database.db, { runId: await authorizeRun(database, "fetch-retry", sourceIds(database)), transport, articleFetch: affected.articleFetch, now: new Date("2026-11-02T00:02:00.000Z"), ...PAID });

    expect(unavailable.fetched).toEqual([url]);
    expect(first.outputs.skipped).toBe(1);
    expect(unaffected.fetched).toEqual([]);
    expect(rerun.submitted).toBe(0);
    expect(affected.fetched).toEqual([url]);
    expect(retry.submitted).toBe(1);
  });

  test("a restarted run resumes its pending work without refetching or resubmitting, and keeps its counts", async () => {
    const database = unprocessedGame();
    insertSources(database.native, CYBERPUNK, "initial", 1, MEDIA_OUTLETS[1]);
    const runId = await authorizeRun(database, "restart");
    const transport = new ControlledGeminiTransport();
    const outlet = outletArticles();
    await advanceMediaProcessing(database.db, { runId, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:00:00.000Z"), ...PAID });
    expect(transport.submissions).toHaveLength(2);

    let { db } = database.reopen();
    for (const name of ["batches/test-1", "batches/test-2"]) transport.polls.set(name, { state: "succeeded", output: extractionOutput(), usage: SUCCEEDED_USAGE });
    transport.nextPolls.push({ state: "succeeded", output: overviewOutputForUrls(sourceUrls(database)), usage: SUCCEEDED_USAGE });
    await advanceMediaProcessing(db, { runId, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:01:00.000Z"), ...PAID });
    ({ db } = database.reopen());
    const resumed = await advanceMediaProcessing(db, { runId, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:02:00.000Z"), ...PAID });
    ({ db } = database.reopen());
    const recorded = await advanceMediaProcessing(db, { runId, transport, articleFetch: outlet.articleFetch, now: new Date("2026-11-02T00:03:00.000Z"), ...PAID });

    expect(outlet.fetched).toEqual(sourceUrls(database));
    expect(transport.submissions).toHaveLength(3);
    expect(resumed.status).toBe("completed");
    expect(recorded.outputs).toEqual({ new: 3, reused: 0, replaced: 0, invalidated: 0, skipped: 0 });
    expect(await getMediaOverview(db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();
  });

  test("an affected set accepts only distinct sources of the run's games and is fixed once authorized", async () => {
    const database = unprocessedGame();
    const [sourceId] = sourceIds(database);
    const runId = insertCompletedRun(database.native, "initial:validation:test", [CYBERPUNK]);

    await expect(authorizeMediaProcessing(database.db, runId, { affectedSourceIds: [sourceId! + 100] })).rejects.toThrow();
    await expect(authorizeMediaProcessing(database.db, runId, { affectedSourceIds: [sourceId!, sourceId!] })).rejects.toThrow();
    await authorizeMediaProcessing(database.db, runId, { affectedSourceIds: [sourceId!] });
    await expect(authorizeMediaProcessing(database.db, runId, { affectedSourceIds: [] })).rejects.toThrow();
    await expect(authorizeMediaProcessing(database.db, runId)).resolves.toMatchObject({ runId, status: "queued" });
  });
});
