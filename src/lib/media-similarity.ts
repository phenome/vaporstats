import type { AppDatabase } from "./db";
import { decodeVector, GEMINI_EMBEDDING_DIMENSIONS } from "./media-embedding-vector";
import {
  type CommunityTagMembership,
  gameplayTagScore,
  gameplayTagVector,
  meetsGameplayMatchBar,
  sharedGameplayTagLabels,
} from "./media-gameplay-tags";
import { isMediaOverviewPublic, PUBLIC_MEDIA_ROOT_SQL } from "./media-publication";
import { getCanonicalChildPath } from "./related";
import { getCanonicalGamePath } from "./slug";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export { GEMINI_EMBEDDING_DIMENSIONS } from "./media-embedding-vector";
export const GEMINI_EMBEDDING_CONFIG_VERSION = "media-embedding-2026-09-13-v1";

export type MediaMatchDimension = "gameplay" | "story_world";
const MEDIA_MATCH_DIMENSIONS: readonly MediaMatchDimension[] = ["gameplay", "story_world"];
const DEFAULT_MATCH_LIMIT = 3;
const MAX_MATCH_LIMIT = 100;
const MAX_MATCH_PATHS = MAX_MATCH_LIMIT * MEDIA_MATCH_DIMENSIONS.length;
const CANDIDATE_BATCH_SIZE = 128;
const MEDIA_ROOT_SQL = "app.type = 'game' AND app.is_playable = 1 AND app.parent_appid IS NULL";
const notMediaAccessorySql = (alias: "app" | "parent") => `NOT EXISTS (
  SELECT 1
  FROM app_relationships AS relationship
  WHERE relationship.child_appid = ${alias}.appid
    AND relationship.relationship_type IN ('server', 'tool', 'demo', 'test', 'soundtrack')
)`;
export const ELIGIBLE_MEDIA_ROOT_SQL = `app.is_eligible = 1 AND ${MEDIA_ROOT_SQL} AND ${notMediaAccessorySql("app")}`;
export const ELIGIBLE_MEDIA_ENTITY_SQL = `(
  (${MEDIA_ROOT_SQL})
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
        AND ${notMediaAccessorySql("parent")}
    )
  )
) AND ${notMediaAccessorySql("app")}`;

export interface MediaGameMatch {
  dimension: MediaMatchDimension;
  /** Gameplay: the gameplay tag score. Story & world: the embedding cosine. */
  similarity: number;
  matchedGame: { appid: number; name: string; slug: string };
  /** Gameplay matches only: tags both games share, strongest first. */
  sharedTags?: string[];
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
  if (!options.includeUnpublished && !isMediaOverviewPublic()) return [];
  const publicScope = options.includeUnpublished ? "" : `AND ${PUBLIC_MEDIA_ROOT_SQL}`;
  const limit = normalizeLimit(options.limit);
  if (limit === 0) return [];

