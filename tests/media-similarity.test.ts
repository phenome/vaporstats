import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  GEMINI_BATCH_CAPABILITY_VERSION,
  GEMINI_BATCH_PRICING_VERSION,
  advanceMediaProcessing,
  authorizeMediaProcessing,
  createGeminiBatchTransport,
  type GeminiBatchPoll,
  type GeminiBatchTransport,
} from "../src/lib/media-processing";
import {
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_CONFIG_VERSION,
  GEMINI_EMBEDDING_MODEL,
  getMediaGameMatches,
} from "../src/lib/media-similarity";

function adapter(native: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next) { values = next; return statement; },
        async first<T>(column?: string) {
          const row = native.prepare(query).get(...values as SQLQueryBindings[]) as Record<string, unknown> | null;
          return row ? (column ? row[column] : row) as T : null;
        },
        async run() {
          const result = native.prepare(query).run(...values as SQLQueryBindings[]);
          return { success: true, meta: { changes: result.changes, duration: 0 } };
        },
        async all<T>() {
          return { success: true, results: native.prepare(query).all(...values as SQLQueryBindings[]) as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T>() { return native.prepare(query).values(...values as SQLQueryBindings[]) as T[]; },
      };
      return statement;
    },
    async batch(statements) {
      native.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query) { native.exec(query); return { count: 0, duration: 0 }; },
  };
}

function vector(first: number): Uint8Array {
  const bytes = new ArrayBuffer(GEMINI_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT);
  const values = new Float32Array(bytes);
  values[0] = first;
  values[1] = 1;
  return new Uint8Array(bytes);
}

function fixture() {
  const native = new Database(":memory:");
  applyMigrations(native);
  native.exec("PRAGMA foreign_keys = ON");
  native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)").run(101, "Alpha", "alpha", 202, "Beta", "beta", 303, "Alpha Expansion", "alpha-expansion");
  native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', '2026-09-13T00:00:00.000Z', 'review', 1, 'PC', 'release'), (?, 'initial', ?, ?, 'Eurogamer', '2026-09-13T00:00:00.000Z', 'review', 0, 'PC', NULL)").run(101, "https://ign.test/alpha", "Alpha article", 202, "https://eurogamer.test/beta", "Beta article");
  const sources = native.prepare("SELECT id, appid, original_url FROM media_sources ORDER BY id").all() as { id: number; appid: number; original_url: string }[];
  native.prepare("INSERT INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json) VALUES (?, ?, 'hash-a', 'cleanup', 'extractor', 'extract-config', ?), (?, ?, 'hash-b', 'cleanup', 'extractor', 'extract-config', ?)").run(sources[0]!.id, "extract-a", JSON.stringify({ similarityInputs: { gameplay: ["turn-based tactics"] } }), sources[1]!.id, "extract-b", JSON.stringify({ similarityInputs: { gameplay: ["turn-based tactics"] } }));
  const embeddingModel = GEMINI_EMBEDDING_MODEL;
  const embeddingConfig = "media-embedding-2026-09-13-v1";
  native.prepare("INSERT INTO media_article_embeddings (source_id, dimension, input_identity, extraction_input_identity, model, dimensions, config_version, vector) VALUES (?, 'gameplay', 'vector-a', 'extract-a', ?, ?, ?, ?), (?, 'gameplay', 'vector-b', 'extract-b', ?, ?, ?, ?)").run(sources[0]!.id, embeddingModel, GEMINI_EMBEDDING_DIMENSIONS, embeddingConfig, vector(1), sources[1]!.id, embeddingModel, GEMINI_EMBEDDING_DIMENSIONS, embeddingConfig, vector(1));
  native.prepare("INSERT INTO media_game_matches (appid, matched_appid, dimension, trait, explanation, similarity, current_source_ids, matched_source_ids, current_extraction_identities, matched_extraction_identities, current_vector_identities, matched_vector_identities, input_identity, model, config_version) VALUES (101, 202, 'gameplay', 'turn-based tactics', 'Both use turn-based tactics.', 1, ?, ?, ?, ?, ?, ?, 'explanation-a', 'gemini-3.1-flash-lite', 'explanation-config')").run(JSON.stringify([sources[0]!.id]), JSON.stringify([sources[1]!.id]), JSON.stringify(["extract-a"]), JSON.stringify(["extract-b"]), JSON.stringify(["vector-a"]), JSON.stringify(["vector-b"]));
  return { native, db: adapter(native), sources };
}

