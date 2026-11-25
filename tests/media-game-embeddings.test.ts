import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { AppDatabase } from "../src/lib/db";
import {
  advanceMediaProcessing,
  authorizeMediaProcessing,
  type MediaProcessingSummary,
} from "../src/lib/media-processing";
import { openTestDatabase } from "./support/db";
import {
  ControlledGeminiTransport,
  CYBERPUNK,
  extractionAppid,
  insertCompletedRun,
  mediaObservation,
  overviewOutput,
  refuseRequests,
  seedApps,
  type ChatOutput,
  type Refusal,
} from "./support/media";

const APPID = CYBERPUNK;
const URL = "https://ign.com/articles/cyberpunk-review";
const FINDING = "The campaign includes a series of hand-authored encounters";
const FLEXIBLE_GAMEPLAY = "Combat supports flexible builds";
const TACTICAL_GAMEPLAY = "Combat supports tactical builds";
const CITY_STORY = "The campaign follows factions across a dense city";
const INITIAL_EVIDENCE = { gameplay: FLEXIBLE_GAMEPLAY, storyWorld: CITY_STORY };
const TACTICAL_EVIDENCE = { gameplay: TACTICAL_GAMEPLAY, storyWorld: CITY_STORY };

interface MatchEvidence {
  gameplay?: string;
  storyWorld?: string;
}

function articleHtml(evidence: MatchEvidence, detail = "The opening encounter is set at night."): string {
  const excerpts = [...new Set(Object.values(evidence))].map((text) => `${text}.`).join(" ");
  return `<!doctype html><html><body><article><h1>Cyberpunk Review</h1><p>${FINDING}. ${detail} ${excerpts} This preview was played on PC during Early Access and does not assess the final release.</p></article></body></html>`;
}

const ARTICLE_HTML = articleHtml(INITIAL_EVIDENCE);
const cleanups: Array<() => void> = [];

afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

interface EmbeddingFixture {
  native: Database;
  db: AppDatabase;
  runId: number;
}

function fixture(): EmbeddingFixture {
  const database = openTestDatabase("vaporstats-game-embeddings-");
  cleanups.push(database.cleanup);
  seedApps(database.native, [APPID]);
  const runId = insertCompletedRun(database.native, "initial:embedding-test", [APPID]);
  database.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review', 1, 'PC', 'Early Access')").run(APPID, URL, "Cyberpunk 2077 Review", "2026-09-11T00:00:00.000Z");
  return { native: database.native, db: database.db, runId };
}

function extractionOutput({ gameplay, storyWorld }: MatchEvidence = INITIAL_EVIDENCE): ChatOutput {
  return (request) => {
    const appid = extractionAppid(request);
    const qualifiers = ["PC", "Early Access"];
    return {
      observations: [
        { ...mediaObservation(appid, "encounters", "finding", FINDING, FINDING), qualifiers },
        ...(gameplay ? [{ ...mediaObservation(appid, "combat", "gameplay", gameplay, gameplay), qualifiers }] : []),
        ...(storyWorld ? [{ ...mediaObservation(appid, "campaign", "storyWorld", storyWorld, storyWorld), qualifiers }] : []),
      ],
    };
  };
}

function embeddingOutput(value: number): Record<string, unknown> {
  return { embedding: { values: Array.from({ length: 3072 }, () => value) } };
}

const advanceCounts = new WeakMap<EmbeddingFixture, number>();

/** Advances the fixture's current run one ingestion tick (15 minutes) after its previous advance. */
async function advance(value: EmbeddingFixture, transport: ControlledGeminiTransport, article: string | ((url: string) => string) = ARTICLE_HTML): Promise<MediaProcessingSummary> {
  const ticks = advanceCounts.get(value) ?? 0;
  advanceCounts.set(value, ticks + 1);
  return advanceMediaProcessing(value.db, {
    runId: value.runId,
    transport, openRouter: transport.openRouter,
    articleFetch: async (url) => typeof article === "string" ? article : article(url),
    now: new Date(Date.parse("2026-09-11T00:00:00.000Z") + ticks * 15 * 60 * 1_000),
  });
}

