import type { AppDatabase } from "./db";
import { toPublisherSlug, toPublisherUnicodeSlug, parsePublisherSlug, getCanonicalPublisherPath } from "./slug";

export interface PublisherGameItem {
  appid: number;
  name: string;
  slug: string;
  developer: string;
  publisher: string;
  release_date: string | null;
  release_status: string;
  header_image: string;
  isPublisher: boolean;
  isDeveloper: boolean;
}

export interface PublisherDetail {
  id: number;
  name: string;
  slug: string;
  canonicalPath: string;
  isPublisher: boolean;
  isDeveloper: boolean;
  totalGames: number;
  games: PublisherGameItem[];
}

export interface PublisherSummary {
  id: number;
  name: string;
  slug: string;
  path: string;
  isPublisher: boolean;
  isDeveloper: boolean;
  gameCount: number;
}

interface RawAppPublisherRow {
  appid: number;
  name: string;
  slug: string;
  developer: string;
  publisher: string;
  release_date: string | null;
  release_status: string;
  header_image: string;
  is_publisher: number;
  is_developer: number;
}

interface RawPublisherSummaryRow {
  id: number;
  display_name: string;
  is_publisher: number;
  is_developer: number;
  game_count: number;
}

const eligibleAppsSql =
  "JOIN apps a ON a.appid = ac.appid " +
  "WHERE a.is_playable = 1 AND a.is_eligible = 1 AND a.parent_appid IS NULL";

/**
 * Resolves IDs directly, marked exact names through aliases, and old ASCII
 * slugs only when every matching alias belongs to the same creator.
 */
export async function getPublisherGames(
  db: AppDatabase,
  param: string
): Promise<PublisherDetail | null> {
  const parsed = parsePublisherSlug(param);
  if (!parsed) return null;
  let creatorId = parsed.id;

  if (!creatorId) {
    if (parsed.exactName || toPublisherSlug(parsed.slug) !== parsed.slug) {
      const name = parsed.exactName || parsed.slug;
      const alias = await db.prepare("SELECT creator_id FROM creator_aliases WHERE name = ?")
        .bind(name).first<{ creator_id: number }>();
      creatorId = alias?.creator_id;
      if (!creatorId) return null;
    } else {
      const aliases = await db.prepare("SELECT name, creator_id FROM creator_aliases")
        .all<{ name: string; creator_id: number }>();
      let matchedId: number | undefined;
      for (const row of aliases.results ?? []) {
        if (toPublisherSlug(row.name) !== parsed.slug) continue;
        if (matchedId !== undefined && matchedId !== row.creator_id) return null;
        matchedId = row.creator_id;
      }
      if (matchedId === undefined) return null;
      creatorId = matchedId;
    }
  }
  const creator = await db.prepare("SELECT id, display_name FROM creators WHERE id = ?")
    .bind(creatorId).first<{ id: number; display_name: string }>();
  if (!creator) return null;

  const result = await db.prepare(
    "SELECT a.appid, a.name, a.slug, a.developer, a.publisher, a.release_date, " +
      "a.release_status, a.header_image, " +
      "MAX(ac.role = 'publisher') AS is_publisher, MAX(ac.role = 'developer') AS is_developer " +
      "FROM app_creators ac " + eligibleAppsSql +
      " AND ac.creator_id = ? GROUP BY a.appid " +
      "ORDER BY a.name COLLATE NOCASE, a.name, a.appid"
  ).bind(creator.id).all<RawAppPublisherRow>();
  const games: PublisherGameItem[] = [];
  let isPublisher = false;
  let isDeveloper = false;
  for (const row of result.results ?? []) {
    const published = row.is_publisher === 1;
    const developed = row.is_developer === 1;
    isPublisher ||= published;
    isDeveloper ||= developed;
    games.push({
      appid: row.appid,
      name: row.name,
      slug: row.slug,
      developer: row.developer || "",
      publisher: row.publisher || "",
      release_date: row.release_date,
      release_status: row.release_status || "released",
      header_image: row.header_image || "",
      isPublisher: published,
      isDeveloper: developed,
    });
  }
  if (games.length === 0) return null;

  return {
    id: creator.id,
    name: creator.display_name,
    slug: toPublisherUnicodeSlug(creator.display_name),
    canonicalPath: getCanonicalPublisherPath(creator.display_name, creator.id),
    isPublisher,
    isDeveloper,
    totalGames: games.length,
    games,
  };
}

/** Lists eligible creators by distinct game count, with only the requested page materialized. */
export async function listPublishers(
  db: AppDatabase,
  page: number,
  pageSize: number
): Promise<{ publishers: PublisherSummary[]; total: number }> {
  const count = await db.prepare(
    "SELECT COUNT(DISTINCT ac.creator_id) AS total FROM app_creators ac " + eligibleAppsSql
  ).first<{ total: number }>();
  const total = count?.total ?? 0;
  if (!Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 ||
      page > Math.ceil(total / pageSize)) {
    return { publishers: [], total };
  }

  const result = await db.prepare(
    "SELECT c.id, c.display_name, MAX(ac.role = 'publisher') AS is_publisher, " +
      "MAX(ac.role = 'developer') AS is_developer, COUNT(DISTINCT ac.appid) AS game_count " +
      "FROM app_creators ac JOIN creators c ON c.id = ac.creator_id " + eligibleAppsSql +
      " GROUP BY c.id " +
      "ORDER BY game_count DESC, c.display_name COLLATE NOCASE, c.display_name, c.id " +
      "LIMIT ? OFFSET ?"
  ).bind(pageSize, (page - 1) * pageSize).all<RawPublisherSummaryRow>();

  return {
    publishers: (result.results ?? []).map((row) => ({
      id: row.id,
      name: row.display_name,
      slug: toPublisherUnicodeSlug(row.display_name),
      path: getCanonicalPublisherPath(row.display_name, row.id),
      isPublisher: row.is_publisher === 1,
      isDeveloper: row.is_developer === 1,
      gameCount: row.game_count,
    })),
    total,
  };
}
