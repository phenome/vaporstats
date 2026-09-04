import type { D1Database } from "./db";
import { toSlug, parseGameSlug } from "./slug";
import type { CatalogEntity } from "./catalog";
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

/**
 * Persists a normalized relationship between parent game and child app.
 */
export async function upsertAppRelationship(
  db: D1Database,
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
  db: D1Database,
  parentAppId: number
): Promise<GroupedRelatedApps> {
  const tableCheck = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_relationships'")
    .first<{ name: string }>();

  let rows: RawRelatedRow[] = [];

  if (tableCheck) {
    const stmt = db
      .prepare(
        `SELECT a.*, r.relationship_type as rel_type, r.prominence
         FROM apps a
         LEFT JOIN app_relationships r ON a.appid = r.child_appid AND r.parent_appid = ?
         WHERE (a.parent_appid = ? OR r.parent_appid = ?)
           AND a.is_eligible = 1
         ORDER BY r.prominence DESC, a.release_date DESC, a.name ASC`
      )
      .bind(parentAppId, parentAppId, parentAppId);
    const res = await stmt.all<RawRelatedRow>();
    rows = res.results || [];
  } else {
    const stmt = db
      .prepare(
        `SELECT a.*, NULL as rel_type, 0 as prominence
         FROM apps a
         WHERE a.parent_appid = ?
           AND a.is_eligible = 1
         ORDER BY a.release_date DESC, a.name ASC`
      )
      .bind(parentAppId);
    const res = await stmt.all<RawRelatedRow>();
    rows = res.results || [];
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
  db: D1Database,
  parentAppId: number,
  childAppId: number
): Promise<{ parent: CatalogEntity; child: RelatedAppEntity } | null> {
  // 1. Authoritative parent must be an eligible playable root game
  const parentStmt = db
    .prepare(
      `SELECT * FROM apps 
       WHERE appid = ? 
         AND is_playable = 1 
         AND is_eligible = 1 
         AND parent_appid IS NULL`
    )
    .bind(parentAppId);
  const parentRow = await parentStmt.first<RawRelatedRow>();
  if (!parentRow) {
    return null;
  }

  // 2. Child app must exist, be eligible, and have relationship with parentAppId
  const tableCheck = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_relationships'")
    .first<{ name: string }>();

  let childRow: RawRelatedRow | null = null;

  if (tableCheck) {
    const childStmt = db
      .prepare(
        `SELECT a.*, r.relationship_type as rel_type, r.prominence
         FROM apps a
         LEFT JOIN app_relationships r ON a.appid = r.child_appid AND r.parent_appid = ?
         WHERE a.appid = ? 
           AND a.is_eligible = 1
           AND (a.parent_appid = ? OR r.parent_appid = ?)`
      )
      .bind(parentAppId, childAppId, parentAppId, parentAppId);
    childRow = await childStmt.first<RawRelatedRow>();
  } else {
    const childStmt = db
      .prepare(
        `SELECT a.*, NULL as rel_type, 0 as prominence
         FROM apps a
         WHERE a.appid = ? 
           AND a.is_eligible = 1
           AND a.parent_appid = ?`
      )
      .bind(childAppId, parentAppId);
    childRow = await childStmt.first<RawRelatedRow>();
  }

  if (!childRow) {
    return null;
  }

  const parent: CatalogEntity = {
    appid: parentRow.appid,
    name: parentRow.name,
    slug: parentRow.slug || toSlug(parentRow.name),
    type: parentRow.type,
    is_eligible: parentRow.is_eligible === 1,
    is_playable: parentRow.is_playable === 1,
    parent_appid: null,
    release_date: parentRow.release_date,
    release_status: (parentRow.release_status as CatalogEntity["release_status"]) || "released",
    description: parentRow.description || "",
    header_image: parentRow.header_image || "",
    developer: parentRow.developer || "",
    publisher: parentRow.publisher || "",
    created_at: parentRow.created_at,
    updated_at: parentRow.updated_at,
  };

  const child = mapRowToRelatedEntity(childRow);

  return { parent, child };
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
  db: D1Database,
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<SearchCatalogResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: trimmed, items: [], total: 0 };
  }

  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  const searchPattern = `%${trimmed.toLowerCase()}%`;
  const numericAppId = parseInt(trimmed, 10);
  const isNumeric = !isNaN(numericAppId) && numericAppId > 0;

  // 1. Find matching playable games
  let playableSql = `
    SELECT * FROM apps 
    WHERE is_playable = 1 
      AND is_eligible = 1 
      AND parent_appid IS NULL
      AND (LOWER(name) LIKE ? ${isNumeric ? "OR appid = ?" : ""})
    ORDER BY 
      CASE WHEN LOWER(name) = ? THEN 1
           WHEN LOWER(name) LIKE ? THEN 2
           ELSE 3 END,
      name ASC
    LIMIT ? OFFSET ?
  `;

  const bindings: unknown[] = [searchPattern];
  if (isNumeric) bindings.push(numericAppId);
  bindings.push(trimmed.toLowerCase(), `${trimmed.toLowerCase()}%`, limit, offset);

  const playableStmt = db.prepare(playableSql).bind(...bindings);
  const playableRes = await playableStmt.all<RawRelatedRow>();
  const playableRows = playableRes.results || [];

  // Map of parentAppId -> SearchItem
  const resultMap = new Map<number, SearchItem>();

  for (const row of playableRows) {
    const parentEntity: CatalogEntity = {
      appid: row.appid,
      name: row.name,
      slug: row.slug || toSlug(row.name),
      type: row.type,
      is_eligible: row.is_eligible === 1,
      is_playable: row.is_playable === 1,
      parent_appid: null,
      release_date: row.release_date,
      release_status: (row.release_status as CatalogEntity["release_status"]) || "released",
      description: row.description || "",
      header_image: row.header_image || "",
      developer: row.developer || "",
      publisher: row.publisher || "",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    resultMap.set(row.appid, {
      game: parentEntity,
      matching_related: [],
    });
  }

  // 2. Find matching related/accessory apps
  let accessorySql = `
    SELECT a.*, NULL as rel_type, 0 as prominence
    FROM apps a
    WHERE (a.is_playable = 0 OR a.parent_appid IS NOT NULL)
      AND a.is_eligible = 1
      AND (LOWER(a.name) LIKE ? ${isNumeric ? "OR a.appid = ?" : ""})
    LIMIT 50
  `;
  const accBindings: unknown[] = [searchPattern];
  if (isNumeric) accBindings.push(numericAppId);

  const accStmt = db.prepare(accessorySql).bind(...accBindings);
  const accRes = await accStmt.all<RawRelatedRow>();
  const accRows = accRes.results || [];

  for (const row of accRows) {
    if (!row.parent_appid) continue;
    const parentAppId = row.parent_appid;

    let searchItem = resultMap.get(parentAppId);
    if (!searchItem) {
      // Fetch parent game if not already in result map
      const parentRow = await db
        .prepare(
          `SELECT * FROM apps WHERE appid = ? AND is_playable = 1 AND is_eligible = 1 AND parent_appid IS NULL`
        )
        .bind(parentAppId)
        .first<RawRelatedRow>();

      if (!parentRow) continue; // Ineligible or accessory parent

      const parentEntity: CatalogEntity = {
        appid: parentRow.appid,
        name: parentRow.name,
        slug: parentRow.slug || toSlug(parentRow.name),
        type: parentRow.type,
        is_eligible: parentRow.is_eligible === 1,
        is_playable: parentRow.is_playable === 1,
        parent_appid: null,
        release_date: parentRow.release_date,
        release_status: (parentRow.release_status as CatalogEntity["release_status"]) || "released",
        description: parentRow.description || "",
        header_image: parentRow.header_image || "",
        developer: parentRow.developer || "",
        publisher: parentRow.publisher || "",
        created_at: parentRow.created_at,
        updated_at: parentRow.updated_at,
      };

      searchItem = {
        game: parentEntity,
        matching_related: [],
      };
      resultMap.set(parentAppId, searchItem);
    }

    const childEntity = mapRowToRelatedEntity(row);
    if (!searchItem.matching_related.some((r) => r.appid === childEntity.appid)) {
      searchItem.matching_related.push(childEntity);
    }
  }

  const items = Array.from(resultMap.values());
  return {
    query: trimmed,
    items,
    total: items.length,
  };
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