class ControlledSimilarityTransport implements GeminiBatchTransport {
  readonly submissions: string[] = [];
  readonly embeddingSubmissions: string[] = [];
  readonly requestPayloads: string[] = [];
  readonly polls = new Map<string, GeminiBatchPoll>();
  private sequence = 0;

  async countTokens(): Promise<number> {
    return 10;
  }

  async submitBatch(_model: string, requests: readonly { key: string; request: Record<string, unknown> }[]): Promise<{ name: string }> {
    const item = requests[0]!;
    const text = JSON.stringify(item.request);
    const name = `batches/similarity-${++this.sequence}`;
    this.submissions.push(item.key);
    this.requestPayloads.push(text);
    if (text.includes("Analyze only")) {
      const appid = text.includes("1086940") ? 1086940 : 1091500;
      this.polls.set(name, {
        state: "succeeded",
        output: {
          contributions: [{ text: "Turn-based tactics shape encounters", category: "Gameplay & systems" }],
          similarityInputs: {
            gameplay: ["turn-based tactics shape encounters"],
            ...(appid === 1091500 ? { storyWorld: ["mythic worlds frame a focused journey"] } : {}),
          },
          traits: ["turn-based tactics"],
          qualifications: [],
          provenance: [],
        },
        usage: { inputTokens: 10, outputTokens: 20, thinkingTokens: 0 },
      });
    } else if (text.includes("Synthesize")) {
      const appid = text.includes("1086940") ? 1086940 : 1091500;
      const url = appid === 1086940 ? "https://eurogamer.net/articles/baldurs" : "https://ign.com/articles/cyberpunk";
      this.polls.set(name, {
        state: "succeeded",
        output: { statements: [{ text: "A focused game with turn-based tactics.", sourceUrls: [url] }] },
        usage: { inputTokens: 10, outputTokens: 20, thinkingTokens: 0 },
      });
    } else {
      this.polls.set(name, {
        state: "succeeded",
        output: {
          supported: true,
          dimension: "gameplay",
          trait: "turn-based tactics",
          explanation: "Both games use turn-based tactics to shape encounters.",
          currentSourceUrls: ["https://eurogamer.net/articles/baldurs"],
          matchedSourceUrls: ["https://ign.com/articles/cyberpunk"],
        },
        usage: { inputTokens: 10, outputTokens: 20, thinkingTokens: 0 },
      });
    }
    return { name };
  }

