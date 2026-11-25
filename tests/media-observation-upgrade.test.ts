import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { advanceMediaProcessing, authorizeMediaProcessing } from "../src/lib/media-processing";
import { openTestDatabase } from "./support/db";
import { controlledOpenRouterApi, CYBERPUNK, insertCompletedRun, insertSources, processingArticleHtml, seedApps, stableJson } from "./support/media";

test("a waiting extraction and synthesis from before the observation contract each send once under the new version", async () => {
  const { db, native, cleanup } = openTestDatabase();
  try {
    seedApps(native, [CYBERPUNK]);
    insertSources(native, CYBERPUNK, "initial", 1);
    const runId = insertCompletedRun(native, "observation-upgrade", [CYBERPUNK]);
    await authorizeMediaProcessing(db, runId);
    const provider = controlledOpenRouterApi();
    const step = (submissionsPerTick: number) => advanceMediaProcessing(db, {
      runId, submissionsPerTick, providerFetch: provider.fetchFn, openRouterApiKey: "fixture",
      articleFetch: async () => processingArticleHtml(CYBERPUNK),
    });
    await step(0);
    expect(native.run("UPDATE media_processing_jobs SET config_version = 'old-extraction' WHERE stage = 'extraction' AND status = 'queued'").changes).toBe(1);
    await step(1);
    const sources = native.query<{ sourceId: number; inputIdentity: string }, []>(
      "SELECT source_id AS sourceId, input_identity AS inputIdentity FROM media_article_extractions WHERE active = 1",
    ).all();
    expect(sources).toHaveLength(1);
    const configVersion = "old-synthesis";
    const identity = createHash("sha256").update(stableJson({
      stage: "synthesis", appid: CYBERPUNK, model: "anthropic/claude-haiku-5.5", configVersion, extractions: sources,
    })).digest("hex");
    expect(native.run("UPDATE media_processing_jobs SET config_version = ?, input_identity = ?, request_key = ? WHERE stage = 'synthesis' AND status = 'queued'",
      [configVersion, identity, `synthesis:${CYBERPUNK}:${identity}`]).changes).toBe(1);
    await step(4);
    expect(provider.requests.map(r => r.stage)).toEqual(["extraction", "synthesis"]);
    const stored = native.query<{ output_json: string }, []>("SELECT output_json FROM media_game_overviews WHERE active = 1").get();
    expect(JSON.parse(stored!.output_json).statements[0].observationRefs[0].sourceIdentity).toBe(sources[0]!.inputIdentity);
  } finally {
    cleanup();
  }
});

test("a launch-scoped bug and a historical build designation cannot become current claims", async () => {
  const { parseArticleObservations } = await import("../src/lib/media-observations");
  const quote = "At PC launch, animations frequently froze. This happened in the Early Access build.";
  const finding = { id: "animation", appid: CYBERPUNK, kind: "finding", category: "Technical experience & accessibility",
    text: "Animations frequently freeze.", quote: "At PC launch, animations frequently froze.", qualifiers: [] };
  const tag = { id: "build", appid: CYBERPUNK, kind: "tag", category: "", text: "Early Access build", quote: "This happened in the Early Access build.", qualifiers: ["Early Access"] };
  expect(parseArticleObservations({ observations: [finding, tag] }, CYBERPUNK, quote)).toEqual([]);
  const modeQuote = "There is a single-player mode.";
  const mode = { ...tag, text: "Single-player", quote: modeQuote, qualifiers: [] };
  expect(parseArticleObservations({ observations: [mode] }, CYBERPUNK, modeQuote, ["Early Access"])).toEqual([]);
  expect(parseArticleObservations({ observations: [{ ...finding, qualifiers: ["At PC launch"] }] }, CYBERPUNK, quote)).toHaveLength(1);
});
