import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaRun, MEDIA_OUTLETS, runAuthorizedMediaDiscovery, type MediaOutlet, type MediaPass } from "../src/lib/media-discovery";
import {
  advanceMediaProcessing,
  authorizeMediaProcessing,
} from "../src/lib/media-processing";
import { reserveOutletAttempt } from "../src/lib/media-outlet-access";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  insertCompletedRun,
  ControlledGeminiTransport,
  CYBERPUNK,
  discoveryFetch,
  HADES_II,
  insertLaterRun,
  insertSources,
  processingArticleHtml,
  seedApps,
} from "./support/media";

// Media limits are shared by the initial and later assessment passes. The
// trigger cannot start a later pass yet, so each test creates later-pass state
// directly and drives discovery and processing with a controlled transport and clock.

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

function fixture(): TestDatabase {
  const database = openTestDatabase("vaporstats-media-limits-");
  cleanups.push(database.cleanup);
  seedApps(database.native, [CYBERPUNK, BALDURS_GATE, HADES_II]);
  return database;
}

const DAY_ONE = new Date("2026-09-10T12:00:00.000Z");
const DAY_ONE_LATE = new Date("2026-09-10T23:59:59.000Z");
const DAY_TWO = new Date("2026-09-11T00:00:01.000Z");

type Call = { url: string; init?: RequestInit };

function outletCalls(calls: readonly Call[], domain: string): { searches: number; fetches: number } {
  return {
    searches: calls.filter((call) => call.url.endsWith("/search") && String(call.init?.body).includes(`"${domain}"`)).length,
    fetches: calls.filter((call) => new URL(call.url).hostname === domain).length,
  };
}

function seedAttempts(database: TestDatabase, outlet: MediaOutlet, pass: MediaPass, day: string, total: number): void {
  const insert = database.native.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, succeeded, attempted_at) VALUES (?, ?, ?, ?, 'fetch', 1, ?)");
  for (let index = 0; index < total; index += 1) insert.run(CYBERPUNK, outlet, pass, day, `${day}T00:00:00.000Z`);
}

function progress(database: TestDatabase, pass: MediaPass, outlet: MediaOutlet): { status: string; stop_reason: string | null } | null {
  return database.native
    .query<{ status: string; stop_reason: string | null }, [string, string, number]>("SELECT status, stop_reason FROM media_discovery_progress WHERE pass = ? AND outlet = ? AND appid = ?")
    .get(pass, outlet, CYBERPUNK);
}

function count(database: TestDatabase, query: string, ...values: (string | number)[]): number {
  return database.native.query<{ count: number }, (string | number)[]>(query).get(...values)?.count ?? 0;
}

describe("article ceilings across assessment passes", () => {
  test("a later pass for a game at 15 articles across passes issues no query, fetch, or article", async () => {
    const database = fixture();
    insertSources(database.native, CYBERPUNK, "initial", 10);
    insertSources(database.native, CYBERPUNK, "later", 5);
    const runId = insertLaterRun(database.native, [CYBERPUNK]);
    const { calls, fetchFn } = discoveryFetch();

    await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE });

    expect(calls.filter((call) => !call.url.endsWith("/usage"))).toEqual([]);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_sources WHERE appid = ?", CYBERPUNK)).toBe(15);
  });

  test("a later pass admits an article beyond 45 accepted in total across passes, up to the entity's own 15-article ceiling", async () => {
    const database = fixture();
    insertSources(database.native, BALDURS_GATE, "initial", 15);
    insertSources(database.native, HADES_II, "initial", 10);
    insertSources(database.native, HADES_II, "later", 5);
    insertSources(database.native, CYBERPUNK, "initial", 14);
    database.native.prepare("INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid) VALUES (2138330, 'Phantom Liberty', 'phantom-liberty', 'expansion', 1, 1, ?)").run(CYBERPUNK);
    insertSources(database.native, 2138330, "later", 1);
    const runId = insertLaterRun(database.native, [CYBERPUNK]);
    const { calls, fetchFn } = discoveryFetch();

    await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE });

    // The 45-article experiment total is retired: Cyberpunk 2077 takes its
    // fifteenth article, and the outlets after it find it at its ceiling.
    expect(count(database, "SELECT COUNT(*) AS count FROM media_sources WHERE appid = ?", CYBERPUNK)).toBe(15);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_sources")).toBe(46);
  });
});