async function completeInitial(value: EmbeddingFixture, transport: ControlledGeminiTransport): Promise<void> {
  await authorizeMediaProcessing(value.db, value.runId);
  // Text answers settle as they arrive, so one advance extracts, synthesizes
  // and submits the Overview's embeddings, which settle when polled.
  transport.nextPolls.push(
    { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
    { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    { state: "succeeded", output: embeddingOutput(1), usage: { inputTokens: 100 } },
    { state: "succeeded", output: embeddingOutput(2), usage: { inputTokens: 100 } },
  );
  await advance(value, transport);
  await advance(value, transport);
}
async function startNextRun(value: EmbeddingFixture, key: string, affectedSourceIds: readonly number[] = []): Promise<void> {
  value.runId = insertCompletedRun(value.native, `initial:${key}`, [APPID]);
  await authorizeMediaProcessing(value.db, value.runId, { affectedSourceIds });
}

function sourceIds(value: EmbeddingFixture): number[] {
  return value.native.query<{ id: number }, []>("SELECT id FROM media_sources ORDER BY id").all().map(({ id }) => id);
}

/**
 * Rebuilds the game's Overview from revised article evidence and advances
 * the embedding work with the supplied provider answers.
 */
async function rebuildOverview(
  value: EmbeddingFixture,
  transport: ControlledGeminiTransport,
  key: string,
  evidence: MatchEvidence,
  embeddings: readonly (Record<string, unknown> | { state: "pending" })[] = [],
): Promise<void> {
  await startNextRun(value, key, sourceIds(value));
  const article = articleHtml(evidence);
  transport.nextPolls.push(
    { state: "succeeded", output: extractionOutput(evidence), usage: { inputTokens: 100, outputTokens: 20 } },
    { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    ...embeddings.map((output) => ("state" in output && output.state === "pending" ? { state: "pending" as const } : { state: "succeeded" as const, output, usage: { inputTokens: 100 } })),
  );
  await advance(value, transport, article);
  await advance(value, transport, article);
}


describe("game overview aggregate embeddings", () => {
  test("submits one canonical vector per supported dimension and no explanation work", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    await completeInitial(value, transport);

    const embeddings = await value.db.prepare("SELECT appid, dimension, overview_input_identity, model, dimensions, active FROM media_game_embeddings ORDER BY dimension").all<{
      appid: number; dimension: string; overview_input_identity: string; model: string; dimensions: number; active: number;
    }>();
    expect(embeddings.results).toHaveLength(2);
    expect(embeddings.results?.map(({ dimension }) => dimension)).toEqual(["gameplay", "story_world"]);
    expect(embeddings.results?.every((row) => row.appid === APPID && row.model === "gemini-embedding-2" && row.dimensions === 3072 && row.active === 1)).toBe(true);
    const overview = await value.db.prepare("SELECT output_json FROM media_game_overviews WHERE appid = ? AND active = 1").bind(APPID).first<{ output_json: string }>();
    expect(JSON.parse(overview?.output_json ?? "{}").similarityInputs).toEqual({
      gameplay: [`${FLEXIBLE_GAMEPLAY} (PC, Early Access)`],
      storyWorld: [`${CITY_STORY} (PC, Early Access)`],
    });
    expect(await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'explanation'").first<{ count: number }>()).toEqual({ count: 0 });
    expect(transport.embeddingSubmissions).toHaveLength(2);
    expect(JSON.stringify(transport.requestBodies)).not.toContain("Compare exact games");
  });
  test("keeps eligible child vectors and article evidence on the child entity", async () => {
    const value = fixture();
    const childAppid = 2138330;
    const childUrl = "https://ign.com/articles/phantom-liberty-review";
    value.native.prepare("INSERT INTO apps (appid, name, slug, type, parent_appid) VALUES (?, ?, ?, 'expansion', ?)").run(childAppid, "Cyberpunk 2077: Phantom Liberty", "cyberpunk-2077-phantom-liberty", APPID);
    value.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review', 1, 'PC', 'Early Access')").run(childAppid, childUrl, "Phantom Liberty Review", "2026-09-11T00:00:00.000Z");
    await authorizeMediaProcessing(value.db, value.runId);
    const childEvidence = {
      gameplay: "Combat adds a route for stealth builds",
      storyWorld: "The expansion follows undercover agents through a walled district",
    };
    const transport = new ControlledGeminiTransport({ embeddings: true });
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(childEvidence), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(childUrl), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: embeddingOutput(1), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(2), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(3), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(4), usage: { inputTokens: 100 } },
    );
    const fetchArticle = (url: string) => url === childUrl ? articleHtml(childEvidence) : ARTICLE_HTML;
    await advance(value, transport, fetchArticle);
    await advance(value, transport, fetchArticle);
    await advance(value, transport, fetchArticle);
    const activeSources = await value.db.prepare(
      "SELECT s.appid, s.original_url, e.output_json FROM media_article_extractions e JOIN media_sources s ON s.id = e.source_id WHERE e.active = 1 ORDER BY s.appid",
    ).all<{ appid: number; original_url: string; output_json: string }>();
    expect(activeSources.results?.map(({ appid, original_url, output_json }) => ({
      appid,
      url: original_url,
      evidence: JSON.parse(output_json).observations.map(({ appid, text }: { appid: number; text: string }) => [appid, text]),
    }))).toEqual([
      { appid: APPID, url: URL, evidence: [[APPID, FINDING], [APPID, FLEXIBLE_GAMEPLAY], [APPID, CITY_STORY]] },
      { appid: childAppid, url: childUrl, evidence: [[childAppid, FINDING], [childAppid, childEvidence.gameplay], [childAppid, childEvidence.storyWorld]] },
    ]);
    const overviews = value.native.query<{ appid: number; output_json: string }, []>(
      "SELECT appid, output_json FROM media_game_overviews WHERE active = 1 ORDER BY appid",
    ).all();
    expect(overviews.map(({ appid, output_json }) => [appid, JSON.parse(output_json).similarityInputs])).toEqual([
      [APPID, { gameplay: [`${FLEXIBLE_GAMEPLAY} (PC, Early Access)`], storyWorld: [`${CITY_STORY} (PC, Early Access)`] }],
      [childAppid, { gameplay: [`${childEvidence.gameplay} (PC, Early Access)`], storyWorld: [`${childEvidence.storyWorld} (PC, Early Access)`] }],
    ]);
    const vectors = await value.db.prepare(
      "SELECT appid, dimension, active FROM media_game_embeddings WHERE active = 1 ORDER BY appid, dimension",
    ).all<{ appid: number; dimension: string; active: number }>();
    expect(vectors.results?.map(({ appid, dimension }) => [appid, dimension])).toEqual([
      [APPID, "gameplay"],
      [APPID, "story_world"],
      [childAppid, "gameplay"],
      [childAppid, "story_world"],
    ]);
  });

  test("re-embeds only a changed category and omits unsupported dimensions", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    await completeInitial(value, transport);
    const before = transport.embeddingSubmissions.length;
    const activeEmbeddings = value.native.query<{ id: number; dimension: string }, [number]>(
      "SELECT id, dimension FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension",
    );
    const original = activeEmbeddings.all(APPID);
    await rebuildOverview(value, transport, "changed-category", TACTICAL_EVIDENCE, [embeddingOutput(3)]);
    expect(transport.embeddingSubmissions.length - before).toBe(1);
    expect(transport.embeddingSubmissions.at(-1)).toContain(":gameplay:");
    const replaced = activeEmbeddings.all(APPID);
    expect(replaced.map(({ dimension }) => dimension)).toEqual(["gameplay", "story_world"]);
    expect(replaced[0]?.id).not.toBe(original[0]?.id);
    expect(replaced[1]).toEqual(original[1]);

    await rebuildOverview(value, transport, "removed-category", { gameplay: TACTICAL_GAMEPLAY });
    expect(activeEmbeddings.all(APPID)).toEqual([replaced[0]]);
    expect(transport.embeddingSubmissions.length - before).toBe(1);
  });
  test.each([
    ["quality", "Excellent writing and outstanding quality"],
    ["popularity", "A popular game with a large following"],
    ["technical complaints", "Frequent crashes and framerate problems"],
  ])("retires both match dimensions when a replacement supplies only %s", async (reason, observation) => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    await completeInitial(value, transport);
    const submissions = transport.embeddingSubmissions.length;
    await rebuildOverview(value, transport, reason, {
      gameplay: observation,
      storyWorld: observation,
    });

    const extraction = value.native.query<{ output_json: string }, []>(
      "SELECT output_json FROM media_article_extractions WHERE active = 1",
    ).get();
    expect(JSON.parse(extraction?.output_json ?? "{}").observations).toEqual([
      expect.objectContaining({ kind: "finding", text: FINDING }),
      expect.objectContaining({ kind: "gameplay", text: observation }),
      expect.objectContaining({ kind: "storyWorld", text: observation }),
    ]);
    const active = value.native.query("SELECT dimension FROM media_game_embeddings WHERE appid = ? AND active = 1").all(APPID);
    expect(active).toEqual([]);
    expect(transport.embeddingSubmissions).toHaveLength(submissions);
    const current = value.native.query<{ output_json: string }, [number]>(
      "SELECT output_json FROM media_game_overviews WHERE appid = ? AND active = 1",
    ).get(APPID);
    expect(current).not.toBeNull();
    expect(JSON.parse(current!.output_json)).not.toHaveProperty("similarityInputs");
  });

  test("reuses vectors when only the Overview identity changes", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    await completeInitial(value, transport);
    const previous = await value.db.prepare("SELECT input_identity FROM media_game_overviews WHERE appid = ? AND active = 1").bind(APPID).first<{ input_identity: string }>();
    const embeddingSubmissions = transport.embeddingSubmissions.length;
    await startNextRun(value, "overview-identity", sourceIds(value));
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advance(value, transport, articleHtml(INITIAL_EVIDENCE, "The opening encounter is set at dawn."));
    await advance(value, transport, articleHtml(INITIAL_EVIDENCE, "The opening encounter is set at dawn."));
    const current = await value.db.prepare("SELECT input_identity FROM media_game_overviews WHERE appid = ? AND active = 1").bind(APPID).first<{ input_identity: string }>();
    const vectors = await value.db.prepare("SELECT dimension, overview_input_identity FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension").bind(APPID).all<{ dimension: string; overview_input_identity: string }>();
    expect(current?.input_identity).not.toBe(previous?.input_identity);
    expect(transport.embeddingSubmissions.length).toBe(embeddingSubmissions);
    expect(vectors.results?.map(({ dimension }) => dimension)).toEqual(["gameplay", "story_world"]);
    expect(vectors.results?.every(({ overview_input_identity }) => overview_input_identity === current?.input_identity)).toBe(true);
  });

  test("rejects an embedding completion after the active Overview changes", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    await completeInitial(value, transport);
    const before = transport.embeddingSubmissions.length;
    // The embedding is still in flight when the next change happens.
    await rebuildOverview(value, transport, "stale-completion", TACTICAL_EVIDENCE, [{ state: "pending" }]);
    expect(transport.embeddingSubmissions.length).toBe(before + 1);
    transport.polls.set(`batches/embed-${transport.embeddingSubmissions.length}`, { state: "succeeded", output: embeddingOutput(4), usage: { inputTokens: 100 } });
    await value.db.prepare("UPDATE media_game_overviews SET input_identity = ? WHERE appid = ? AND active = 1").bind("c".repeat(64), APPID).run();
    const result = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(TACTICAL_EVIDENCE),
    });
    expect(result.failed).toBeGreaterThan(0);
    const stale = await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'embedding' AND status = 'stale'").first<{ count: number }>();
    expect(Number(stale?.count ?? 0)).toBeGreaterThan(0);
  });
  test("polls and settles a submitted embedding after entity eligibility is lost", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    await completeInitial(value, transport);
    const before = transport.embeddingSubmissions.length;
    // The embedding is still in flight when the next change happens.
    await rebuildOverview(value, transport, "lost-eligibility", TACTICAL_EVIDENCE, [{ state: "pending" }]);
    expect(transport.embeddingSubmissions.length).toBe(before + 1);
    transport.polls.set(`batches/embed-${transport.embeddingSubmissions.length}`, { state: "succeeded", output: embeddingOutput(4), usage: { inputTokens: 100 } });
    await value.db.prepare("UPDATE apps SET is_eligible = 0 WHERE appid = ?").bind(APPID).run();
    const result = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => ARTICLE_HTML,
      now: new Date("2026-09-11T00:00:00.000Z"),
    });
    expect(result.failed).toBeGreaterThan(0);
    const stale = await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'embedding' AND status = 'stale'").first<{ count: number }>();
    expect(Number(stale?.count ?? 0)).toBeGreaterThan(0);
    const settled = await value.db.prepare("SELECT status, charged_microusd, reservation_active FROM media_processing_jobs WHERE stage = 'embedding' ORDER BY id DESC LIMIT 1").first<{ status: string; charged_microusd: number | null; reservation_active: number }>();
    expect(settled).toMatchObject({ status: "stale", reservation_active: 0 });
    expect(settled?.charged_microusd).toBeGreaterThan(0);
    const inactive = await value.db.prepare("SELECT COUNT(*) AS count FROM media_game_embeddings WHERE appid = ? AND active = 1").bind(APPID).first<{ count: number }>();
    expect(Number(inactive?.count ?? 0)).toBe(0);
    await advance(value, transport);
    expect(transport.embeddingSubmissions.length).toBe(before + 1);
  });

  test("rejects finite provider values that overflow Float32 storage", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: embeddingOutput(Number.MAX_VALUE), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(2), usage: { inputTokens: 100 } },
    );
    await advance(value, transport);
    await advance(value, transport);
    const refused = await value.db.prepare("SELECT status, error FROM media_processing_jobs WHERE stage = 'embedding' AND status = 'refused'").first<{ status: string; error: string }>();
    expect(refused).toEqual({ status: "refused", error: "invalid_output: incompatible vector" });
    const active = await value.db.prepare("SELECT dimension FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension").bind(APPID).all<{ dimension: string }>();
    expect(active.results?.map(({ dimension }) => dimension)).toEqual(["story_world"]);
  });

  test("keeps embedding work reserved and retryable when submit capability is absent", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    Object.defineProperty(transport, "submitEmbeddingBatch", { value: undefined });
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advance(value, transport);
    await advance(value, transport);
    const jobs = await value.db.prepare("SELECT status, attempt_count FROM media_processing_jobs WHERE stage = 'embedding'").all<{ status: string; attempt_count: number }>();
    expect(jobs.results?.length).toBeGreaterThan(0);
    expect(jobs.results?.every((job) => job.status === "queued" && job.attempt_count === 0)).toBe(true);
  });

  test.each<[Refusal | "failed batch", number]>([["token cap", 2], ["failed batch", 2]])("embeddings an earlier run left undone by a %s get work only from a run whose affected set covers the game", async (undone, undoneCount) => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    if (undone !== "failed batch") refuseRequests(transport, (model) => model.includes("embedding"), undone);
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    if (undone === "failed batch") transport.nextPolls.push({ state: "failed", error: "embedding failed" }, { state: "failed", error: "embedding failed" });
    await advance(value, transport);
    await advance(value, transport);
    await advance(value, transport);
    const undoneEmbeddings = await value.db.prepare("SELECT COUNT(*) AS count FROM media_game_embeddings WHERE appid = ? AND active = 1").bind(APPID).first<{ count: number }>();
    expect(undoneEmbeddings?.count).toBe(0);
    delete (transport as Partial<ControlledGeminiTransport>).countTokens;
    const countsBefore = transport.counts.length;
    const submissionsBefore = transport.embeddingSubmissions.length;

    await startNextRun(value, "embedding-rerun");
    const rerun = await advance(value, transport);
    expect(rerun.submitted).toBe(0);
    expect(transport.counts.length).toBe(countsBefore);

    await startNextRun(value, "embedding-affected", sourceIds(value));
    transport.nextPolls.push(
      { state: "succeeded", output: embeddingOutput(1), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(2), usage: { inputTokens: 100 } },
    );
    const retried = await advance(value, transport);
    const settled = await advance(value, transport);

    expect(retried.submitted).toBe(undoneCount);
    expect(transport.embeddingSubmissions.length).toBe(submissionsBefore + undoneCount);
    expect(settled.status).toBe("completed");
    const active = await value.db.prepare("SELECT dimension FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension").bind(APPID).all<{ dimension: string }>();
    expect(active.results?.map(({ dimension }) => dimension)).toEqual(["gameplay", "story_world"]);
  });

  test.each<[Refusal, number]>([["token cap", 2]])("counts each embedding refused by its %s as skipped once and does not retry it in the run", async (refusal, refusals) => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    const embeddingCounts = refuseRequests(transport, (model) => model.includes("embedding"), refusal);
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advance(value, transport);
    await advance(value, transport);
    const refused = await advance(value, transport);

    expect(embeddingCounts()).toBe(refusals);
    expect(refused.outputs).toEqual({ new: 2, reused: 0, replaced: 0, invalidated: 0, skipped: refusals });
  });

  test("retries an embedding whose token count throws after its backoff instead of refusing it", async () => {
    const value = fixture();
    const transport = new ControlledGeminiTransport({ embeddings: true });
    const embeddingCounts = refuseRequests(transport, (model) => model.includes("embedding"), "token count");
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    // One advance extracts, synthesizes, and fails both embeddings' first count.
    const failed = await advance(value, transport);
    embeddingCounts.restore();
    const retried = await advance(value, transport);

    // Both dimensions failed their first count and retry at the next tick.
    expect(embeddingCounts()).toBe(2);
    expect(failed.status).toBe("waiting");
    expect(failed.stopReasons).toEqual(["transient_provider_failure"]);
    expect(failed.outputs.skipped).toBe(0);
    expect(retried.submitted).toBe(2);
    expect(transport.embeddingSubmissions).toHaveLength(2);
  });

});
