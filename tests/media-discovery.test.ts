import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  authorizeMediaRun,
  getMediaSources,
  MEDIA_OUTLETS,
  runAuthorizedMediaDiscovery,
  runSerializedMediaDiscovery,
} from "../src/lib/media-discovery";
import { handleRequest } from "../src/server";

function createAdapter(native: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next) {
          values = next;
          return statement;
        },
        async first<T>(column?: string) {
          const row = native.prepare(query).get(...(values as SQLQueryBindings[])) as Record<string, unknown> | null;
          if (!row) return null;
          return (column ? row[column] : row) as T;
        },
        async run() {
          const result = native.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: result.changes, duration: 0 } };
        },
        async all<T>() {
          return { success: true, results: native.prepare(query).all(...(values as SQLQueryBindings[])) as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T>() {
          return native.prepare(query).values(...(values as SQLQueryBindings[])) as T[];
        },
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
    async exec(query) {
      native.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}

const APPIDS = [1091500, 1086940, 1145350] as const;
const NAMES: Record<number, string> = {
  1091500: "Cyberpunk 2077",
  1086940: "Baldur's Gate 3",
  1145350: "Hades II",
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vaporstats-media-test-"));
  const databasePath = join(directory, "media.sqlite");
  const native = new Database(databasePath);
  applyMigrations(native);
  native.exec("PRAGMA foreign_keys = ON");
  for (const appid of APPIDS) {
    native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, NAMES[appid], NAMES[appid]!.toLowerCase().replaceAll(" ", "-"));
  }
  return { native, databasePath, directory, db: createAdapter(native), cleanup: () => { native.close(true); rmSync(directory, { recursive: true, force: true }); } };
}

function html(appid: number, title: string, options: { date?: string; author?: string; affiliation?: string; body?: string } = {}): string {
  const body = options.body ?? `${NAMES[appid]} delivers a substantial playable campaign with detailed systems and memorable encounters. `.repeat(5);
  const affiliation = options.affiliation ? `<meta name="author_affiliation" content="${options.affiliation}">` : "";
  return `<!doctype html><html><head><meta property="og:title" content="${title}"><meta property="article:published_time" content="${options.date ?? "2025-01-01"}"><meta name="author" content="${options.author ?? "Reviewer"}">${affiliation}</head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
}

function discoveryFetch(options: { variants?: Record<string, { status?: number; body?: string; redirect?: string }> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 1, plan_limit: 100, paygo_usage: 0, paygo_limit: 0, request_id: "usage-1" });
    if (url.endsWith("/search")) {
      const payload = JSON.parse(String(init?.body)) as { include_domains: string[]; query: string };
      const domain = payload.include_domains[0]!;
      const appid = payload.query.includes("Baldur") ? 1086940 : payload.query.includes("Hades") ? 1145350 : 1091500;
      const slug = `${appid}-${domain.replaceAll(".", "-")}`;
      return Response.json({ request_id: `search-${domain}`, usage: { credits_used: 1 }, results: [{ url: `https://${domain}/articles/${slug}` }] });
    }
    const variant = options.variants?.[url];
    if (variant?.redirect) return new Response(null, { status: variant.status ?? 302, headers: { location: variant.redirect } });
    if (variant?.body) return new Response(variant.body, { status: variant.status ?? 200 });
    const appid = url.includes("1086940") ? 1086940 : url.includes("1145350") ? 1145350 : 1091500;
    const outlet = MEDIA_OUTLETS.find((item) => url.includes(item.domain));
    return new Response(html(appid, `${NAMES[appid]} Review${outlet ? ` - ${outlet.name}` : ""}`));
  };
  return { calls, fetchFn };
}

afterEach(() => {
  // Fixtures are intentionally short-lived; each test owns its in-memory native handle.
});

