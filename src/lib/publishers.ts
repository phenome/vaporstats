import type { AppDatabase } from "./db";
import { toPublisherSlug, parsePublisherSlug, getCanonicalPublisherPath } from "./slug";

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
  name: string;
  slug: string;
  canonicalPath: string;
  isPublisher: boolean;
  isDeveloper: boolean;
  totalGames: number;
  games: PublisherGameItem[];
}

export interface PublisherSummary {
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
}

interface RawPublisherNameRow {
  entity_name: string;
}

interface RawPublisherSummaryRow {
  entity_name: string;
  is_publisher: number;
  is_developer: number;
  game_count: number;
}

const eligiblePublisherEntitiesSql =
  "SELECT appid, TRIM(publisher) AS entity_name, 1 AS is_publisher, 0 AS is_developer " +
  "FROM apps WHERE is_playable = 1 AND is_eligible = 1 AND parent_appid IS NULL AND TRIM(publisher) <> '' " +
  "UNION ALL " +
  "SELECT appid, TRIM(developer) AS entity_name, 0 AS is_publisher, 1 AS is_developer " +
  "FROM apps WHERE is_playable = 1 AND is_eligible = 1 AND parent_appid IS NULL AND TRIM(developer) <> ''";

/**
 * Retrieves games published or developed by the specified entity.
 * Accepts a name or a URL slug (with or without numeric id prefix).
 */
export async function getPublisherGames(
  db: AppDatabase,
  slugOrParam: string
): Promise<PublisherDetail | null> {
  const parsed = parsePublisherSlug(slugOrParam);
  if (!parsed || !parsed.slug) {
    return null;
  }

  const targetSlug = toPublisherSlug(parsed.slug);
  const namesResult = await db
    .prepare(
      "SELECT DISTINCT entity_name FROM (" + eligiblePublisherEntitiesSql + ") AS publisher_entities " +
        "ORDER BY entity_name ASC"
    )
    .all<RawPublisherNameRow>();
  const matchingNames = (namesResult.results ?? [])
    .map((row) => row.entity_name.trim())
    .filter((name, index, names) =>
      name !== "" && toPublisherSlug(name) === targetSlug && names.indexOf(name) === index
    );

  if (matchingNames.length === 0) {
    return null;
  }

  const placeholders = matchingNames.map(() => "?").join(", ");
  const stmt = db
    .prepare(
      "SELECT appid, name, slug, developer, publisher, release_date, release_status, header_image " +
        "FROM apps WHERE is_playable = 1 AND is_eligible = 1 AND parent_appid IS NULL " +
        "AND (TRIM(publisher) IN (" + placeholders + ") OR TRIM(developer) IN (" + placeholders + ")) " +
        "ORDER BY name ASC"
    )
    .bind(...matchingNames, ...matchingNames);
  const result = await stmt.all<RawAppPublisherRow>();
  const rows = result.results ?? [];

  const matchingGames: PublisherGameItem[] = [];
  let canonicalName = "";
  let isPublisher = false;
  let isDeveloper = false;

  for (const row of rows) {
    const pub = (row.publisher || "").trim();
    const dev = (row.developer || "").trim();
    const pubMatch = pub !== "" && toPublisherSlug(pub) === targetSlug;
    const devMatch = dev !== "" && toPublisherSlug(dev) === targetSlug;

    if (!pubMatch && !devMatch) continue;
    if (pubMatch) {
      isPublisher = true;
      if (!canonicalName) canonicalName = pub;
    }
    if (devMatch) {
      isDeveloper = true;
      if (!canonicalName) canonicalName = dev;
    }
    matchingGames.push({
      appid: row.appid,
      name: row.name,
      slug: row.slug,
      developer: row.developer || "",
      publisher: row.publisher || "",
      release_date: row.release_date,
      release_status: row.release_status || "released",
      header_image: row.header_image || "",
      isPublisher: pubMatch,
      isDeveloper: devMatch,
    });
  }

  if (matchingGames.length === 0 || !canonicalName) {
    return null;
  }

  return {
    name: canonicalName,
    slug: toPublisherSlug(canonicalName),
    canonicalPath: getCanonicalPublisherPath(canonicalName),
    isPublisher,
    isDeveloper,
    totalGames: matchingGames.length,
    games: matchingGames,
  };
}

/**
 * Lists all distinct publishers and developers across eligible playable games.
 * Returns sorted summaries with game counts and links.
 */
export async function listPublishers(db: AppDatabase): Promise<PublisherSummary[]> {
  const result = await db
    .prepare(
      "SELECT entity_name, MAX(is_publisher) AS is_publisher, MAX(is_developer) AS is_developer, " +
        "COUNT(DISTINCT appid) AS game_count FROM (" +
        eligiblePublisherEntitiesSql +
        ") AS publisher_entities GROUP BY entity_name ORDER BY entity_name ASC"
    )
    .all<RawPublisherSummaryRow>();

  const map = new Map<string, PublisherSummary>();
  for (const row of result.results ?? []) {
    const name = row.entity_name.trim();
    if (!name) continue;
    const slug = toPublisherSlug(name);
    const existing = map.get(slug);
    if (existing) {
      existing.isPublisher ||= row.is_publisher === 1;
      existing.isDeveloper ||= row.is_developer === 1;
      existing.gameCount += row.game_count;
      continue;
    }
    map.set(slug, {
      name,
      slug,
      path: getCanonicalPublisherPath(name),
      isPublisher: row.is_publisher === 1,
      isDeveloper: row.is_developer === 1,
      gameCount: row.game_count,
    });
  }

  return Array.from(map.values()).sort(
    (a, b) => b.gameCount - a.gameCount || a.name.localeCompare(b.name)
  );
}
