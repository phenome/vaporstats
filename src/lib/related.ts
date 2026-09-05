import type { AppDatabase } from "./db";
import { toSlug, parseGameSlug } from "./slug";
import type { CatalogEntity, ReleaseDateSource } from "./catalog";
import { getLiveApiCacheHeaders, CACHE_POLICIES } from "./cache";

export type RelatedAppType =
  | "dlc"
  | "expansion"
  | "soundtrack"
  | "server"
  | "tool"
  | "demo"
  | "test"
  | "other";

export const RELATED_APP_TYPES: RelatedAppType[] = [
  "expansion",
  "dlc",
  "soundtrack",
  "server",
  "tool",
  "demo",
  "test",
  "other",
];

export function normalizeAppType(rawType: string): RelatedAppType {
  const t = rawType.toLowerCase().trim().replace(/[-_ ]+/g, "_");
  if (t === "expansion" || t === "major_expansion") return "expansion";
  if (t === "dlc" || t === "downloadable_content") return "dlc";
  if (t === "music" || t === "soundtrack") return "soundtrack";
  if (t === "server" || t === "dedicated_server" || t === "dedicatedserver") return "server";
  if (t === "tool") return "tool";
  if (t === "demo") return "demo";
  if (t === "beta" || t === "test" || t === "testing") return "test";
  return "other";
}

export function isAccessoryType(type: string): boolean {
  const norm = normalizeAppType(type);
  return norm !== "other" || type.toLowerCase() !== "game";
}

export interface RelatedAppEntity {
  appid: number;
  name: string;
  slug: string;
  type: RelatedAppType;
  raw_type: string;
  is_eligible: boolean;
  is_playable: boolean;
  parent_appid: number | null;
  release_date: string | null;
  release_status: "released" | "upcoming" | "unannounced";
  description: string;
  header_image: string;
  developer: string;
  publisher: string;
  prominence: number;
  created_at: string;
  updated_at: string;
}

export interface GroupedRelatedApps {
  parent_appid: number;
  expansions: RelatedAppEntity[];
  dlc: RelatedAppEntity[];
  soundtracks: RelatedAppEntity[];
  servers: RelatedAppEntity[];
  tools: RelatedAppEntity[];
  demos: RelatedAppEntity[];
  tests: RelatedAppEntity[];
  other: RelatedAppEntity[];
  total_count: number;
}

interface RawRelatedRow {
  appid: number;
  name: string;
  slug: string;
  type: string;
  is_eligible: number;
  is_playable: number;
  parent_appid: number | null;
  release_date: string | null;
  steam_release_date: string | null;
  original_release_date: string | null;
  original_steam_release_date: string | null;
  release_from_early_access_date: string | null;
  release_date_source: ReleaseDateSource;
  is_early_access: number | boolean | null;
  has_left_early_access: number | boolean | null;
  release_status: string;
  description: string;
  header_image: string;
  developer: string;
  publisher: string;
  prominence: number | null;
  rel_type: string | null;
  created_at: string;
  updated_at: string;
}

