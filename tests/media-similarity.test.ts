import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import {
  GEMINI_EMBEDDING_CONFIG_VERSION,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL,
  getMediaGameMatchPaths,
  getMediaGameMatches,
} from "../src/lib/media-similarity";
import { getCanonicalChildPath } from "../src/lib/related";
import { getCanonicalGamePath } from "../src/lib/slug";

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
function countRows(native: Database, table: "media_processing_jobs" | "media_game_embeddings" | "media_game_overviews"): number {
  const row = native.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function vector(first = 0, second = 0): Uint8Array {
  const bytes = new ArrayBuffer(GEMINI_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT);
  const values = new Float32Array(bytes);
  values[0] = first;
  values[1] = second;
  return new Uint8Array(bytes);
}

type VectorOverrides = Partial<{
  inputIdentity: string;
  overviewInputIdentity: string;
  model: string;
  configVersion: string;
  active: number;
  vector: Uint8Array;
}>;

function addOverview(native: Database, appid: number, inputIdentity: string): void {
  native.prepare(
    "INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json) VALUES (?, ?, 'summary-model', 'summary-config', '{}')",
  ).run(appid, inputIdentity);
}

function addVector(
  native: Database,
  appid: number,
  dimension: "gameplay" | "story_world",
  values: Uint8Array,
  overrides: VectorOverrides = {},
): void {
  native.prepare(
    `INSERT INTO media_game_embeddings
      (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    appid,
    dimension,
    overrides.inputIdentity ?? `${appid}-${dimension}`,
    overrides.overviewInputIdentity ?? `overview-${appid}`,
    overrides.model ?? GEMINI_EMBEDDING_MODEL,
    GEMINI_EMBEDDING_DIMENSIONS,
    overrides.configVersion ?? GEMINI_EMBEDDING_CONFIG_VERSION,
    overrides.vector ?? values,
    overrides.active ?? 1,
  );
}

function fixture() {
  const native = new Database(":memory:");
  applyMigrations(native);
  native.exec("PRAGMA foreign_keys = ON");
  native.prepare(
    `INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid)
     VALUES
       (100, 'Target', 'target', 'game', 1, 1, NULL),
       (201, 'Alpha', 'alpha', 'game', 1, 1, NULL),
       (202, 'Beta', 'beta', 'game', 1, 1, NULL),
       (203, 'Gamma', 'gamma', 'game', 1, 1, NULL),
       (204, 'Delta', 'delta', 'game', 1, 1, NULL),
       (205, 'Epsilon', 'epsilon', 'game', 1, 1, NULL),
       (401, 'Target DLC', 'target-dlc', 'dlc', 1, 0, 100),
       (402, 'Hidden', 'hidden', 'game', 1, 0, NULL),
       (403, 'Stale', 'stale', 'game', 1, 1, NULL),
       (404, 'Inactive', 'inactive', 'game', 1, 1, NULL),
       (405, 'Wrong Model', 'wrong-model', 'game', 1, 1, NULL),
       (406, 'Wrong Config', 'wrong-config', 'game', 1, 1, NULL),
       (407, 'Malformed', 'malformed', 'game', 1, 1, NULL),
       (408, 'Zero', 'zero', 'game', 1, 1, NULL),
       (409, 'Accessory', 'accessory', 'game', 1, 1, NULL),
       (410, 'Target Expansion', 'target-expansion', 'expansion', 1, 0, 100)`,
  ).run();
  native.prepare("INSERT INTO app_relationships (parent_appid, child_appid, relationship_type) VALUES (100, 409, 'tool')").run();
  for (const appid of [100, 201, 202, 203, 204, 205, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410]) {
    addOverview(native, appid, `overview-${appid}`);
  }
  addVector(native, 100, "gameplay", vector(1, 0));
  addVector(native, 100, "story_world", vector(0, 1));
  addVector(native, 201, "gameplay", vector(1, 0.1));
  addVector(native, 201, "story_world", vector(0, 1));
  addVector(native, 202, "gameplay", vector(1, 0));
  addVector(native, 202, "story_world", vector(1, 1));
  addVector(native, 203, "gameplay", vector(0, 1));
  addVector(native, 203, "story_world", vector(0, 1));
  addVector(native, 204, "gameplay", vector(1, 0.2));
  addVector(native, 204, "story_world", vector(1, 1));
  addVector(native, 205, "gameplay", vector(1, 0.5));
  addVector(native, 205, "story_world", vector(0, 1));
  addVector(native, 401, "gameplay", vector(0.9, 0.4));
  addVector(native, 402, "gameplay", vector(1, 0));
  addVector(native, 403, "gameplay", vector(1, 0), { overviewInputIdentity: "old-overview-403" });
  addVector(native, 404, "gameplay", vector(1, 0), { active: 0 });
  addVector(native, 405, "gameplay", vector(1, 0), { model: "other-model" });
  addVector(native, 406, "gameplay", vector(1, 0), { configVersion: "old-config" });
  addVector(native, 407, "gameplay", vector(Number.NaN, 0));
  addVector(native, 408, "gameplay", vector(0, 0));
  addVector(native, 409, "gameplay", vector(1, 0));
  addVector(native, 410, "gameplay", vector(0.8, 0.6));
  return { native, db: adapter(native) };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

describe("live media similarity", () => {
  test("ranks exact cosine matches independently per dimension with deterministic ties", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    const matches = await getMediaGameMatches(value.db, 100, { limit: 2, includeUnpublished: true });

    expect(matches).toHaveLength(4);
    expect(matches.map((match) => [match.dimension, match.matchedGame.appid])).toEqual([
      ["gameplay", 202],
      ["gameplay", 201],
      ["story_world", 201],
      ["story_world", 203],
    ]);
    expect(matches[0]?.similarity).toBe(1);
    expect(matches[1]?.similarity).toBeCloseTo(1 / Math.sqrt(1.01), 7);
    expect(matches[2]?.similarity).toBe(1);
    expect(matches[3]?.similarity).toBe(1);
    for (const match of matches) {
      expect(Object.keys(match)).toEqual(["dimension", "similarity", "matchedGame"]);
      expect(Object.keys(match.matchedGame)).toEqual(["appid", "name", "slug"]);
    }
  });

  test("resolves canonical root and child paths once per matched appid", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    const paths = await getMediaGameMatchPaths(value.db, [
      {
        dimension: "gameplay",
        similarity: 1,
        matchedGame: { appid: 201, name: "stale", slug: "stale" },
      },
      {
        dimension: "story_world",
        similarity: 1,
        matchedGame: { appid: 201, name: "duplicate", slug: "duplicate" },
      },
      {
        dimension: "gameplay",
        similarity: 0.5,
        matchedGame: { appid: 401, name: "stale", slug: "stale" },
      },
      {
        dimension: "story_world",
        similarity: 0.4,
        matchedGame: { appid: 410, name: "stale", slug: "stale" },
      },
      {
        dimension: "gameplay",
        similarity: 0.3,
        matchedGame: { appid: 402, name: "Hidden", slug: "hidden" },
      },
      {
        dimension: "gameplay",
        similarity: 0.2,
        matchedGame: { appid: 409, name: "Accessory", slug: "accessory" },
      },
      {
        dimension: "gameplay",
        similarity: 0.1,
        matchedGame: { appid: 999, name: "Missing", slug: "missing" },
      },
    ]);

    expect(paths).toEqual({
      201: getCanonicalGamePath(201, "Alpha"),
      401: getCanonicalChildPath(100, "Target", 401, "Target DLC"),
      410: getCanonicalChildPath(100, "Target", 410, "Target Expansion"),
    });
    expect(Object.keys(paths)).toHaveLength(3);
    expect(paths[402]).toBeUndefined();
    expect(paths[409]).toBeUndefined();
    expect(paths[999]).toBeUndefined();
  });

  test("requires every child match and path to have an eligible playable root parent", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    value.native.prepare(
      `INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid)
       VALUES
         (501, 'Ineligible Parent', 'ineligible-parent', 'game', 0, 1, NULL),
         (502, 'Non-playable Parent', 'non-playable-parent', 'game', 1, 0, NULL),
         (503, 'Nested Parent', 'nested-parent', 'game', 1, 1, 100),
         (411, 'Ineligible Parent DLC', 'ineligible-parent-dlc', 'dlc', 1, 0, 501),
         (412, 'Non-playable Parent Expansion', 'non-playable-parent-expansion', 'expansion', 1, 0, 502),
         (413, 'Nested Parent DLC', 'nested-parent-dlc', 'dlc', 1, 0, 503)`,
    ).run();
    for (const appid of [411, 412, 413]) {
      addOverview(value.native, appid, `overview-${appid}`);
      addVector(value.native, appid, "gameplay", vector(1, 0));
    }

    const matches = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    const matchedAppids = new Set(matches.map((match) => match.matchedGame.appid));
    expect(matchedAppids.has(401)).toBe(true);
    expect(matchedAppids.has(410)).toBe(true);
    expect(matchedAppids.has(411)).toBe(false);
    expect(matchedAppids.has(412)).toBe(false);
    expect(matchedAppids.has(413)).toBe(false);
    expect(await getMediaGameMatches(value.db, 411, { includeUnpublished: true })).toEqual([]);

    const paths = await getMediaGameMatchPaths(value.db, [
      { dimension: "gameplay", similarity: 1, matchedGame: { appid: 401, name: "stale", slug: "stale" } },
      { dimension: "gameplay", similarity: 1, matchedGame: { appid: 410, name: "stale", slug: "stale" } },
      { dimension: "gameplay", similarity: 1, matchedGame: { appid: 411, name: "stale", slug: "stale" } },
      { dimension: "gameplay", similarity: 1, matchedGame: { appid: 412, name: "stale", slug: "stale" } },
      { dimension: "gameplay", similarity: 1, matchedGame: { appid: 413, name: "stale", slug: "stale" } },
    ]);
    expect(paths[401]).toBe(getCanonicalChildPath(100, "Target", 401, "Target DLC"));
    expect(paths[410]).toBe(getCanonicalChildPath(100, "Target", 410, "Target Expansion"));
    expect(paths[411]).toBeUndefined();
    expect(paths[412]).toBeUndefined();
    expect(paths[413]).toBeUndefined();
  });

  test("handles limits and keeps each dimension independently bounded", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    const limited = await getMediaGameMatches(value.db, 100, { limit: 1, includeUnpublished: true });
    expect(limited.map((match) => [match.dimension, match.matchedGame.appid])).toEqual([
      ["gameplay", 202],
      ["story_world", 201],
    ]);
    expect(await getMediaGameMatches(value.db, 100, { limit: 0, includeUnpublished: true })).toEqual([]);
    expect(await getMediaGameMatches(value.db, 100, { limit: -1, includeUnpublished: true })).toEqual([]);
    const bounded = await getMediaGameMatches(value.db, 100, { includeUnpublished: true });
    expect(bounded.filter((match) => match.dimension === "gameplay")).toHaveLength(3);
    expect(bounded.filter((match) => match.dimension === "story_world")).toHaveLength(3);
  });

  test("scans compatible vectors in bounded batches without losing later exact matches", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    value.native.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid <> 100 AND dimension = 'gameplay'").run();
    for (let appid = 1000; appid < 1130; appid += 1) {
      value.native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, `Candidate ${appid}`, `candidate-${appid}`);
      addOverview(value.native, appid, `overview-${appid}`);
      addVector(value.native, appid, "gameplay", appid === 1129 ? vector(1, 0) : vector(0, 1));
    }

    const matches = await getMediaGameMatches(value.db, 100, { limit: 1, includeUnpublished: true });
    expect(matches.find((match) => match.dimension === "gameplay")?.matchedGame.appid).toBe(1129);
  });

  test("isolates incompatible, stale, inactive, malformed, and accessory vectors while retaining separate expansions", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    const matches = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    const matchedAppids = new Set(matches.map((match) => match.matchedGame.appid));

    expect(matchedAppids).toEqual(new Set([201, 202, 203, 204, 205, 401, 410]));
    expect(matchedAppids.has(100)).toBe(false);
    expect(matchedAppids.has(401)).toBe(true);
    expect(matchedAppids.has(402)).toBe(false);
    expect(matchedAppids.has(403)).toBe(false);
    expect(matchedAppids.has(404)).toBe(false);
    expect(matchedAppids.has(405)).toBe(false);
    expect(matchedAppids.has(406)).toBe(false);
    expect(matchedAppids.has(407)).toBe(false);
    expect(matchedAppids.has(408)).toBe(false);
    expect(matchedAppids.has(409)).toBe(false);
    expect(matchedAppids.has(410)).toBe(true);
  });

  test("requires an active vector tied to the current Overview", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    value.native.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = 100").run();
    expect(await getMediaGameMatches(value.db, 100, { includeUnpublished: true })).toEqual([]);

    value.native.prepare("UPDATE media_game_embeddings SET active = 1 WHERE appid = 100").run();
    value.native.prepare("UPDATE media_game_overviews SET input_identity = 'new-overview' WHERE appid = 100 AND active = 1").run();
    expect(await getMediaGameMatches(value.db, 100, { includeUnpublished: true })).toEqual([]);
  });

  test("applies the publication gate without creating read-time jobs or spending", async () => {
    const value = fixture();
    cleanups.push(() => value.native.close(true));
    const before = {
      jobs: countRows(value.native, "media_processing_jobs"),
      embeddings: countRows(value.native, "media_game_embeddings"),
      overviews: countRows(value.native, "media_game_overviews"),
    };
    const prior = process.env.MEDIA_OVERVIEW_PUBLIC;
    try {
      delete process.env.MEDIA_OVERVIEW_PUBLIC;
      expect(await getMediaGameMatches(value.db, 100)).toEqual([]);
      expect(await getMediaGameMatches(value.db, 100, { includeUnpublished: true })).not.toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
      else process.env.MEDIA_OVERVIEW_PUBLIC = prior;
    }
    const after = {
      jobs: countRows(value.native, "media_processing_jobs"),
      embeddings: countRows(value.native, "media_game_embeddings"),
      overviews: countRows(value.native, "media_game_overviews"),
    };
    expect(after).toEqual(before);
  });
});
