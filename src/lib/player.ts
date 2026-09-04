import type { D1Database, D1PreparedStatement } from "./db";

/**
 * Player activity collection limits and tier configurations.
 */
export const TIER_FAST_MAX = 10;
export const TIER_HOURLY_MAX = 90;
export const TIER_DAILY_MAX = 900;
export const MAX_TRACKED_GAMES = 1000;

export const DAILY_REQUEST_CAP = 5000;
export const TICK_REQUEST_CAP = 100;
export const CONCURRENCY_LIMIT = 6;

export const CADENCE_MINUTES = {
  fast: 10,
  hourly: 60,
  daily: 1440,
} as const;

export const CADENCE_MS = {
  fast: 10 * 60 * 1000,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
} as const;

export type PlayerTier = "fast" | "hourly" | "daily";

export interface TrackedGame {
  appid: number;
  tier: PlayerTier;
  slot: number;
  next_due_at: string;
  last_attempted_at: string | null;
  last_successful_at: string | null;
  latest_players: number | null;
  consecutive_failures: number;
  created_at?: string;
  updated_at?: string;
}

export interface PlayerObservation {
  id?: number;
  appid: number;
  current_players: number;
  observed_at: string;
  created_at?: string;
}

export interface GameOverviewData {
  appid: number;
  latest_players: number | null;
  observed_at: string | null;
}

/**
 * Formats a Date as UTC YYYY-MM-DD for daily limit tracking.
 */
export function formatUtcDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Calculates deterministic ten-minute slot distribution for a game.
 * Fast: runs every 10-minute tick (slot 0).
 * Hourly: distributed across 6 slots per hour (0..5) via appid % 6.
 * Daily: distributed across 144 slots per day (0..143) via appid % 144.
 */
export function calculateDeterministicSlot(appid: number, tier: PlayerTier): number {
  if (tier === "fast") return 0;
  if (tier === "hourly") return Math.abs(appid) % 6;
  return Math.abs(appid) % 144;
}

/**
 * Calculates next due time aligned to appid's deterministic 10-minute UTC slot
 * using epoch 10-minute tick arithmetic:
 * - First tick strictly after anchorTime.
 * - Fast: aligns to next UTC 10-minute tick.
 * - Hourly: advances to next tick where (tick % 6) equals (appid % 6).
 * - Daily: advances to next tick where (tick % 144) equals (appid % 144).
 * Always strictly after anchorTime and exactly on a 10-minute UTC boundary.
 */
export function calculateNextDueAt(
  anchorTime: Date,
  tier: PlayerTier,
  appid: number
): Date {
  const TICK_MS = 10 * 60 * 1000;
  const firstNextTick = Math.floor(anchorTime.getTime() / TICK_MS) + 1;

  if (tier === "fast") {
    return new Date(firstNextTick * TICK_MS);
  }

  const candidateDate = new Date(firstNextTick * TICK_MS);

  if (tier === "hourly") {
    const targetSlot = Math.abs(appid) % 6;
    const currentSlot = Math.floor(candidateDate.getUTCMinutes() / 10);
    const delta = (targetSlot - currentSlot + 6) % 6;
    return new Date((firstNextTick + delta) * TICK_MS);
  }

  const targetSlot = Math.abs(appid) % 144;
  const currentSlot = Math.floor((candidateDate.getUTCHours() * 60 + candidateDate.getUTCMinutes()) / 10);
  const delta = (targetSlot - currentSlot + 144) % 144;
  return new Date((firstNextTick + delta) * TICK_MS);
}
/**
 * Retrieves latest observation for a specific game.
 */
export async function getLatestPlayerObservation(
  db: D1Database,
  appid: number
): Promise<{ current_players: number; observed_at: string } | null> {
  const stmt = db
    .prepare(
      `SELECT current_players, observed_at FROM observations 
       WHERE appid = ? 
       ORDER BY observed_at DESC 
       LIMIT 1`
    )
    .bind(appid);
  return await stmt.first<{ current_players: number; observed_at: string }>();
}

/**
 * Retrieves tracked games due for collection at anchorTime.
 * Orders by tier priority (fast -> hourly -> daily), then oldest due work, then appid.
 */
export async function getDueTrackedGames(
  db: D1Database,
  anchorTime: Date,
  limit: number
): Promise<TrackedGame[]> {
  const anchorIso = anchorTime.toISOString();
  const stmt = db
    .prepare(
      `SELECT appid, tier, slot, next_due_at, last_attempted_at, last_successful_at, latest_players, consecutive_failures
       FROM tracked_games
       WHERE next_due_at <= ?
       ORDER BY 
         CASE tier 
           WHEN 'fast' THEN 1 
           WHEN 'hourly' THEN 2 
           WHEN 'daily' THEN 3 
           ELSE 4 
         END ASC,
         next_due_at ASC,
         appid ASC
       LIMIT ?`
    )
    .bind(anchorIso, limit);

  const res = await stmt.all<TrackedGame>();
  return res.results || [];
}

/**
 * Retrieves current daily request count for a given UTC date.
 */
