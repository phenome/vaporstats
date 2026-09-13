import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  GEMINI_BATCH_CAPABILITY_VERSION,
  GEMINI_BATCH_BILLING_CONFIRMATION,
  GEMINI_BATCH_PRICING_VERSION,
  advanceMediaProcessing,
  authorizeMediaProcessing,
  createGeminiBatchTransport,
  type GeminiBatchPoll,
  type GeminiBatchTransport,
} from "../src/lib/media-processing";
import { getMediaOverview, normalizeMediaTag, parseMediaOverview } from "../src/lib/media-overview";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";

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

const APPIDS = [1091500, 1086940] as const;
const NAMES: Record<number, string> = { 1091500: "Cyberpunk 2077", 1086940: "Baldur's Gate 3" };
const URLS: Record<number, string> = {
  1091500: "https://ign.com/articles/cyberpunk-review",
  1086940: "https://ign.com/articles/baldurs-review",
};

function articleHtml(appid: number): string {
  const name = NAMES[appid];
  return `<!doctype html><html><head><title>${name} Review</title><script>secret-not-content</script></head><body><nav>Navigation noise</nav><article><h1>${name} Review</h1><p>${name} has a focused campaign with flexible combat and memorable encounters.</p><h2>Qualifications</h2><p>This preview was played on PC during Early Access and does not assess the final release.</p><ul><li>Builds reward experimentation</li><li>Performance varies by platform</li></ul></article><aside class="advertisement">Advertisement noise</aside></body></html>`;
}

