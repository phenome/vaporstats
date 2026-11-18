import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDatabase, type TestDatabase } from "./support/db";
import { BALDURS_GATE, CYBERPUNK, experimentWorld, GAME_NAMES, HADES_II, PRODUCTION_LIKE, runMediaTick, seedProductionLike, type MediaWorld } from "./support/media";

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

describe("production-like media state", () => {
  test("is the state of 2026-11-18: 9 sources, 3 GameSpot denials, 4 day-capped initial queries, 8 retained Gemini jobs, 7 completed authorizations and no enrollment", () => {
    const { native } = productionLike();
    const count = (query: string) => native.query<{ count: number }, []>(query).get()!.count;
    expect(native.query("SELECT appid, outlet, pass FROM media_sources ORDER BY appid, outlet").all()).toEqual(
      [BALDURS_GATE, CYBERPUNK, HADES_II].flatMap((appid) => ["Eurogamer", "IGN", "PC Gamer"].map((outlet) => ({ appid, outlet, pass: "initial" }))),
    );
    expect(count("SELECT COUNT(*) AS count FROM media_sources WHERE processing_run_id IS NOT NULL")).toBe(3);
    expect(native.query("SELECT DISTINCT s.appid FROM media_article_extractions AS e JOIN media_sources AS s ON s.id = e.source_id WHERE e.active = 1").all()).toEqual([{ appid: CYBERPUNK }]);
    expect(native.query("SELECT appid FROM media_game_overviews WHERE active = 1").all()).toEqual([{ appid: CYBERPUNK }]);
    expect(native.query("SELECT appid, outlet, status_code FROM media_discovery_attempts WHERE kind = 'fetch' AND status_code IN (401, 403) ORDER BY appid").all()).toEqual([BALDURS_GATE, CYBERPUNK, HADES_II].map((appid) => ({ appid, outlet: "GameSpot", status_code: 403 })));
    expect(native.query("SELECT appid, outlet, substr(stopped_at, 1, 7) AS month FROM media_discovery_progress WHERE stop_reason = 'daily_attempt_cap' ORDER BY appid, outlet").all()).toEqual(
      PRODUCTION_LIKE.dayCappedQueries.map(([appid, outlet]) => ({ appid, outlet, month: "2026-09" })).sort((a, b) => a.appid - b.appid || a.outlet.localeCompare(b.outlet)),
    );
    expect(native.query("SELECT status, COUNT(*) AS count FROM media_processing_jobs WHERE retained = 1 AND provider = 'gemini' GROUP BY status ORDER BY status").all()).toEqual([{ status: "stale", count: 2 }, { status: "succeeded", count: 6 }]);
    expect(count("SELECT COUNT(*) AS count FROM media_processing_jobs")).toBe(8);
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

  // The review of #75 expected: day 1, Cyberpunk 2077's later pass on its
  // represented outlets plus the four reopened Baldur's Gate 3 and Hades II
  // initial queries; day 2, those games' later passes on their represented
  // outlets; day 3, no search. The reopened queries each accept an initial
  // article on day 1, so on day 2 Kotaku and GamesRadar+ are represented
  // too. Every source new to processing is queued on the day it is accepted
  // or, for the six discovered-only sources, on day 1, and each game's
  // Overview is rebuilt the day its contributions change.
  test("switched on, day 1 takes Cyberpunk 2077's later pass and the four reopened initial queries, day 2 the Baldur's Gate 3 and Hades II later passes, and day 3 searches nothing", async () => {
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
        searches: [...at(CYBERPUNK, PRODUCTION_LIKE.representedOutlets), ...at(BALDURS_GATE, ["Kotaku", "GamesRadar+"]), ...at(HADES_II, ["Kotaku", "GamesRadar+"])],
        // Baldur's Gate 3 and Hades II: 3 discovered-only sources and 2 reopened
        // initial articles each; Cyberpunk 2077: 3 later articles. The new
        // Overviews change every game's gameplay similarity input.
        enqueued: [
          `embedding ${name(BALDURS_GATE)} ×1`, `embedding ${name(CYBERPUNK)} ×1`, `embedding ${name(HADES_II)} ×1`,
          `extraction ${name(BALDURS_GATE)} ×5`, `extraction ${name(CYBERPUNK)} ×3`, `extraction ${name(HADES_II)} ×5`,
          `synthesis ${name(BALDURS_GATE)} ×1`, `synthesis ${name(CYBERPUNK)} ×1`, `synthesis ${name(HADES_II)} ×1`,
        ],
        overviews: [name(BALDURS_GATE), name(CYBERPUNK), name(HADES_II)],
      },
      {
        searches: [...at(BALDURS_GATE, [...PRODUCTION_LIKE.representedOutlets, "Kotaku", "GamesRadar+"]), ...at(HADES_II, [...PRODUCTION_LIKE.representedOutlets, "Kotaku", "GamesRadar+"])],
        // Their Overviews keep the same similarity inputs, so no embedding is queued.
        enqueued: [`extraction ${name(BALDURS_GATE)} ×5`, `extraction ${name(HADES_II)} ×5`, `synthesis ${name(BALDURS_GATE)} ×1`, `synthesis ${name(HADES_II)} ×1`],
        overviews: [name(BALDURS_GATE), name(HADES_II)],
      },
      { searches: [], enqueued: [], overviews: [] },
    ]);
    // GameSpot stays denied; retained Gemini jobs are never touched.
    expect(fetched.filter((url) => url.includes("gamespot.com"))).toEqual([]);
    expect(database.native.query("SELECT * FROM media_processing_jobs WHERE retained = 1 ORDER BY id").all()).toEqual(retained);
    expect(database.native.query("SELECT status, COUNT(*) AS count FROM media_processing_jobs WHERE retained = 0 GROUP BY status").all()).toEqual([{ status: "succeeded", count: 31 }]);
  });
});