export async function getDailyRequestCount(
  db: D1Database,
  dateStr: string
): Promise<number> {
  const stmt = db
    .prepare("SELECT count FROM player_daily_requests WHERE date = ?")
    .bind(dateStr);
  const row = await stmt.first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Prepares statement to insert a successful observation.
 */
export function prepareObservationInsert(
  db: D1Database,
  appid: number,
  current_players: number,
  observed_at: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO observations (appid, current_players, observed_at)
       VALUES (?, ?, ?)`
    )
    .bind(appid, current_players, observed_at);
}

/**
 * Prepares statement to advance tracking state upon success.
 */
export function prepareSuccessTrackingUpdate(
  db: D1Database,
  appid: number,
  next_due_at: string,
  latest_players: number,
  observed_at: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tracked_games 
       SET latest_players = ?,
           last_successful_at = ?,
           last_attempted_at = ?,
           next_due_at = ?,
           consecutive_failures = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE appid = ?`
    )
    .bind(latest_players, observed_at, observed_at, next_due_at, appid);
}

/**
 * Prepares statement to advance tracking state upon failure.
 * Does NOT overwrite latest_players.
 * Advances next_due_at to next normal cadence without 10-min retry loop.
 */
export function prepareFailureTrackingUpdate(
  db: D1Database,
  appid: number,
  next_due_at: string,
  attempted_at: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tracked_games 
       SET last_attempted_at = ?,
           next_due_at = ?,
           consecutive_failures = consecutive_failures + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE appid = ?`
    )
    .bind(attempted_at, next_due_at, appid);
}

/**
 * Prepares statement to atomically increment daily request count.
 */
export function prepareIncrementDailyCount(
  db: D1Database,
  dateStr: string,
  count: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO player_daily_requests (date, count, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(date) DO UPDATE SET 
         count = player_daily_requests.count + excluded.count,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(dateStr, count);
}

/**
 * Registers or updates a tracked game.
 */
export async function registerTrackedGame(
  db: D1Database,
  appid: number,
  tier: PlayerTier = "daily",
  initialDueAt?: Date,
  latestPlayers: number | null = null
): Promise<void> {
  const slot = calculateDeterministicSlot(appid, tier);
  const nextDue = (initialDueAt ?? calculateNextDueAt(new Date(), tier, appid)).toISOString();
  await db
    .prepare(
      `INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(appid) DO UPDATE SET
         tier = excluded.tier,
         slot = excluded.slot,
         next_due_at = excluded.next_due_at,
         latest_players = COALESCE(excluded.latest_players, tracked_games.latest_players),
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(appid, tier, slot, nextDue, latestPlayers)
    .run();
}

/**
 * Re-ranks tracked games according to latest successful count:
 * Top 10 -> fast tier (10m)
 * Next 90 -> hourly tier (60m)
 * Remaining up to 900 -> daily tier (24h)
 * Enforces at most 1,000 tracked games.
 */
export async function reRankTrackedTiers(
  db: D1Database,
  anchorTime: Date = new Date()
): Promise<{ fastCount: number; hourlyCount: number; dailyCount: number }> {
  // Query all tracked games ordered by latest_players DESC (nulls last), then appid ASC
  const rowsRes = await db
    .prepare(
      `SELECT appid, tier, slot, latest_players 
       FROM tracked_games
       ORDER BY 
         CASE WHEN latest_players IS NULL THEN 1 ELSE 0 END ASC,
         latest_players DESC,
         appid ASC
       LIMIT ?`
    )
    .bind(MAX_TRACKED_GAMES)
    .all<{ appid: number; tier: PlayerTier; slot: number; latest_players: number | null }>();

  const rows = rowsRes.results || [];
  let fastCount = 0;
  let hourlyCount = 0;
  let dailyCount = 0;

  const stmts: D1PreparedStatement[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let newTier: PlayerTier;
    if (i < TIER_FAST_MAX) {
      newTier = "fast";
      fastCount++;
    } else if (i < TIER_FAST_MAX + TIER_HOURLY_MAX) {
      newTier = "hourly";
      hourlyCount++;
    } else {
      newTier = "daily";
      dailyCount++;
    }

    const newSlot = calculateDeterministicSlot(row.appid, newTier);
    if (row.tier !== newTier || row.slot !== newSlot) {
      const nextDue = calculateNextDueAt(anchorTime, newTier, row.appid).toISOString();
      stmts.push(
        db
          .prepare(
            `UPDATE tracked_games 
             SET tier = ?, slot = ?, next_due_at = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE appid = ?`
          )
          .bind(newTier, newSlot, nextDue, row.appid)
      );
    }
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  return { fastCount, hourlyCount, dailyCount };
}

/**
 * Retrieves game overview data for a playable game by appid.
 * Returns null if game does not exist or is not playable/eligible.
 */
export async function getGameOverview(
  db: D1Database,
  appid: number
): Promise<GameOverviewData | null> {
  const appStmt = db
    .prepare(
      `SELECT appid FROM apps 
       WHERE appid = ? 
         AND is_playable = 1 
         AND is_eligible = 1 
         AND parent_appid IS NULL`
    )
    .bind(appid);
  const app = await appStmt.first<{ appid: number }>();
  if (!app) {
    return null;
  }

  const obs = await getLatestPlayerObservation(db, appid);
  return {
    appid,
    latest_players: obs ? obs.current_players : null,
    observed_at: obs ? obs.observed_at : null,
  };
}