  async submitEmbeddingBatch(_model: string, requests: readonly { key: string; request: Record<string, unknown> }[]): Promise<{ name: string }> {
    const item = requests[0]!;
    const name = `batches/similarity-embedding-${++this.sequence}`;
    this.embeddingSubmissions.push(item.key);
    this.polls.set(name, {
      state: "succeeded",
      output: { embedding: { values: Array.from({ length: GEMINI_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0) } },
      usage: { inputTokens: 10 },
    });
    return { name };
  }

  async pollBatch(name: string): Promise<GeminiBatchPoll> {
    return this.polls.get(name) ?? { state: "pending" };
  }
}

function processingFixture() {
  const native = new Database(":memory:");
  applyMigrations(native);
  native.exec("PRAGMA foreign_keys = ON");
  native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?), (?, ?, ?)").run(1091500, "Cyberpunk 2077", "cyberpunk-2077", 1086940, "Baldur's Gate 3", "baldurs-gate-3");
  native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', 'similarity-e2e', ?, 'completed')").run(JSON.stringify([1091500, 1086940]));
  const run = native.prepare("SELECT id FROM media_discovery_runs WHERE identity_key = 'similarity-e2e'").get() as { id: number };
  native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', '2026-09-13T00:00:00.000Z', 'review', 1, 'PC', 'release'), (?, 'initial', ?, ?, 'Eurogamer', '2026-09-13T00:00:00.000Z', 'review', 1, 'PC', 'release')").run(1091500, "https://ign.com/articles/cyberpunk", "Cyberpunk Review", 1086940, "https://eurogamer.net/articles/baldurs", "Baldur's Gate 3 Review");
  return { native, db: adapter(native), runId: Number(run.id) };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

describe("persisted media similarity", () => {
  test("reads exact current citations independently by dimension without spending", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    const before = value.native.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs").get() as { count: number };
    const matches = await getMediaGameMatches(value.db, 101, { includeUnpublished: true });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ dimension: "gameplay", trait: "turn-based tactics", matchedGame: { appid: 202, slug: "beta" } });
    expect(matches[0]?.currentSources[0]).toMatchObject({ originalUrl: "https://ign.test/alpha", handsOn: true });
    expect(matches[0]?.matchedSources[0]).toMatchObject({ originalUrl: "https://eurogamer.test/beta", handsOn: false });
    const after = value.native.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs").get() as { count: number };
    expect(after.count).toBe(before.count);
  });

  test("applies publication gate and rejects stale evidence", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    const prior = process.env.MEDIA_OVERVIEW_PUBLIC;
    delete process.env.MEDIA_OVERVIEW_PUBLIC;
    expect(await getMediaGameMatches(value.db, 101)).toEqual([]);
    if (prior === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC; else process.env.MEDIA_OVERVIEW_PUBLIC = prior;
    value.native.prepare("UPDATE media_article_extractions SET input_identity = 'replaced' WHERE source_id = ?").run(value.sources[0]!.id);
    expect(await getMediaGameMatches(value.db, 101, { includeUnpublished: true })).toEqual([]);
  });

  test("rejects incompatible stored vector lengths", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    value.native.prepare("UPDATE media_article_embeddings SET vector = x'00' WHERE source_id = ?").run(value.sources[0]!.id);
    expect(await getMediaGameMatches(value.db, 101, { includeUnpublished: true })).toEqual([]);
  });

  test("uses the official async embedding batch REST path and shape", async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, any> });
      const response = url.endsWith(":countTokens") ? { totalTokens: 3 } : { name: "batches/embedding-test" };
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    };
    const transport = createGeminiBatchTransport("test-key", fetchFn) as GeminiBatchTransport & { submitEmbeddingBatch: NonNullable<GeminiBatchTransport["submitEmbeddingBatch"]> };
    const request = { model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text: "turn-based tactics" }] }, embedContentConfig: { outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS } };
    expect(await transport.countTokens(GEMINI_EMBEDDING_MODEL, request)).toBe(3);
    expect(requests[0]?.body).toEqual({ model: `models/${GEMINI_EMBEDDING_MODEL}`, contents: [request.content] });
    await transport.submitEmbeddingBatch(GEMINI_EMBEDDING_MODEL, [{ key: "embedding-key", request }]);
    const submitted = requests[1]!;
    expect(submitted.url).toContain(`/models/${GEMINI_EMBEDDING_MODEL}:asyncBatchEmbedContent`);
    expect(submitted.body.batch.displayName).toBe("embedding-key");
    expect(submitted.body.batch.inputConfig.requests.requests[0].metadata.key).toBe("embedding-key");
    expect(submitted.body.batch.inputConfig.requests.requests[0].request.embedContentConfig.outputDimensionality).toBe(GEMINI_EMBEDDING_DIMENSIONS);
  });
  test("processes vectors and explanations through durable stages, then reuses them", async () => {
    const value = processingFixture();
    cleanups.push(() => value.native.close(true));
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledSimilarityTransport();
    const options = {
      runId: value.runId,
      transport,
      articleFetch: async () => "<!doctype html><html><body><article><h1>Game article</h1><p>Turn-based tactics shape encounters while a focused journey connects distinct missions and memorable worlds for this hands-on article.</p></article></body></html>",
      now: new Date("2026-09-13T00:00:00.000Z"),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    };
    await advanceMediaProcessing(value.db, options);
    await advanceMediaProcessing(value.db, options);
    await advanceMediaProcessing(value.db, options);
    const embeddingRows = value.native.prepare("SELECT dimension, dimensions, COUNT(*) AS count FROM media_article_embeddings GROUP BY dimension, dimensions ORDER BY dimension").all() as { dimension: string; dimensions: number; count: number }[];
    expect(embeddingRows).toEqual([
      { dimension: "gameplay", dimensions: GEMINI_EMBEDDING_DIMENSIONS, count: 2 },
      { dimension: "story_world", dimensions: GEMINI_EMBEDDING_DIMENSIONS, count: 1 },
    ]);
    const stageRows = value.native.prepare("SELECT stage, COUNT(*) AS count FROM media_processing_jobs GROUP BY stage ORDER BY stage").all() as { stage: string; count: number }[];
    expect(stageRows.map((row) => row.stage)).toEqual(["embedding", "explanation", "extraction", "synthesis"]);
    const matches = await getMediaGameMatches(value.db, 1091500, { includeUnpublished: true });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.dimension).toBe("gameplay");
    expect(matches[0]?.currentSources).toHaveLength(1);
    expect(matches[0]?.matchedSources).toHaveLength(1);
    expect(matches[0]?.currentSources[0]?.originalUrl).toBe("https://ign.com/articles/cyberpunk");
    expect(matches[0]?.matchedSources[0]?.originalUrl).toBe("https://eurogamer.net/articles/baldurs");
    value.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (1091500, 'initial', 'https://ign.com/articles/cyberpunk-later', 'Cyberpunk later assessment', 'IGN', '2026-09-13T00:00:00.000Z', 'review'), (1086940, 'initial', 'https://eurogamer.net/articles/baldurs-later', 'Baldur later assessment', 'Eurogamer', '2026-09-13T00:00:00.000Z', 'review')").run();
    const laterSources = value.native.prepare("SELECT id, appid FROM media_sources WHERE original_url LIKE '%-later' ORDER BY appid").all() as { id: number; appid: number }[];
    for (const laterSource of laterSources) {
      const extractionIdentity = `later-extract-${laterSource.appid}`;
      value.native.prepare("INSERT INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json) VALUES (?, ?, ?, 'cleanup', 'extractor', 'extract-config', ?)").run(laterSource.id, extractionIdentity, `hash-${laterSource.appid}`, JSON.stringify({ similarityInputs: { gameplay: ["turn-based tactics create flexible encounters"] } }));
      value.native.prepare("INSERT INTO media_article_embeddings (source_id, dimension, input_identity, extraction_input_identity, model, dimensions, config_version, vector) VALUES (?, 'gameplay', ?, ?, ?, ?, ?, ?)").run(laterSource.id, `later-vector-${laterSource.appid}`, extractionIdentity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION, vector(1));
    }
    await advanceMediaProcessing(value.db, options);
    await advanceMediaProcessing(value.db, options);
    const groupedRequest = [...transport.requestPayloads].reverse().find((payload) => payload.includes("Compare exact games")) ?? "";
    expect(groupedRequest).toContain("https://ign.com/articles/cyberpunk-later");
    expect(groupedRequest).toContain("https://eurogamer.net/articles/baldurs-later");
    await advanceMediaProcessing(value.db, options);
    expect(await getMediaGameMatches(value.db, 1091500, { includeUnpublished: true })).toHaveLength(1);
    const submissions = [...transport.submissions, ...transport.embeddingSubmissions];
    await advanceMediaProcessing(value.db, options);
    expect([...transport.submissions, ...transport.embeddingSubmissions]).toEqual(submissions);
    expect(await getMediaGameMatches(value.db, 1091500, { includeUnpublished: true })).toHaveLength(1);
    const beforeCategoryChange = transport.embeddingSubmissions.length;
    const source = value.native.prepare("SELECT id FROM media_sources WHERE appid = 1091500").get() as { id: number };
    const current = value.native.prepare("SELECT * FROM media_article_extractions WHERE source_id = ? AND active = 1").get(source.id) as {
      input_identity: string; content_hash: string; cleanup_version: string; model: string; config_version: string; output_json: string;
    };
    const changed = JSON.parse(current.output_json) as { similarityInputs: { gameplay: string[]; storyWorld: string[] } };
    changed.similarityInputs.storyWorld = ["a changed mythic world"];
    value.native.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ?").run(source.id);
    value.native.prepare("INSERT INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json) VALUES (?, 'changed-extraction', ?, ?, ?, ?, ?)").run(source.id, current.content_hash, current.cleanup_version, current.model, current.config_version, JSON.stringify(changed));
    await advanceMediaProcessing(value.db, options);
    expect(transport.embeddingSubmissions).toHaveLength(beforeCategoryChange + 1);
    expect(transport.embeddingSubmissions.at(-1)).toContain(":story_world:");
    await advanceMediaProcessing(value.db, options);
    value.native.prepare("UPDATE media_article_extractions SET active = CASE WHEN input_identity = ? THEN 1 ELSE 0 END WHERE source_id = ?").run(current.input_identity, source.id);
    await advanceMediaProcessing(value.db, options);
    const activeStoryEmbeddings = value.native.prepare("SELECT COUNT(*) AS count FROM media_article_embeddings WHERE source_id = ? AND dimension = 'story_world' AND active = 1").get(source.id) as { count: number };
    expect(activeStoryEmbeddings.count).toBe(1);
  });
});