  const currentGame = await db.prepare(
    `SELECT app.appid, app.name, app.slug
     FROM apps AS app
     WHERE app.appid = ? AND app.is_eligible = 1
       AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
       ${publicScope}
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

  const gameplay = await rankGameplayMatches(db, appid, publicScope, limit);
  const story = await rankStoryWorldMatches(db, appid, currentOverview.input_identity, publicScope, limit);
  return [...gameplay, ...story];
}

/**
 * Gameplay & systems: the overlap of the two games' gameplay tags (ADR 0023). Candidates
 * pass the same eligibility and publication rules as the current game and have an active
 * Overview; they need no embedding. Only candidates that reach the bar are listed.
 */
async function rankGameplayMatches(
  db: AppDatabase,
  appid: number,
  publicScope: string,
  limit: number,
): Promise<MediaGameMatch[]> {
  const currentResult = await db.prepare(
    `SELECT membership.source_id, membership.weight, facet.name
     FROM app_facet_memberships AS membership
     LEFT JOIN app_facets AS facet
       ON facet.facet_group = membership.facet_group
      AND facet.source_id = membership.source_id
     WHERE membership.appid = ? AND membership.facet_group = 'community_tag'
     ORDER BY membership.source_order, membership.source_id`,
  ).bind(appid).all<{ source_id: string; weight: number | null; name: string | null }>();
  const currentRows = currentResult.results ?? [];
  const currentVector = gameplayTagVector(
    currentRows.map((row) => ({ sourceId: row.source_id, weight: row.weight })),
  );
  if (currentVector.size === 0) return [];
  const names = new Map(currentRows.map((row) => [row.source_id, row.name]));

  const ranked: Array<{ similarity: number; game: GameRow; sharedTags: string[] }> = [];
  let cursorAppid = 0;
  while (true) {
    const candidateResult = await db.prepare(
      `SELECT app.appid, app.name, app.slug
       FROM apps AS app
       WHERE app.appid <> ? AND app.appid > ?
         AND app.is_eligible = 1
         AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
         ${publicScope}
         AND EXISTS (
           SELECT 1
           FROM media_game_overviews AS overview
           WHERE overview.appid = app.appid AND overview.active = 1
         )
       ORDER BY app.appid
       LIMIT ?`,
    ).bind(appid, cursorAppid, CANDIDATE_BATCH_SIZE).all<GameRow>();
    const candidates = candidateResult.results ?? [];
    if (candidates.length > 0) {
      const placeholders = candidates.map(() => "?").join(", ");
      const membershipResult = await db.prepare(
        `SELECT appid, source_id, weight
         FROM app_facet_memberships
         WHERE facet_group = 'community_tag' AND appid IN (${placeholders})`,
      ).bind(...candidates.map((candidate) => candidate.appid))
        .all<{ appid: number; source_id: string; weight: number | null }>();
      const membershipsByApp = new Map<number, CommunityTagMembership[]>();
      for (const row of membershipResult.results ?? []) {
        const memberships = membershipsByApp.get(row.appid) ?? [];
        memberships.push({ sourceId: row.source_id, weight: row.weight });
        membershipsByApp.set(row.appid, memberships);
      }
      for (const candidate of candidates) {
        if (!candidate.name || !candidate.slug) continue;
        const vector = gameplayTagVector(membershipsByApp.get(candidate.appid) ?? []);
        if (vector.size === 0) continue;
        const similarity = gameplayTagScore(currentVector, vector);
        if (!meetsGameplayMatchBar(similarity)) continue;
        ranked.push({
          similarity,
          game: { appid: candidate.appid, name: candidate.name, slug: candidate.slug },
          sharedTags: sharedGameplayTagLabels(currentVector, vector, (id) => names.get(id)),
        });
        ranked.sort((left, right) => right.similarity - left.similarity || left.game.appid - right.game.appid);
        if (ranked.length > limit) ranked.length = limit;
      }
    }
    const last = candidates.at(-1);
    if (!last || candidates.length < CANDIDATE_BATCH_SIZE) break;
    cursorAppid = last.appid;
  }
  return ranked.map((match) => ({
    dimension: "gameplay",
    similarity: match.similarity,
    matchedGame: match.game,
    sharedTags: match.sharedTags,
  }));
}

/** Story & world: the cosine of the current story/world embeddings tied to each game's current Overview. */
async function rankStoryWorldMatches(
  db: AppDatabase,
  appid: number,
  overviewInputIdentity: string,
  publicScope: string,
  limit: number,
): Promise<MediaGameMatch[]> {
  const currentResult = await db.prepare(
    `SELECT appid, dimension, input_identity, overview_input_identity, vector
     FROM media_game_embeddings
     WHERE appid = ? AND active = 1 AND dimension = 'story_world'
       AND overview_input_identity = ? AND model = ? AND dimensions = ?
       AND config_version = ?
     ORDER BY id DESC`,
  ).bind(
    appid,
    overviewInputIdentity,
    GEMINI_EMBEDDING_MODEL,
    GEMINI_EMBEDDING_DIMENSIONS,
    GEMINI_EMBEDDING_CONFIG_VERSION,
  ).all<VectorRow>();
  let target: Float32Array | null = null;
  for (const row of currentResult.results ?? []) {
    target = decodeVector(row.vector);
    if (target) break;
  }
  if (!target) return [];

  const ranked: Array<{ similarity: number; game: GameRow }> = [];
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
        ${publicScope}
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
         AND embedding.dimension = 'story_world'
         AND embedding.appid > ?
       ORDER BY embedding.appid
       LIMIT ?`,
    ).bind(
      appid,
      GEMINI_EMBEDDING_MODEL,
      GEMINI_EMBEDDING_DIMENSIONS,
      GEMINI_EMBEDDING_CONFIG_VERSION,
      cursorAppid,
      CANDIDATE_BATCH_SIZE,
    ).all<VectorRow>();
    const candidateRows = candidateResult.results ?? [];
    for (const row of candidateRows) {
      if (!row.name || !row.slug) continue;
      const vector = decodeVector(row.vector);
      const similarity = vector ? cosine(target, vector) : null;
      if (similarity === null) continue;
      ranked.push({
        similarity,
        game: { appid: row.appid, name: row.name, slug: row.slug },
      });
      ranked.sort((left, right) => right.similarity - left.similarity || left.game.appid - right.game.appid);
      if (ranked.length > limit) ranked.length = limit;
    }
    const last = candidateRows.at(-1);
    if (!last || candidateRows.length < CANDIDATE_BATCH_SIZE) break;
    cursorAppid = last.appid;
  }
  return ranked.map((match) => ({ dimension: "story_world", similarity: match.similarity, matchedGame: match.game }));
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