describe("per-outlet UTC-day attempt cap across passes", () => {
  test("initial-pass attempts leave the later pass one attempt that day, across a restart, and reopen on the next UTC day", async () => {
    const database = fixture();
    seedAttempts(database, "IGN", "initial", "2026-09-10", 29);
    const runId = insertLaterRun(database.native, [CYBERPUNK]);
    const { calls, fetchFn } = discoveryFetch();

    const first = await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE });

    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 1, fetches: 0 });
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = 'IGN' AND day = '2026-09-10'")).toBe(30);
    expect(first.stopReasons).toContain("IGN:daily_attempt_cap");
    expect(progress(database, "later", "IGN")).toEqual({ status: "stopped", stop_reason: "daily_attempt_cap" });

    database.reopen();
    await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE_LATE });
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 1, fetches: 0 });

    await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_TWO });
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 1, fetches: 1 });
    expect(count(database, "SELECT COUNT(*) AS count FROM media_sources WHERE pass = 'later' AND outlet = 'IGN'")).toBe(1);
  });
});

describe("outlet attempt reservation", () => {
  test("a reservation under a run that does not exist records nothing and fails instead of returning another attempt", async () => {
    const database = fixture();
    seedAttempts(database, "IGN", "initial", "2026-09-10", 1);

    await expect(reserveOutletAttempt(database.db, { runId: 999, appid: CYBERPUNK, outlet: "IGN", kind: "fetch", url: "https://ign.com/a", date: DAY_ONE })).rejects.toThrow();
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_attempts")).toBe(1);
  });
});

