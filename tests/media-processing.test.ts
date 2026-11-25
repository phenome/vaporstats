import { afterEach, describe, expect, test } from "bun:test";
import {
  advanceMediaProcessing,
  authorizeMediaProcessing,
  createGeminiBatchTransport,
} from "../src/lib/media-processing";
import { getMediaOverview, normalizeMediaTag, parseMediaOverview } from "../src/lib/media-overview";
import { getMediaSources } from "../src/lib/media-discovery";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { openTestDatabase } from "./support/db";
import {
  ControlledGeminiTransport as ControlledTransport,
  GAME_NAMES,
  emptySynthesisSelection,
  extractionOutput,
  extractionAppid,
  legacyExtractionOutput,
  mediaObservation,
  synthesisEvidence,
  synthesisSelectionId,
  type ChatOutput,
  insertCompletedRun,
  overviewOutput,
  overviewOutputForUrls,
  insertSubmittedGeminiExtraction,
  processingArticleHtml,
  seedApps,
} from "./support/media";

const APPIDS = [1091500, 1086940] as const;
const URLS: Record<number, string> = {
  1091500: "https://ign.com/articles/cyberpunk-review",
  1086940: "https://ign.com/articles/baldurs-review",
};

function articleHtml(appid: number): string {
  return processingArticleHtml(appid).replace(
    "This preview was played on PC during Early Access and does not assess the final release.",
    "The review covers the finished PC release.",
  );
}

function fixture(appids: readonly number[] = [APPIDS[0]]) {
  const database = openTestDatabase("vaporstats-media-processing-");
  seedApps(database.native, appids);
  const runId = insertCompletedRun(database.native, `initial:${appids.join(",")}:test`, appids);
  for (const appid of appids) {
    database.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review', 1, 'PC', 'release')").run(appid, URLS[appid], `${GAME_NAMES[appid]} Review`, "2026-09-11T00:00:00.000Z");
  }
  return { ...database, runId };
}

function extractionOutputWithUnsupportedCategories(request: Parameters<ChatOutput>[0]) {
  const appid = extractionAppid(request);
  const quote = "Builds reward experimentation";
  return { observations: [
    mediaObservation(appid, "supported", "finding", "Supported contribution", quote),
    mediaObservation(appid, "supported-category", "finding", "Supported category evidence", quote),
    mediaObservation(appid, "wrong-category", "finding", "Unsupported contribution", quote, "Unsupported category"),
    mediaObservation(appid, "missing-category", "finding", "Missing category contribution", quote, ""),
  ] };
}

function overviewOutputWithoutTags(url: string): ChatOutput {
  return overviewOutputForUrls([url], { tags: false });
}

const RICH_FINDINGS = {
  stray: "Critics agree that one outlet saw flexible combat.",
  pacing: "Stealth and gunplay support different approaches to fights.",
  flexible: "Flexible builds support experimentation.",
  deliberate: "Combat pacing feels deliberate.",
  sluggish: "Combat pacing feels sluggish.",
  duplicate: "Outlets agree on a duplicated observation.",
  city: "The city presentation stands out.",
  pro: "Flexible builds reward experimentation.",
};

function richOverviewOutput(urls: Record<"ign" | "followup" | "eurogamer" | "republication" | "explicitRepublication", string>): ChatOutput {
  return ({ body }) => {
    const sources = synthesisEvidence(body);
    const ids = (id: keyof typeof RICH_FINDINGS, ...sourceUrls: string[]) => sourceUrls.map((url) => synthesisSelectionId(sources.find(({ sourceUrl }) => sourceUrl === url)!, id));
    const finding = (id: keyof typeof RICH_FINDINGS, ...sourceUrls: string[]) => ({ text: RICH_FINDINGS[id], observationIds: ids(id, ...sourceUrls) });
    const syndicated = [urls.eurogamer, urls.republication, urls.explicitRepublication];
    const empty = emptySynthesisSelection(sources);
    return {
      ...empty,
      statements: [
        { ...finding("pacing", urls.ign, ...syndicated), text: "Fights accommodate both stealth and gunplay." },
        finding("stray", urls.ign),
      ],
      categories: {
        ...empty.categories,
        "Gameplay & systems": [
          finding("flexible", urls.ign),
          finding("deliberate", urls.ign),
          finding("sluggish", ...syndicated),
          { ...finding("pacing", urls.ign, ...syndicated), text: "Fights accommodate both stealth and gunplay." },
        ],
        "Visuals & audio": [finding("city", urls.followup)],
      },
      prosCons: { ...empty.prosCons, pros: [finding("pro", urls.ign, urls.eurogamer)] },
    };
  };
}

