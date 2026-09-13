import type { AppDatabase } from "./db";
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const GEMINI_EMBEDDING_DIMENSIONS = 3072;
export const GEMINI_EMBEDDING_CONFIG_VERSION = "media-embedding-2026-09-13-v1";

export type MediaMatchDimension = "gameplay" | "story_world";

export interface MediaMatchCitation {
  originalUrl: string;
  title: string;
  outlet: string;
  type: string;
  handsOn: boolean | null;
  platform: string | null;
  buildContext: string | null;
}

export interface MediaGameMatch {
  dimension: MediaMatchDimension;
  trait: string;
  explanation: string;
  similarity: number;
  matchedGame: { appid: number; name: string; slug: string };
  currentSources: MediaMatchCitation[];
  matchedSources: MediaMatchCitation[];
}

type MatchRow = {
  id: number;
  appid: number;
  matched_appid: number;
  dimension: MediaMatchDimension;
  trait: string;
  explanation: string;
  similarity: number;
  current_source_ids: string;
  matched_source_ids: string;
  current_extraction_identities: string;
  matched_extraction_identities: string;
  current_vector_identities: string;
  matched_vector_identities: string;
};

type SourceRow = {
  id: number;
  appid: number;
  original_url: string;
  title: string;
  outlet: string;
  type: string;
  hands_on: number | null;
  platform: string | null;
  build_context: string | null;
  extraction_input_identity: string | null;
  vector_input_identity: string | null;
  vector: unknown;
};

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function rows<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(query).bind(...values).all<T>()).results ?? [];
}

function jsonStrings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

function jsonNumbers(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is number => Number.isInteger(item) && item > 0) : [];
  } catch {
    return [];
  }
}

function usableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
function usableVector(value: unknown): boolean {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
  if (!bytes || bytes.byteLength !== GEMINI_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) return false;
  return new Float32Array(bytes.slice().buffer).every(Number.isFinite);
}

async function currentSources(
  db: AppDatabase,
  appid: number,
  sourceIdsJson: string,
  extractionIdentitiesJson: string,
  vectorIdentitiesJson: string,
  dimension: MediaMatchDimension,
): Promise<MediaMatchCitation[]> {
  const ids = jsonNumbers(sourceIdsJson);
  const extractionIdentities = jsonStrings(extractionIdentitiesJson);
  const vectorIdentities = jsonStrings(vectorIdentitiesJson);
  if (ids.length === 0 || ids.length !== extractionIdentities.length || ids.length !== vectorIdentities.length) return [];
  const result: MediaMatchCitation[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const source = await first<SourceRow>(db, `SELECT source.id, source.appid, source.original_url, source.title, source.outlet, source.type, source.hands_on, source.platform, source.build_context,
      extraction.input_identity AS extraction_input_identity,
      embedding.input_identity AS vector_input_identity,
      embedding.vector
      FROM media_sources AS source
      JOIN media_article_extractions AS extraction ON extraction.source_id = source.id AND extraction.active = 1
      JOIN media_article_embeddings AS embedding ON embedding.source_id = source.id AND embedding.dimension = ? AND embedding.active = 1
      WHERE source.id = ? AND source.appid = ?
      ORDER BY embedding.id DESC LIMIT 1`, dimension, ids[index], appid);
    if (!source || !usableVector(source.vector) || source.extraction_input_identity !== extractionIdentities[index] || source.vector_input_identity !== vectorIdentities[index]) return [];
    if (!source.original_url || !source.title || !source.outlet || !usableUrl(source.original_url)) return [];
    result.push({
      originalUrl: source.original_url,
      title: source.title,
      outlet: source.outlet,
      type: source.type,
      handsOn: source.hands_on === null ? null : source.hands_on === 1,
      platform: source.platform,
      buildContext: source.build_context,
    });
  }
  return result;
}

export async function getMediaGameMatches(
  db: AppDatabase,
  appid: number,
  options: { includeUnpublished?: boolean } = {},
): Promise<MediaGameMatch[]> {
  if (!Number.isInteger(appid) || appid <= 0) return [];
  const publicEnabled = typeof process !== "undefined" && process.env?.MEDIA_OVERVIEW_PUBLIC === "true";
  if (!options.includeUnpublished && !publicEnabled) return [];
  const matches = await rows<MatchRow>(db, `SELECT id, appid, matched_appid, dimension, trait, explanation, similarity,
    current_source_ids, matched_source_ids, current_extraction_identities, matched_extraction_identities,
    current_vector_identities, matched_vector_identities
    FROM media_game_matches WHERE active = 1 AND (appid = ? OR matched_appid = ?) ORDER BY dimension, similarity DESC, id`, appid, appid);
  const result: MediaGameMatch[] = [];
  for (const match of matches) {
    if (!["gameplay", "story_world"].includes(match.dimension) || !match.trait.trim() || !match.explanation.trim() || !Number.isFinite(match.similarity)) continue;
    const leftSources = await currentSources(db, match.appid, match.current_source_ids, match.current_extraction_identities, match.current_vector_identities, match.dimension);
    const rightSources = await currentSources(db, match.matched_appid, match.matched_source_ids, match.matched_extraction_identities, match.matched_vector_identities, match.dimension);
    if (leftSources.length === 0 || rightSources.length === 0) continue;
    const game = await first<{ appid: number; name: string; slug: string }>(db, "SELECT appid, name, slug FROM apps WHERE appid = ? AND is_playable = 1", match.matched_appid);
    if (!game) continue;
    if (appid === match.appid) {
      result.push({ dimension: match.dimension, trait: match.trait, explanation: match.explanation, similarity: match.similarity, matchedGame: game, currentSources: leftSources, matchedSources: rightSources });
      continue;
    }
    const currentGame = await first<{ appid: number; name: string; slug: string }>(db, "SELECT appid, name, slug FROM apps WHERE appid = ? AND is_playable = 1", match.appid);
    if (!currentGame) continue;
    result.push({ dimension: match.dimension, trait: match.trait, explanation: match.explanation, similarity: match.similarity, matchedGame: currentGame, currentSources: rightSources, matchedSources: leftSources });
  }
  return result;
}

export const MEDIA_MATCH_EMBEDDING = {
  model: GEMINI_EMBEDDING_MODEL,
  dimensions: GEMINI_EMBEDDING_DIMENSIONS,
  configVersion: GEMINI_EMBEDDING_CONFIG_VERSION,
} as const;
