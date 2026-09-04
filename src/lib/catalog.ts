import type { D1Database } from "./db";
import { toSlug } from "./slug";

export interface CatalogEntity {
  appid: number;
  name: string;
  slug: string;
  type: string;
  is_eligible: boolean;
  is_playable: boolean;
  parent_appid: number | null;
  release_date: string | null;
  release_status: "released" | "upcoming" | "unannounced";
  description: string;
  header_image: string;
  developer: string;
  publisher: string;
  created_at: string;
  updated_at: string;
}

export interface GameDetail extends CatalogEntity {
  /**
   * Latest observed player count.
   * `null` denotes an unobserved game ("No data yet").
   * `0` denotes an observed player count of zero.
   */
  latest_players: number | null;
  peak_players: number | null;
  last_observed_at: string | null;
}

interface RawAppRow {
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
  created_at: string;
  updated_at: string;
}

function mapRowToEntity(row: RawAppRow): CatalogEntity {
  return {
    appid: row.appid,
    name: row.name,
    slug: row.slug,
    type: row.type,
    is_eligible: row.is_eligible === 1,
    is_playable: row.is_playable === 1,
    parent_appid: row.parent_appid,
    release_date: row.release_date,
    release_status: (row.release_status as CatalogEntity["release_status"]) || "released",
    description: row.description || "",
    header_image: row.header_image || "",
    developer: row.developer || "",
    publisher: row.publisher || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Lists playable games from the catalog.
 * Excludes accessory apps (DLC, soundtracks, expansions, tools, demos) and subordinate apps.
 */
export async function listPlayableGames(
  db: D1Database,
  options: { limit?: number; offset?: number } = {}
): Promise<CatalogEntity[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const stmt = db
    .prepare(
      `SELECT * FROM apps 
       WHERE is_playable = 1 
         AND is_eligible = 1 
         AND parent_appid IS NULL 
       ORDER BY appid ASC 
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset);

  const res = await stmt.all<RawAppRow>();
  return (res.results || []).map(mapRowToEntity);
}

/**
 * Retrieves a playable root game by its numeric AppID.
 * Restricts lookup strictly to eligible playable root games (parent_appid IS NULL).
 * Accessories or ineligible apps return null (producing 404s).
 * Observations query failure propagates; missing data is successful absence (null).
 */
export async function getGameByAppId(
  db: D1Database,
  appid: number
): Promise<GameDetail | null> {
  const appStmt = db
    .prepare(
      `SELECT * FROM apps 
       WHERE appid = ? 
         AND is_playable = 1 
         AND is_eligible = 1 
         AND parent_appid IS NULL`
    )
    .bind(appid);
  const row = await appStmt.first<RawAppRow>();

  if (!row) {
    return null;
  }

  const entity = mapRowToEntity(row);

  let latest_players: number | null = null;
  let peak_players: number | null = null;
  let last_observed_at: string | null = null;

  // Check if observations table exists in D1 schema
  const tableCheck = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'")
    .first<{ name: string }>();

  if (tableCheck) {
    // Observations table exists: query it directly.
    // D1 failure is not swallowed; missing data is a successful null result.
    const obsStmt = db
      .prepare(
        `SELECT current_players, observed_at FROM observations 
         WHERE appid = ? 
         ORDER BY observed_at DESC 
         LIMIT 1`
      )
      .bind(appid);
    const obs = await obsStmt.first<{ current_players: number; observed_at: string }>();
    if (obs && typeof obs.current_players === "number") {
      latest_players = obs.current_players;
      last_observed_at = obs.observed_at;
    }
  }

  return {
    ...entity,
    latest_players,
    peak_players,
    last_observed_at,
  };
}

/**
 * Persists or updates a catalog entity in D1.
 */
export async function upsertApp(
  db: D1Database,
  app: {
    appid: number;
    name: string;
    slug?: string;
    type?: string;
    is_eligible?: boolean;
    is_playable?: boolean;
    parent_appid?: number | null;
    release_date?: string | null;
    release_status?: string;
    description?: string;
    header_image?: string;
    developer?: string;
    publisher?: string;
  }
): Promise<void> {
  const slug = app.slug || toSlug(app.name);
  const type = app.type ?? "game";
  const isEligible = app.is_eligible !== false ? 1 : 0;
  const isPlayable = app.is_playable !== false ? 1 : 0;
  const parentAppId = app.parent_appid ?? null;
  const releaseDate = app.release_date ?? null;
  const releaseStatus = app.release_status ?? "released";
  const description = app.description ?? "";
  const headerImage = app.header_image ?? "";
  const developer = app.developer ?? "";
  const publisher = app.publisher ?? "";

  const stmt = db
    .prepare(
      `INSERT INTO apps (
        appid, name, slug, type, is_eligible, is_playable, 
        parent_appid, release_date, release_status, description, 
        header_image, developer, publisher, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(appid) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        type = excluded.type,
        is_eligible = excluded.is_eligible,
        is_playable = excluded.is_playable,
        parent_appid = excluded.parent_appid,
        release_date = excluded.release_date,
        release_status = excluded.release_status,
        description = excluded.description,
        header_image = excluded.header_image,
        developer = excluded.developer,
        publisher = excluded.publisher,
        updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      app.appid,
      app.name,
      slug,
      type,
      isEligible,
      isPlayable,
      parentAppId,
      releaseDate,
      releaseStatus,
      description,
      headerImage,
      developer,
      publisher
    );

  await stmt.run();
}

/**
 * Reads a checkpoint from D1.
 */
export async function getCheckpoint(
  db: D1Database,
  key: string
): Promise<{ value: string; cursor: number | null; updated_at: string } | null> {
  const stmt = db
    .prepare(`SELECT key, value, cursor, updated_at FROM checkpoints WHERE key = ?`)
    .bind(key);
  return stmt.first<{ key: string; value: string; cursor: number | null; updated_at: string }>();
}

/**
 * Records or updates a checkpoint in D1.
 */
export async function setCheckpoint(
  db: D1Database,
  key: string,
  value: string,
  cursor: number | null = null
): Promise<void> {
  const stmt = db
    .prepare(
      `INSERT INTO checkpoints (key, value, cursor, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         cursor = excluded.cursor,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(key, value, cursor);
  await stmt.run();
}