describe("bounded media discovery", () => {
  test("authorizes only the initial subset, sends exact Tavily requests, persists metadata, and resumes without new queries", async () => {
    const { db, cleanup } = fixture();
    const { calls, fetchFn } = discoveryFetch();
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500, 1086940, 1145350] });
    await expect(authorizeMediaRun(db, { pass: "later" as never, games: [1091500] })).rejects.toThrow();
    await expect(authorizeMediaRun(db, { pass: "initial", games: [] })).rejects.toThrow();
    const first = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(first.queries).toBe(18);
    expect(first.summary.discovered).toBe(18);
    expect(first.articles).toBe(18);
    const searchCalls = calls.filter((call) => call.url.endsWith("/search"));
    expect(searchCalls).toHaveLength(18);
    const payload = JSON.parse(String(searchCalls[0]!.init?.body));
    expect(payload).toEqual(expect.objectContaining({ search_depth: "basic", auto_parameters: false, max_results: 10, include_answer: false, include_raw_content: false, include_usage: true }));
    expect(payload.include_domains).toEqual(["ign.com"]);
    const sources = await getMediaSources(db, 1091500);
    expect(sources).toHaveLength(6);
    expect(sources[0]).toEqual(expect.objectContaining({ type: "review", outlet: "IGN", handsOn: null }));
    expect(sources[0]).not.toHaveProperty("body");
    const resumedAuthorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500, 1086940, 1145350] });
    const resumed = await runAuthorizedMediaDiscovery(db, { runId: resumedAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-11T00:00:00.000Z") });
    expect(resumed.queries).toBe(18);
    expect(calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(18);
    expect(JSON.stringify(resumed)).not.toContain("test-key");
    cleanup();
  });
  test("accepts the Researcher free plan and never exceeds remaining search credits", async () => {
    const { db, cleanup } = fixture();
    const { calls, fetchFn: baseFetch } = discoveryFetch();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/usage")) return Response.json({ account: { current_plan: "Researcher", plan_usage: 2, plan_limit: 5, paygo_usage: 0, paygo_limit: null } });
      return baseFetch(input, init);
    };
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
    const result = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(3);
    expect(result.usage.plan).toBe("free");
    expect(result.usage).toEqual(expect.objectContaining({ planUsageAtStart: 2, planUsage: 5, searchCreditsConsumed: 3, remainingCredits: 0 }));
    expect(result.stopReasons).toContain("tavily_credits_exhausted");
    cleanup();
  });

  test("counts redirects and failures, rejects excluded pages, and falls back to a substantive hands-on preview", async () => {
    const { db, cleanup } = fixture();
    const redirectUrl = "https://ign.com/articles/canonical";
    const { fetchFn } = discoveryFetch({ variants: { "https://ign.com/articles/1091500-ign-com": { redirect: redirectUrl } } });
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
    const result = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: () => new Date("2026-09-10T12:00:00.000Z") });
    expect(result.attempts).toBeGreaterThan(6);
    expect((await getMediaSources(db, 1091500)).length).toBeGreaterThan(0);
    const attemptRows = await db.prepare("SELECT kind FROM media_discovery_attempts WHERE outlet = 'IGN' ORDER BY id").all<{ kind: string }>();
    expect(attemptRows.results.some((row) => row.kind === "redirect")).toBe(true);
    cleanup();
  });
  test("rejects wrong entities, roundups, developer pages, announcements, and Phantom Liberty", async () => {
    const { db, cleanup } = fixture();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 1, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 });
      if (url.endsWith("/search")) {
        const payload = JSON.parse(String(init?.body)) as { include_domains: string[] };
        return Response.json({ request_id: "search", usage: { credits_used: 1 }, results: [{ url: `https://${payload.include_domains[0]}/articles/1091500-${payload.include_domains[0]}` }] });
      }
      const domain = new URL(url).hostname;
      if (domain === "ign.com") return new Response(html(1091500, "Cyberpunk 2077 Review", { body: "Phantom Liberty is the expansion under review, with Dogtown missions and expansion systems. ".repeat(5) }));
      if (domain === "eurogamer.net") return new Response(html(1091500, "The Witcher 3 Review", { body: "The Witcher 3 remains a vast and richly written fantasy RPG with memorable quests and detailed exploration. ".repeat(5) }));
      if (domain === "gamespot.com") return new Response(html(1091500, "Cyberpunk 2077 Roundup"));
      if (domain === "pcgamer.com") return new Response(html(1091500, "Cyberpunk 2077 Announcement"));
      if (domain === "kotaku.com") return new Response(html(1091500, "Cyberpunk 2077 Review", { author: "Jane Smith", affiliation: "CD Projekt Red" }));
      if (domain === "gamesradar.com") return new Response(html(1091500, "Cyberpunk 2077 Hands-on Preview"));
      return new Response(html(1091500, "Cyberpunk 2077 Review"));
    };
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
    const result = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    const sources = await getMediaSources(db, 1091500);
    expect(sources.map((source) => [source.outlet, source.type])).toEqual([["GamesRadar+", "preview"]]);
    expect(result.stopReasons).toEqual(expect.arrayContaining(["IGN:no_qualifying_article", "Eurogamer:no_qualifying_article", "GameSpot:no_qualifying_article", "PC Gamer:no_qualifying_article", "Kotaku:no_qualifying_article"]));
    cleanup();
  });

  test("rejects review-drama, score-news, co-titled, and substantive comparisons while keeping incidental comparisons", async () => {
    const { db, cleanup } = fixture();
    const longComparison = `${"Cyberpunk 2077 is a focused role-playing game with a substantial playable campaign. ".repeat(12)} This is a direct comparison with Zelda throughout.`;
    const incidentalComparisons = `Compared to Zelda, Cyberpunk 2077 has a denser city and more flexible builds. Better than many alternatives, its combat, quests, and exploration remain a substantial review subject. Higher than expected enemy variety keeps the campaign engaging.`;
    const { fetchFn } = discoveryFetch({
      variants: {
        "https://ign.com/articles/1091500-ign-com": { body: html(1091500, "The Cyberpunk 2077 Review Drama") },
        "https://eurogamer.net/articles/1091500-eurogamer-net": { body: html(1091500, "Cyberpunk 2077 Review", { body: longComparison }) },
        "https://gamespot.com/articles/1091500-gamespot-com": { body: html(1091500, "Cyberpunk 2077 Review", { body: incidentalComparisons }) },
        "https://gamesradar.com/articles/1091500-gamesradar-com": { body: html(1091500, "Cyberpunk 2077 Gets a 10/10 Review Score") },
        "https://kotaku.com/articles/1091500-kotaku-com": { body: html(1091500, "Cyberpunk 2077 and The Witcher 3 Reviews") },
        "https://ign.com/articles/1086940-ign-com": { body: html(1086940, "Baldur’s Gate 3 Surpasses Zelda With the Highest Metacritic Review Score") },
      },
    });
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500, 1086940] });
    await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    const cyberpunkSources = await getMediaSources(db, 1091500);
    const baldursSources = await getMediaSources(db, 1086940);
    expect(cyberpunkSources.some((source) => source.outlet === "IGN" || source.outlet === "Eurogamer")).toBe(false);
    expect(cyberpunkSources.some((source) => source.outlet === "GameSpot")).toBe(true);
    expect(cyberpunkSources.some((source) => source.outlet === "GamesRadar+")).toBe(false);
    expect(cyberpunkSources.some((source) => source.outlet === "Kotaku")).toBe(false);
    expect(baldursSources.some((source) => source.outlet === "IGN")).toBe(false);
    cleanup();
  });

  test("persists Early Access context without retaining article text", async () => {
    const { db, cleanup } = fixture();
    const { fetchFn } = discoveryFetch({
      variants: {
        "https://ign.com/articles/1091500-ign-com": {
          body: html(1091500, "Cyberpunk 2077 Review", { body: `This Early Access review covers the playable build and its systems. ${"Detailed hands-on observations follow. ".repeat(8)}` }),
        },
      },
    });
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
    await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    const source = (await getMediaSources(db, 1091500)).find((item) => item.outlet === "IGN");
    expect(source).toEqual(expect.objectContaining({ buildContext: "Early Access" }));
    expect(source).not.toHaveProperty("body");
    cleanup();
  });

  test("enforces the daily cap and resumes persisted progress after restart", async () => {
    const { native, databasePath, directory, db } = fixture();
    let restartedNative: Database | undefined;
    try {
      for (let id = 0; id < 30; id += 1) {
        await db.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, succeeded, attempted_at) VALUES (?, 'IGN', 'initial', ?, 'failure', 0, ?)").bind(1091500, "2026-09-10", `2026-09-10T00:00:${String(id).padStart(2, "0")}.000Z`).run();
      }
      const searched: string[] = [];
      const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/usage")) {
          return Response.json({ account: { current_plan: "Researcher", plan_usage: 1, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 } });
        }
        if (url.endsWith("/search")) {
          searched.push(String(init?.body));
          return Response.json({ usage: { credits: 1 }, results: [] });
        }
        return new Response("", { status: 500 });
      };
      const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      const result = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T12:00:00.000Z") });
      expect(result.stopReasons).toContain("IGN:daily_attempt_cap");
      expect(searched.every((body) => !body.includes("\"ign.com\""))).toBe(true);

      native.close(true);
      restartedNative = new Database(databasePath);
      restartedNative.exec("PRAGMA foreign_keys = ON");
      const restartedDb = createAdapter(restartedNative);
      const resumedAuthorization = await authorizeMediaRun(restartedDb, { pass: "initial", games: [1091500] });
      expect(resumedAuthorization.resumed).toBe(true);
      await runAuthorizedMediaDiscovery(restartedDb, { runId: resumedAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-11T12:00:00.000Z") });
      expect(searched.some((body) => body.includes("\"ign.com\""))).toBe(true);
    } finally {
      try { native.close(true); } catch { /* already closed for the restart */ }
      restartedNative?.close(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("stops an outlet at a denial and records a sanitized durable summary", async () => {
    const { db, cleanup } = fixture();
    const calls: string[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 1, plan_limit: 20, paygo_usage: 0, paygo_limit: 0 });
      if (url.endsWith("/search") && String(init?.body).includes("ign.com")) return new Response("denied", { status: 403 });
      if (url.endsWith("/search")) return Response.json({ results: [] });
      return new Response("", { status: 500 });
    };
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
    const result = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(result.stopReasons).toContain("IGN:search_http_403");
    expect(calls.filter((url) => url.endsWith("/search") && url.includes("tavily") || url.endsWith("/search")).length).toBe(6);
    const summary = await db.prepare("SELECT summary, usage FROM media_discovery_runs WHERE id = ?").bind(authorization.runId).first<{ summary: string; usage: string }>();
    expect(summary?.summary).not.toContain("test-key");
    expect(summary?.summary).not.toContain("Cyberpunk 2077 Review");
    cleanup();
  });

  test("atomically records unexpected failure and reopens progress without repeating a search", async () => {
    const { native, databasePath, directory, db } = fixture();
    let restartedNative: Database | undefined;
    let throwArticleBody = true;
    const searchCalls: string[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 1, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 });
      if (url.endsWith("/search")) {
        searchCalls.push(String(init?.body));
        const payload = JSON.parse(String(init?.body)) as { include_domains: string[] };
        const domain = payload.include_domains[0]!;
        return Response.json({ request_id: `search-${domain}`, usage: { credits_used: 1 }, results: [{ url: `https://${domain}/articles/1091500-${domain.replaceAll(".", "-")}` }] });
      }
      if (throwArticleBody) {
        throwArticleBody = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("unexpected article failure test-key"));
          },
        });
        return new Response(body);
      }
      return new Response(html(1091500, "Cyberpunk 2077 Review"));
    };
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
    const failed = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(failed.status).toBe("failed");
    const failedRow = await db.prepare("SELECT status, finished_at, summary FROM media_discovery_runs WHERE id = ?").bind(authorization.runId).first<{ status: string; finished_at: string | null; summary: string }>();
    const failedSummary = JSON.parse(failedRow?.summary ?? "{}") as Record<string, unknown>;
    expect(failedRow).toEqual(expect.objectContaining({ status: "failed" }));
    expect(failedRow?.finished_at).toBeTruthy();
    expect(failedSummary).toEqual(expect.objectContaining({ runId: authorization.runId, status: "failed", stopReason: expect.stringContaining("execution_error") }));
    expect(JSON.stringify(failedSummary)).not.toContain("test-key");

    native.close(true);
    restartedNative = new Database(databasePath);
    restartedNative.exec("PRAGMA foreign_keys = ON");
    const restartedDb = createAdapter(restartedNative);
    const resumedAuthorization = await authorizeMediaRun(restartedDb, { pass: "initial", games: [1091500] });
    expect(resumedAuthorization.resumed).toBe(true);
    const recovered = await runAuthorizedMediaDiscovery(restartedDb, { runId: resumedAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-11T00:00:00.000Z") });
    expect(recovered.status).toBe("completed");
    expect(searchCalls).toHaveLength(6);
    expect(searchCalls.filter((body) => body.includes("\"ign.com\""))).toHaveLength(1);
    try { native.close(true); } catch { /* already closed for the restart */ }
    restartedNative.close(true);
    rmSync(directory, { recursive: true, force: true });
  });

  test("reports a shortfall when fewer than three outlets produce accepted sources", async () => {
    const { db, cleanup } = fixture();
    const { fetchFn: baseFetch } = discoveryFetch();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/search") && !String(init?.body).includes("\"ign.com\"")) return Response.json({ results: [] });
      return baseFetch(input, init);
    };
    const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
    const result = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
    const expected: NonNullable<typeof result.summary.outletShortfall> = { required: 3, actual: 1, missing: ["Eurogamer", "GameSpot", "PC Gamer", "Kotaku", "GamesRadar+"] };
    expect(result.summary.outletShortfall).toEqual(expected);
    const durable = await db.prepare("SELECT summary FROM media_discovery_runs WHERE id = ?").bind(authorization.runId).first<{ summary: string }>();
    const durableSummary = JSON.parse(durable?.summary ?? "{}") as Record<string, unknown>;
    expect(durableSummary.outletShortfall).toEqual(expected);
    cleanup();
  });
  test("serializes independently authorized runs", async () => {
    const { db, cleanup } = fixture();
    let activeFetches = 0;
    let maxActiveFetches = 0;
    let fetchCalls = 0;
    let releaseFirstFetch!: () => void;
    let markFirstFetchEntered!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const firstFetchEntered = new Promise<void>((resolve) => {
      markFirstFetchEntered = resolve;
    });
    const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
      fetchCalls += 1;
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      if (fetchCalls === 1) {
        markFirstFetchEntered();
        await firstFetchGate;
      }
      activeFetches -= 1;
      if (String(input).endsWith("/usage")) {
        return Response.json({
          account: {
            current_plan: "Researcher",
            plan_usage: 0,
            plan_limit: 100,
            paygo_usage: 0,
            paygo_limit: 0,
          },
        });
      }
      return Response.json({ request_id: crypto.randomUUID(), usage: { credits: 1 }, results: [] });
    };

    const firstRun = runSerializedMediaDiscovery(db, { games: [1091500], tavilyApiKey: "test-key", fetch: fetchFn });
    await firstFetchEntered;
    const secondRun = runSerializedMediaDiscovery(db, { games: [1086940], tavilyApiKey: "test-key", fetch: fetchFn });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstFetch();
    await Promise.all([firstRun, secondRun]);

    expect(maxActiveFetches).toBe(1);
    cleanup();
  });

  test("protects the loopback media trigger before database work", async () => {
    const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
    process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
    const request = (url: string, headers: Record<string, string>, body = "{\"pass\":\"initial\",\"game\":\"cyberpunk-2077\"}") => new Request(url, { method: "POST", headers, body });
    try {
      expect((await handleRequest(request("https://public.example/internal/media-discovery", { Authorization: "Bearer test-trigger-token", "Content-Type": "application/json", Host: "public.example" }), "203.0.113.7")).status).toBe(404);
      expect((await handleRequest(request("http://127.0.0.1/internal/media-discovery", { "Content-Type": "application/json", Host: "127.0.0.1" }), "127.0.0.1")).status).toBe(401);
      expect((await handleRequest(request("http://127.0.0.1/internal/media-discovery", { Authorization: "Bearer wrong", "Content-Type": "application/json", Host: "127.0.0.1" }), "127.0.0.1")).status).toBe(401);
      expect((await handleRequest(request("http://127.0.0.1/internal/media-discovery", { Authorization: "Bearer test-trigger-token", "Content-Type": "text/plain", Host: "127.0.0.1" }), "127.0.0.1")).status).toBe(415);
      expect((await handleRequest(request("http://127.0.0.1/internal/media-discovery", { Authorization: "Bearer test-trigger-token", "Content-Type": "application/json", "Content-Length": "4097", Host: "127.0.0.1" }, "x".repeat(4097)), "127.0.0.1")).status).toBe(413);
      expect((await handleRequest(request("http://127.0.0.1/internal/media-discovery", { Authorization: "Bearer test-trigger-token", "Content-Type": "application/json", Host: "127.0.0.1" }, "{\"pass\":\"later\",\"game\":\"unknown\"}"), "127.0.0.1")).status).toBe(400);
    } finally {
      if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
      else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
    }
  });
  test("does not retry terminal 401/403 outlets after a newly authorized rerun", async () => {
    for (const denialStatus of [401, 403] as const) {
      const { db, cleanup } = fixture();
      try {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = String(input);
          calls.push({ url, init });
          if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 0, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 });
          if (url.endsWith("/search")) {
            if (String(init?.body).includes("\"ign.com\"")) return new Response("", { status: denialStatus });
            return Response.json({ results: [] });
          }
          return new Response("", { status: 500 });
        };
        const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
        const first = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
        expect(first.stopReasons).toContain(`IGN:search_http_${denialStatus}`);
        expect(first.summary.stopReason).toBe(`IGN:search_http_${denialStatus}`);
        const stopped = await db.prepare("SELECT status, stop_reason FROM media_discovery_progress WHERE appid = ? AND outlet = 'IGN'").bind(1091500).first<{ status: string; stop_reason: string | null }>();
        expect(stopped).toEqual({ status: "stopped", stop_reason: `search_http_${denialStatus}` });

        const resumedAuthorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
        const resumed = await runAuthorizedMediaDiscovery(db, { runId: resumedAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-11T00:00:00.000Z") });
        expect(resumedAuthorization.resumed).toBe(true);
        expect(resumed.status).toBe("completed");
        expect(calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(6);
        const stillStopped = await db.prepare("SELECT status, stop_reason FROM media_discovery_progress WHERE appid = ? AND outlet = 'IGN'").bind(1091500).first<{ status: string; stop_reason: string | null }>();
        expect(stillStopped).toEqual({ status: "stopped", stop_reason: `search_http_${denialStatus}` });
      } finally {
        cleanup();
      }
    }
  });

  test("keeps a daily-cap stop closed the same day, then resumes it on a later authorized day", async () => {
    const { db, cleanup } = fixture();
    try {
      for (let id = 0; id < 30; id += 1) {
        await db.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, succeeded, attempted_at) VALUES (?, 'IGN', 'initial', ?, 'failure', 0, ?)").bind(1091500, "2026-09-10", `2026-09-10T00:00:${String(id).padStart(2, "0")}.000Z`).run();
      }
      const { calls, fetchFn } = discoveryFetch();
      const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      const first = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T12:00:00.000Z") });
      expect(first.stopReasons).toContain("IGN:daily_attempt_cap");
      expect(first.summary.stopReason).toBe("IGN:daily_attempt_cap");

      const sameDayAuthorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      await runAuthorizedMediaDiscovery(db, { runId: sameDayAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T18:00:00.000Z") });
      expect(calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(5);
      const sameDayProgress = await db.prepare("SELECT status, stop_reason FROM media_discovery_progress WHERE appid = ? AND outlet = 'IGN'").bind(1091500).first<{ status: string; stop_reason: string | null }>();
      expect(sameDayProgress).toEqual({ status: "stopped", stop_reason: "daily_attempt_cap" });

      const laterAuthorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      await runAuthorizedMediaDiscovery(db, { runId: laterAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-11T12:00:00.000Z") });
      expect(calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(6);
      expect((await getMediaSources(db, 1091500)).some((source) => source.outlet === "IGN")).toBe(true);
      const reopened = await db.prepare("SELECT status FROM media_discovery_progress WHERE appid = ? AND outlet = 'IGN'").bind(1091500).first<{ status: string }>();
      expect(reopened?.status).toBe("completed");
    } finally {
      cleanup();
    }
  });

  test("keeps a fetch 429 stopped the same day, then continues candidates without repeating its search", async () => {
    const { db, cleanup } = fixture();
    try {
      const firstUrl = "https://ign.com/articles/first-candidate";
      const secondUrl = "https://ign.com/articles/second-candidate";
      const searchBodies: string[] = [];
      const articleCalls: string[] = [];
      const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 0, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 });
        if (url.endsWith("/search")) {
          searchBodies.push(String(init?.body));
          const payload = JSON.parse(String(init?.body)) as { include_domains: string[] };
          return Response.json({ results: payload.include_domains[0] === "ign.com" ? [{ url: firstUrl }, { url: secondUrl }] : [] });
        }
        if (url === firstUrl) {
          articleCalls.push(url);
          return new Response("", { status: 429 });
        }
        if (url === secondUrl) {
          articleCalls.push(url);
          return new Response(html(1091500, "Cyberpunk 2077 Review"));
        }
        return new Response("", { status: 500 });
      };
      const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      const first = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
      expect(first.stopReasons).toContain("IGN:fetch_http_429");
      expect(first.summary.stopReason).toBe("IGN:fetch_http_429");
      const stopped = await db.prepare("SELECT status, stop_reason FROM media_discovery_progress WHERE appid = ? AND outlet = 'IGN'").bind(1091500).first<{ status: string; stop_reason: string | null }>();
      expect(stopped).toEqual({ status: "stopped", stop_reason: "fetch_http_429" });

      const sameDayAuthorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      await runAuthorizedMediaDiscovery(db, { runId: sameDayAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T18:00:00.000Z") });
      expect(searchBodies).toHaveLength(6);
      expect(articleCalls).toEqual([firstUrl]);
      const sameDayStopped = await db.prepare("SELECT status, stop_reason FROM media_discovery_progress WHERE appid = ? AND outlet = 'IGN'").bind(1091500).first<{ status: string; stop_reason: string | null }>();
      expect(sameDayStopped).toEqual({ status: "stopped", stop_reason: "fetch_http_429" });

      const laterAuthorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      await runAuthorizedMediaDiscovery(db, { runId: laterAuthorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-11T00:00:00.000Z") });
      expect(searchBodies).toHaveLength(6);
      expect(articleCalls).toEqual([firstUrl, secondUrl]);
      expect((await getMediaSources(db, 1091500)).some((source) => source.outlet === "IGN")).toBe(true);
      const reopened = await db.prepare("SELECT status FROM media_discovery_progress WHERE appid = ? AND outlet = 'IGN'").bind(1091500).first<{ status: string }>();
      expect(reopened?.status).toBe("completed");
    } finally {
      cleanup();
    }
  });

  test("uses a clock function across UTC midnight and enforces the daily cap for each day", async () => {
    const { db, cleanup } = fixture();
    try {
      for (const day of ["2026-09-10", "2026-09-11"]) {
        for (let id = 0; id < 29; id += 1) {
          await db.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, succeeded, attempted_at) VALUES (?, 'IGN', 'initial', ?, 'failure', 0, ?)").bind(1091500, day, `${day}T00:00:${String(id).padStart(2, "0")}.000Z`).run();
        }
      }
      const firstUrl = "https://ign.com/articles/midnight-first";
      const secondUrl = "https://ign.com/articles/midnight-second";
      let currentClock = new Date("2026-09-10T23:59:59.900Z");
      const searched: string[] = [];
      const articleCalls: string[] = [];
      const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 0, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 });
        if (url.endsWith("/search")) {
          const payload = JSON.parse(String(init?.body)) as { include_domains: string[] };
          searched.push(payload.include_domains[0]!);
          if (payload.include_domains[0] === "ign.com") {
            currentClock = new Date("2026-09-11T00:00:00.100Z");
            return Response.json({ results: [{ url: firstUrl }, { url: secondUrl }] });
          }
          return Response.json({ results: [] });
        }
        if (url === firstUrl) {
          articleCalls.push(url);
          return new Response(html(1091500, "Cyberpunk 2077 Review"));
        }
        if (url === secondUrl) {
          articleCalls.push(url);
          return new Response(html(1091500, "Cyberpunk 2077 Review 2"));
        }
        return new Response("", { status: 500 });
      };
      const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      const result = await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: () => new Date(currentClock) });
      expect(result.stopReasons).toContain("IGN:daily_attempt_cap");
      expect(result.summary.stopReason).toBe("IGN:daily_attempt_cap");
      expect(searched).toHaveLength(6);
      expect(articleCalls).toEqual([firstUrl]);
      const dayRows = await db.prepare("SELECT day, COUNT(*) AS count FROM media_discovery_attempts WHERE appid = ? AND outlet = 'IGN' GROUP BY day ORDER BY day").bind(1091500).all<{ day: string; count: number }>();
      expect(dayRows.results).toEqual([{ day: "2026-09-10", count: 30 }, { day: "2026-09-11", count: 30 }]);
    } finally {
      cleanup();
    }
  });

  test("rejects review embargo and reaction news while accepting an ordinary full review", async () => {
    const { db, cleanup } = fixture();
    try {
      const { fetchFn } = discoveryFetch({
        variants: {
          "https://ign.com/articles/1091500-ign-com": { body: html(1091500, "Cyberpunk 2077 Review Embargo Has Been Lifted") },
          "https://eurogamer.net/articles/1091500-eurogamer-net": { body: html(1091500, "Cyberpunk 2077 Review Reaction: What Critics Think") },
          "https://gamespot.com/articles/1091500-gamespot-com": { body: html(1091500, "Cyberpunk 2077 Review") },
        },
      });
      const authorization = await authorizeMediaRun(db, { pass: "initial", games: [1091500] });
      await runAuthorizedMediaDiscovery(db, { runId: authorization.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") });
      const sources = await getMediaSources(db, 1091500);
      expect(sources.some((source) => source.outlet === "IGN")).toBe(false);
      expect(sources.some((source) => source.outlet === "Eurogamer")).toBe(false);
      expect(sources).toEqual(expect.arrayContaining([expect.objectContaining({ outlet: "GameSpot", type: "review", title: "Cyberpunk 2077 Review" })]));
    } finally {
      cleanup();
    }
  });
});