function fixture(appids: readonly number[] = [APPIDS[0]]) {
  const directory = mkdtempSync(join(tmpdir(), "vaporstats-media-processing-"));
  const databasePath = join(directory, "processing.sqlite");
  const native = new Database(databasePath);
  applyMigrations(native);
  native.exec("PRAGMA foreign_keys = ON");
  for (const appid of appids) native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, NAMES[appid], NAMES[appid]!.toLowerCase().replaceAll(" ", "-"));
  native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')").run(`initial:${appids.join(",")}:test`, JSON.stringify(appids));
  const runId = Number((native.prepare("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get() as { id: number } | null)?.id);
  for (const appid of appids) {
    native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'preview', 1, 'PC', 'Early Access')").run(appid, URLS[appid], `${NAMES[appid]} Review`, "2026-09-11T00:00:00.000Z");
  }
  return { native, databasePath, directory, db: adapter(native), runId, cleanup: () => { try { native.close(true); } catch { /* already reopened */ } rmSync(directory, { recursive: true, force: true }); } };
}

class ControlledTransport implements GeminiBatchTransport {
  readonly submissions: string[] = [];
  readonly counts: string[] = [];
  readonly requestBodies: Record<string, unknown>[] = [];
  readonly polls = new Map<string, GeminiBatchPoll>();
  nextPolls: GeminiBatchPoll[] = [];
  throwSubmission = false;
  inspectDuringSubmit: ((requestKey: string) => void | Promise<void>) | undefined;

  async countTokens(model: string, request: Record<string, unknown>): Promise<number> {
    this.counts.push(model + JSON.stringify(request).slice(0, 20));
    return 100;
  }

  async submitBatch(_model: string, requests: readonly { key: string; request: Record<string, unknown> }[]): Promise<{ name: string }> {
    const request = requests[0]!;
    this.requestBodies.push(request.request);
    await this.inspectDuringSubmit?.(request.key);
    if (this.throwSubmission) throw new Error("network dropped before batch acknowledgement");
    const name = `batches/test-${this.submissions.length + 1}`;
    this.submissions.push(request.key);
    this.polls.set(name, this.nextPolls.shift() ?? { state: "pending" });
    return { name };
  }

  async pollBatch(name: string): Promise<GeminiBatchPoll> {
    return this.polls.get(name) ?? { state: "pending" };
  }
}

function extractionOutput(): Record<string, unknown> {
  return { contributions: [{ text: "The combat supports flexible builds", category: "Gameplay & systems" }], traits: ["build experimentation"], qualifications: ["Early Access", "PC preview"], provenance: [] };
}

function extractionOutputWithUnsupportedCategories(): Record<string, unknown> {
  return {
    categories: { "Gameplay & systems": ["Supported category evidence"], "Unsupported category": ["Must not persist"] },
    contributions: [
      { text: "Supported contribution", category: "Gameplay & systems" },
      { text: "Unsupported contribution", category: "Unsupported category" },
      { text: "Missing category contribution" },
    ],
    traits: [],
    qualifications: [],
    provenance: [],
  };
}

function overviewOutput(url: string): Record<string, unknown> {
  return {
    statements: [{ text: "The game presents a focused campaign with flexible combat, with the preview's Early Access and PC qualification retained.", sourceUrls: [url] }],
    tags: [{ label: "Build.Experimentation", sourceUrls: [url] }],
  };
}
function overviewOutputForUrls(urls: readonly string[]): Record<string, unknown> {
  return {
    statements: [{ text: "The game presents a focused campaign with flexible combat.", sourceUrls: [...urls] }],
    tags: [{ label: "Build experimentation", sourceUrls: [...urls] }],
  };
}

function overviewOutputWithoutTags(url: string): Record<string, unknown> {
  return {
    statements: [{ text: "The game presents a focused campaign with flexible combat.", sourceUrls: [url] }],
  };
}

function richOverviewOutput(urls: {
  ign: string;
  followup: string;
  eurogamer: string;
  republication: string;
  explicitRepublication: string;
}): Record<string, unknown> {
  return {
    statements: [
      { text: "Critics agree that one outlet saw flexible combat.", sourceUrls: [urls.ign, urls.followup] },
      { text: "Flexible combat has material differences in pacing.", sourceUrls: [urls.ign, urls.eurogamer, urls.republication, urls.explicitRepublication] },
    ],
    categories: [
      {
        name: "Gameplay & systems",
        findings: [
          { text: "Flexible builds support experimentation.", sourceUrls: [urls.ign] },
          { text: "Combat pacing can feel deliberate or sluggish depending on build.", sourceUrls: [urls.ign, urls.eurogamer, urls.republication, urls.explicitRepublication], contested: true },
          { text: "Outlets agree on a duplicated observation.", sourceUrls: [urls.eurogamer, urls.republication, urls.explicitRepublication] },
        ],
      },
      { name: "Visuals & audio", findings: [{ text: "The city presentation stands out.", sourceUrls: [urls.followup] }] },
      { name: "Unsupported category", findings: [{ text: "Must remain absent.", sourceUrls: [urls.ign] }] },
    ],
    prosCons: {
      pros: [{ text: "Flexible builds reward experimentation.", sourceUrls: [urls.ign, urls.eurogamer] }],
      cons: [],
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function finishSingle(fixtureValue: ReturnType<typeof fixture>, transport: ControlledTransport) {
  transport.nextPolls.push({ state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 30, thinkingTokens: 5 } });
  transport.nextPolls.push({ state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 30, thinkingTokens: 5 } });
  const first = await advanceMediaProcessing(fixtureValue.db, { runId: fixtureValue.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), now: new Date("2026-09-11T00:00:00.000Z"), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
  expect(first.submitted).toBe(2);
  const second = await advanceMediaProcessing(fixtureValue.db, { runId: fixtureValue.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), now: new Date("2026-09-11T00:01:00.000Z"), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
  expect(second.completed).toBeGreaterThanOrEqual(2);
  return second;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });
  test("normalizes cited media tags independently of overview wording", () => {
    const url = URLS[APPIDS[0]];
    const parsed = parseMediaOverview({
      statements: [{ text: "The game supports varied tactics.", sourceUrls: [url] }],
      tags: [
        { label: "  First-Person Shooter! ", sourceUrls: [url] },
        { label: "first person shooter", sourceUrls: [url] },
        { label: "unsupported", sourceUrls: ["https://example.test/not-current"] },
      ],
    }, APPIDS[0], new Map([[url, { outlet: "IGN", identities: ["current"] }]]));
    expect(normalizeMediaTag("First.Person Shooter")).toEqual({
      label: "First.Person Shooter",
      slug: "first-person-shooter",
    });
    expect(parsed?.tags).toEqual([{ label: "First-Person Shooter", slug: "first-person-shooter" }]);
  });


describe("bounded Gemini media processing", () => {
  test("orders support after transitive duplicate grouping", () => {
    const urls = {
      first: "https://ign.com/articles/first",
      second: "https://www.eurogamer.net/second",
      bridge: "https://www.gamesradar.com/bridge",
      independentIgn: "https://ign.com/articles/independent",
      independentEurogamer: "https://www.eurogamer.net/independent",
    };
    const sources = new Map([
      [urls.first, { outlet: "IGN", identities: ["origin-a"] }],
      [urls.second, { outlet: "Eurogamer", identities: ["origin-b"] }],
      [urls.bridge, { outlet: "GamesRadar+", identities: ["origin-a", "origin-b"] }],
      [urls.independentIgn, { outlet: "IGN", identities: ["origin-c"] }],
      [urls.independentEurogamer, { outlet: "Eurogamer", identities: ["origin-d"] }],
    ]);
    const parsed = parseMediaOverview({
      statements: [{ text: "Flexible mission design.", sourceUrls: [urls.first] }],
      categories: [{
        name: "Gameplay & systems",
        findings: [
          { text: "Bridged combat pacing.", sourceUrls: [urls.first, urls.second, urls.bridge] },
          { text: "Independent movement and combat.", sourceUrls: [urls.independentIgn, urls.independentEurogamer] },
        ],
      }],
    }, APPIDS[0], sources);
    expect(parsed?.categories[0]?.findings.map((finding) => finding.text)).toEqual([
      "Independent movement and combat.",
      "Bridged combat pacing.",
    ]);
  });
  test("authorizes a persisted discovery run, cleans/discards content, and produces a cited overview", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    const transport = new ControlledTransport();
    await authorizeMediaProcessing(value.db, value.runId);
    const summary = await finishSingle(value, transport);
    const overview = await getMediaOverview(value.db, APPIDS[0], { includeUnpublished: true });
    expect(overview?.tags).toEqual([{ label: "Build.Experimentation", slug: "build-experimentation" }]);
    const membership = await value.db.prepare(
      "SELECT m.tag_label, m.tag_slug, m.source_id, m.extraction_input_identity FROM media_tag_memberships m JOIN media_article_extractions e ON e.source_id = m.source_id AND e.input_identity = m.extraction_input_identity AND e.active = 1 WHERE m.appid = ?",
    ).bind(APPIDS[0]).first<{ tag_label: string; tag_slug: string; source_id: number; extraction_input_identity: string }>();
    expect(membership).toMatchObject({ tag_label: "Build.Experimentation", tag_slug: "build-experimentation" });
    expect(membership?.source_id).toBeGreaterThan(0);
    const activeExtraction = await value.db.prepare("SELECT input_identity FROM media_article_extractions WHERE active = 1").first<{ input_identity: string }>();
    expect(membership?.extraction_input_identity).toBe(activeExtraction?.input_identity);
    expect(overview?.appid).toBe(APPIDS[0]);
    expect(overview?.statements[0]?.sourceUrls).toContain(URLS[APPIDS[0]]);
    expect(summary.overviewAppids).toContain(APPIDS[0]);
    const charged = await value.db.prepare("SELECT COALESCE(SUM(charged_microusd), 0) AS charged FROM media_processing_jobs").first<{ charged: number }>();
    expect(charged?.charged).toBe(78);
    const source = await value.db.prepare("SELECT processing_content FROM media_sources WHERE appid = ?").bind(APPIDS[0]).first<{ processing_content: string | null }>();
    expect(source?.processing_content).toBeNull();
    const persistedExtraction = await value.db.prepare("SELECT output_json FROM media_article_extractions LIMIT 1").first<{ output_json: string }>();
    expect(persistedExtraction?.output_json).not.toContain("secret-not-content");
    const authorization = await value.db.prepare("SELECT billing_confirmation FROM media_processing_authorizations WHERE run_id = ?").bind(value.runId).first<{ billing_confirmation: string | null }>();
    expect(authorization?.billing_confirmation).toBe(GEMINI_BATCH_BILLING_CONFIRMATION);
  });
  test("keeps memberships scoped to each entity and preserves unaffected current support", async () => {
    const value = fixture(APPIDS); cleanups.push(value.cleanup);
    const secondUrl = "https://www.eurogamer.net/cyberpunk-2077-tag-review";
    value.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'Eurogamer', ?, 'review')").run(APPIDS[0], secondUrl, "Cyberpunk 2077 tag review", "2026-09-11T00:00:00.000Z");
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URLS[APPIDS[1]]), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutputForUrls([URLS[APPIDS[0]], secondUrl]), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    const first = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      articleFetch: async (url) => articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    expect(first.submitted).toBe(5);
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      articleFetch: async (url) => articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    const memberships = await value.db.prepare(
      "SELECT appid, source_id, tag_slug FROM media_tag_memberships ORDER BY appid, source_id",
    ).all<{ appid: number; source_id: number; tag_slug: string }>();
    expect(memberships.results).toHaveLength(3);
    expect(memberships.results?.map(({ appid, tag_slug }) => [appid, tag_slug])).toEqual([
      [APPIDS[1], "build-experimentation"],
      [APPIDS[0], "build-experimentation"],
      [APPIDS[0], "build-experimentation"],
    ]);
    const firstSource = value.native.prepare("SELECT id FROM media_sources WHERE original_url = ?").get(URLS[APPIDS[0]]) as { id: number };
    value.native.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ?").run(firstSource.id);
    const current = await value.db.prepare(
      "SELECT m.appid, m.source_id FROM media_tag_memberships m JOIN media_article_extractions e ON e.source_id = m.source_id AND e.input_identity = m.extraction_input_identity AND e.active = 1 ORDER BY m.appid, m.source_id",
    ).all<{ appid: number; source_id: number }>();
    expect(current.results).toHaveLength(2);
    expect(current.results?.map(({ appid }) => appid)).toEqual([APPIDS[1], APPIDS[0]]);
  });

  test("replaces prior memberships when a current synthesis has no tags", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    await finishSingle(value, transport);
    const countBefore = await value.db.prepare("SELECT COUNT(*) AS count FROM media_tag_memberships WHERE appid = ?").bind(APPIDS[0]).first<{ count: number }>();
    expect(countBefore?.count).toBe(1);
    value.native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')").run("initial:empty-tags:test", JSON.stringify([APPIDS[0]]));
    const nextRun = value.native.prepare("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get() as { id: number };
    await authorizeMediaProcessing(value.db, nextRun.id);
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutputWithoutTags(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advanceMediaProcessing(value.db, {
      runId: nextRun.id,
      transport,
      articleFetch: async () => articleHtml(APPIDS[0]).replace("flexible combat", "deliberate combat"),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    await advanceMediaProcessing(value.db, {
      runId: nextRun.id,
      transport,
      articleFetch: async () => articleHtml(APPIDS[0]).replace("flexible combat", "deliberate combat"),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    const countAfter = await value.db.prepare("SELECT COUNT(*) AS count FROM media_tag_memberships WHERE appid = ?").bind(APPIDS[0]).first<{ count: number }>();
    expect(countAfter?.count).toBe(0);
  });

  test("processes every bounded source before one multi-outlet synthesis", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    const secondUrl = "https://www.eurogamer.net/cyberpunk-2077-review";
    value.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform) VALUES (?, 'initial', ?, ?, 'Eurogamer', ?, 'review', 1, 'PC')").run(APPIDS[0], secondUrl, "Cyberpunk 2077 review", "2026-09-11T00:00:00.000Z");
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "pending" },
    );
    const summary = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    const extractionJobs = await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'extraction'").first<{ count: number }>();
    expect(extractionJobs?.count).toBe(2);
    expect(transport.submissions).toHaveLength(3);
    expect(summary.submitted).toBe(3);
    const synthesisRequest = JSON.stringify(transport.requestBodies.at(-1));
    expect(synthesisRequest).toContain(URLS[APPIDS[0]]);
    expect(synthesisRequest).toContain(secondUrl);
  });

  test("does not process more than fifteen selected articles per game", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    for (let index = 1; index < 16; index += 1) {
      value.native.prepare(
        "INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review')",
      ).run(
        APPIDS[0],
        `https://ign.com/articles/cyberpunk-review-${index}`,
        `Cyberpunk 2077 Review ${index}`,
        "2026-09-11T00:00:00.000Z",
      );
    }
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      articleFetch: async () => articleHtml(APPIDS[0]),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    const extractionJobs = await value.db.prepare(
      "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'extraction'",
    ).first<{ count: number }>();
    expect(extractionJobs?.count).toBe(15);
    expect(transport.submissions).toHaveLength(15);
  });

  test("serves controlled authorized output through the detail API without provider work on reads", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    const transport = new ControlledTransport();
    await authorizeMediaProcessing(value.db, value.runId);
    await finishSingle(value, transport);
    const original = process.env.MEDIA_OVERVIEW_PUBLIC;
    try {
      delete process.env.MEDIA_OVERVIEW_PUBLIC;
      expect(await getMediaOverview(value.db, APPIDS[0])).toBeNull();
      process.env.MEDIA_OVERVIEW_PUBLIC = "true";
      for (let read = 0; read < 2; read += 1) {
        const response = await handleGameDetailRequest(
          new Request("https://vaporstats.test/api/games/1091500/detail"),
          value.db,
          APPIDS[0],
        );
        expect(response.status).toBe(200);
        const body = await response.json() as { data: { mediaOverview: { statements: Array<{ sourceUrls: string[] }> } | null } };
        expect(body.data.mediaOverview?.statements[0]?.sourceUrls).toContain(URLS[APPIDS[0]]);
      }
    } finally {
      if (original === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC; else process.env.MEDIA_OVERVIEW_PUBLIC = original;
    }
    expect(transport.submissions).toHaveLength(2);
  });

  test("enforces the lifetime budget across competing reservations", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    await value.db.prepare("INSERT INTO media_processing_jobs (run_id, stage, appid, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd) VALUES (?, 'extraction', ?, 'other-run', 'other-input', 'other-model', 'other-config', 1, 1, 4999999)").bind(value.runId, APPIDS[0]).run();
    const transport = new ControlledTransport();
    const summary = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(summary.submitted).toBe(0);
    expect(summary.outstandingReservedMicrousd).toBeGreaterThanOrEqual(4999999);
    expect(summary.stopReasons).toContain("lifetime_budget");
  });

  test("stops before token counting when the paid capability is unconfirmed", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    const summary = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      articleFetch: async () => articleHtml(APPIDS[0]),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: "wrong-capability",
    });
    expect(summary.submitted).toBe(0);
    expect(transport.counts).toHaveLength(0);
    expect(transport.submissions).toHaveLength(0);
    expect(summary.stopReasons).toEqual(["capability_unconfirmed"]);
    expect(summary.status).toBe("waiting");
  });

  test("marks submission failures uncertain and does not retry them", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    let observedDuringSubmit: string | null = null;
    const transport = new ControlledTransport();
    transport.inspectDuringSubmit = async () => {
      const job = await value.db.prepare("SELECT status FROM media_processing_jobs LIMIT 1").first<{ status: string }>();
      observedDuringSubmit = job?.status ?? null;
    };
    transport.throwSubmission = true;
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(String(observedDuringSubmit)).toBe("uncertain");
    expect(first.uncertain).toBe(1);
    transport.throwSubmission = false;
    const second = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(second.submitted).toBe(0);
    expect(transport.submissions).toHaveLength(0);
    const job = await value.db.prepare("SELECT status, reservation_active FROM media_processing_jobs LIMIT 1").first<{ status: string; reservation_active: number }>();
    expect(job).toEqual({ status: "uncertain", reservation_active: 1 });
  });

  test("does not refetch while same-run submitted work is polling", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push({ state: "pending" });
    let fetches = 0;
    const articleFetch = async () => {
      fetches += 1;
      return articleHtml(APPIDS[0]);
    };
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch, pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    const second = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch, pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(first.submitted).toBe(1);
    expect(second.status).toBe("waiting");
    expect(second.submitted).toBe(0);
    expect(fetches).toBe(1);
    expect(transport.submissions).toHaveLength(1);
    await value.db.prepare("UPDATE media_processing_jobs SET error = 'transient provider lookup failure' WHERE stage = 'extraction'").run();
    transport.polls.set("batches/test-1", { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch, pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    const recovered = await value.db.prepare("SELECT status, error FROM media_processing_jobs WHERE stage = 'extraction'").first<{ status: string; error: string | null }>();
    expect(recovered).toEqual({ status: "succeeded", error: null });
  });

  test("refetches a newly authorized run and rebuilds changed article evidence", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    await finishSingle(value, transport);
    const oldExtraction = await value.db.prepare("SELECT input_identity, content_hash FROM media_article_extractions WHERE active = 1").first<{ input_identity: string; content_hash: string }>();
    value.native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')").run("initial:changed-run:test", JSON.stringify([APPIDS[0]]));
    const latestRun = value.native.prepare("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get() as { id: number };
    const newRunId = Number(latestRun.id);
    await authorizeMediaProcessing(value.db, newRunId);
    const changedArticle = articleHtml(APPIDS[0]).replace("flexible combat", "deliberate tactical combat");
    let fetches = 0;
    transport.nextPolls.push({ state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    transport.nextPolls.push({ state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } });
    await advanceMediaProcessing(value.db, {
      runId: newRunId,
      transport,
      articleFetch: async () => {
        fetches += 1;
        return changedArticle;
      },
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    await advanceMediaProcessing(value.db, {
      runId: newRunId,
      transport,
      articleFetch: async () => {
        fetches += 1;
        return changedArticle;
      },
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    const extractionRows = await value.db.prepare("SELECT input_identity, content_hash, active FROM media_article_extractions ORDER BY id").all<{ input_identity: string; content_hash: string; active: number }>();
    const extractions = extractionRows.results ?? [];
    expect(fetches).toBe(1);
    expect(transport.submissions).toHaveLength(4);
    expect(extractions).toHaveLength(2);
    expect(extractions[0]?.input_identity).not.toBe(extractions[1]?.input_identity);
    expect(extractions[0]?.content_hash).not.toBe(extractions[1]?.content_hash);
    expect(extractions.filter((row) => row.active === 1)).toHaveLength(1);
    expect(extractions.find((row) => row.active === 1)?.input_identity).not.toBe(oldExtraction?.input_identity);
  });

  test("keeps supported output active while a config-only replacement is pending", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    await finishSingle(value, transport);
    const source = await value.db.prepare("SELECT appid, original_url, title, outlet, author, published_at, updated_at, type, hands_on, affiliation, platform, build_context, normalized_content_hash, cleanup_version FROM media_sources WHERE appid = ?").bind(APPIDS[0]).first<{
      appid: number; original_url: string; title: string; outlet: string; author: string | null; published_at: string | null; updated_at: string | null; type: string; hands_on: number | null; affiliation: string | null; platform: string | null; build_context: string | null; normalized_content_hash: string; cleanup_version: string;
    }>();
    const extraction = await value.db.prepare("SELECT id, model FROM media_article_extractions WHERE active = 1").first<{ id: number; model: string }>();
    expect(source).not.toBeNull();
    expect(extraction).not.toBeNull();
    const legacyConfig = "media-extraction-legacy";
    const legacyIdentity = createHash("sha256").update(stableJson({
      stage: "extraction",
      hash: source!.normalized_content_hash,
      cleanupVersion: source!.cleanup_version,
      model: extraction!.model,
      configVersion: legacyConfig,
      metadata: {
        appid: source!.appid,
        originalUrl: source!.original_url,
        title: source!.title,
        outlet: source!.outlet,
        author: source!.author,
        publishedAt: source!.published_at,
        updatedAt: source!.updated_at,
        type: source!.type,
        handsOn: source!.hands_on,
        affiliation: source!.affiliation,
        platform: source!.platform,
        buildContext: source!.build_context,
      },
    })).digest("hex");
    await value.db.prepare("UPDATE media_article_extractions SET input_identity = ?, config_version = ? WHERE id = ?").bind(legacyIdentity, legacyConfig, extraction!.id).run();
    value.native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')").run("initial:config-refresh:test", JSON.stringify([APPIDS[0]]));
    const newRun = value.native.prepare("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get() as { id: number };
    await authorizeMediaProcessing(value.db, newRun.id);
    transport.nextPolls.push({ state: "pending" }, { state: "pending" });
    await advanceMediaProcessing(value.db, {
      runId: newRun.id,
      transport,
      articleFetch: async () => articleHtml(APPIDS[0]),
      pricingVersion: GEMINI_BATCH_PRICING_VERSION,
      capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
    });
    expect(await getMediaOverview(value.db, APPIDS[0], { includeUnpublished: true })).not.toBeNull();
    const active = await value.db.prepare("SELECT input_identity FROM media_article_extractions WHERE active = 1").first<{ input_identity: string }>();
    expect(active?.input_identity).toBe(legacyIdentity);
  });

  test("filters unsupported and missing contribution categories before persistence and synthesis", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push({ state: "succeeded", output: extractionOutputWithUnsupportedCategories(), usage: { inputTokens: 100, outputTokens: 20 } });
    const summary = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(summary.submitted).toBe(2);
    const extraction = await value.db.prepare("SELECT output_json FROM media_article_extractions WHERE active = 1").first<{ output_json: string }>();
    const persisted = extraction?.output_json ?? "";
    expect(persisted).toContain("Supported contribution");
    expect(persisted).toContain("Supported category evidence");
    expect(persisted).not.toContain("Unsupported contribution");
    expect(persisted).not.toContain("Unsupported category");
    expect(persisted).not.toContain("Missing category contribution");
    const synthesisRequest = JSON.stringify(transport.requestBodies[1]);
    expect(synthesisRequest).toContain("Supported contribution");
    expect(synthesisRequest).not.toContain("Unsupported contribution");
    expect(synthesisRequest).not.toContain("Unsupported category");
    expect(synthesisRequest).not.toContain("Missing category contribution");
  });

  test("persists ordered cited synthesis without false cross-outlet support", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    const urls = {
      ign: URLS[APPIDS[0]],
      followup: "https://ign.com/articles/cyberpunk-review-followup",
      eurogamer: "https://www.eurogamer.net/cyberpunk-2077-review",
      republication: "https://www.gamesradar.com/cyberpunk-2077-review",
      explicitRepublication: "https://kotaku.com/cyberpunk-2077-review-republication",
    };
    for (const [url, outlet, platform, build] of [
      [urls.followup, "IGN", "PC", "release"],
      [urls.eurogamer, "Eurogamer", null, null],
      [urls.republication, "GamesRadar+", "PC", "release"],
      [urls.explicitRepublication, "Kotaku", "PC", "release"],
    ] as const) {
      value.native.prepare(
        "INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, ?, ?, 'review', 1, ?, ?)",
      ).run(APPIDS[0], url, "Cyberpunk 2077 review", outlet, "2026-09-11T00:00:00.000Z", platform, build);
    }
    value.native.prepare("UPDATE media_sources SET author = 'Wire Author', title = 'Wire Original' WHERE original_url = ?").run(urls.eurogamer);
    value.native.prepare("INSERT INTO apps (appid, name, slug, type, parent_appid) VALUES (2138330, 'Cyberpunk 2077: Phantom Liberty', 'cyberpunk-2077-phantom-liberty', 'expansion', ?)").run(APPIDS[0]);
    const expansionUrl = "https://ign.com/articles/phantom-liberty-review";
    value.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (2138330, 'initial', ?, 'Phantom Liberty review', 'IGN', ?, 'review')").run(expansionUrl, "2026-09-11T00:00:00.000Z");

    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: { ...extractionOutput(), originatingAssessment: "Wire Author|Wire Original" }, usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: richOverviewOutput(urls), usage: { inputTokens: 100, outputTokens: 60 } },
    );
    const articleFetch = async (url: string) => {
      if (url === urls.eurogamer || url === urls.republication) {
        return articleHtml(APPIDS[0]).replace("memorable encounters", "measured encounters");
      }
      if (url === urls.explicitRepublication) {
        return articleHtml(APPIDS[0]).replace("memorable encounters", "republished encounters");
      }
      if (url === urls.followup) return articleHtml(APPIDS[0]).replace("memorable encounters", "later encounters");
      return articleHtml(APPIDS[0]);
    };
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch, pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(first.submitted).toBe(6);
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch, pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });

    const overview = await getMediaOverview(value.db, APPIDS[0], { includeUnpublished: true });
    expect(overview?.statements.map((finding) => finding.text)).toEqual([
      "Flexible combat has material differences in pacing.",
    ]);
    expect(overview?.categories.map((category) => category.name)).toEqual([
      "Gameplay & systems",
      "Visuals & audio",
    ]);
    expect(overview?.categories[0]?.findings.map((finding) => finding.text)).toEqual([
      "Combat pacing can feel deliberate or sluggish depending on build.",
      "Flexible builds support experimentation.",
    ]);
    expect(overview?.categories[0]?.findings[0]?.contested).toBe(true);
    expect(overview?.categories[0]?.findings[0]?.sourceUrls).toEqual([
      urls.ign,
      urls.eurogamer,
      urls.republication,
      urls.explicitRepublication,
    ]);
    expect(overview?.prosCons?.pros[0]?.sourceUrls).toEqual([urls.ign, urls.eurogamer]);
    expect(overview?.prosCons?.cons).toEqual([]);
    const synthesisRequest = JSON.stringify(transport.requestBodies.at(-1));
    expect(synthesisRequest).not.toContain(expansionUrl);
    expect(synthesisRequest).toContain('\\"platform\\":null');
    const synthesisJobs = await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'synthesis'").first<{ count: number }>();
    expect(synthesisJobs?.count).toBe(1);
  });
  test("reopens submitted work, isolates partial failures, and reuses unchanged output", async () => {
    const value = fixture(APPIDS); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push({ state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    transport.nextPolls.push({ state: "failed", error: "one item failed", usage: { inputTokens: 100, outputTokens: 1 } });
    transport.nextPolls.push({ state: "succeeded", output: overviewOutput(URLS[APPIDS[1]]), usage: { inputTokens: 100, outputTokens: 20 } });
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async (url) => articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    value.native.close(true);
    const reopenedNative = new Database(value.databasePath);
    reopenedNative.exec("PRAGMA foreign_keys = ON");
    cleanups.push(() => reopenedNative.close(true));
    const reopenedDb = adapter(reopenedNative);
    await advanceMediaProcessing(reopenedDb, { runId: value.runId, transport, articleFetch: async (url) => articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(await getMediaOverview(reopenedDb, APPIDS[1], { includeUnpublished: true })).not.toBeNull();
    expect(await getMediaOverview(reopenedDb, APPIDS[0], { includeUnpublished: true })).toBeNull();
    const submissionCount = transport.submissions.length;
    const reused = await advanceMediaProcessing(reopenedDb, { runId: value.runId, transport, articleFetch: async (url) => articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(reused.submitted).toBe(0);
    expect(reused.reused).toBeGreaterThan(0);
    expect(transport.submissions).toHaveLength(submissionCount);
  });
  test("reconciles submitted work from an earlier authorization", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "pending" },
    );
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });

    value.native.prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')").run("initial:later-authorization:test", JSON.stringify([APPIDS[0]]));
    const laterRun = value.native.prepare("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get() as { id: number };
    await authorizeMediaProcessing(value.db, laterRun.id);
    transport.polls.set("batches/test-2", { state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } });

    const result = await advanceMediaProcessing(value.db, { runId: laterRun.id, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(result.status).toBe("completed");
    expect(await getMediaOverview(value.db, APPIDS[0], { includeUnpublished: true })).not.toBeNull();
  });


  test("changes metadata identity and rejects stale results", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push({ state: "pending" });
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(first.submitted).toBe(1);
    await value.db.prepare("UPDATE media_sources SET published_at = ? WHERE appid = ?").bind("2026-09-12T00:00:00.000Z", APPIDS[0]).run();
    transport.polls.set("batches/test-1", { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    transport.nextPolls.push({ state: "pending" });
    const second = await advanceMediaProcessing(value.db, { runId: value.runId, transport, articleFetch: async () => articleHtml(APPIDS[0]), pricingVersion: GEMINI_BATCH_PRICING_VERSION, capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION });
    expect(second.submitted).toBe(1);
    const active = await value.db.prepare("SELECT COUNT(*) AS count FROM media_article_extractions WHERE active = 1").first<{ count: number }>();
    expect(active?.count).toBe(0);
    const source = await value.db.prepare("SELECT processing_input_identity FROM media_sources WHERE appid = ?").bind(APPIDS[0]).first<{ processing_input_identity: string }>();
    expect(source?.processing_input_identity).toBeTruthy();
  });

  test("uses the official Gemini count, create, and poll REST paths", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      if (String(input).includes(":countTokens")) return Response.json({ totalTokens: 7 });
      if (String(input).includes(":batchGenerateContent")) return Response.json({ name: "batches/official" });
      return Response.json({ state: { name: "BATCH_STATE_RUNNING" } });
    };
    const transport = createGeminiBatchTransport("secret-key", fetchFn);
    expect(await transport.countTokens("gemini-3.1-flash-lite", { contents: [], generationConfig: { maxOutputTokens: 8 } })).toBe(7);
    expect(await transport.submitBatch("gemini-3.1-flash-lite", [{ key: "one", request: { contents: [] } }])).toEqual({ name: "batches/official" });
    expect(await transport.pollBatch("batches/official")).toEqual({ state: "pending" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:countTokens",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:batchGenerateContent",
      "https://generativelanguage.googleapis.com/v1beta/batches/official",
    ]);
    expect(String(calls[0]!.init?.body)).not.toContain("generationConfig");
    expect(String(calls[1]!.init?.body)).not.toContain("secret-key");
  });

  test("normalizes the official nested inline Batch response", async () => {
    const transport = createGeminiBatchTransport("secret-key", async () => Response.json({
      metadata: { state: "BATCH_STATE_SUCCEEDED" },
      response: {
        "@type": "type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatchOutput",
        inlinedResponses: {
          inlinedResponses: [{
            response: {
              candidates: [{ content: { parts: [{ text: "{\"contributions\":[]}" }] } }],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
            },
          }],
        },
      },
    }));
    const result = await transport.pollBatch("batches/official");
    expect(result.state).toBe("succeeded");
    expect(result.output).toBe("{\"contributions\":[]}");
    expect(result.usage?.inputTokens).toBe(12);
    expect(result.usage?.outputTokens).toBe(3);
    expect(result.usage?.thinkingTokens).toBe(2);
  });
});