describe("outlet stops across passes", () => {
  test("an outlet's initial-pass access denial stops its later-pass work with the original reason", async () => {
    const database = fixture();
    const denied = discoveryFetch({ variants: { [`https://ign.com/articles/${CYBERPUNK}-ign-com`]: { status: 403, body: " " } } });
    const initial = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    await runAuthorizedMediaDiscovery(database.db, { runId: initial.runId, tavilyApiKey: "test-key", fetch: denied.fetchFn, now: DAY_ONE });
    expect(progress(database, "initial", "IGN")).toEqual({ status: "stopped", stop_reason: "fetch_http_403" });

    database.reopen();
    const runId = insertLaterRun(database.native, [CYBERPUNK]);
    const { calls, fetchFn } = discoveryFetch();
    const later = await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-10-10T12:00:00.000Z") });

    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 0, fetches: 0 });
    expect(outletCalls(calls, "eurogamer.net")).toEqual({ searches: 1, fetches: 1 });
    expect(progress(database, "later", "IGN")).toEqual({ status: "stopped", stop_reason: "fetch_http_403" });
    expect(later.stopReasons).toContain("IGN:fetch_http_403");
  });

  test("a search provider authorization failure stops the run without denying any outlet", async () => {
    const database = fixture();
    const rejected = discoveryFetch();
    const rejectingFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/search")
        ? (rejected.calls.push({ url: String(input), init }), new Response("", { status: 401 }))
        : rejected.fetchFn(input, init);
    const initial = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const stopped = await runAuthorizedMediaDiscovery(database.db, { runId: initial.runId, tavilyApiKey: "test-key", fetch: rejectingFetch, now: DAY_ONE });
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReasons).toEqual(["tavily_search_http_401"]);
    expect(rejected.calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(1);

    const runId = insertLaterRun(database.native, [CYBERPUNK]);
    const { calls, fetchFn } = discoveryFetch();
    const later = await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_TWO });
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 1, fetches: 1 });
    expect(later.stopReasons.filter((reason) => reason.startsWith("IGN:"))).toEqual([]);

    insertSources(database.native, BALDURS_GATE, "initial", 1, IGN);
    const { fetched, advance } = await processingRunFor(database, [BALDURS_GATE]);
    await advance(DAY_TWO);
    expect(fetched).toEqual([`https://ign.com/articles/${BALDURS_GATE}-initial-seeded-0`]);
  });

  test("a search provider authorization failure leaves its query for the next authorized run, which issues it once", async () => {
    const database = fixture();
    const rejectingFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/search") ? new Response("", { status: 403 }) : discoveryFetch().fetchFn(input, init);
    const first = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const stopped = await runAuthorizedMediaDiscovery(database.db, { runId: first.runId, tavilyApiKey: "test-key", fetch: rejectingFetch, now: DAY_ONE });
    expect(stopped.stopReasons).toEqual(["tavily_search_http_403"]);
    expect(stopped.queries).toBe(0);
    expect(progress(database, "initial", "IGN")?.status).toBe("queued");

    const resumed = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    expect(resumed.resumed).toBe(true);
    const { calls, fetchFn } = discoveryFetch();
    const rerun = await runAuthorizedMediaDiscovery(database.db, { runId: resumed.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE_LATE });

    expect(rerun.status).toBe("completed");
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 1, fetches: 1 });
    expect(progress(database, "initial", "IGN")).toEqual({ status: "completed", stop_reason: null });
    expect(rerun.queries).toBe(MEDIA_OUTLETS.length);
  });

  test("a search provider rate limit stops searching for the run without limiting the outlet, and its query reopens on the next UTC day", async () => {
    const database = fixture();
    const limited = discoveryFetch();
    const limitedFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/search") ? (limited.calls.push({ url: String(input), init }), new Response("", { status: 429 })) : limited.fetchFn(input, init);
    const first = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const stopped = await runAuthorizedMediaDiscovery(database.db, { runId: first.runId, tavilyApiKey: "test-key", fetch: limitedFetch, now: DAY_ONE });

    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReasons).toEqual(["tavily_search_http_429"]);
    expect(stopped.queries).toBe(0);
    expect(limited.calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(1);
    expect(progress(database, "initial", "IGN")).toEqual({ status: "stopped", stop_reason: "tavily_search_http_429" });

    const sameDay = discoveryFetch();
    const sameDayRun = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    await runAuthorizedMediaDiscovery(database.db, { runId: sameDayRun.runId, tavilyApiKey: "test-key", fetch: sameDay.fetchFn, now: DAY_ONE_LATE });
    expect(outletCalls(sameDay.calls, "ign.com")).toEqual({ searches: 0, fetches: 0 });
    expect(outletCalls(sameDay.calls, "eurogamer.net")).toEqual({ searches: 1, fetches: 1 });

    const nextDay = discoveryFetch();
    const nextDayRun = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const reopened = await runAuthorizedMediaDiscovery(database.db, { runId: nextDayRun.runId, tavilyApiKey: "test-key", fetch: nextDay.fetchFn, now: DAY_TWO });
    expect(outletCalls(nextDay.calls, "ign.com")).toEqual({ searches: 1, fetches: 1 });
    expect(progress(database, "initial", "IGN")).toEqual({ status: "completed", stop_reason: null });
    expect(reopened.queries).toBe(MEDIA_OUTLETS.length);
  });

  test("exhausted search credits stop the run and leave the unissued query for the next authorized run, which issues it once", async () => {
    const database = fixture();
    const oneCredit = discoveryFetch();
    const oneCreditFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/usage")
        ? Response.json({ account: { current_plan: "free" }, plan_usage: 99, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 })
        : oneCredit.fetchFn(input, init);
    const first = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const stopped = await runAuthorizedMediaDiscovery(database.db, { runId: first.runId, tavilyApiKey: "test-key", fetch: oneCreditFetch, now: DAY_ONE });

    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReasons).toEqual(["tavily_credits_exhausted"]);
    expect(stopped.queries).toBe(1);
    expect(outletCalls(oneCredit.calls, "eurogamer.net")).toEqual({ searches: 0, fetches: 0 });
    expect(progress(database, "initial", "Eurogamer")).toEqual({ status: "queued", stop_reason: "tavily_credits_exhausted" });

    const resumed = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const { calls, fetchFn } = discoveryFetch();
    const rerun = await runAuthorizedMediaDiscovery(database.db, { runId: resumed.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE_LATE });

    expect(rerun.status).toBe("completed");
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 0, fetches: 0 });
    expect(outletCalls(calls, "eurogamer.net")).toEqual({ searches: 1, fetches: 1 });
    expect(progress(database, "initial", "Eurogamer")).toEqual({ status: "completed", stop_reason: null });
    expect(rerun.queries).toBe(MEDIA_OUTLETS.length);
  });

  test.each([
    ["a server error", "tavily_search_http_503", async (): Promise<Response> => new Response("", { status: 503 })],
    ["a network error", "tavily_search_error", async (): Promise<Response> => { throw new TypeError("fetch failed"); }],
  ])("%s from the search provider stops searching without using the outlet's attempts, and the next authorized run issues the query once", async (_failure, reason, failingSearch) => {
    const database = fixture();
    seedAttempts(database, "IGN", "initial", "2026-09-10", 28);
    const failing = discoveryFetch();
    const failingFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/search") ? (failing.calls.push({ url: String(input), init }), failingSearch()) : failing.fetchFn(input, init);
    const first = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const stopped = await runAuthorizedMediaDiscovery(database.db, { runId: first.runId, tavilyApiKey: "test-key", fetch: failingFetch, now: DAY_ONE });

    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReasons).toEqual([reason]);
    expect(stopped.queries).toBe(0);
    expect(failing.calls.filter((call) => call.url.endsWith("/search"))).toHaveLength(1);
    expect(progress(database, "initial", "IGN")).toEqual({ status: "queued", stop_reason: reason });

    const resumed = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const { calls, fetchFn } = discoveryFetch();
    const rerun = await runAuthorizedMediaDiscovery(database.db, { runId: resumed.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE_LATE });

    expect(rerun.status).toBe("completed");
    expect(rerun.stopReasons.filter((stop) => stop.startsWith("IGN:"))).toEqual([]);
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 1, fetches: 1 });
    expect(progress(database, "initial", "IGN")).toEqual({ status: "completed", stop_reason: null });
    expect(rerun.queries).toBe(MEDIA_OUTLETS.length);
  });

  test("a same-day initial-pass rate limit stops later-pass work that day and reopens on the next UTC day", async () => {
    const database = fixture();
    const limited = discoveryFetch({ variants: { [`https://ign.com/articles/${CYBERPUNK}-ign-com`]: { status: 429, body: " " } } });
    const initial = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    await runAuthorizedMediaDiscovery(database.db, { runId: initial.runId, tavilyApiKey: "test-key", fetch: limited.fetchFn, now: DAY_ONE });
    expect(progress(database, "initial", "IGN")).toEqual({ status: "stopped", stop_reason: "fetch_http_429" });

    const runId = insertLaterRun(database.native, [CYBERPUNK]);
    const { calls, fetchFn } = discoveryFetch();
    const sameDay = await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE_LATE });
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 0, fetches: 0 });
    expect(progress(database, "later", "IGN")).toEqual({ status: "stopped", stop_reason: "fetch_http_429" });
    expect(sameDay.stopReasons).toContain("IGN:fetch_http_429");

    database.reopen();
    await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_TWO });
    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 1, fetches: 1 });
    expect(progress(database, "later", "IGN")?.status).toBe("completed");
  });
});

