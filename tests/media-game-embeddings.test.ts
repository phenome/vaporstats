import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  advanceMediaProcessing,
  authorizeMediaProcessing,
  GEMINI_BATCH_CAPABILITY_VERSION,
  GEMINI_BATCH_PRICING_VERSION,
  type GeminiBatchPoll,
  type GeminiBatchTransport,
} from "../src/lib/media-processing";

const APPID = 1091500;
const URL = "https://ign.com/articles/cyberpunk-review";
const ARTICLE_HTML = "<!doctype html><html><body><article><h1>Cyberpunk 2077 Review</h1><p>Cyberpunk 2077 has a focused campaign with flexible combat and memorable encounters. This preview was played on PC during Early Access and does not assess the final release.</p></article></body></html>";
const cleanups: Array<() => void> = [];

afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

function adapter(native: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next) { values = next; return statement; },
        async first<T>(column?: string) {
          const row = native.prepare(query).get(...(values as SQLQueryBindings[])) as Record<string, unknown> | null;
          return row ? (column ? row[column] : row) as T : null;
        },
        async run() {
          const result = native.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: result.changes, duration: 0 } };
        },
        async all<T>() {
          return { success: true, results: native.prepare(query).all(...(values as SQLQueryBindings[])) as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T>() { return native.prepare(query).values(...(values as SQLQueryBindings[])) as T[]; },
      };
      return statement;
    },
    async batch(statements) {
      native.exec("BEGIN IMMEDIATE");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        native.exec("COMMIT");
        return result;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query) { native.exec(query); return { count: 0, duration: 0 }; },
  };
}

class ControlledTransport implements GeminiBatchTransport {
  readonly submissions: string[] = [];
  readonly embeddingSubmissions: string[] = [];
  readonly requestBodies: Record<string, unknown>[] = [];
  readonly polls = new Map<string, GeminiBatchPoll>();
  nextPolls: GeminiBatchPoll[] = [];
  beforePoll: ((name: string) => void | Promise<void>) | undefined;
  private sequence = 0;

  async countTokens(): Promise<number> { return 100; }

  async submitBatch(_model: string, requests: readonly { key: string; request: Record<string, unknown> }[]): Promise<{ name: string }> {
    const request = requests[0]!;
    this.requestBodies.push(request.request);
    const name = `batches/generate-${++this.sequence}`;
    this.submissions.push(request.key);
    this.polls.set(name, this.nextPolls.shift() ?? { state: "pending" });
    return { name };
  }

  async submitEmbeddingBatch(_model: string, requests: readonly { key: string; request: Record<string, unknown> }[]): Promise<{ name: string }> {
    const request = requests[0]!;
    this.requestBodies.push(request.request);
    const name = `batches/embed-${++this.sequence}`;
    this.embeddingSubmissions.push(request.key);
    this.polls.set(name, this.nextPolls.shift() ?? { state: "pending" });
    return { name };
  }

  async pollBatch(name: string): Promise<GeminiBatchPoll> {
    await this.beforePoll?.(name);
    return this.polls.get(name) ?? { state: "pending" };
  }
}

interface EmbeddingFixture {
  native: Database;
  db: AppDatabase;
  runId: number;
  directory: string;
}

