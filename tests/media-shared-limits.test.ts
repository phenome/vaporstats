import { afterEach, describe, expect, test } from "bun:test";
import { authorizeMediaRun, MEDIA_OUTLETS, runAuthorizedMediaDiscovery, type MediaOutlet, type MediaPass } from "../src/lib/media-discovery";
import {
  advanceMediaProcessing,
  authorizeMediaProcessing,
  GEMINI_BATCH_CAPABILITY_VERSION,
  GEMINI_BATCH_PRICING_VERSION,
} from "../src/lib/media-processing";
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

  test("a later pass admits no article once 45 are accepted across passes, and issues no query", async () => {
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

    expect(calls.filter((call) => !call.url.endsWith("/usage"))).toEqual([]);
    expect(count(database, "SELECT COUNT(*) AS count FROM media_sources")).toBe(45);
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
    transport,
    articleFetch: async (url) => { fetched.push(url); return respond(url); },
    now,
    pricingVersion: GEMINI_BATCH_PRICING_VERSION,
    capabilityVersion: GEMINI_BATCH_CAPABILITY_VERSION,
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

  test("a later run's processing draws on the lifetime allowance the initial pass already charged", async () => {
    const database = fixture();
    const initialRunId = insertCompletedRun(database.native, "initial:charged", [CYBERPUNK]);
    database.native.prepare("INSERT INTO media_processing_jobs (run_id, stage, appid, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status) VALUES (?, 'extraction', ?, 'initial-charged', 'initial-input', 'model', 'config', 1, 1, 4999999, 4999999, 0, 'succeeded')").run(initialRunId, CYBERPUNK);
    insertSources(database.native, CYBERPUNK, "later", 1, EUROGAMER);
    const { fetched, advance } = await processingRun(database);

    const summary = await advance(DAY_ONE);

    expect(fetched).toHaveLength(1);
    expect(summary.submitted).toBe(0);
    expect(summary.chargedMicrousd).toBe(4999999);
    expect(summary.stopReasons).toContain("lifetime_budget");
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

  test("a same-day rate limit from discovery stops processing fetches on that outlet", async () => {
    const database = fixture();
    database.native.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, status_code, succeeded, attempted_at) VALUES (?, 'IGN', 'initial', '2026-09-10', 'search', 429, 0, '2026-09-10T01:00:00.000Z')").run(CYBERPUNK);
    insertSources(database.native, CYBERPUNK, "initial", 2, IGN);
    const { fetched, advance } = await processingRun(database);

    const summary = await advance(DAY_ONE);

    expect(fetched).toEqual([]);
    expect(summary.stopReasons).toContain("IGN:search_http_429");
  });
});