// A provider stop is any search-provider failure. It never denies or
// day-stops an outlet, uses none of the outlet's daily attempts, keeps the
// query for a later authorized run, and stops the run with a `tavily_*` reason.
describe("provider stops for every search outcome", () => {
  type ProviderStopCase = {
    outcome: string;
    outlet: MediaOutlet;
    reason: string;
    apiKey?: string;
    search?: () => Promise<Response>;
    usage?: () => Response;
    /** The outlet's progress row after the stop; null when no query was ever recorded. */
    kept: { status: string; stop_reason: string } | null;
  };
  const freeUsage = (planUsage: number) => (): Response =>
    Response.json({ account: { current_plan: "free" }, plan_usage: planUsage, plan_limit: 100, paygo_usage: 0, paygo_limit: 0 });
  const refusedWith = (status: number) => async (): Promise<Response> => new Response("", { status });

  const cases: ProviderStopCase[] = [
    { outcome: "HTTP 401", outlet: "IGN", reason: "tavily_search_http_401", search: refusedWith(401), kept: { status: "queued", stop_reason: "tavily_search_http_401" } },
    { outcome: "HTTP 403", outlet: "IGN", reason: "tavily_search_http_403", search: refusedWith(403), kept: { status: "queued", stop_reason: "tavily_search_http_403" } },
    { outcome: "HTTP 429", outlet: "IGN", reason: "tavily_search_http_429", search: refusedWith(429), kept: { status: "stopped", stop_reason: "tavily_search_http_429" } },
    { outcome: "HTTP 500", outlet: "IGN", reason: "tavily_search_http_500", search: refusedWith(500), kept: { status: "queued", stop_reason: "tavily_search_http_500" } },
    { outcome: "HTTP 503", outlet: "IGN", reason: "tavily_search_http_503", search: refusedWith(503), kept: { status: "queued", stop_reason: "tavily_search_http_503" } },
    { outcome: "a thrown network error", outlet: "IGN", reason: "tavily_search_error", search: async () => { throw new TypeError("fetch failed"); }, kept: { status: "queued", stop_reason: "tavily_search_error" } },
    { outcome: "credits exhausted before the run", outlet: "IGN", reason: "tavily_credits_exhausted", usage: freeUsage(100), kept: null },
    { outcome: "credits exhausted during the run", outlet: "Eurogamer", reason: "tavily_credits_exhausted", usage: freeUsage(99), kept: { status: "queued", stop_reason: "tavily_credits_exhausted" } },
    { outcome: "a missing key", outlet: "IGN", reason: "tavily_missing_key", apiKey: "", kept: null },
  ];

  test.each(cases.map((item) => [item.outcome, item] as const))("%s", async (_outcome, item) => {
    const database = fixture();
    const outlet = MEDIA_OUTLETS.find((candidate) => candidate.name === item.outlet)!;
    seedAttempts(database, item.outlet, "initial", "2026-09-10", 28);
    const base = discoveryFetch();
    const failingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (item.usage && url.endsWith("/usage")) return item.usage();
      if (item.search && url.endsWith("/search")) return base.calls.push({ url, init }), item.search();
      return base.fetchFn(input, init);
    };
    const first = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const stopped = await runAuthorizedMediaDiscovery(database.db, { runId: first.runId, tavilyApiKey: item.apiKey ?? "test-key", fetch: failingFetch, now: DAY_ONE });

    // The run stops with the provider's reason, and only provider reasons.
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReasons).toContain(item.reason);
    for (const reason of stopped.stopReasons) expect(reason).toMatch(/^tavily_/);

    // The query is kept for a later authorized run: never marked searched.
    expect(progress(database, "initial", item.outlet)).toEqual(item.kept);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_progress WHERE outlet = ? AND query_attempted_at IS NOT NULL", item.outlet)).toBe(0);

    // The outlet is neither denied nor day-stopped, and its UTC-day count is
    // unchanged: exactly the two attempts left before the stop remain.
    const probe = () => reserveOutletAttempt(database.db, { runId: first.runId, appid: CYBERPUNK, outlet: item.outlet, kind: "fetch", url: null, date: DAY_ONE_LATE });
    expect("attemptId" in (await probe())).toBe(true);
    expect("attemptId" in (await probe())).toBe(true);
    expect(await probe()).toEqual({ stop: "daily_attempt_cap" });

    // The next authorized run issues the kept query exactly once.
    const retry = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    const { calls, fetchFn } = discoveryFetch();
    const rerun = await runAuthorizedMediaDiscovery(database.db, { runId: retry.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_TWO });
    expect(rerun.status).toBe("completed");
    expect(outletCalls(calls, outlet.domain)).toEqual({ searches: 1, fetches: 1 });
    expect(progress(database, "initial", item.outlet)).toEqual({ status: "completed", stop_reason: null });
  });
});

