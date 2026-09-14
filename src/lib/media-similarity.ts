import type { AppDatabase } from "./db";
import { getCanonicalChildPath } from "./related";
import { getCanonicalGamePath } from "./slug";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const GEMINI_EMBEDDING_DIMENSIONS = 3072;
export const GEMINI_EMBEDDING_CONFIG_VERSION = "media-embedding-2026-09-13-v1";

export type MediaMatchDimension = "gameplay" | "story_world";
const MEDIA_MATCH_DIMENSIONS: readonly MediaMatchDimension[] = ["gameplay", "story_world"];
const DEFAULT_MATCH_LIMIT = 3;
const MAX_MATCH_LIMIT = 100;
const MAX_MATCH_PATHS = MAX_MATCH_LIMIT * MEDIA_MATCH_DIMENSIONS.length;
const CANDIDATE_BATCH_SIZE = 128;
export const ELIGIBLE_MEDIA_ENTITY_SQL = `(
  (app.type = 'game' AND app.is_playable = 1 AND app.parent_appid IS NULL)
  OR (
    app.type IN ('dlc', 'expansion')
    AND app.parent_appid IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM apps AS parent
      WHERE parent.appid = app.parent_appid
        AND parent.type = 'game'
        AND parent.is_playable = 1
        AND parent.is_eligible = 1
        AND parent.parent_appid IS NULL
    )
  )
) AND NOT EXISTS (
  SELECT 1
  FROM app_relationships AS relationship
  WHERE relationship.child_appid = app.appid
    AND relationship.relationship_type IN ('server', 'tool', 'demo', 'test', 'soundtrack')
)`;

export interface MediaGameMatch {
  dimension: MediaMatchDimension;
  similarity: number;
  matchedGame: { appid: number; name: string; slug: string };
}

type GameRow = {
  appid: number;
  name: string;
  slug: string;
};

type OverviewRow = {
  input_identity: string;
};

type VectorRow = {
  appid: number;
  dimension: string;
  input_identity: string;
  overview_input_identity: string;
  vector: unknown;
  name?: string;
  slug?: string;
};

type MatchPathRow = {
  appid: number;
  name: string;
  parent_appid: number | null;
  parent_name: string | null;
};

function decodeVector(value: unknown): Float32Array | null {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
  const byteLength = GEMINI_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
  if (!bytes || bytes.byteLength !== byteLength) return null;
  const aligned = bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0;
  const buffer = aligned ? bytes.buffer : bytes.slice().buffer;
  const offset = aligned ? bytes.byteOffset : 0;
  const decoded = new Float32Array(buffer, offset, GEMINI_EMBEDDING_DIMENSIONS);
  return decoded.every(Number.isFinite) ? decoded : null;
}

function cosine(left: Float32Array, right: Float32Array): number | null {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < GEMINI_EMBEDDING_DIMENSIONS; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return null;
  const similarity = dot / Math.sqrt(leftMagnitude * rightMagnitude);
  if (!Number.isFinite(similarity)) return null;
  return Math.max(-1, Math.min(1, similarity));
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MATCH_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(MAX_MATCH_LIMIT, Math.floor(limit));
}

