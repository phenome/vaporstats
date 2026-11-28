import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  GEMINI_EMBEDDING_CONFIG_VERSION,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL,
  getMediaGameMatchPaths,
  getMediaGameMatches,
  type MediaGameMatch,
} from "../src/lib/media-similarity";
import { GAMEPLAY_MATCH_BAR, gameplayTagScore, gameplayTagVector } from "../src/lib/media-gameplay-tags";
import { STEAM_GAMEPLAY_TAGS } from "../src/lib/steam-gameplay-tags";
import { getCanonicalChildPath } from "../src/lib/related";
import { getCanonicalGamePath } from "../src/lib/slug";
import { decodeVector, encodeVector } from "../src/lib/media-embedding-vector";
import { openMemoryDatabase } from "./support/db";

function countRows(
  native: Database,
  table: "media_processing_jobs" | "media_game_embeddings" | "media_game_overviews" | "app_facet_memberships",
): number {
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

const OPEN_WORLD = "1695";
const FPS = "1663";
const RPG = "122";
const STORY_RICH = "1742"; // a community tag outside the gameplay table
const UNNAMED = "1663"; // reused below with its dictionary name removed

type TagWeights = ReadonlyArray<readonly [sourceId: string, weight: number | null]>;

function addTags(native: Database, appid: number, tags: TagWeights): void {
  for (const [order, [sourceId, weight]] of tags.entries()) {
    native.prepare(
      "INSERT OR IGNORE INTO app_facets (facet_group, source_id, name) VALUES ('community_tag', ?, ?)",
    ).run(sourceId, STEAM_GAMEPLAY_TAGS[sourceId]?.name ?? (sourceId === STORY_RICH ? "Story Rich" : null));
    native.prepare(
      "INSERT INTO app_facet_memberships (appid, facet_group, source_id, source_order, weight) VALUES (?, 'community_tag', ?, ?, ?)",
    ).run(appid, sourceId, order, weight);
  }
}

function expectedScore(left: TagWeights, right: TagWeights): number {
  const vector = (tags: TagWeights) => gameplayTagVector(tags.map(([sourceId, weight]) => ({ sourceId, weight })));
  return gameplayTagScore(vector(left), vector(right));
}

const TARGET_TAGS: TagWeights = [[OPEN_WORLD, 100], [FPS, 50], [STORY_RICH, 80]];
const SAME_TAGS: TagWeights = [[OPEN_WORLD, 100], [FPS, 50]];
const CLOSE_TAGS: TagWeights = [[OPEN_WORLD, 100], [FPS, 50], [RPG, 40]];
const FARTHER_TAGS: TagWeights = [[OPEN_WORLD, 100], [RPG, 90]];
const DISJOINT_TAGS: TagWeights = [[RPG, 100]];

function fixture() {
  const database = openMemoryDatabase();
  const native = database.native;
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
       (410, 'Target Expansion', 'target-expansion', 'expansion', 1, 0, 100),
       (420, 'Ineligible', 'ineligible', 'game', 0, 1, NULL),
       (421, 'No Overview', 'no-overview', 'game', 1, 1, NULL),
       (422, 'Inactive Overview', 'inactive-overview', 'game', 1, 1, NULL),
       (423, 'Unweighted', 'unweighted', 'game', 1, 1, NULL),
       (424, 'Themes Only', 'themes-only', 'game', 1, 1, NULL)`,
  ).run();
  native.prepare("INSERT INTO app_relationships (parent_appid, child_appid, relationship_type) VALUES (100, 409, 'tool')").run();
  for (const appid of [100, 201, 202, 203, 204, 205, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 420, 422, 423, 424]) {
    addOverview(native, appid, `overview-${appid}`);
  }
  native.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = 422").run();

  // Story & world: the embedding cosine.
  addVector(native, 100, "story_world", vector(0, 1));
  addVector(native, 201, "story_world", vector(0, 1));
  addVector(native, 202, "story_world", vector(1, 1));
  addVector(native, 203, "story_world", vector(0, 1));
  addVector(native, 204, "story_world", vector(1, 1));
  addVector(native, 205, "story_world", vector(0, 1));
  addVector(native, 401, "story_world", vector(0.4, 0.9));
  addVector(native, 402, "story_world", vector(0, 1));
  addVector(native, 403, "story_world", vector(0, 1), { overviewInputIdentity: "old-overview-403" });
  addVector(native, 404, "story_world", vector(0, 1), { active: 0 });
  addVector(native, 405, "story_world", vector(0, 1), { model: "other-model" });
  addVector(native, 406, "story_world", vector(0, 1), { configVersion: "old-config" });
  addVector(native, 407, "story_world", vector(Number.NaN, 1));
  addVector(native, 408, "story_world", vector(0, 0));
  addVector(native, 409, "story_world", vector(0, 1));
  addVector(native, 410, "story_world", vector(0.6, 0.8));
  addVector(native, 420, "story_world", vector(0, 1));
  addVector(native, 422, "story_world", vector(0, 1), { overviewInputIdentity: "overview-422" });

  // Gameplay embeddings that would rank the candidates differently if they were read.
  addVector(native, 100, "gameplay", vector(1, 0));
  for (const appid of [201, 202, 203, 204, 205, 401, 410]) {
    addVector(native, appid, "gameplay", vector(appid === 203 ? 1 : 0, appid === 203 ? 0 : 1));
  }

  // Gameplay & systems: the gameplay tag overlap.
  addTags(native, 100, TARGET_TAGS);
  addTags(native, 201, CLOSE_TAGS);
  addTags(native, 202, SAME_TAGS);
  addTags(native, 203, DISJOINT_TAGS);
  addTags(native, 204, FARTHER_TAGS);
  addTags(native, 205, [[OPEN_WORLD, 30], [STORY_RICH, 100]]);
  addTags(native, 401, SAME_TAGS);
  addTags(native, 410, CLOSE_TAGS);
  for (const appid of [403, 404, 405, 406, 407, 408]) addTags(native, appid, FARTHER_TAGS);
  for (const appid of [402, 409, 420, 421, 422]) addTags(native, appid, SAME_TAGS);
  addTags(native, 423, [[OPEN_WORLD, null], [FPS, null], [STORY_RICH, 100]]);
  addTags(native, 424, [[STORY_RICH, 100]]);
  return database;
}

function dimensionAppids(matches: readonly MediaGameMatch[], dimension: MediaGameMatch["dimension"]): number[] {
  return matches.filter((match) => match.dimension === dimension).map((match) => match.matchedGame.appid);
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

describe("live media similarity", () => {
  test("ranks gameplay by tag overlap and story and world by exact cosine, independently and with deterministic ties", async () => {
    const value = fixture();
    cleanups.push(value.close);
    const matches = await getMediaGameMatches(value.db, 100, { limit: 2, includeUnpublished: true });

    expect(matches.map((match) => [match.dimension, match.matchedGame.appid])).toEqual([
      ["gameplay", 202],
      ["gameplay", 401],
      ["story_world", 201],
      ["story_world", 203],
    ]);
    expect(matches[0]?.similarity).toBeCloseTo(1, 12);
    expect(matches[1]?.similarity).toBeCloseTo(1, 12);
    expect(matches[2]?.similarity).toBe(1);
    expect(matches[3]?.similarity).toBe(1);
    for (const match of matches.slice(0, 2)) {
      expect(Object.keys(match)).toEqual(["dimension", "similarity", "matchedGame", "sharedTags"]);
      expect(match.sharedTags).toEqual(["Open World", "FPS"]);
    }
    for (const match of matches.slice(2)) {
      expect(Object.keys(match)).toEqual(["dimension", "similarity", "matchedGame"]);
    }
    for (const match of matches) expect(Object.keys(match.matchedGame)).toEqual(["appid", "name", "slug"]);

    const all = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    const gameplay = all.filter((match) => match.dimension === "gameplay");
    expect(gameplay.map((match) => match.matchedGame.appid)).toEqual([202, 401, 201, 410, 205, 204, 403, 404, 405, 406, 407, 408]);
    expect(gameplay.map((match) => match.similarity)).toEqual([
      expectedScore(TARGET_TAGS, SAME_TAGS),
      expectedScore(TARGET_TAGS, SAME_TAGS),
      expectedScore(TARGET_TAGS, CLOSE_TAGS),
      expectedScore(TARGET_TAGS, CLOSE_TAGS),
      expectedScore(TARGET_TAGS, [[OPEN_WORLD, 30], [STORY_RICH, 100]]),
      ...Array<number>(7).fill(expectedScore(TARGET_TAGS, FARTHER_TAGS)),
    ]);
    expect(gameplay.every((match) => match.similarity >= GAMEPLAY_MATCH_BAR)).toBe(true);
    expect(gameplay.find((match) => match.matchedGame.appid === 204)?.sharedTags).toEqual(["Open World"]);
  });

  test("reads no gameplay embedding", async () => {
    const value = fixture();
    cleanups.push(value.close);
    const statements: string[] = [];
    const prepare = value.db.prepare.bind(value.db);
    value.db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql); }) as typeof value.db.prepare;
    const before = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });

    const embeddingReads = statements.filter((sql) => sql.includes("media_game_embeddings"));
    expect(embeddingReads.length).toBeGreaterThan(0);
    for (const sql of embeddingReads) {
      expect(sql).toContain("dimension = 'story_world'");
      expect(sql).not.toContain("'gameplay'");
    }

    value.native.prepare("DELETE FROM media_game_embeddings WHERE dimension = 'gameplay'").run();
    expect(await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true })).toEqual(before);
  });

  test("lists a gameplay candidate only at or above the bar", async () => {
    const value = fixture();
    cleanups.push(value.close);
    value.native.prepare("DELETE FROM app_facet_memberships WHERE appid <> 100").run();
    // With Open World at weight `a` beneath a top non-gameplay tag, the score rises with `a`.
    const candidate = (a: number): TagWeights => [[OPEN_WORLD, a], [RPG, 1000]];
    let first = 1;
    while (expectedScore(TARGET_TAGS, candidate(first)) < GAMEPLAY_MATCH_BAR) first += 1;
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThan(1000);
    const below = expectedScore(TARGET_TAGS, candidate(first - 1));
    const atOrAbove = expectedScore(TARGET_TAGS, candidate(first));
    expect(below).toBeLessThan(GAMEPLAY_MATCH_BAR);
    expect(below).toBeGreaterThan(GAMEPLAY_MATCH_BAR - 0.002);
    expect(atOrAbove).toBeGreaterThanOrEqual(GAMEPLAY_MATCH_BAR);
    expect(atOrAbove).toBeLessThan(GAMEPLAY_MATCH_BAR + 0.002);
    addTags(value.native, 201, candidate(first - 1));
    addTags(value.native, 202, candidate(first));

    const matches = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    expect(dimensionAppids(matches, "gameplay")).toEqual([202]);
    expect(matches[0]?.similarity).toBe(atOrAbove);

    value.native.prepare("DELETE FROM app_facet_memberships WHERE appid = 202").run();
    const none = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    expect(dimensionAppids(none, "gameplay")).toEqual([]);
    expect(dimensionAppids(none, "story_world")).toEqual(dimensionAppids(matches, "story_world"));
  });

  test("a game with no weighted gameplay tag has no gameplay matches and is no candidate, while story and world stay unchanged", async () => {
    const value = fixture();
    cleanups.push(value.close);
    const before = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    const storyBefore = before.filter((match) => match.dimension === "story_world");

    for (const appid of [423, 424]) {
      expect(dimensionAppids(await getMediaGameMatches(value.db, appid, { limit: 100, includeUnpublished: true }), "gameplay")).toEqual([]);
    }
    expect(dimensionAppids(before, "gameplay")).not.toContain(423);
    expect(dimensionAppids(before, "gameplay")).not.toContain(424);
    expect(dimensionAppids(before, "gameplay")).not.toContain(203);

    value.native.prepare("UPDATE app_facet_memberships SET weight = NULL WHERE appid = 100 AND source_id <> ?").run(STORY_RICH);
    const unweighted = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    expect(dimensionAppids(unweighted, "gameplay")).toEqual([]);
    expect(unweighted).toEqual(storyBefore);

    value.native.prepare("DELETE FROM app_facet_memberships WHERE appid = 100").run();
    expect(await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true })).toEqual(storyBefore);
  });

  test("names shared tags from the Catalog Facet dictionary and leaves out an unnamed tag", async () => {
    const value = fixture();
    cleanups.push(value.close);
    value.native.prepare("UPDATE app_facets SET name = NULL WHERE facet_group = 'community_tag' AND source_id = ?").run(UNNAMED);
    const matches = await getMediaGameMatches(value.db, 100, { limit: 1, includeUnpublished: true });
    const gameplay = matches.find((match) => match.dimension === "gameplay");
    expect(gameplay?.matchedGame.appid).toBe(202);
    expect(gameplay?.similarity).toBeCloseTo(1, 12);
    expect(gameplay?.sharedTags).toEqual(["Open World"]);
  });

  test("resolves canonical root and child paths once per matched appid", async () => {
    const value = fixture();
    cleanups.push(value.close);
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
    cleanups.push(value.close);
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
      addVector(value.native, appid, "story_world", vector(0, 1));
      addTags(value.native, appid, SAME_TAGS);
    }

    const matches = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });
    for (const dimension of ["gameplay", "story_world"] as const) {
      const matchedAppids = new Set(dimensionAppids(matches, dimension));
      expect(matchedAppids.has(401)).toBe(true);
      expect(matchedAppids.has(410)).toBe(true);
      expect(matchedAppids.has(411)).toBe(false);
      expect(matchedAppids.has(412)).toBe(false);
      expect(matchedAppids.has(413)).toBe(false);
    }
    expect(await getMediaGameMatches(value.db, 411, { includeUnpublished: true })).toEqual([]);
    expect(dimensionAppids(await getMediaGameMatches(value.db, 401, { limit: 100, includeUnpublished: true }), "gameplay"))
      .toEqual([100, 202, 201, 410, 205, 204, 403, 404, 405, 406, 407, 408]);

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
    cleanups.push(value.close);
    const limited = await getMediaGameMatches(value.db, 100, { limit: 1, includeUnpublished: true });
    expect(limited.map((match) => [match.dimension, match.matchedGame.appid])).toEqual([
      ["gameplay", 202],
      ["story_world", 201],
    ]);
    expect(await getMediaGameMatches(value.db, 100, { limit: 0, includeUnpublished: true })).toEqual([]);
    expect(await getMediaGameMatches(value.db, 100, { limit: -1, includeUnpublished: true })).toEqual([]);
    const bounded = await getMediaGameMatches(value.db, 100, { includeUnpublished: true });
    expect(dimensionAppids(bounded, "gameplay")).toEqual([202, 401, 201]);
    expect(bounded.filter((match) => match.dimension === "story_world")).toHaveLength(3);
    const five = await getMediaGameMatches(value.db, 100, { limit: 5, includeUnpublished: true });
    expect(dimensionAppids(five, "gameplay")).toEqual([202, 401, 201, 410, 205]);
    expect(five.filter((match) => match.dimension === "story_world")).toHaveLength(5);
  });

  test("scans gameplay candidates in bounded batches without losing later matches", async () => {
    const value = fixture();
    cleanups.push(value.close);
    value.native.prepare("DELETE FROM app_facet_memberships WHERE appid <> 100").run();
    for (let appid = 1000; appid < 1300; appid += 1) {
      value.native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, `Candidate ${appid}`, `candidate-${appid}`);
      addOverview(value.native, appid, `overview-${appid}`);
      addTags(value.native, appid, appid === 1299 ? SAME_TAGS : appid === 1150 ? CLOSE_TAGS : DISJOINT_TAGS);
    }

    const matches = await getMediaGameMatches(value.db, 100, { limit: 2, includeUnpublished: true });
    expect(dimensionAppids(matches, "gameplay")).toEqual([1299, 1150]);
  });

  test("scans story and world vectors in bounded batches without losing later exact matches", async () => {
    const value = fixture();
    cleanups.push(value.close);
    value.native.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid <> 100 AND dimension = 'story_world'").run();
    for (let appid = 1000; appid < 1130; appid += 1) {
      value.native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(appid, `Candidate ${appid}`, `candidate-${appid}`);
      addOverview(value.native, appid, `overview-${appid}`);
      addVector(value.native, appid, "story_world", appid === 1129 ? vector(0, 1) : vector(1, 0));
    }

    const matches = await getMediaGameMatches(value.db, 100, { limit: 1, includeUnpublished: true });
    expect(matches.find((match) => match.dimension === "story_world")?.matchedGame.appid).toBe(1129);
  });

  test("isolates self, ineligible, non-playable, accessory, uncovered and incompatible candidates while retaining separate expansions", async () => {
    const value = fixture();
    cleanups.push(value.close);
    const matches = await getMediaGameMatches(value.db, 100, { limit: 100, includeUnpublished: true });

    // Gameplay: no embedding needed, but the same eligibility rules and an active Overview.
    expect(new Set(dimensionAppids(matches, "gameplay"))).toEqual(new Set([201, 202, 204, 205, 401, 403, 404, 405, 406, 407, 408, 410]));
    // Story & world: unchanged, a compatible current vector is also needed.
    expect(new Set(dimensionAppids(matches, "story_world"))).toEqual(new Set([201, 202, 203, 204, 205, 401, 410]));
    for (const excluded of [100, 402, 409, 420, 421, 422, 423, 424]) {
      expect(matches.some((match) => match.matchedGame.appid === excluded)).toBe(false);
    }
  });

  test("requires the current game's active Overview, and a story and world vector only for that dimension", async () => {
    const value = fixture();
    cleanups.push(value.close);
    const all = await getMediaGameMatches(value.db, 100, { includeUnpublished: true });
    const gameplay = all.filter((match) => match.dimension === "gameplay");
    expect(gameplay).toHaveLength(3);

    value.native.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = 100").run();
    expect(await getMediaGameMatches(value.db, 100, { includeUnpublished: true })).toEqual(gameplay);

    value.native.prepare("UPDATE media_game_embeddings SET active = 1 WHERE appid = 100").run();
    value.native.prepare("UPDATE media_game_overviews SET input_identity = 'new-overview' WHERE appid = 100 AND active = 1").run();
    expect(await getMediaGameMatches(value.db, 100, { includeUnpublished: true })).toEqual(gameplay);

    value.native.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = 100").run();
    expect(await getMediaGameMatches(value.db, 100, { includeUnpublished: true })).toEqual([]);
    expect(await getMediaGameMatches(value.db, 422, { includeUnpublished: true })).toEqual([]);
    expect(await getMediaGameMatches(value.db, 421, { includeUnpublished: true })).toEqual([]);
    expect(await getMediaGameMatches(value.db, 402, { includeUnpublished: true })).toEqual([]);
    expect(await getMediaGameMatches(value.db, 409, { includeUnpublished: true })).toEqual([]);
    expect(await getMediaGameMatches(value.db, 420, { includeUnpublished: true })).toEqual([]);
  });

  test("applies the publication gate without creating read-time jobs or spending", async () => {
    const value = fixture();
    cleanups.push(value.close);
    const before = {
      jobs: countRows(value.native, "media_processing_jobs"),
      embeddings: countRows(value.native, "media_game_embeddings"),
      overviews: countRows(value.native, "media_game_overviews"),
      memberships: countRows(value.native, "app_facet_memberships"),
    };
    const prior = process.env.MEDIA_OVERVIEW_PUBLIC;
    try {
      delete process.env.MEDIA_OVERVIEW_PUBLIC;
      expect(await getMediaGameMatches(value.db, 100)).toEqual([]);
      const internal = await getMediaGameMatches(value.db, 100, { includeUnpublished: true });
      expect(dimensionAppids(internal, "gameplay")).not.toEqual([]);
      expect(dimensionAppids(internal, "story_world")).not.toEqual([]);
      process.env.MEDIA_OVERVIEW_PUBLIC = "true";
      // None of these fixture games is a published root.
      expect(await getMediaGameMatches(value.db, 100)).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
      else process.env.MEDIA_OVERVIEW_PUBLIC = prior;
    }
    const after = {
      jobs: countRows(value.native, "media_processing_jobs"),
      embeddings: countRows(value.native, "media_game_embeddings"),
      overviews: countRows(value.native, "media_game_overviews"),
      memberships: countRows(value.native, "app_facet_memberships"),
    };
    expect(after).toEqual(before);
  });
});

describe("embedding vector codec", () => {
  test("round-trips 3,072 dimensions from blobs and aligned or unaligned byte views", () => {
    const input = Array.from({ length: 3_072 }, (_, index) => (index - 1_536) * 0.1);
    const expected = Float32Array.from(input);
    const encoded = encodeVector(input)!;
    expect(encoded.byteLength).toBe(12_288);
    expect(decodeVector(encoded)).toEqual(expected);
    expect(decodeVector(Uint8Array.from(encoded).buffer)).toEqual(expected);

    const backing = new Uint8Array(12_296);
    backing.set(encoded, 4);
    expect(decodeVector(backing.subarray(4, 12_292))).toEqual(expected);
    backing.set(encoded, 1);
    expect(decodeVector(backing.subarray(1, 12_289))).toEqual(expected);
  });

  test("rejects malformed, wrong-length and non-finite buffers", () => {
    for (const value of [
      null, "vector", new Float32Array(3_072), new DataView(new ArrayBuffer(12_288)),
      new ArrayBuffer(12_284), new Uint8Array(12_287), new Uint8Array(12_292),
    ]) {
      expect(decodeVector(value)).toBeNull();
    }
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const buffer = new ArrayBuffer(12_288);
      new Float32Array(buffer)[3_071] = invalid;
      expect(decodeVector(buffer)).toBeNull();
    }
  });

  test("rejects input that cannot be encoded as a finite Float32 vector", () => {
    const valid = Array<number>(3_072).fill(0);
    for (const invalid of [NaN, Infinity, Number.MAX_VALUE, "1", undefined]) {
      expect(encodeVector([...valid.slice(1), invalid])).toBeNull();
    }
    expect(encodeVector(valid.slice(1))).toBeNull();
    expect(encodeVector(Array<number>(3_072))).toBeNull();
  });
});