function mapRowToRelatedEntity(row: RawRelatedRow): RelatedAppEntity {
  const effectiveType = row.rel_type || row.type;
  const normalized = normalizeAppType(effectiveType);
  const isExpansion = normalized === "expansion" || (row.prominence ?? 0) > 0;

  return {
    appid: row.appid,
    name: row.name,
    slug: row.slug || toSlug(row.name),
    type: isExpansion ? "expansion" : normalized,
    raw_type: row.type,
    is_eligible: row.is_eligible === 1,
    is_playable: row.is_playable === 1,
    parent_appid: row.parent_appid,
    release_date: row.release_date,
    release_status: (row.release_status as RelatedAppEntity["release_status"]) || "released",
    description: row.description || "",
    header_image: row.header_image || "",
    developer: row.developer || "",
    publisher: row.publisher || "",
    prominence: isExpansion ? Math.max(row.prominence ?? 1, 1) : (row.prominence ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}


function mapRowToCatalogEntity(row: RawRelatedRow): CatalogEntity {
  return {
    appid: row.appid,
    name: row.name,
    slug: row.slug || toSlug(row.name),
    type: row.type,
    is_eligible: row.is_eligible === 1,
    is_playable: row.is_playable === 1,
    parent_appid: row.parent_appid,
    release_date: row.release_date ?? null,
    steam_release_date: row.steam_release_date ?? null,
    original_release_date: row.original_release_date ?? null,
    original_steam_release_date: row.original_steam_release_date ?? null,
    release_from_early_access_date: row.release_from_early_access_date ?? null,
    release_date_source: row.release_date_source ?? null,
    is_early_access:
      row.is_early_access == null
        ? null
        : typeof row.is_early_access === "boolean"
          ? row.is_early_access
          : row.is_early_access === 1,
    has_left_early_access:
      row.has_left_early_access == null
        ? null
        : typeof row.has_left_early_access === "boolean"
          ? row.has_left_early_access
          : row.has_left_early_access === 1,
    release_status: (row.release_status as CatalogEntity["release_status"]) || "released",
    description: row.description || "",
    header_image: row.header_image || "",
    developer: row.developer || "",
    publisher: row.publisher || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SEARCH_PARENT_COLUMNS = [
  "p.appid AS parent_search_appid",
  "p.name AS parent_search_name",
  "p.slug AS parent_search_slug",
  "p.type AS parent_search_type",
  "p.is_eligible AS parent_search_is_eligible",
  "p.is_playable AS parent_search_is_playable",
  "p.parent_appid AS parent_search_parent_appid",
  "p.release_date AS parent_search_release_date",
  "p.steam_release_date AS parent_search_steam_release_date",
  "p.original_release_date AS parent_search_original_release_date",
  "p.original_steam_release_date AS parent_search_original_steam_release_date",
  "p.release_from_early_access_date AS parent_search_release_from_early_access_date",
  "p.release_date_source AS parent_search_release_date_source",
  "p.is_early_access AS parent_search_is_early_access",
  "p.has_left_early_access AS parent_search_has_left_early_access",
  "p.release_status AS parent_search_release_status",
  "p.description AS parent_search_description",
  "p.header_image AS parent_search_header_image",
  "p.developer AS parent_search_developer",
  "p.publisher AS parent_search_publisher",
  "p.created_at AS parent_search_created_at",
  "p.updated_at AS parent_search_updated_at",
].join(", ");

/**
 * Persists a normalized relationship between parent game and child app.
 */
export async function upsertAppRelationship(
  db: AppDatabase,
  rel: {
    parent_appid: number;
    child_appid: number;
    relationship_type: string;
    prominence?: number;
  }
): Promise<void> {
  const normType = normalizeAppType(rel.relationship_type);
  const prominence = rel.prominence ?? (normType === "expansion" ? 1 : 0);

  // First check if app_relationships table exists
  const tableCheck = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_relationships'")
    .first<{ name: string }>();

  if (tableCheck) {
    const stmt = db
      .prepare(
        `INSERT INTO app_relationships (parent_appid, child_appid, relationship_type, prominence, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (parent_appid, child_appid) DO UPDATE SET
           relationship_type = excluded.relationship_type,
           prominence = excluded.prominence,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(rel.parent_appid, rel.child_appid, normType, prominence);
    await stmt.run();
  }

  // Ensure apps table also reflects parent_appid and type
  const appStmt = db
    .prepare(
      `UPDATE apps 
       SET parent_appid = ?,
           type = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE appid = ?`
    )
    .bind(rel.parent_appid, normType, rel.child_appid);
  await appStmt.run();
}

/**
 * Retrieves and groups all related apps for a parent game.
 * Promotes major expansions above standard DLC.
 */
export async function getRelatedApps(
  db: AppDatabase,
  parentAppId: number
): Promise<GroupedRelatedApps> {
  const tableCheck = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_relationships'")
    .first<{ name: string }>();

  let rows: RawRelatedRow[] = [];
  if (tableCheck) {
    // Keep each relationship source indexable: the direct-parent branch uses
    // idx_apps_parent and the relationship branch starts at the parent key.
    const stmt = db
      .prepare(
        "SELECT * FROM (" +
          "SELECT a.*, r.relationship_type AS rel_type, COALESCE(r.prominence, 0) AS prominence " +
          "FROM apps a LEFT JOIN app_relationships r " +
          "ON r.parent_appid = ? AND r.child_appid = a.appid " +
          "WHERE a.parent_appid = ? AND a.is_eligible = 1 " +
          "UNION ALL " +
          "SELECT a.*, r.relationship_type AS rel_type, r.prominence " +
          "FROM app_relationships r JOIN apps a ON a.appid = r.child_appid " +
          "WHERE r.parent_appid = ? AND a.is_eligible = 1 " +
          "AND NOT EXISTS (SELECT 1 FROM apps direct " +
          "WHERE direct.appid = a.appid AND direct.parent_appid = ?)" +
          ") AS related ORDER BY prominence DESC, release_date DESC, name ASC"
      )
      .bind(parentAppId, parentAppId, parentAppId, parentAppId);
    const res = await stmt.all<RawRelatedRow>();
    rows = res.results ?? [];
  } else {
    const stmt = db
      .prepare(
        "SELECT a.*, NULL AS rel_type, 0 AS prominence FROM apps a " +
          "WHERE a.parent_appid = ? AND a.is_eligible = 1 " +
          "ORDER BY a.release_date DESC, a.name ASC"
      )
      .bind(parentAppId);
    const res = await stmt.all<RawRelatedRow>();
    rows = res.results ?? [];
  }

  const grouped: GroupedRelatedApps = {
    parent_appid: parentAppId,
    expansions: [],
    dlc: [],
    soundtracks: [],
    servers: [],
    tools: [],
    demos: [],
    tests: [],
    other: [],
    total_count: 0,
  };

  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.appid)) continue;
    seen.add(row.appid);

    const entity = mapRowToRelatedEntity(row);
    grouped.total_count++;
    switch (entity.type) {
      case "expansion":
        grouped.expansions.push(entity);
        break;
      case "dlc":
        grouped.dlc.push(entity);
        break;
      case "soundtrack":
        grouped.soundtracks.push(entity);
        break;
      case "server":
        grouped.servers.push(entity);
        break;
      case "tool":
        grouped.tools.push(entity);
        break;
      case "demo":
        grouped.demos.push(entity);
        break;
      case "test":
        grouped.tests.push(entity);
        break;
      default:
        grouped.other.push(entity);
        break;
    }
  }

  return grouped;
}

/**
 * Retrieves a subordinate child app under an authoritative parent.
 * Rejects mismatched parent-child pairs or ineligible apps (returns null -> 404).
 */
export async function getChildApp(
  db: AppDatabase,
  parentAppId: number,
  childAppId: number
): Promise<{ parent: CatalogEntity; child: RelatedAppEntity } | null> {
  const parentRow = await db
    .prepare(
      "SELECT * FROM apps WHERE appid = ? AND is_playable = 1 AND is_eligible = 1 " +
        "AND parent_appid IS NULL"
    )
    .bind(parentAppId)
    .first<RawRelatedRow>();
  if (!parentRow) return null;

  const tableCheck = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_relationships'")
    .first<{ name: string }>();

  let childRow: RawRelatedRow | null = null;
  if (tableCheck) {
    const childStmt = db
      .prepare(
        "SELECT * FROM (" +
          "SELECT a.*, r.relationship_type AS rel_type, COALESCE(r.prominence, 0) AS prominence " +
          "FROM apps a LEFT JOIN app_relationships r " +
          "ON r.parent_appid = ? AND r.child_appid = a.appid " +
          "WHERE a.appid = ? AND a.parent_appid = ? AND a.is_eligible = 1 " +
          "UNION ALL " +
          "SELECT a.*, r.relationship_type AS rel_type, r.prominence " +
          "FROM app_relationships r JOIN apps a ON a.appid = r.child_appid " +
          "WHERE r.parent_appid = ? AND r.child_appid = ? AND a.is_eligible = 1 " +
          "AND NOT EXISTS (SELECT 1 FROM apps direct " +
          "WHERE direct.appid = a.appid AND direct.parent_appid = ?)" +
          ") AS child LIMIT 1"
      )
      .bind(parentAppId, childAppId, parentAppId, parentAppId, childAppId, parentAppId);
    childRow = await childStmt.first<RawRelatedRow>();
  } else {
    childRow = await db
      .prepare(
        "SELECT a.*, NULL AS rel_type, 0 AS prominence FROM apps a " +
          "WHERE a.appid = ? AND a.is_eligible = 1 AND a.parent_appid = ?"
      )
      .bind(childAppId, parentAppId)
      .first<RawRelatedRow>();
  }

  if (!childRow) return null;
  return {
    parent: mapRowToCatalogEntity(parentRow),
    child: mapRowToRelatedEntity(childRow),
  };
}

export function getCanonicalChildPath(
  parentAppId: number,
  parentName: string,
  childAppId: number,
  childName: string
): string {
  const pSlug = toSlug(parentName);
  const cSlug = toSlug(childName);
  return `/games/${parentAppId}-${pSlug}/${childAppId}-${cSlug}`;
}

export function parseChildSlug(
  parentParam: string,
  childParam: string
): { parentAppId: number; parentSlug: string; childAppId: number; childSlug: string } | null {
  const p = parseGameSlug(parentParam);
  const c = parseGameSlug(childParam);
  if (!p || !c) return null;
  return {
    parentAppId: p.appid,
    parentSlug: p.slug,
    childAppId: c.appid,
    childSlug: c.slug,
  };
}

export interface SearchItem {
  game: CatalogEntity;
  matching_related: RelatedAppEntity[];
}

export interface SearchCatalogResult {
  query: string;
  items: SearchItem[];
  total: number;
}

/**
 * Playable-first search.
 * Playable root games rank first.
 * Matching accessory apps are grouped underneath their respective parent games,
 * never presented as top-level peers.
 */
export async function searchCatalog(
  db: AppDatabase,
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<SearchCatalogResult> {
  const trimmed = query.trim();
  if (!trimmed) return { query: trimmed, items: [], total: 0 };

  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  const searchPattern = "%" + trimmed.toLowerCase() + "%";
  const numericAppId = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
  const isNumeric = numericAppId > 0;

  const playableStmt = isNumeric
    ? db
        .prepare(
          "SELECT * FROM apps WHERE appid = ? AND is_playable = 1 " +
            "AND is_eligible = 1 AND parent_appid IS NULL LIMIT ? OFFSET ?"
        )
        .bind(numericAppId, limit, offset)
    : db
        .prepare(
          "SELECT * FROM apps WHERE is_playable = 1 AND is_eligible = 1 " +
            "AND parent_appid IS NULL AND LOWER(name) LIKE ? " +
            "ORDER BY CASE WHEN LOWER(name) = ? THEN 1 " +
            "WHEN LOWER(name) LIKE ? THEN 2 ELSE 3 END, name ASC LIMIT ? OFFSET ?"
        )
        .bind(searchPattern, trimmed.toLowerCase(), trimmed.toLowerCase() + "%", limit, offset);
  const playableRes = await playableStmt.all<RawRelatedRow>();

  const resultMap = new Map<number, SearchItem>();
  for (const row of playableRes.results ?? []) {
    resultMap.set(row.appid, { game: mapRowToCatalogEntity(row), matching_related: [] });
  }

  type RawSearchRelatedRow = RawRelatedRow & {
    parent_search_appid: number;
    parent_search_name: string;
    parent_search_slug: string;
    parent_search_type: string;
    parent_search_is_eligible: number;
    parent_search_is_playable: number;
    parent_search_parent_appid: number | null;
    parent_search_release_date: string | null;
    parent_search_steam_release_date: string | null;
    parent_search_original_release_date: string | null;
    parent_search_original_steam_release_date: string | null;
    parent_search_release_from_early_access_date: string | null;
    parent_search_release_date_source: ReleaseDateSource;
    parent_search_is_early_access: number | boolean | null;
    parent_search_has_left_early_access: number | boolean | null;
    parent_search_release_status: string;
    parent_search_description: string;
    parent_search_header_image: string;
    parent_search_developer: string;
    parent_search_publisher: string;
    parent_search_created_at: string;
    parent_search_updated_at: string;
  };
  const accessoryStmt = db
    .prepare(
      "SELECT a.*, NULL AS rel_type, 0 AS prominence, " + SEARCH_PARENT_COLUMNS + " " +
        "FROM apps a JOIN apps p ON p.appid = a.parent_appid " +
        "AND p.is_playable = 1 AND p.is_eligible = 1 AND p.parent_appid IS NULL " +
        "WHERE a.parent_appid IS NOT NULL AND a.is_eligible = 1 AND " +
        (isNumeric ? "a.appid = ?" : "LOWER(a.name) LIKE ?") +
        " LIMIT 50"
    )
    .bind(isNumeric ? numericAppId : searchPattern);
  const accRes = await accessoryStmt.all<RawSearchRelatedRow>();

  for (const row of accRes.results ?? []) {
    const parentAppId = row.parent_search_appid;
    let searchItem = resultMap.get(parentAppId);
    if (!searchItem) {
      const parentRow: RawRelatedRow = {
        appid: row.parent_search_appid,
        name: row.parent_search_name,
        slug: row.parent_search_slug,
        type: row.parent_search_type,
        is_eligible: row.parent_search_is_eligible,
        is_playable: row.parent_search_is_playable,
        parent_appid: row.parent_search_parent_appid,
        release_date: row.parent_search_release_date,
        steam_release_date: row.parent_search_steam_release_date,
        original_release_date: row.parent_search_original_release_date,
        original_steam_release_date: row.parent_search_original_steam_release_date,
        release_from_early_access_date: row.parent_search_release_from_early_access_date,
        release_date_source: row.parent_search_release_date_source,
        is_early_access: row.parent_search_is_early_access,
        release_status: row.parent_search_release_status,
        has_left_early_access: row.parent_search_has_left_early_access,
        description: row.parent_search_description,
        header_image: row.parent_search_header_image,
        developer: row.parent_search_developer,
        publisher: row.parent_search_publisher,
        prominence: null,
        rel_type: null,
        created_at: row.parent_search_created_at,
        updated_at: row.parent_search_updated_at,
      };
      searchItem = { game: mapRowToCatalogEntity(parentRow), matching_related: [] };
      resultMap.set(parentAppId, searchItem);
    }

    const childEntity = mapRowToRelatedEntity(row);
    if (!searchItem.matching_related.some((related) => related.appid === childEntity.appid)) {
      searchItem.matching_related.push(childEntity);
    }
  }

  const items = Array.from(resultMap.values());
  return { query: trimmed, items, total: items.length };
}

export type ApiResponse<T> =
  | { status: "data"; data: T; source_timestamp: string }
  | { status: "empty"; data: T | null; message: string; source_timestamp: string }
  | { status: "error"; error: string; source_timestamp: string };

export function createApiDataResponse<T>(data: T, sourceTimestamp?: string): Response {
  const body: ApiResponse<T> = {
    status: "data",
    data,
    source_timestamp: sourceTimestamp || new Date().toISOString(),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...getLiveApiCacheHeaders(),
    },
  });
}

export function createApiEmptyResponse(message = "No data yet", sourceTimestamp?: string): Response {
  const body: ApiResponse<null> = {
    status: "empty",
    data: null,
    message,
    source_timestamp: sourceTimestamp || new Date().toISOString(),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...getLiveApiCacheHeaders(),
    },
  });
}

export function createApiErrorResponse(error: string, status = 500): Response {
  const body: ApiResponse<null> = {
    status: "error",
    error,
    source_timestamp: new Date().toISOString(),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": CACHE_POLICIES.noStore,
    },
  });
}