export async function getMediaGameMatches(
  db: AppDatabase,
  appid: number,
  options: { limit?: number; includeUnpublished?: boolean } = {},
): Promise<MediaGameMatch[]> {
  if (!Number.isInteger(appid) || appid <= 0) return [];
  const publicEnabled = typeof process !== "undefined" && process.env?.MEDIA_OVERVIEW_PUBLIC === "true";
  if (!options.includeUnpublished && !publicEnabled) return [];
  const limit = normalizeLimit(options.limit);
  if (limit === 0) return [];

  const currentGame = await db.prepare(
    `SELECT app.appid, app.name, app.slug
     FROM apps AS app
     WHERE app.appid = ? AND app.is_eligible = 1
       AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
     LIMIT 1`,
  ).bind(appid).first<GameRow>();
  if (!currentGame) return [];
  const currentOverview = await db.prepare(
    `SELECT input_identity
     FROM media_game_overviews
     WHERE appid = ? AND active = 1
     ORDER BY id DESC
     LIMIT 1`,
  ).bind(appid).first<OverviewRow>();
  if (!currentOverview?.input_identity) return [];

  const currentResult = await db.prepare(
    `SELECT appid, dimension, input_identity, overview_input_identity, vector
     FROM media_game_embeddings
     WHERE appid = ? AND active = 1
       AND overview_input_identity = ? AND model = ? AND dimensions = ?
       AND config_version = ?
     ORDER BY id DESC`,
  ).bind(
    appid,
    currentOverview.input_identity,
    GEMINI_EMBEDDING_MODEL,
    GEMINI_EMBEDDING_DIMENSIONS,
    GEMINI_EMBEDDING_CONFIG_VERSION,
  ).all<VectorRow>();
  const currentRows = currentResult.results ?? [];
  const currentVectors = new Map<MediaMatchDimension, Float32Array>();
  for (const row of currentRows) {
    if (row.dimension !== "gameplay" && row.dimension !== "story_world") continue;
    const vector = decodeVector(row.vector);
    if (vector && !currentVectors.has(row.dimension)) currentVectors.set(row.dimension, vector);
  }
  if (currentVectors.size === 0) return [];

  const rankedByDimension = new Map<MediaMatchDimension, Array<{ similarity: number; game: GameRow }>>();
  let cursorDimension = "";
  let cursorAppid = 0;
  while (true) {
    const candidateResult = await db.prepare(
      `SELECT embedding.appid, embedding.dimension, embedding.input_identity,
              embedding.overview_input_identity, embedding.vector,
              app.name, app.slug
       FROM media_game_embeddings AS embedding
       JOIN apps AS app
         ON app.appid = embedding.appid
        AND app.is_eligible = 1
        AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
       JOIN media_game_overviews AS overview
         ON overview.appid = embedding.appid
        AND overview.active = 1
        AND overview.id = (
          SELECT latest.id
          FROM media_game_overviews AS latest
          WHERE latest.appid = embedding.appid AND latest.active = 1
          ORDER BY latest.id DESC
          LIMIT 1
        )
        AND overview.input_identity = embedding.overview_input_identity
       WHERE embedding.appid <> ? AND embedding.active = 1
         AND embedding.model = ? AND embedding.dimensions = ?
         AND embedding.config_version = ?
         AND embedding.dimension IN ('gameplay', 'story_world')
         AND (
           embedding.dimension > ?
           OR (embedding.dimension = ? AND embedding.appid > ?)
         )
       ORDER BY embedding.dimension, embedding.appid
       LIMIT ?`,
    ).bind(
      appid,
      GEMINI_EMBEDDING_MODEL,
      GEMINI_EMBEDDING_DIMENSIONS,
      GEMINI_EMBEDDING_CONFIG_VERSION,
      cursorDimension,
      cursorDimension,
      cursorAppid,
      CANDIDATE_BATCH_SIZE,
    ).all<VectorRow>();
    const candidateRows = candidateResult.results ?? [];
    for (const row of candidateRows) {
      if (row.dimension !== "gameplay" && row.dimension !== "story_world") continue;
      const target = currentVectors.get(row.dimension);
      if (!target || !row.name || !row.slug) continue;
      const vector = decodeVector(row.vector);
      const similarity = vector ? cosine(target, vector) : null;
      if (similarity === null) continue;
      const ranked = rankedByDimension.get(row.dimension) ?? [];
      ranked.push({
        similarity,
        game: { appid: row.appid, name: row.name, slug: row.slug },
      });
      ranked.sort((left, right) => right.similarity - left.similarity || left.game.appid - right.game.appid);
      if (ranked.length > limit) ranked.length = limit;
      rankedByDimension.set(row.dimension, ranked);
    }
    const last = candidateRows.at(-1);
    if (!last || candidateRows.length < CANDIDATE_BATCH_SIZE) break;
    cursorDimension = last.dimension;
    cursorAppid = last.appid;
  }

  const result: MediaGameMatch[] = [];
  for (const dimension of MEDIA_MATCH_DIMENSIONS) {
    for (const match of rankedByDimension.get(dimension) ?? []) {
      result.push({ dimension, similarity: match.similarity, matchedGame: match.game });
    }
  }
  return result;
}

export async function getMediaGameMatchPaths(
  db: AppDatabase,
  matches: readonly MediaGameMatch[],
): Promise<Record<number, string>> {
  const appids = [...new Set(
    matches
      .map((match) => match.matchedGame.appid)
      .filter((appid): appid is number => Number.isSafeInteger(appid) && appid > 0),
  )].slice(0, MAX_MATCH_PATHS);
  if (appids.length === 0) return {};

  const placeholders = appids.map(() => "?").join(", ");
  const result = await db.prepare(
    `SELECT app.appid, app.name, app.parent_appid, parent.name AS parent_name
     FROM apps AS app
     LEFT JOIN apps AS parent ON parent.appid = app.parent_appid
     WHERE app.appid IN (${placeholders})
       AND app.is_eligible = 1
       AND ${ELIGIBLE_MEDIA_ENTITY_SQL}`,
  ).bind(...appids).all<MatchPathRow>();

  const paths: Record<number, string> = {};
  for (const row of result.results ?? []) {
    if (!row.name) continue;
    if (row.parent_appid === null) {
      paths[row.appid] = getCanonicalGamePath(row.appid, row.name);
    } else if (row.parent_name) {
      paths[row.appid] = getCanonicalChildPath(row.parent_appid, row.parent_name, row.appid, row.name);
    }
  }
  return paths;
}

export const MEDIA_MATCH_EMBEDDING = {
  model: GEMINI_EMBEDDING_MODEL,
  dimensions: GEMINI_EMBEDDING_DIMENSIONS,
  configVersion: GEMINI_EMBEDDING_CONFIG_VERSION,
} as const;
