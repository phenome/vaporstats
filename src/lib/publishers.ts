import type { D1Database } from "./db";
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

/**
 * Retrieves games published or developed by the specified entity.
 * Accepts a name or a URL slug (with or without numeric id prefix).
 */
export async function getPublisherGames(
  db: D1Database,
  slugOrParam: string
): Promise<PublisherDetail | null> {
  const parsed = parsePublisherSlug(slugOrParam);
  if (!parsed || !parsed.slug) {
    return null;
  }

  const targetSlug = toPublisherSlug(parsed.slug);

  const stmt = db.prepare(
    `SELECT appid, name, slug, developer, publisher, release_date, release_status, header_image
     FROM apps
     WHERE is_playable = 1 
       AND is_eligible = 1 
       AND parent_appid IS NULL
     ORDER BY name ASC`
  );

  const result = await stmt.all<RawAppPublisherRow>();
  const rows = result.results || [];

  const matchingGames: PublisherGameItem[] = [];
  let canonicalName = "";
  let isPublisher = false;
  let isDeveloper = false;

  for (const row of rows) {
    const pub = (row.publisher || "").trim();
    const dev = (row.developer || "").trim();

    const pubMatch = pub !== "" && toPublisherSlug(pub) === targetSlug;
    const devMatch = dev !== "" && toPublisherSlug(dev) === targetSlug;

    if (pubMatch || devMatch) {
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
  }

  if (matchingGames.length === 0 || !canonicalName) {
    return null;
  }

  const canonicalSlug = toPublisherSlug(canonicalName);

  return {
    name: canonicalName,
    slug: canonicalSlug,
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
export async function listPublishers(db: D1Database): Promise<PublisherSummary[]> {
  const stmt = db.prepare(
    `SELECT appid, name, slug, developer, publisher
     FROM apps
     WHERE is_playable = 1 
       AND is_eligible = 1 
       AND parent_appid IS NULL`
  );

  const result = await stmt.all<RawAppPublisherRow>();
  const rows = result.results || [];

  const map = new Map<
    string,
    {
      name: string;
      slug: string;
      isPublisher: boolean;
      isDeveloper: boolean;
      appids: Set<number>;
    }
  >();

  for (const row of rows) {
    const pub = (row.publisher || "").trim();
    const dev = (row.developer || "").trim();

    if (pub) {
      const slug = toPublisherSlug(pub);
      const existing = map.get(slug) || {
        name: pub,
        slug,
        isPublisher: false,
        isDeveloper: false,
        appids: new Set<number>(),
      };
      existing.isPublisher = true;
      existing.appids.add(row.appid);
      map.set(slug, existing);
    }

    if (dev) {
      const slug = toPublisherSlug(dev);
      const existing = map.get(slug) || {
        name: dev,
        slug,
        isPublisher: false,
        isDeveloper: false,
        appids: new Set<number>(),
      };
      existing.isDeveloper = true;
      existing.appids.add(row.appid);
      map.set(slug, existing);
    }
  }

  const summaries: PublisherSummary[] = [];
  for (const entry of map.values()) {
    summaries.push({
      name: entry.name,
      slug: entry.slug,
      path: getCanonicalPublisherPath(entry.name),
      isPublisher: entry.isPublisher,
      isDeveloper: entry.isDeveloper,
      gameCount: entry.appids.size,
    });
  }

  return summaries.sort((a, b) => b.gameCount - a.gameCount || a.name.localeCompare(b.name));
}