describe("discovery query bound per pass", () => {
  test("each pass queries every eligible entity once per outlet, and reruns and restarts add none", async () => {
    const database = fixture();
    database.native.prepare("INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid) VALUES (2138330, 'Phantom Liberty', 'phantom-liberty', 'expansion', 1, 1, ?)").run(CYBERPUNK);
    const { calls, fetchFn } = discoveryFetch();
    const searches = () => calls.filter((call) => call.url.endsWith("/search")).length;
    const initial = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    await runAuthorizedMediaDiscovery(database.db, { runId: initial.runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE });
    expect(searches()).toBe(12);

    const runId = insertLaterRun(database.native, [CYBERPUNK]);
    const later = await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_TWO });
    expect(later.queries).toBe(12);
    expect(searches()).toBe(24);

    database.reopen();
    await runAuthorizedMediaDiscovery(database.db, { runId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_TWO });
    const rerunId = insertLaterRun(database.native, [CYBERPUNK]);
    const rerun = await runAuthorizedMediaDiscovery(database.db, { runId: rerunId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-12T00:00:00.000Z") });
    expect(searches()).toBe(24);
    expect(rerun.queries).toBe(12);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_progress WHERE pass = 'later' AND query_attempted_at IS NOT NULL")).toBe(12);
  });
});

const IGN = MEDIA_OUTLETS[0];
const EUROGAMER = MEDIA_OUTLETS[1];

