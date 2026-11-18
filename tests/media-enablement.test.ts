import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDatabase, type TestDatabase } from "./support/db";
import { BALDURS_GATE, CYBERPUNK, experimentWorld, GAME_NAMES, HADES_II, productionCandidateUrl, runMediaTick, seedProductionLike, type MediaWorld } from "./support/media";

// Switching automatic media ingestion off and on over the production media
// state of 2026-11-18, at the ingestion-tick seam, with a temporary SQLite
// file and controlled providers and outlets. Nothing reaches a real provider.

const cleanups: Array<() => void> = [];
const artifacts = process.env.RECEPTION_ARTIFACT_DIR;
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (artifacts === undefined) delete process.env.RECEPTION_ARTIFACT_DIR;
  else process.env.RECEPTION_ARTIFACT_DIR = artifacts;
});

const DAYS = ["2026-11-19", "2026-11-20", "2026-11-21"];
const TIMES = ["05:45", "06:00", "06:15", "06:30", "06:45", "07:00"];

function productionLike(): TestDatabase {
  const database = openTestDatabase("vaporstats-media-enablement-");
  cleanups.push(database.cleanup);
  seedProductionLike(database.native);
  return database;
}

/** Every media row, and the media checkpoints, as they are now. */
function mediaState(native: Database): Record<string, unknown[]> {
  const tables = native.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'media\\_%' ESCAPE '\\' ORDER BY name").all().map(({ name }) => name);
  const state: Record<string, unknown[]> = Object.fromEntries(tables.map((name) => [name, native.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  state.checkpoints = native.query("SELECT key, value FROM checkpoints WHERE key LIKE 'media:%' ORDER BY key").all();
  return state;
}

/** Every outbound request a media world served: searches, article fetches, text requests and embedding submissions. */
function providerCalls(world: MediaWorld, fetched: readonly string[]) {
  return {
    tavily: world.tavily.requests.length + world.tavily.usageCalls,
    outlet: fetched.length,
    openRouter: world.openRouter.calls.length,
    gemini: world.gemini.calls.length,
  };
}

const name = (appid: number) => GAME_NAMES[appid]!;
const domains: Record<string, string> = { IGN: "ign.com", Eurogamer: "eurogamer.net", "PC Gamer": "pcgamer.com", Kotaku: "kotaku.com", "GamesRadar+": "gamesradar.com" };

// The production media state, read-only, as checked on 2026-11-18. Each
// progress row is [appid, outlet, status, stop reason, candidate index,
// candidate count, searched, stopped at].
const BG3 = BALDURS_GATE;
const CP = CYBERPUNK;
const H2 = HADES_II;
const PRODUCTION_SOURCES = [[1, BG3, "IGN"], [3, BG3, "GamesRadar+"], [4, CP, "IGN"], [5, CP, "Eurogamer"], [6, CP, "PC Gamer"], [8, H2, "IGN"], [9, H2, "Eurogamer"], [10, H2, "PC Gamer"], [11, H2, "Kotaku"]];
const PRODUCTION_PROGRESS = [
  [BG3, "Eurogamer", "completed", null, 0, 0, 1, null],
  [BG3, "GameSpot", "stopped", "fetch_http_403", 2, 10, 1, "2026-09-11T03:47:12.000Z"],
  [BG3, "GamesRadar+", "completed", null, 10, 10, 1, null],
  [BG3, "IGN", "completed", null, 10, 10, 1, null],
  [BG3, "Kotaku", "completed", null, 10, 10, 1, null],
  [BG3, "PC Gamer", "completed", null, 0, 0, 1, null],
  [CP, "Eurogamer", "completed", null, 10, 10, 1, null],
  [CP, "GameSpot", "stopped", "fetch_http_403", 1, 10, 1, "2026-09-13T21:24:01.000Z"],
  [CP, "GamesRadar+", "completed", null, 10, 10, 1, null],
  [CP, "IGN", "completed", null, 10, 10, 1, null],
  [CP, "Kotaku", "completed", null, 10, 10, 1, null],
  [CP, "PC Gamer", "completed", null, 10, 10, 1, null],
  [H2, "Eurogamer", "completed", null, 10, 10, 1, null],
  [H2, "GameSpot", "stopped", "fetch_http_403", 1, 10, 1, "2026-09-11T03:47:12.000Z"],
  [H2, "GamesRadar+", "stopped", "daily_attempt_cap", 0, 0, 0, "2026-09-11T03:47:12.000Z"],
  [H2, "IGN", "stopped", "daily_attempt_cap", 6, 10, 1, "2026-09-11T03:47:12.000Z"],
  [H2, "Kotaku", "stopped", "daily_attempt_cap", 7, 10, 1, "2026-09-11T03:47:12.000Z"],
  [H2, "PC Gamer", "stopped", "daily_attempt_cap", 4, 10, 1, "2026-09-11T03:47:12.000Z"],
];

describe("production-like media state", () => {
  test("is the production state of 2026-11-18: its sources, initial progress, Overviews, retained Gemini jobs and authorizations, and no enrollment", () => {
    const { native } = productionLike();
    const count = (query: string) => native.query<{ count: number }, []>(query).get()!.count;
    expect(native.query("SELECT id, appid, outlet FROM media_sources ORDER BY id").all()).toEqual(PRODUCTION_SOURCES.map(([id, appid, outlet]) => ({ id, appid, outlet })));
    expect(native.query("SELECT id FROM media_sources WHERE processing_run_id IS NOT NULL ORDER BY id").all()).toEqual([{ id: 4 }, { id: 5 }, { id: 6 }]);
    expect(native.query("SELECT DISTINCT pass FROM media_sources").all()).toEqual([{ pass: "initial" }]);
    expect(native.query<{ appid: number; outlet: string; status: string; stop_reason: string | null; candidate_index: number; candidates: number; searched: number; stopped_at: string | null }, []>(
      "SELECT appid, outlet, status, stop_reason, candidate_index, json_array_length(candidate_urls) AS candidates, query_attempted_at IS NOT NULL AS searched, stopped_at FROM media_discovery_progress WHERE pass = 'initial' ORDER BY appid, outlet",
    ).all().map((row) => [row.appid, row.outlet, row.status, row.stop_reason, row.candidate_index, row.candidates, row.searched, row.stopped_at])).toEqual(PRODUCTION_PROGRESS);
    // The capped Hades II queries that were searched had already admitted their outlet's source.
    for (const [outlet, source] of [["IGN", 8], ["Kotaku", 11], ["PC Gamer", 10]] as const) {
      const row = native.query<{ candidate_urls: string; candidate_index: number }, [string]>(`SELECT candidate_urls, candidate_index FROM media_discovery_progress WHERE appid = ${H2} AND outlet = ?`).get(outlet)!;
      const considered = (JSON.parse(row.candidate_urls) as Array<{ url: string }>).slice(0, row.candidate_index).map(({ url }) => url);
      expect(considered).toContain(native.query<{ discovery_url: string }, [number]>("SELECT discovery_url FROM media_sources WHERE id = ?").get(source)!.discovery_url);
    }
    expect(native.query("SELECT appid, outlet, status_code FROM media_discovery_attempts WHERE kind = 'fetch' AND status_code IN (401, 403) ORDER BY appid").all()).toEqual([BG3, CP, H2].map((appid) => ({ appid, outlet: "GameSpot", status_code: 403 })));
    expect(native.query("SELECT appid, active FROM media_game_overviews ORDER BY id").all()).toEqual([{ appid: CP, active: 0 }, { appid: CP, active: 1 }]);
    expect(native.query("SELECT appid, stage, status, provider, retained, COUNT(*) AS count FROM media_processing_jobs GROUP BY appid, stage, status, provider, retained ORDER BY stage, status").all()).toEqual([
      { appid: CP, stage: "extraction", status: "succeeded", provider: "gemini", retained: 1, count: 4 },
      { appid: CP, stage: "synthesis", status: "stale", provider: "gemini", retained: 1, count: 2 },
      { appid: CP, stage: "synthesis", status: "succeeded", provider: "gemini", retained: 1, count: 2 },
    ]);
    expect(count("SELECT COUNT(*) AS count FROM media_game_embeddings")).toBe(0);
    expect(native.query("SELECT status, COUNT(*) AS count FROM media_processing_authorizations GROUP BY status").all()).toEqual([{ status: "completed", count: 7 }]);
    expect(count("SELECT COUNT(*) AS count FROM media_enrollments")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM checkpoints WHERE key LIKE 'media:%'")).toBe(0);
  });
});

describe("automatic media ingestion over the production-like state", () => {
  test("switched off, three days of ticks make no provider or outlet call and change no media row", async () => {
    const database = productionLike();
    const world = experimentWorld();
    const fetched: string[] = [];
    const before = mediaState(database.native);
    for (const day of DAYS) {
      for (const time of TIMES) {
        expect((await runMediaTick(database, world, `${day}T${time}:00.000Z`, { outlet: world.outlet, fetched, mediaAutomaticIngestion: false })).status).toBe("completed");
      }
    }
    expect(providerCalls(world, fetched)).toEqual({ tavily: 0, outlet: 0, openRouter: 0, gemini: 0 });
    expect(mediaState(database.native)).toEqual(before);
  });

  // Day 1: every Baldur's Gate 3 and Cyberpunk 2077 initial query has
  // completed or met an Outlet denial, so both later passes are due and ask
  // the outlets with an accepted initial article. Hades II's four capped
  // queries reopen: GamesRadar+, never searched, is searched; IGN, Kotaku and
  // PC Gamer resume at their recorded candidate without a new search and,
  // having admitted their article before the cap, admit no other. Every
  // source new to processing is queued. Cyberpunk 2077's active Overview has
  // similarity inputs and no vector, but its later articles are queued for
  // extraction in the same advance and will replace it, so its embedding
  // work waits (#80, 2026-11-18): it gets one embedding round, for the
  // replacement Overview's gameplay input only. Day 2: Hades II's initial
  // pass finished on day 1, so its later pass asks its five represented
  // outlets. Day 3: nothing is due.
  test("switched on, day 1 takes the Baldur's Gate 3 and Cyberpunk 2077 later passes and resumes Hades II's capped queries without a new search or a second article, day 2 the Hades II later pass, and day 3 searches nothing", async () => {
    const database = productionLike();
    const world = experimentWorld();
    const fetched: string[] = [];
    const retained = database.native.query("SELECT * FROM media_processing_jobs WHERE retained = 1 ORDER BY id").all();
    const observed: Array<{ searches: string[]; enqueued: string[]; overviews: string[] }> = [];
    for (const day of DAYS) {
      const searches = world.tavily.searches.length;
      const lastJob = database.native.query<{ id: number }, []>("SELECT MAX(id) AS id FROM media_processing_jobs").get()!.id;
      const lastOverview = database.native.query<{ id: number }, []>("SELECT MAX(id) AS id FROM media_game_overviews").get()!.id;
      for (const time of TIMES) await runMediaTick(database, world, `${day}T${time}:00.000Z`, { outlet: world.outlet, fetched });
      observed.push({
        searches: world.tavily.searches.slice(searches),
        enqueued: database.native.query<{ stage: string; appid: number; count: number }, [number]>("SELECT stage, appid, COUNT(*) AS count FROM media_processing_jobs WHERE id > ? GROUP BY stage, appid ORDER BY stage, appid").all(lastJob).map(({ stage, appid, count }) => `${stage} ${name(appid)} ×${count}`),
        overviews: database.native.query<{ appid: number }, [number]>("SELECT appid FROM media_game_overviews WHERE id > ? AND active = 1 ORDER BY appid").all(lastOverview).map(({ appid }) => name(appid)),
      });
    }

    const at = (appid: number, outlets: readonly string[]) => outlets.map((outlet) => `${name(appid)}@${domains[outlet]}`);
    expect(observed).toEqual([
      {
        searches: [...at(BG3, ["IGN", "GamesRadar+"]), ...at(CP, ["IGN", "Eurogamer", "PC Gamer"]), ...at(H2, ["GamesRadar+"])],
        enqueued: [
          `embedding ${name(BG3)} ×1`, `embedding ${name(CP)} ×1`, `embedding ${name(H2)} ×1`,
          `extraction ${name(BG3)} ×4`, `extraction ${name(CP)} ×3`, `extraction ${name(H2)} ×5`,
          `synthesis ${name(BG3)} ×1`, `synthesis ${name(CP)} ×1`, `synthesis ${name(H2)} ×1`,
        ],
        overviews: [name(BG3), name(CP), name(H2)],
      },
      {
        searches: at(H2, ["IGN", "Eurogamer", "PC Gamer", "Kotaku", "GamesRadar+"]),
        // Its Overview keeps the same similarity inputs, so no embedding is queued.
        enqueued: [`extraction ${name(H2)} ×5`, `synthesis ${name(H2)} ×1`],
        overviews: [name(H2)],
      },
      { searches: [], enqueued: [], overviews: [] },
    ]);
    // One initial article per Hades II outlet: the resumed capped queries admitted no second one.
    expect(database.native.query(`SELECT outlet, id FROM media_sources WHERE appid = ${H2} AND pass = 'initial' ORDER BY outlet`).all()).toEqual([
      { outlet: "Eurogamer", id: 9 }, { outlet: "GamesRadar+", id: 17 }, { outlet: "IGN", id: 8 }, { outlet: "Kotaku", id: 11 }, { outlet: "PC Gamer", id: 10 },
    ]);
    // Each resumed capped query fetched its remaining candidates once, and completed on day 1.
    for (const [outlet, from] of [["IGN", 6], ["Kotaku", 7], ["PC Gamer", 4]] as const) {
      const domain = domains[outlet]!;
      expect(fetched.filter((url) => url.startsWith(`https://${domain}/articles/${H2}-`) && url.includes("-candidate-"))).toEqual(Array.from({ length: 10 - from }, (_, index) => productionCandidateUrl(H2, domain, from + index)));
    }
    expect(database.native.query(`SELECT outlet, status, completed_at FROM media_discovery_progress WHERE appid = ${H2} AND pass = 'initial' AND outlet IN ('IGN', 'Kotaku', 'PC Gamer', 'GamesRadar+') ORDER BY outlet`).all()).toEqual(
      ["GamesRadar+", "IGN", "Kotaku", "PC Gamer"].map((outlet) => ({ outlet, status: "completed", completed_at: "2026-11-19T06:00:00.000Z" })),
    );
    // GameSpot stays denied; retained Gemini jobs are never touched.
    expect(fetched.filter((url) => url.includes("gamespot.com"))).toEqual([]);
    expect(database.native.query("SELECT * FROM media_processing_jobs WHERE retained = 1 ORDER BY id").all()).toEqual(retained);
    expect(database.native.query("SELECT status, COUNT(*) AS count FROM media_processing_jobs WHERE retained = 0 GROUP BY status").all()).toEqual([{ status: "succeeded", count: 24 }]);
    // Every embedding Cyberpunk 2077 got embeds its replacement Overview, which is active.
    expect(database.native.query(`SELECT e.dimension, e.overview_input_identity = o.input_identity AS current FROM media_game_embeddings AS e JOIN media_game_overviews AS o ON o.appid = e.appid AND o.active = 1 WHERE e.appid = ${CP} ORDER BY e.id`).all()).toEqual([{ dimension: "gameplay", current: 1 }]);
  });
});

describe("embedding holds over the production-like state", () => {
  test("a new Cyberpunk 2077 article behind GameSpot's Outlet denial is refused as outlet_denied, so the Overview is rebuilt and embedded", async () => {
    const database = productionLike();
    const world = experimentWorld();
    const fetched: string[] = [];
    const url = "https://www.gamespot.com/articles/1091500-gamespot-late-review";
    database.native.prepare("INSERT INTO media_sources (appid, pass, original_url, discovery_url, title, outlet, author, published_at, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'Cyberpunk 2077 Review', 'GameSpot', 'GameSpot critic', '2025-01-01T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 'review')").run(CP, url, url);

    for (const day of DAYS) for (const time of TIMES) await runMediaTick(database, world, `${day}T${time}:00.000Z`, { outlet: world.outlet, fetched });

    expect(fetched.filter((fetchedUrl) => fetchedUrl.includes("gamespot.com"))).toEqual([]);
    expect(database.native.query("SELECT j.status, j.error FROM media_processing_jobs AS j JOIN media_sources AS s ON s.id = j.source_id WHERE s.outlet = 'GameSpot'").all()).toEqual([{ status: "refused", error: "outlet_denied" }]);
    const overview = database.native.query<{ input_identity: string }, []>(`SELECT input_identity FROM media_game_overviews WHERE appid = ${CP} AND active = 1`).get()!;
    expect(database.native.query(`SELECT dimension, overview_input_identity FROM media_game_embeddings WHERE appid = ${CP} AND active = 1`).all()).toEqual([{ dimension: "gameplay", overview_input_identity: overview.input_identity }]);
  });
});