function sourceIds(fixtureValue: ReturnType<typeof fixture>): number[] {
  return fixtureValue.native.query<{ id: number }, []>("SELECT id FROM media_sources ORDER BY id").all().map(({ id }) => id);
}

async function finishSingle(fixtureValue: ReturnType<typeof fixture>, transport: ControlledTransport) {
  transport.nextPolls.push({ state: "succeeded", output: extractionOutput("Build.Experimentation"), usage: { inputTokens: 100, outputTokens: 30, thinkingTokens: 5 } });
  transport.nextPolls.push({ state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 30, thinkingTokens: 5 } });
  // Text answers settle as they arrive: one advance extracts and synthesizes.
  const summary = await advanceMediaProcessing(fixtureValue.db, { runId: fixtureValue.runId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]), now: new Date("2026-09-11T00:00:00.000Z") });
  expect(summary).toMatchObject({ submitted: 2, completed: 2 });
  return summary;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });
  test("normalizes cited media tags independently of overview wording", () => {
    const url = URLS[APPIDS[0]];
    const parsed = parseMediaOverview({
      statements: [{ text: "The game supports varied tactics.", sourceUrls: [url] }],
      categories: [{ name: "Gameplay & systems", findings: [{ text: "Stealth is useful but inconsistently supported.", sourceUrls: [url], contested: true }] }],
      tags: [
        { label: "  First-Person Shooter! ", sourceUrls: [url] },
        { label: "first person shooter", sourceUrls: [url] },
        { label: "Joy-Con mouse-style aiming (Switch 2 port)!", sourceUrls: [url] },
        { label: "unsupported", sourceUrls: ["https://example.test/not-current"] },
      ],
    }, APPIDS[0], new Map([[url, { outlet: "IGN", identities: ["current"] }]]));
    expect(normalizeMediaTag("First.Person Shooter")).toEqual({
      label: "First.Person Shooter",
      slug: "first-person-shooter",
    });
    expect(parsed?.tags).toEqual([
      { label: "First-Person Shooter", slug: "first-person-shooter" },
      { label: "Joy-Con mouse-style aiming (Switch 2 port)", slug: "joy-con-mouse-style-aiming-switch-2-port" },
    ]);
    expect(parsed?.categories[0]?.findings[0]?.contested).toBe(true);
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
    // OpenRouter reports each request's cost: 100 input and 30 output tokens at Claude Haiku 5.5's prices.
    expect(charged?.charged).toBe(50);
    const source = await value.db.prepare("SELECT processing_content FROM media_sources WHERE appid = ?").bind(APPIDS[0]).first<{ processing_content: string | null }>();
    expect(source?.processing_content).toBeNull();
    const persistedExtraction = await value.db.prepare("SELECT output_json FROM media_article_extractions LIMIT 1").first<{ output_json: string }>();
    expect(persistedExtraction?.output_json).not.toContain("secret-not-content");
  });
  test("processes an authorized root's eligible child as an independent durable entity", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    const childAppid = 2138330;
    const childUrl = "https://ign.com/articles/phantom-liberty-review";
    value.native.prepare("INSERT INTO apps (appid, name, slug, type, parent_appid) VALUES (?, ?, ?, 'expansion', ?)").run(childAppid, "Cyberpunk 2077: Phantom Liberty", "cyberpunk-2077-phantom-liberty", APPIDS[0]);
    value.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review', 1, 'PC', 'release')").run(childAppid, childUrl, "Phantom Liberty Review", "2026-09-11T00:00:00.000Z");
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: extractionOutput("expansion combat"), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(childUrl), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    const first = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async (url) => url === childUrl ? articleHtml(APPIDS[0]).replaceAll("Cyberpunk 2077", "Phantom Liberty") : articleHtml(APPIDS[0]),
    });
    expect(first.submitted).toBe(4);
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async (url) => url === childUrl ? articleHtml(APPIDS[0]).replaceAll("Cyberpunk 2077", "Phantom Liberty") : articleHtml(APPIDS[0]),
    });
    expect(await getMediaOverview(value.db, APPIDS[0], { includeUnpublished: true })).not.toBeNull();
    expect(await getMediaOverview(value.db, childAppid, { includeUnpublished: true })).not.toBeNull();
    await value.db.prepare("UPDATE apps SET type = 'soundtrack' WHERE appid = ?").bind(childAppid).run();
    expect(await getMediaSources(value.db, childAppid, { includeUnpublished: true })).toEqual([]);
    expect(await getMediaOverview(value.db, childAppid, { includeUnpublished: true })).toBeNull();
    await value.db.prepare("UPDATE apps SET type = 'expansion' WHERE appid = ?").bind(childAppid).run();
    const overviewAppids = await value.db.prepare("SELECT appid FROM media_game_overviews WHERE active = 1 ORDER BY appid").all<{ appid: number }>();
    expect(overviewAppids.results?.map(({ appid }) => appid)).toEqual([APPIDS[0], childAppid]);
    const activeSources = await value.db.prepare(
      "SELECT s.appid, s.original_url FROM media_article_extractions e JOIN media_sources s ON s.id = e.source_id WHERE e.active = 1 ORDER BY s.appid",
    ).all<{ appid: number; original_url: string }>();
    expect(activeSources.results).toEqual([
      { appid: APPIDS[0], original_url: URLS[APPIDS[0]] },
      { appid: childAppid, original_url: childUrl },
    ]);
  });
  test("excludes ineligible and accessory children from authorized processing", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    const ineligibleChild = 2138330;
    const accessoryChild = 2138331;
    const childRows = [
      [ineligibleChild, "Cyberpunk 2077: Ineligible Expansion", "https://ign.com/articles/ineligible-expansion-review"],
      [accessoryChild, "Cyberpunk 2077 Dedicated Server", "https://ign.com/articles/dedicated-server-review"],
    ] as const;
    for (const [appid, name, url] of childRows) {
      value.native.prepare("INSERT INTO apps (appid, name, slug, type, parent_appid) VALUES (?, ?, ?, 'expansion', ?)").run(appid, name, name.toLowerCase().replaceAll(" ", "-"), APPIDS[0]);
      value.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review')").run(appid, url, name, "2026-09-11T00:00:00.000Z");
    }
    value.native.prepare("UPDATE apps SET is_eligible = 0 WHERE appid = ?").run(ineligibleChild);
    value.native.prepare("INSERT INTO app_relationships (parent_appid, child_appid, relationship_type) VALUES (?, ?, 'server')").run(APPIDS[0], accessoryChild);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    const result = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    expect(result.submitted).toBe(2);
    const jobAppids = await value.db.prepare("SELECT DISTINCT appid FROM media_processing_jobs WHERE run_id = ? ORDER BY appid").bind(value.runId).all<{ appid: number }>();
    expect(jobAppids.results?.map(({ appid }) => appid)).toEqual([APPIDS[0]]);
    const childJobs = await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE appid IN (?, ?)").bind(ineligibleChild, accessoryChild).first<{ count: number }>();
    expect(Number(childJobs?.count ?? 0)).toBe(0);
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
      transport, openRouter: transport.openRouter,
      articleFetch: async (url) => articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]),
    });
    expect(first.submitted).toBe(5);
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async (url) => articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]),
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
    const nextRunId = insertCompletedRun(value.native, "initial:empty-tags:test", [APPIDS[0]]);
    await authorizeMediaProcessing(value.db, nextRunId, { affectedSourceIds: sourceIds(value) });
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutputWithoutTags(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    await advanceMediaProcessing(value.db, {
      runId: nextRunId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]).replace("flexible combat", "deliberate combat"),
    });
    await advanceMediaProcessing(value.db, {
      runId: nextRunId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]).replace("flexible combat", "deliberate combat"),
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
      { state: "succeeded", output: overviewOutputForUrls([URLS[APPIDS[0]], secondUrl]), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    const summary = await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });
    const extractionJobs = await value.db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE stage = 'extraction'").first<{ count: number }>();
    expect(extractionJobs?.count).toBe(2);
    expect(transport.submissions).toHaveLength(3);
    expect(summary.submitted).toBe(3);
    const synthesisRequest = JSON.stringify(transport.requestBodies.at(-1));
    expect(synthesisRequest).not.toContain(RICH_FINDINGS.stray);
    expect(synthesisRequest).not.toContain(RICH_FINDINGS.duplicate);
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
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
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

  test("marks a submission in flight uncertain, and a connection lost after sending returns it to the queue with backoff", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    let observedDuringSubmit: string | null = null;
    const transport = new ControlledTransport();
    transport.inspectDuringSubmit = async () => {
      const job = await value.db.prepare("SELECT status FROM media_processing_jobs LIMIT 1").first<{ status: string }>();
      observedDuringSubmit = job?.status ?? null;
    };
    transport.throwSubmission = true;
    const now = new Date("2026-11-18T07:00:00.000Z");
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, now, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });
    expect(String(observedDuringSubmit)).toBe("uncertain");
    expect(first.uncertain).toBe(1);
    transport.throwSubmission = false;
    // The backoff holds it for one tick.
    const second = await advanceMediaProcessing(value.db, { runId: value.runId, now: new Date("2026-11-18T07:05:00.000Z"), transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });
    expect(second.submitted).toBe(0);
    expect(transport.submissions).toHaveLength(0);
    const job = await value.db.prepare("SELECT status, error, next_attempt_at, reservation_active FROM media_processing_jobs LIMIT 1").first();
    // New work reserves nothing: the provider's credit limit bounds spend.
    expect(job).toEqual({ status: "queued", error: "uncertain:no_response", next_attempt_at: "2026-11-18T07:15:00.000Z", reservation_active: 0 });
  });

  test("text answers scripted on the controlled transport reach processing through the real OpenRouter transport and classifier", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    // A 200 that reports a provider failure after acceptance only means
    // something to the real transport: it is uncertain, with its charge kept.
    transport.nextPolls.push({ state: "reply", reply: { status: 200, body: { id: "gen-accepted", usage: { prompt_tokens: 100, completion_tokens: 0, cost: 0.00001 }, error: { code: 502, message: "Provider returned error" } } } });

    const summary = await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });

    expect(summary.uncertain).toBe(1);
    expect(value.native.query("SELECT status, error, generation_id, charged_microusd FROM media_processing_jobs").all()).toEqual([
      { status: "queued", error: "uncertain:accepted_http_502", generation_id: "gen-accepted", charged_microusd: 10 },
    ]);
  });

  test("does not refetch or resubmit while a Gemini extraction batch submitted before the move to OpenRouter is polling", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    insertSubmittedGeminiExtraction(value.native, { runId: value.runId, sourceId: sourceIds(value)[0]! });
    const transport = new ControlledTransport();
    transport.polls.set("batches/test-1", { state: "pending" });
    let fetches = 0;
    const articleFetch = async () => {
      fetches += 1;
      return articleHtml(APPIDS[0]);
    };
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch });
    const second = await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch });
    expect(first.submitted).toBe(0);
    expect(second.status).toBe("waiting");
    expect(second.submitted).toBe(0);
    expect(fetches).toBe(0);
    expect(transport.submissions).toHaveLength(0);
    await value.db.prepare("UPDATE media_processing_jobs SET error = 'transient provider lookup failure' WHERE stage = 'extraction'").run();
    transport.polls.set("batches/test-1", { state: "succeeded", output: legacyExtractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch });
    const recovered = await value.db.prepare("SELECT status, error FROM media_processing_jobs WHERE stage = 'extraction'").first<{ status: string; error: string | null }>();
    expect(recovered).toEqual({ status: "succeeded", error: null });
  });

  test("refetches an authorized affected source and rebuilds changed article evidence", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    await finishSingle(value, transport);
    const oldExtraction = await value.db.prepare("SELECT input_identity, content_hash FROM media_article_extractions WHERE active = 1").first<{ input_identity: string; content_hash: string }>();
    const newRunId = insertCompletedRun(value.native, "initial:changed-run:test", [APPIDS[0]]);
    await authorizeMediaProcessing(value.db, newRunId, { affectedSourceIds: sourceIds(value) });
    const changedArticle = articleHtml(APPIDS[0]).replace("flexible combat", "deliberate tactical combat");
    let fetches = 0;
    transport.nextPolls.push({ state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    transport.nextPolls.push({ state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } });
    await advanceMediaProcessing(value.db, {
      runId: newRunId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => {
        fetches += 1;
        return changedArticle;
      },
    });
    await advanceMediaProcessing(value.db, {
      runId: newRunId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => {
        fetches += 1;
        return changedArticle;
      },
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

  test("filters unsupported and missing observation categories before persistence and synthesis", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push({ state: "succeeded", output: extractionOutputWithUnsupportedCategories, usage: { inputTokens: 100, outputTokens: 20 } });
    transport.nextPolls.push({ state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } });
    const summary = await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });
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

  test("excludes review factboxes from gameplay evidence while retaining article prose and product context", async () => {
    const value = fixture();
    cleanups.push(value.cleanup);
    value.native.prepare("UPDATE media_sources SET type = 'preview', build_context = 'Early Access'").run();
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: { observations: [mediaObservation(APPIDS[0], "coop", "finding", "Drop-in cooperation", "a second player could drop into the same mission", "Social play")] } },
      { state: "succeeded", output: overviewOutputWithoutTags(URLS[APPIDS[0]]) },
    );
    const html = processingArticleHtml(APPIDS[0]).replace("<html>", '<html class="ads-enabled">').replace("<body>", '<body class="reading">').replace("</article>", `
      <div class="ad-slot"><p>Paid placement for a multiplayer game</p></div>
      <div class="fancy-box">
        <div class="fancy_box-title">Need to Know</div>
        <div class="fancy_box_body">
          <p><strong>Multiplayer:</strong> Yes<br><strong>Steam Deck:</strong> Verified</p>
        </div>
      </div>
      <div class="fancy-box">
        <div class="fancy_box-title">Playing Together</div>
        <p>During the preview, a second player could drop into the same mission and take a different role.</p>
      </div>
      <p class="reading">The Early Access character creator offers four distinct playable classes.</p>
    </article>`);

    const summary = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      openRouter: transport.openRouter,
      articleFetch: async () => html,
    });

    expect(summary).toMatchObject({ submitted: 2, completed: 2 });
    const extraction = transport.openRouterApi.requests[0]!.body.messages;
    expect(extraction[1]?.content).toContain('"buildContext":"Early Access"');
    expect(extraction[1]?.content).not.toContain("Paid placement");
    expect(extraction[1]?.content).toContain("a second player could drop into the same mission");
    expect(extraction[1]?.content).toContain("character creator offers four distinct playable classes");
    expect(extraction[1]?.content).not.toContain("Multiplayer:");
    expect(extraction[1]?.content).not.toContain("Verified");
    const synthesis = transport.openRouterApi.requests[1]!.body.messages[0]?.content;
    expect(extraction[0]?.content).toContain("how human players cooperate");
    expect(synthesis).toContain("under the exact finding categories");
    expect(synthesis).toContain("Give each differing assessment its own concrete clause and citations");
    expect(synthesis).toContain("Drop-in cooperation");
    expect(synthesis).toContain('"buildContext":"Early Access"');
  });

  const citedSynthesis = JSON.stringify({ statements: [{ text: "Combat rewards experimentation.", observationIds: ["unknown"] }], categories: { "Gameplay & systems": [] }, prosCons: { pros: null, cons: null }, tags: [] });
  test.each([
    {
      scenario: "a prematurely closed root object",
      output: `${citedSynthesis},"categories":[]}`,
      error: "invalid_output: malformed JSON",
    },
    {
      scenario: "a valid object without usable citations",
      output: citedSynthesis,
      error: "invalid_output: no cited statements",
    },
    {
      scenario: "a valid JSON array",
      output: `[${citedSynthesis}]`,
      error: "invalid_output: expected a JSON object",
    },
  ])("records the synthesis refusal for $scenario", async ({ output, error }) => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput() },
      { state: "succeeded", output },
    );

    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport,
      openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });

    expect(value.native.query("SELECT status, error FROM media_processing_jobs WHERE stage = 'synthesis'").all())
      .toEqual([{ status: "refused", error }]);
    expect(value.native.query("SELECT id FROM media_game_overviews").all()).toEqual([]);
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
    value.native.prepare("UPDATE media_sources SET type = 'review', platform = NULL, build_context = NULL").run();
    for (const [url, outlet] of [
      [urls.followup, "IGN"],
      [urls.eurogamer, "Eurogamer"],
      [urls.republication, "GamesRadar+"],
      [urls.explicitRepublication, "Kotaku"],
    ] as const) {
      value.native.prepare(
        "INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on) VALUES (?, 'initial', ?, ?, ?, ?, 'review', 1)",
      ).run(APPIDS[0], url, "Cyberpunk 2077 review", outlet, "2026-09-11T00:00:00.000Z");
    }
    value.native.prepare("UPDATE media_sources SET author = 'Wire Author', title = 'Wire Original' WHERE original_url = ?").run(urls.eurogamer);

    const supported: Record<string, (keyof typeof RICH_FINDINGS)[]> = {
      [urls.ign]: ["stray", "pacing", "flexible", "deliberate", "pro"],
      [urls.followup]: ["stray", "city"],
      [urls.eurogamer]: ["pacing", "sluggish", "duplicate", "pro"],
      [urls.republication]: ["pacing", "sluggish", "duplicate", "pro"],
      [urls.explicitRepublication]: ["pacing", "sluggish", "duplicate"],
    };
    const articleFetch = async (url: string) => articleHtml(APPIDS[0]).replace("</article>",
      `<p>${supported[url]!.map((id) => RICH_FINDINGS[id]).join(" ")}</p></article>`);
    await authorizeMediaProcessing(value.db, value.runId);
    const transport = new ControlledTransport();
    for (const url of Object.values(urls)) {
      const observations = supported[url]!.map((id) => mediaObservation(APPIDS[0], id, id === "pro" ? "pro" : "finding",
        RICH_FINDINGS[id], RICH_FINDINGS[id], id === "city" ? "Visuals & audio" : id === "pro" ? "" : "Gameplay & systems"));
      transport.nextPolls.push({
        state: "succeeded",
        output: { observations, ...(url === urls.explicitRepublication ? { originatingAssessment: "Wire Author|Wire Original" } : {}) },
        usage: { inputTokens: 100, outputTokens: 20 },
      });
    }
    transport.nextPolls.push({ state: "succeeded", output: richOverviewOutput(urls), usage: { inputTokens: 100, outputTokens: 60 } });
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch });
    expect(first.submitted).toBe(6);
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch });

    const overview = await getMediaOverview(value.db, APPIDS[0], { includeUnpublished: true });
    expect(overview?.statements.map((finding) => finding.text)).toEqual([
      "Fights accommodate both stealth and gunplay.",
    ]);
    expect(overview?.categories.map((category) => category.name)).toEqual([
      "Gameplay & systems",
      "Visuals & audio",
    ]);
    expect(overview?.categories[0]?.findings.map((finding) => finding.text)).toEqual([
      RICH_FINDINGS.flexible,
      RICH_FINDINGS.deliberate,
      RICH_FINDINGS.sluggish,
    ]);
    expect(overview?.categories[0]?.findings[1]?.sourceUrls).toEqual([urls.ign]);
    expect(overview?.categories[0]?.findings[2]?.sourceUrls).toEqual([
      urls.eurogamer,
      urls.republication,
      urls.explicitRepublication,
    ]);
    expect(overview?.prosCons?.pros[0]?.sourceUrls).toEqual([urls.ign, urls.eurogamer]);
    expect(overview?.prosCons?.cons).toEqual([]);
    const synthesisRequest = JSON.stringify(transport.requestBodies.at(-1));
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
    let fetches = 0;
    const articleFetch = async (url: string) => {
      fetches += 1;
      return articleHtml(url.includes("baldurs") ? APPIDS[1] : APPIDS[0]);
    };
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch });
    const { db: reopenedDb } = value.reopen();
    const reopened = await advanceMediaProcessing(reopenedDb, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch });
    expect(await getMediaOverview(reopenedDb, APPIDS[1], { includeUnpublished: true })).not.toBeNull();
    expect(await getMediaOverview(reopenedDb, APPIDS[0], { includeUnpublished: true })).toBeNull();
    expect(reopened.submitted).toBe(0);
    expect(fetches).toBe(2);
    expect(reopened.outputs).toEqual({ new: 2, reused: 0, replaced: 0, invalidated: 0, skipped: 1 });
  });
  test("reconciles submitted work from an earlier authorization", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    insertSubmittedGeminiExtraction(value.native, { runId: value.runId, sourceId: sourceIds(value)[0]! });
    const transport = new ControlledTransport();
    transport.polls.set("batches/test-1", { state: "pending" });
    await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });

    const laterRunId = insertCompletedRun(value.native, "initial:later-authorization:test", [APPIDS[0]]);
    await authorizeMediaProcessing(value.db, laterRunId);
    transport.polls.set("batches/test-1", { state: "succeeded", output: legacyExtractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    transport.nextPolls.push({ state: "succeeded", output: overviewOutput(URLS[APPIDS[0]]), usage: { inputTokens: 100, outputTokens: 20 } });

    const result = await advanceMediaProcessing(value.db, { runId: laterRunId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });
    expect(result.status).toBe("completed");
    expect(await getMediaOverview(value.db, APPIDS[0], { includeUnpublished: true })).not.toBeNull();
  });


  test("rejects a Gemini extraction batch submitted before the move to OpenRouter as stale once an authorized refetch changes the article", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    insertSubmittedGeminiExtraction(value.native, { runId: value.runId, sourceId: sourceIds(value)[0]! });
    const transport = new ControlledTransport();
    transport.polls.set("batches/test-1", { state: "pending" });
    const first = await advanceMediaProcessing(value.db, { runId: value.runId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });
    expect(first.submitted).toBe(0);
    const correctionRunId = insertCompletedRun(value.native, "initial:correction:test", [APPIDS[0]]);
    await authorizeMediaProcessing(value.db, correctionRunId, { affectedSourceIds: sourceIds(value) });
    // The correction's own extraction of the changed article is sent and times out.
    transport.nextPolls.push({ state: "pending" });
    const second = await advanceMediaProcessing(value.db, { runId: correctionRunId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]).replace("flexible combat", "deliberate combat") });
    expect(transport.submissions).toEqual(["extraction:chat-1"]);
    expect(second.uncertain).toBe(1);
    transport.polls.set("batches/test-1", { state: "succeeded", output: legacyExtractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    await advanceMediaProcessing(value.db, { runId: correctionRunId, transport, openRouter: transport.openRouter, articleFetch: async () => articleHtml(APPIDS[0]) });
    const rejected = await value.db.prepare("SELECT status FROM media_processing_jobs WHERE provider_batch_id = 'batches/test-1'").first<{ status: string }>();
    expect(rejected?.status).toBe("stale");
    const active = await value.db.prepare("SELECT COUNT(*) AS count FROM media_article_extractions WHERE active = 1").first<{ count: number }>();
    expect(active?.count).toBe(0);
    const source = await value.db.prepare("SELECT processing_input_identity FROM media_sources WHERE appid = ?").bind(APPIDS[0]).first<{ processing_input_identity: string }>();
    expect(source?.processing_input_identity).toBeTruthy();
  });

  test("polls submitted work even when its authorization is already completed", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    insertSubmittedGeminiExtraction(value.native, { runId: value.runId, sourceId: sourceIds(value)[0]! });
    const transport = new ControlledTransport();
    transport.polls.set("batches/test-1", { state: "pending" });
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    await value.db.prepare("UPDATE media_processing_authorizations SET status = 'completed' WHERE run_id = ?").bind(value.runId).run();
    transport.polls.set("batches/test-1", { state: "succeeded", output: legacyExtractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    const result = await advanceMediaProcessing(value.db, {
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    const job = await value.db.prepare("SELECT status, reservation_active, charged_microusd FROM media_processing_jobs WHERE stage = 'extraction'").first<{ status: string; reservation_active: number; charged_microusd: number | null }>();
    expect(result.runId).toBe(value.runId);
    expect(result.submitted).toBe(0);
    expect(job).toMatchObject({ status: "succeeded", reservation_active: 0 });
    expect(job?.charged_microusd).toBeGreaterThan(0);
  });

  test("reconciles globally submitted work after its authorization is removed", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    insertSubmittedGeminiExtraction(value.native, { runId: value.runId, sourceId: sourceIds(value)[0]! });
    const transport = new ControlledTransport();
    transport.polls.set("batches/test-1", { state: "pending" });
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    await value.db.prepare("DELETE FROM media_processing_authorizations WHERE run_id = ?").bind(value.runId).run();
    transport.polls.set("batches/test-1", { state: "succeeded", output: legacyExtractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });

    const result = await advanceMediaProcessing(value.db, {
      transport, openRouter: transport.openRouter,
    });
    const job = await value.db.prepare("SELECT status, reservation_active FROM media_processing_jobs WHERE stage = 'extraction'").first<{ status: string; reservation_active: number }>();
    expect(result).toMatchObject({ runId: value.runId, status: "completed", completed: 1 });
    expect(job).toEqual({ status: "succeeded", reservation_active: 0 });
  });
  test("records zero cost marked unknown, not a token-cap estimate, when a Gemini batch settles without provider usage", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    insertSubmittedGeminiExtraction(value.native, { runId: value.runId, sourceId: sourceIds(value)[0]! });
    const transport = new ControlledTransport();
    transport.polls.set("batches/test-1", { state: "pending" });
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    transport.polls.set("batches/test-1", { state: "succeeded", output: legacyExtractionOutput() });
    const result = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    const settled = await value.db.prepare("SELECT status, charged_microusd, cost_source FROM media_processing_jobs WHERE stage = 'extraction'").first<{ status: string; charged_microusd: number; cost_source: string }>();
    expect(result.completed).toBeGreaterThan(0);
    expect(settled).toEqual({ status: "succeeded", charged_microusd: 0, cost_source: "unknown" });
  });


  test("an item held uncertain before uncertain items were resent returns to the queue with backoff and keeps its authorization waiting", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    await value.db.prepare("DELETE FROM media_sources WHERE appid = ?").bind(APPIDS[0]).run();
    await value.db.prepare(
      "INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json, active) VALUES (?, ?, ?, ?, ?, 1)",
    ).bind(APPIDS[0], "uncertain-overview-input", "test-model", "test-config", "{}").run();
    await value.db.prepare(
      "INSERT INTO media_processing_jobs (run_id, stage, appid, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, usage_json, error) VALUES (?, 'extraction', ?, 'uncertain-job', 'uncertain-input', 'test-model', 'test-config', 1, 1, 1234, 1, 'uncertain', '{}', 'uncertain:timeout')",
    ).bind(value.runId, APPIDS[0]).run();

    const transport = new ControlledTransport();
    const result = await advanceMediaProcessing(value.db, {
      runId: value.runId,
      now: new Date("2026-11-18T07:00:00.000Z"),
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    const authorization = await value.db.prepare(
      "SELECT status, stop_reason FROM media_processing_authorizations WHERE run_id = ?",
    ).bind(value.runId).first<{ status: string; stop_reason: string | null }>();

    expect(result).toMatchObject({
      status: "waiting",
      submitted: 0,
      uncertain: 1,
      overviewAppids: [APPIDS[0]],
      cost: { uncertain: 1, providers: { gemini: { allTimeMicrousd: 0 } } },
    });
    expect(value.native.query("SELECT status, attempt_count, next_attempt_at, error FROM media_processing_jobs WHERE request_key = 'uncertain-job'").get()).toEqual({ status: "queued", attempt_count: 1, next_attempt_at: "2026-11-18T07:15:00.000Z", error: "uncertain:timeout" });
    expect(authorization).toEqual({ status: "waiting", stop_reason: "uncertain_submission" });
    expect(transport.submissions).toHaveLength(0);
  });
  test("polls existing submitted work without a queued authorization", async () => {
    const value = fixture(); cleanups.push(value.cleanup);
    await authorizeMediaProcessing(value.db, value.runId);
    insertSubmittedGeminiExtraction(value.native, { runId: value.runId, sourceId: sourceIds(value)[0]! });
    const transport = new ControlledTransport();
    transport.polls.set("batches/test-1", { state: "pending" });
    await advanceMediaProcessing(value.db, {
      runId: value.runId,
      transport, openRouter: transport.openRouter,
      articleFetch: async () => articleHtml(APPIDS[0]),
    });
    await value.db.prepare("UPDATE media_processing_authorizations SET status = 'completed' WHERE run_id = ?").bind(value.runId).run();
    transport.polls.set("batches/test-1", { state: "succeeded", output: legacyExtractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } });
    const result = await advanceMediaProcessing(value.db, { transport, openRouter: transport.openRouter });
    const job = await value.db.prepare("SELECT status, reservation_active FROM media_processing_jobs WHERE stage = 'extraction'").first<{ status: string; reservation_active: number }>();
    expect(result.status).toBe("completed");
    expect(result.stopReasons).toEqual([]);
    expect(job).toEqual({ status: "succeeded", reservation_active: 0 });
  });

  test("uses the official Gemini count and poll REST paths", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      if (String(input).includes(":countTokens")) return Response.json({ totalTokens: 7 });
      if (String(input).includes(":batchGenerateContent")) return Response.json({ name: "batches/official" });
      return Response.json({ state: { name: "BATCH_STATE_RUNNING" } });
    };
    const transport = createGeminiBatchTransport("secret-key", fetchFn);
    expect(await transport.countTokens("gemini-3.1-flash-lite", { contents: [], generationConfig: { maxOutputTokens: 8 } })).toBe(7);
    expect(await transport.pollBatch("batches/official")).toEqual({ state: "pending" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:countTokens",
      "https://generativelanguage.googleapis.com/v1beta/batches/official",
    ]);
    expect(String(calls[0]!.init?.body)).not.toContain("generationConfig");
    for (const call of calls) expect(String(call.init?.body ?? "")).not.toContain("secret-key");
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