function fixture(): EmbeddingFixture {
  const directory = mkdtempSync(join(tmpdir(), "vaporstats-game-embeddings-"));
  const native = new Database(join(directory, "processing.sqlite"));
  applyMigrations(native);
  native.exec("PRAGMA foreign_keys = ON");
  native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(APPID, "Cyberpunk 2077", "cyberpunk-2077");
  native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')").run("initial:embedding-test", JSON.stringify([APPID]));
  const runId = Number((native.prepare("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get() as { id: number }).id);
  native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review', 1, 'PC', 'Early Access')").run(APPID, URL, "Cyberpunk 2077 Review", "2026-09-11T00:00:00.000Z");
  const value = { native, db: adapter(native), runId, directory };
  cleanups.push(() => { try { native.close(true); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return value;
}

function extractionOutput(): Record<string, unknown> {
  return {
    contributions: [
      { text: "Combat supports flexible builds", category: "Gameplay & systems" },
      { text: "The campaign follows factions across a dense city", category: "Story & world" },
    ],
    similarityInputs: {
      gameplay: ["Combat supports flexible builds"],
      storyWorld: ["The campaign follows factions across a dense city"],
    },
    qualifications: ["Early Access", "PC preview"],
    provenance: [],
  };
}

function overviewOutput(input: { gameplay?: string[]; storyWorld?: string[] } = {
  gameplay: ["Combat supports flexible builds", "Excellent quality and fun"],
  storyWorld: ["The campaign follows factions across a dense city"],
}): Record<string, unknown> {
  return {
    statements: [{ text: "The game combines flexible combat with a faction-driven city campaign.", sourceUrls: [URL] }],
    similarityInputs: input,
  };
}

function embeddingOutput(value: number): Record<string, unknown> {
  return { embedding: { values: Array.from({ length: 3072 }, () => value) } };
}

async function advance(value: EmbeddingFixture, transport: ControlledTransport, article = ARTICLE_HTML): Promise<void> {
  await advanceMediaProcessing(value.db, {
    runId: value.runId,
    transport,
    articleFetch: async () => article,
    now: new Date("2026-09-11T00:00:00.000Z"),
    pricingVersion: GEMINI_BATCH_PRICING_VERSION,
    capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
  });
}

async function completeInitial(value: EmbeddingFixture, transport: ControlledTransport): Promise<void> {
  await authorizeMediaProcessing(value.db, value.runId);
  transport.nextPolls.push(
    { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
    { state: "succeeded", output: overviewOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
  );
  await advance(value, transport);
  transport.nextPolls.push(
    { state: "succeeded", output: embeddingOutput(1), usage: { inputTokens: 100 } },
    { state: "succeeded", output: embeddingOutput(2), usage: { inputTokens: 100 } },
  );
  await advance(value, transport);
  await advance(value, transport);
}
async function startNextRun(value: EmbeddingFixture, key: string): Promise<void> {
  value.native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')").run(`initial:${key}`, JSON.stringify([APPID]));
  const latest = value.native.query<{ id: number }, []>("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get();
  if (!latest) throw new Error("Media discovery run was not created");
  value.runId = latest.id;
  await authorizeMediaProcessing(value.db, value.runId);
}


describe("game overview aggregate embeddings", () => {
  test("submits one canonical vector per supported dimension and no explanation work", async () => {
    const value = fixture();
    const transport = new ControlledTransport();
    await completeInitial(value, transport);

    const embeddings = await value.db.prepare("SELECT appid, dimension, overview_input_identity, model, dimensions, active FROM media_game_embeddings ORDER BY dimension").all<{
      appid: number; dimension: string; overview_input_identity: string; model: string; dimensions: number; active: number;
    }>();
    expect(embeddings.results).toHaveLength(2);
    expect(embeddings.results?.map(({ dimension }) => dimension)).toEqual(["gameplay", "story_world"]);
    expect(embeddings.results?.every((row) => row.appid === APPID && row.model === "gemini-embedding-2" && row.dimensions === 3072 && row.active === 1)).toBe(true);
    const overview = await value.db.prepare("SELECT output_json FROM media_game_overviews WHERE appid = ? AND active = 1").bind(APPID).first<{ output_json: string }>();
    expect(JSON.parse(overview?.output_json ?? "{}").similarityInputs).toEqual({
      gameplay: ["Combat supports flexible builds"],
      storyWorld: ["The campaign follows factions across a dense city"],
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
    const childOverview = {
      ...overviewOutput(),
      statements: [{ text: "The expansion combines flexible combat with a faction-driven city campaign.", sourceUrls: [childUrl] }],
    };
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: childOverview, usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: embeddingOutput(1), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(2), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(3), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(4), usage: { inputTokens: 100 } },
    );
    await advance(value, transport);
    await advance(value, transport);
    await advance(value, transport);
    const activeSources = await value.db.prepare(
      "SELECT s.appid, s.original_url FROM media_article_extractions e JOIN media_sources s ON s.id = e.source_id WHERE e.active = 1 ORDER BY s.appid",
    ).all<{ appid: number; original_url: string }>();
    expect(activeSources.results).toEqual([
      { appid: APPID, original_url: URL },
      { appid: childAppid, original_url: childUrl },
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
    const transport = new ControlledTransport();
    await completeInitial(value, transport);
    await startNextRun(value, "changed-category");
    const before = transport.embeddingSubmissions.length;
    await value.db.prepare("UPDATE media_game_overviews SET output_json = ? WHERE appid = ? AND active = 1").bind(JSON.stringify(overviewOutput({
      gameplay: ["Combat supports tactical builds"],
      storyWorld: ["The campaign follows factions across a dense city"],
    })), APPID).run();
    transport.nextPolls.push({ state: "succeeded", output: embeddingOutput(3), usage: { inputTokens: 100 } });
    await advance(value, transport);
    await advance(value, transport);
    expect(transport.embeddingSubmissions.length - before).toBe(1);
    expect(transport.embeddingSubmissions.at(-1)).toContain(":gameplay:");
    const activeAfterChange = await value.db.prepare("SELECT dimension FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension").bind(APPID).all<{ dimension: string }>();
    expect(activeAfterChange.results?.map(({ dimension }) => dimension)).toEqual(["gameplay", "story_world"]);
    await startNextRun(value, "removed-category");

    await value.db.prepare("UPDATE media_game_overviews SET output_json = ? WHERE appid = ? AND active = 1").bind(JSON.stringify(overviewOutput({
      gameplay: ["Combat supports tactical builds"],
    })), APPID).run();
    await advance(value, transport);
    const active = await value.db.prepare("SELECT dimension FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension").bind(APPID).all<{ dimension: string }>();
    expect(active.results?.map(({ dimension }) => dimension)).toEqual(["gameplay"]);
    expect(transport.embeddingSubmissions.length - before).toBe(1);
  });
  test("reuses vectors when only the Overview identity changes", async () => {
    const value = fixture();
    const transport = new ControlledTransport();
    await completeInitial(value, transport);
    const previous = await value.db.prepare("SELECT input_identity FROM media_game_overviews WHERE appid = ? AND active = 1").bind(APPID).first<{ input_identity: string }>();
    const embeddingSubmissions = transport.embeddingSubmissions.length;
    await startNextRun(value, "overview-identity");
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advance(value, transport, ARTICLE_HTML.replace("memorable", "notable"));
    await advance(value, transport, ARTICLE_HTML.replace("memorable", "notable"));
    const current = await value.db.prepare("SELECT input_identity FROM media_game_overviews WHERE appid = ? AND active = 1").bind(APPID).first<{ input_identity: string }>();
    const vectors = await value.db.prepare("SELECT dimension, overview_input_identity FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension").bind(APPID).all<{ dimension: string; overview_input_identity: string }>();
    expect(current?.input_identity).not.toBe(previous?.input_identity);
    expect(transport.embeddingSubmissions.length).toBe(embeddingSubmissions);
    expect(vectors.results?.map(({ dimension }) => dimension)).toEqual(["gameplay", "story_world"]);
    expect(vectors.results?.every(({ overview_input_identity }) => overview_input_identity === current?.input_identity)).toBe(true);
  });

  test("rejects an embedding completion after the active Overview changes", async () => {
    const value = fixture();
    const transport = new ControlledTransport();
    await completeInitial(value, transport);
    await startNextRun(value, "stale-completion");
    await value.db.prepare("UPDATE media_game_overviews SET output_json = ? WHERE appid = ? AND active = 1").bind(JSON.stringify(overviewOutput({ gameplay: ["Combat supports tactical builds"], storyWorld: ["The campaign follows factions across a dense city"] })), APPID).run();
    transport.nextPolls.push({ state: "succeeded", output: embeddingOutput(4), usage: { inputTokens: 100 } });
    const before = transport.embeddingSubmissions.length;
    await advance(value, transport);
    expect(transport.embeddingSubmissions.length).toBe(before + 1);
    await value.db.prepare("UPDATE media_game_overviews SET input_identity = ? WHERE appid = ? AND active = 1").bind("c".repeat(64), APPID).run();
    const result = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      articleFetch: async () => "<!doctype html><html><body><article><p>Cyberpunk 2077 has a focused campaign with flexible combat and memorable encounters. This preview was played on PC during Early Access and does not assess the final release.</p></article></body></html>",
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    expect(result.failed).toBeGreaterThan(0);
    const stale = await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'embedding' AND status = 'stale'").first<{ count: number }>();
    expect(Number(stale?.count ?? 0)).toBeGreaterThan(0);
  });
  test("polls and settles a submitted embedding after entity eligibility is lost", async () => {
    const value = fixture();
    const transport = new ControlledTransport();
    await completeInitial(value, transport);
    await startNextRun(value, "lost-eligibility");
    await value.db.prepare("UPDATE media_game_overviews SET output_json = ? WHERE appid = ? AND active = 1").bind(JSON.stringify(overviewOutput({
      gameplay: ["Combat supports tactical builds"],
      storyWorld: ["The campaign follows factions across a dense city"],
    })), APPID).run();
    transport.nextPolls.push({ state: "succeeded", output: embeddingOutput(4), usage: { inputTokens: 100 } });
    const before = transport.embeddingSubmissions.length;
    await advance(value, transport);
    expect(transport.embeddingSubmissions.length).toBe(before + 1);
    await value.db.prepare("UPDATE apps SET is_eligible = 0 WHERE appid = ?").bind(APPID).run();
    const result = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      articleFetch: async () => ARTICLE_HTML,
      now: new Date("2026-09-11T00:00:00.000Z"),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
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
    const transport = new ControlledTransport();
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advance(value, transport);
    transport.nextPolls.push(
      { state: "succeeded", output: embeddingOutput(Number.MAX_VALUE), usage: { inputTokens: 100 } },
      { state: "succeeded", output: embeddingOutput(2), usage: { inputTokens: 100 } },
    );
    await advance(value, transport);
    await advance(value, transport);
    const failed = await value.db.prepare("SELECT status, error FROM media_processing_jobs WHERE stage = 'embedding' AND status = 'failed'").first<{ status: string; error: string }>();
    expect(failed).toEqual({ status: "failed", error: "Gemini embedding returned an incompatible vector" });
    const active = await value.db.prepare("SELECT dimension FROM media_game_embeddings WHERE appid = ? AND active = 1 ORDER BY dimension").bind(APPID).all<{ dimension: string }>();
    expect(active.results?.map(({ dimension }) => dimension)).toEqual(["story_world"]);
  });

  test("keeps embedding work reserved and retryable when submit capability is absent", async () => {
    const value = fixture();
    const transport = new ControlledTransport();
    Object.defineProperty(transport, "submitEmbeddingBatch", { value: undefined });
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advance(value, transport);
    await advance(value, transport);
    const jobs = await value.db.prepare("SELECT status, reservation_active FROM media_processing_jobs WHERE stage = 'embedding'").all<{ status: string; reservation_active: number }>();
    expect(jobs.results?.length).toBeGreaterThan(0);
    expect(jobs.results?.every((job) => job.status === "reserved" && job.reservation_active === 1)).toBe(true);
  });

  test("keeps aggregate reservations within the shared five-dollar bound", async () => {
    const value = fixture();
    const transport = new ControlledTransport();
    await authorizeMediaProcessing(value.db, value.runId);
    transport.nextPolls.push({ state: "pending" });
    await advance(value, transport);
    const totals = await value.db.prepare("SELECT COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE COALESCE(charged_microusd, 0) END), 0) AS total FROM media_processing_jobs").first<{ total: number }>();
    expect(totals).not.toBeNull();
    expect(Number(totals?.total ?? 0)).toBeLessThanOrEqual(5_000_000);
  });
});