/** A completed later-pass run authorized for processing, with fetches recorded by URL. */
function processingRun(database: TestDatabase, respond: (url: string) => Response | string = () => processingArticleHtml(CYBERPUNK)) {
  return processingRunFor(database, [CYBERPUNK], respond);
}

async function processingRunFor(database: TestDatabase, games: readonly number[], respond: (url: string) => Response | string = () => processingArticleHtml(CYBERPUNK)) {
  const runId = insertLaterRun(database.native, games);
  database.native.prepare("UPDATE media_discovery_runs SET status = 'completed' WHERE id = ?").run(runId);
  await authorizeMediaProcessing(database.db, runId);
  const fetched: string[] = [];
  const transport = new ControlledGeminiTransport();
  const advance = (now: Date) => advanceMediaProcessing(database.db, {
    runId,
    transport, openRouter: transport.openRouter,
    articleFetch: async (url) => { fetched.push(url); return respond(url); },
    now,
  });
  return { runId, fetched, advance };
}

describe("processing limits across passes", () => {
  test("the processing source set holds at most 15 articles per game counted across passes", async () => {
    const database = fixture();
    insertSources(database.native, CYBERPUNK, "initial", 10);
    insertSources(database.native, CYBERPUNK, "later", 6, EUROGAMER);
    const { fetched, advance } = await processingRun(database);

    await advance(DAY_ONE);

    expect(fetched).toHaveLength(15);
    expect(fetched.filter((url) => url.includes("-initial-"))).toHaveLength(10);
    expect(fetched.filter((url) => url.includes("-later-"))).toHaveLength(5);
  });

  test("article fetches count toward the outlet's UTC-day cap with every pass's attempts", async () => {
    const database = fixture();
    seedAttempts(database, "IGN", "initial", "2026-09-10", 29);
    insertSources(database.native, CYBERPUNK, "later", 3, IGN);
    const { fetched, advance } = await processingRun(database);

    const summary = await advance(DAY_ONE);

    expect(fetched).toHaveLength(1);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = 'IGN' AND day = '2026-09-10'")).toBe(30);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE pass = 'later'")).toBe(1);
    expect(summary.stopReasons).toContain("IGN:daily_attempt_cap");

    await advance(DAY_TWO);
    expect(fetched).toHaveLength(3);
  });

  test("an article fetch's attempt is recorded before the outlet is contacted", async () => {
    const database = fixture();
    insertSources(database.native, CYBERPUNK, "later", 1, IGN);
    const recordedBeforeFetch: number[] = [];
    const { advance } = await processingRun(database, () => {
      recordedBeforeFetch.push(count(database, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = 'IGN' AND day = '2026-09-10'"));
      return processingArticleHtml(CYBERPUNK);
    });

    await advance(DAY_ONE);

    expect(recordedBeforeFetch).toEqual([1]);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = 'IGN'")).toBe(1);
  });

  test("concurrent discovery and processing admit only the last attempt left under the UTC-day cap", async () => {
    const database = fixture();
    seedAttempts(database, "IGN", "initial", "2026-09-10", 29);
    insertSources(database.native, CYBERPUNK, "later", 1, IGN);
    const { fetched, advance } = await processingRun(database);
    const discoveryRunId = insertLaterRun(database.native, [BALDURS_GATE]);
    const { calls, fetchFn } = discoveryFetch();

    await Promise.all([
      advance(DAY_ONE),
      runAuthorizedMediaDiscovery(database.db, { runId: discoveryRunId, tavilyApiKey: "test-key", fetch: fetchFn, now: DAY_ONE }),
    ]);

    const ignContacts = fetched.filter((url) => url.includes("ign.com")).length + outletCalls(calls, "ign.com").searches + outletCalls(calls, "ign.com").fetches;
    expect(ignContacts).toBe(1);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = 'IGN' AND day = '2026-09-10'")).toBe(30);
  });

  test("an access denial during an article fetch stops that outlet for the rest of the run with its reason", async () => {
    const database = fixture();
    insertSources(database.native, CYBERPUNK, "initial", 3, IGN);
    insertSources(database.native, CYBERPUNK, "initial", 1, EUROGAMER);
    const { fetched, advance } = await processingRun(database, (url) =>
      url.includes("ign.com") ? new Response("", { status: 403 }) : processingArticleHtml(CYBERPUNK));

    const summary = await advance(DAY_ONE);

    expect(fetched.filter((url) => url.includes("ign.com"))).toHaveLength(1);
    expect(fetched.filter((url) => url.includes("eurogamer.net"))).toHaveLength(1);
    expect(summary.stopReasons).toContain("IGN:fetch_http_403");
  });

  test("a processing denial persists across a reopen, for the rest of the run and for later-pass discovery", async () => {
    const database = fixture();
    insertSources(database.native, CYBERPUNK, "initial", 2, IGN);
    const { fetched, advance } = await processingRun(database, (url) =>
      url.includes("ign.com") ? new Response("", { status: 403 }) : processingArticleHtml(CYBERPUNK));
    await advance(DAY_ONE);
    expect(fetched).toHaveLength(1);

    database.reopen();
    const resumed = await advance(DAY_TWO);
    expect(fetched).toHaveLength(1);
    expect(resumed.stopReasons).toContain("IGN:fetch_http_403");

    const laterId = insertLaterRun(database.native, [CYBERPUNK]);
    const { calls, fetchFn } = discoveryFetch();
    const later = await runAuthorizedMediaDiscovery(database.db, { runId: laterId, tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-10-10T12:00:00.000Z") });

    expect(outletCalls(calls, "ign.com")).toEqual({ searches: 0, fetches: 0 });
    expect(later.stopReasons).toContain("IGN:fetch_http_403");
  });

  test("a processing run records the explicit reason for every outlet it stopped", async () => {
    const database = fixture();
    insertSources(database.native, CYBERPUNK, "initial", 1, IGN);
    insertSources(database.native, CYBERPUNK, "initial", 1, EUROGAMER);
    const { runId, advance } = await processingRun(database, (url) =>
      new Response("", { status: url.includes("ign.com") ? 403 : 401 }));

    const summary = await advance(DAY_ONE);

    expect(summary.stopReasons).toEqual(expect.arrayContaining(["IGN:fetch_http_403", "Eurogamer:fetch_http_401"]));
    const recorded = database.native.query<{ stop_reason: string | null }, [number]>("SELECT stop_reason FROM media_processing_authorizations WHERE run_id = ?").get(runId)?.stop_reason ?? "";
    expect(recorded).toContain("IGN:fetch_http_403");
    expect(recorded).toContain("Eurogamer:fetch_http_401");
  });

  test("an outlet that denied a discovery fetch is not contacted again by later processing, which keeps the original reason", async () => {
    const database = fixture();
    insertSources(database.native, CYBERPUNK, "initial", 2, IGN);
    const denying = discoveryFetch({ variants: { [`https://ign.com/articles/${CYBERPUNK}-ign-com`]: { status: 403, body: " " } } });
    const initial = await authorizeMediaRun(database.db, { pass: "initial", games: [CYBERPUNK] });
    await runAuthorizedMediaDiscovery(database.db, { runId: initial.runId, tavilyApiKey: "test-key", fetch: denying.fetchFn, now: DAY_ONE });

    database.reopen();
    const { fetched, advance } = await processingRun(database);
    const summary = await advance(new Date("2026-10-10T12:00:00.000Z"));

    expect(fetched.filter((url) => url.includes("ign.com"))).toEqual([]);
    expect(summary.stopReasons).toContain("IGN:fetch_http_403");
  });

  test("a same-day search provider rate limit neither limits the outlet's article fetches nor uses its daily attempts", async () => {
    const database = fixture();
    seedAttempts(database, "IGN", "initial", "2026-09-10", 29);
    const limitedFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/search") ? new Response("", { status: 429 }) : discoveryFetch().fetchFn(input, init);
    const later = insertLaterRun(database.native, [CYBERPUNK]);
    const discovery = await runAuthorizedMediaDiscovery(database.db, { runId: later, tavilyApiKey: "test-key", fetch: limitedFetch, now: DAY_ONE });
    expect(discovery.stopReasons).toEqual(["tavily_search_http_429"]);

    insertSources(database.native, BALDURS_GATE, "initial", 1, IGN);
    const { fetched, advance } = await processingRunFor(database, [BALDURS_GATE]);
    const summary = await advance(DAY_ONE);

    expect(fetched).toEqual([`https://ign.com/articles/${BALDURS_GATE}-initial-seeded-0`]);
    expect(summary.stopReasons.filter((reason) => reason.startsWith("IGN:"))).toEqual([]);
  });
});
