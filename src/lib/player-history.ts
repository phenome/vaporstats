import type { AppDatabase } from "./db";
import { CADENCE_MS } from "./player";
import { toSlug } from "./slug";

export type HistoryRange = "24h" | "7d" | "30d" | "90d" | "all";

export const VALID_HISTORY_RANGES: Record<string, true> = {
  "24h": true,
  "7d": true,
  "30d": true,
  "90d": true,
  "all": true,
};

export const DEFAULT_HISTORY_RANGE: HistoryRange = "30d";
function formatUtcDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

export interface RollupRecord {
  appid: number;
  date: string; // UTC YYYY-MM-DD
  min_players: number;
  max_players: number;
  avg_players: number;
  close_players: number;
  sample_count: number;
  created_at?: string;
}

export interface PlayerHistoryPoint {
  timestamp: string; // ISO-8601 or UTC date string
  players: number | null; // null for gaps or missing periods; NEVER 0 for missing
  min?: number;
  max?: number;
  avg?: number;
  close?: number;
  sample_count?: number;
  is_rollup?: boolean;
  is_gap?: boolean;
}

export interface PlayerHistoryResult {
  appid: number;
  range: HistoryRange;
  earliest_observation: string | null;
  range_start: string | null;
  range_end: string | null;
  points: PlayerHistoryPoint[];
  source_timestamp: string | null;
}
export interface RankedGame {
  rank: number;
  appid: number;
  name: string;
  slug: string;
  current_players: number | null;
  last_observed_at: string | null;
  relative_age: string;
  exact_utc: string;
}

export interface PeakRankedGame {
  rank: number;
  appid: number;
  name: string;
  slug: string;
  peak_players: number;
  period: HistoryRange;
}

/**
 * Strict range parser.
 * Case-insensitively parses "24h", "7d", "30d", "90d", "all".
 * Defaults to "30d" for missing or unrecognized values.
 */
export function parseHistoryRange(raw: unknown): HistoryRange {
  if (typeof raw !== "string") {
    return DEFAULT_HISTORY_RANGE;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized in VALID_HISTORY_RANGES) {
    return normalized as HistoryRange;
  }
  return DEFAULT_HISTORY_RANGE;
}

/**
 * Formats relative age with clean human-readable units.
 * Returns "No data yet" when timestamp is absent.
 */
export function formatRelativeAge(
  observedAt: string | Date | null | undefined,
  now: Date = new Date()
): string {
  if (!observedAt) return "No data yet";
  const date = typeof observedAt === "string" ? new Date(observedAt) : observedAt;
  const time = date.getTime();
  if (isNaN(time)) return "No data yet";

  const diffMs = now.getTime() - time;
  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Formats exact UTC timestamp as "YYYY-MM-DD HH:mm:ss UTC".
 * Returns "No data yet" when timestamp is absent.
 */
export function formatExactUtc(observedAt: string | Date | null | undefined): string {
  if (!observedAt) return "No data yet";
  const date = typeof observedAt === "string" ? new Date(observedAt) : observedAt;
  if (isNaN(date.getTime())) return "No data yet";

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");

  return `${y}-${m}-${d} ${hh}:${mm}:${ss} UTC`;
}

/**
 * Computes boundary cutoff Date for a given history range.
 */
export function getRangeCutoffDate(
  range: HistoryRange,
  anchorTime: Date = new Date(),
  earliestObservation?: string | null
): Date | null {
  switch (range) {
    case "24h":
      return new Date(anchorTime.getTime() - 24 * 60 * 60 * 1000);
    case "7d":
      return new Date(anchorTime.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(anchorTime.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "90d":
      return new Date(anchorTime.getTime() - 90 * 24 * 60 * 60 * 1000);
    case "all":
      return earliestObservation ? new Date(earliestObservation) : null;
  }
}

/**
 * Retrieves the timestamp of the earliest successful observation across
 * the observations table and player_rollups table.
 */
export async function getEarliestObservationDate(
  db: AppDatabase,
  appid?: number
): Promise<string | null> {
  const scope = appid === undefined ? "" : " WHERE appid = ?";
  const values = appid === undefined ? [] : [appid];
  const obsRow = await db
    .prepare("SELECT MIN(observed_at) AS earliest FROM observations" + scope)
    .bind(...values)
    .first<{ earliest: string | null }>();
  const rollupRow = await db
    .prepare("SELECT MIN(date) AS earliest FROM player_rollups" + scope)
    .bind(...values)
    .first<{ earliest: string | null }>();

  const obsEarliest = obsRow?.earliest ?? null;
  const rollupEarliest = rollupRow?.earliest ?? null;
  if (!obsEarliest) return rollupEarliest ? rollupEarliest + "T00:00:00.000Z" : null;
  if (!rollupEarliest || obsEarliest.slice(0, 10) <= rollupEarliest) return obsEarliest;
  return rollupEarliest + "T00:00:00.000Z";
}

/**
 * Idempotently computes and persists one UTC daily rollup for player counts.
 * The scheduled default targets the previous completed UTC day. Explicit targets
 * are still useful for backfills and retries.
 */
export async function computeDailyRollups(
  db: AppDatabase,
  options: { targetDate?: string; anchorTime?: Date } = {}
): Promise<{ rolledUpCount: number; records: RollupRecord[] }> {
  const anchorTime = options.anchorTime ?? new Date();
  const targetDate = options.targetDate ?? formatUtcDateKey(new Date(anchorTime.getTime() - 24 * 60 * 60 * 1000));
  const targetStart = new Date(`${targetDate}T00:00:00.000Z`);
  const targetEnd = new Date(targetStart.getTime() + 24 * 60 * 60 * 1000);
  const targetStartIso = targetStart.toISOString();
  const targetEndIso = targetEnd.toISOString();

  const upsertSql = `
    INSERT INTO player_rollups (
      appid, date, min_players, max_players, avg_players, close_players, sample_count
    )
    SELECT
      daily.appid,
      ?,
      daily.min_players,
      daily.max_players,
      daily.avg_players,
      (
        SELECT latest.current_players
        FROM observations latest
        WHERE latest.appid = daily.appid
          AND latest.observed_at = daily.max_observed_at
        ORDER BY latest.id DESC
        LIMIT 1
      ),
      daily.sample_count
    FROM (
      SELECT
        appid,
        MIN(current_players) AS min_players,
        MAX(current_players) AS max_players,
        ROUND(AVG(current_players), 2) AS avg_players,
        COUNT(*) AS sample_count,
        MAX(observed_at) AS max_observed_at
      FROM observations
      WHERE observed_at >= ? AND observed_at < ?
      GROUP BY appid
    ) daily
    WHERE true
    ON CONFLICT(appid, date) DO UPDATE SET
      min_players = excluded.min_players,
      max_players = excluded.max_players,
      avg_players = excluded.avg_players,
      close_players = excluded.close_players,
      sample_count = excluded.sample_count
  `;
  await db.prepare(upsertSql).bind(targetDate, targetStartIso, targetEndIso).run();

  const results = await db
    .prepare(
      `SELECT appid, date, min_players, max_players, avg_players, close_players, sample_count, created_at
       FROM player_rollups
       WHERE date = ?
       ORDER BY appid`
    )
    .bind(targetDate)
    .all<RollupRecord>();
  const records = results.results ?? [];

  return {
    rolledUpCount: records.length,
    records,
  };
}

export const RAW_OBSERVATION_RETENTION_DAYS = 30;

/**
 * Cleans up raw observations older than the configured thirty-day retention period.
 * Must be executed after or alongside daily rollups to ensure no data loss.
 */
export async function cleanExpiredRawObservations(
  db: AppDatabase,
  anchorTime: Date = new Date(),
  retentionDays = RAW_OBSERVATION_RETENTION_DAYS
): Promise<number> {
  const cutoffDate = new Date(anchorTime.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffDate.toISOString();

  const stmt = db.prepare(`DELETE FROM observations WHERE observed_at < ?`).bind(cutoffIso);
  const res = await stmt.run();
  return res.meta.changes;
}

/** Resolution-aware bucket helpers. */
type HistoryBucketPoint = PlayerHistoryPoint & { bucketKey?: string };
type RawBucketRow = {
  bucket_key: string;
  min_players: number;
  max_players: number;
  avg_players: number;
  close_players: number;
  sample_count: number;
  latest_observed_at: string;
};

type RawObservationRow = {
  id: number;
  current_players: number;
  observed_at: string;
};

async function queryRawBuckets(
  db: AppDatabase,
  appid: number,
  startIso: string,
  endIso: string,
  resolution: "hour" | "six-hour" | "day"
): Promise<RawBucketRow[]> {
  const bucketExpression =
    resolution === "hour"
      ? "substr(observed_at, 1, 13) || ':00:00.000Z'"
      : resolution === "six-hour"
        ? "substr(observed_at, 1, 11) || printf('%02d:00:00.000Z', (CAST(substr(observed_at, 12, 2) AS INTEGER) / 6) * 6)"
        : "substr(observed_at, 1, 10) || 'T00:00:00.000Z'";
  const sql =
    "WITH filtered AS (" +
    " SELECT id, current_players, observed_at, " + bucketExpression + " AS bucket_key" +
    " FROM observations WHERE appid = ? AND observed_at >= ? AND observed_at <= ?" +
    "), grouped AS (" +
    " SELECT bucket_key, MIN(current_players) AS min_players," +
    " MAX(current_players) AS max_players, ROUND(AVG(current_players), 2) AS avg_players," +
    " COUNT(*) AS sample_count, MAX(observed_at) AS latest_observed_at" +
    " FROM filtered GROUP BY bucket_key" +
    ") SELECT grouped.bucket_key, grouped.min_players, grouped.max_players," +
    " grouped.avg_players, grouped.sample_count, grouped.latest_observed_at," +
    " (SELECT current_players FROM filtered latest" +
    "  WHERE latest.bucket_key = grouped.bucket_key" +
    "  ORDER BY latest.observed_at DESC, latest.id DESC LIMIT 1) AS close_players" +
    " FROM grouped ORDER BY grouped.bucket_key ASC";
  const result = await db
    .prepare(sql)
    .bind(appid, startIso, endIso)
    .all<RawBucketRow>();
  return result.results ?? [];
}

function addBucketGaps(
  points: HistoryBucketPoint[],
  range: HistoryRange,
  rawGapThresholdMs: number
): PlayerHistoryPoint[] {
  if (points.length === 0) return [];
  const withGaps: HistoryBucketPoint[] = [];
  if (range === "24h") {
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (index > 0) {
        const previous = new Date(points[index - 1].timestamp).getTime();
        const current = new Date(point.timestamp).getTime();
        if (current - previous > rawGapThresholdMs) {
          withGaps.push({
            timestamp: new Date(previous + (current - previous) / 2).toISOString(),
            players: null,
            is_gap: true,
          });
        }
      }
      withGaps.push(point);
    }
  } else {
    const bucketMs = range === "7d" ? 60 * 60 * 1000 : range === "30d" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (index > 0 && point.bucketKey && points[index - 1].bucketKey) {
        const previous = Date.parse(points[index - 1].bucketKey!);
        const current = Date.parse(point.bucketKey);
        const missing = Math.floor((current - previous) / bucketMs) - 1;
        for (let gap = 1; gap <= missing; gap++) {
          withGaps.push({
            timestamp: new Date(previous + gap * bucketMs).toISOString(),
            players: null,
            is_gap: true,
          });
        }
      }
      withGaps.push(point);
    }
  }
  return withGaps.map(({ bucketKey: _bucketKey, ...point }) => point);
}

function dailyPoint(
  date: string,
  raw: RawBucketRow | undefined,
  rollup: RollupRecord | undefined,
  useRollup: boolean
): HistoryBucketPoint | null {
  if (useRollup && rollup) {
    return {
      bucketKey: date + "T00:00:00.000Z",
      timestamp: raw?.latest_observed_at ?? date + "T00:00:00.000Z",
      players: rollup.close_players,
      min: rollup.min_players,
      max: rollup.max_players,
      avg: rollup.avg_players,
      close: rollup.close_players,
      sample_count: rollup.sample_count,
      is_rollup: true,
    };
  }
  if (!raw) return null;
  return {
    bucketKey: date + "T00:00:00.000Z",
    timestamp: raw.latest_observed_at,
    players: raw.close_players,
    min: raw.min_players,
    max: raw.max_players,
    avg: raw.avg_players,
    close: raw.close_players,
    sample_count: raw.sample_count,
    is_rollup: false,
  };
}

/**
 * Retrieves player history for a game across 24h, 7d, 30d, 90d, or All.
 * Enforces range boundaries, preserves observation gaps (never interpolates or zeros),
 * and defines All as beginning at the first successful observation.
 */
export async function getPlayerHistory(
  db: AppDatabase,
  appid: number,
  rangeInput: unknown = "30d",
  anchorTime: Date = new Date()
): Promise<PlayerHistoryResult> {
  const range = parseHistoryRange(rangeInput);
  const earliestObservation = await getEarliestObservationDate(db, appid);
  const cutoff = getRangeCutoffDate(range, anchorTime, earliestObservation);
  const cutoffIso = cutoff ? cutoff.toISOString() : null;
  const anchorTimeIso = anchorTime.toISOString();
  const anchorDate = anchorTimeIso.slice(0, 10);
  let bucketPoints: HistoryBucketPoint[] = [];
  let rawGapThresholdMs = 30 * 60 * 1000;

  if (range === "all" && !cutoffIso) {
    return {
      appid,
      range,
      earliest_observation: null,
      range_start: null,
      range_end: null,
      points: [],
      source_timestamp: null,
    };
  }

  if (range === "24h") {
    const trackedGame = await db
      .prepare("SELECT tier FROM tracked_games WHERE appid = ?")
      .bind(appid)
      .first<{ tier: string | null }>();
    const tier = trackedGame?.tier;
    if (tier === "fast" || tier === "hourly" || tier === "daily") {
      // Allow 50% scheduling tolerance, but preserve the existing 30-minute floor.
      rawGapThresholdMs = Math.max(30 * 60 * 1000, 1.5 * CADENCE_MS[tier]);
    }
    const result = await db
      .prepare(
        "SELECT id, current_players, observed_at FROM observations" +
        " WHERE appid = ? AND observed_at >= ? AND observed_at <= ?" +
        " ORDER BY observed_at ASC, id ASC"
      )
      .bind(appid, cutoffIso!, anchorTimeIso)
      .all<RawObservationRow>();
    bucketPoints = (result.results ?? []).map((row) => ({
      timestamp: row.observed_at,
      players: row.current_players,
      is_rollup: false,
    }));
  } else if (range === "7d" || range === "30d") {
    const resolution = range === "7d" ? "hour" : "six-hour";
    const rows = await queryRawBuckets(db, appid, cutoffIso!, anchorTimeIso, resolution);
    bucketPoints = rows.map((row) => ({
      bucketKey: row.bucket_key,
      timestamp: row.latest_observed_at,
      players: row.close_players,
      min: row.min_players,
      max: row.max_players,
      avg: row.avg_players,
      close: row.close_players,
      sample_count: row.sample_count,
      is_rollup: false,
    }));
  } else {
    const rawRows = await queryRawBuckets(db, appid, cutoffIso!, anchorTimeIso, "day");
    const rawByDate = new Map(rawRows.map((row) => [row.bucket_key.slice(0, 10), row]));
    const rollupResult = await db
      .prepare(
        "SELECT date, min_players, max_players, avg_players, close_players, sample_count" +
        " FROM player_rollups WHERE appid = ? AND date >= ? AND date < ? ORDER BY date ASC"
      )
      .bind(appid, cutoffIso!.slice(0, 10), anchorDate)
      .all<RollupRecord>();
    const rollups = rollupResult.results ?? [];
    const rollupByDate = new Map(rollups.map((row) => [row.date, row]));
    const dates = new Set<string>([...rawByDate.keys(), ...rollupByDate.keys()]);
    const sortedDates = [...dates].sort();
    const cutoffIsMidnight = cutoffIso!.endsWith("T00:00:00.000Z");
    for (const date of sortedDates) {
      const raw = rawByDate.get(date);
      const rollup = rollupByDate.get(date);
      const isCutoffDate = date === cutoffIso!.slice(0, 10);
      const useRollup = Boolean(rollup && (!isCutoffDate || cutoffIsMidnight));
      const point = dailyPoint(date, raw, rollup, useRollup);
      if (point) bucketPoints.push(point);
    }
  }

  const points = addBucketGaps(bucketPoints, range, rawGapThresholdMs);
  const realPoints = points.filter((point) => point.players !== null && !point.is_gap);
  const sourceTimestamp = realPoints.length > 0 ? realPoints[realPoints.length - 1].timestamp : null;
  const rangeStart = range === "all" && realPoints.length === 0 ? null : cutoffIso;
  const rangeEnd = range === "all" ? sourceTimestamp : anchorTimeIso;

  return {
    appid,
    range,
    earliest_observation: earliestObservation,
    range_start: rangeStart,
    range_end: rangeEnd,
    points,
    source_timestamp: sourceTimestamp,
  };
}

export async function getMostPlayedRankings(
  db: AppDatabase,
  options: { limit?: number; now?: Date } = {}
): Promise<RankedGame[]> {
  const limit = options.limit ?? 100;
  const now = options.now ?? new Date();

  const stmt = db.prepare(
    `SELECT 
       a.appid,
       a.name,
       a.slug,
       t.latest_players,
       t.last_successful_at AS last_observed_at
     FROM apps a
     JOIN tracked_games t ON t.appid = a.appid
     WHERE a.is_playable = 1 
       AND a.is_eligible = 1
       AND t.latest_players IS NOT NULL
     ORDER BY t.latest_players DESC, a.appid ASC
     LIMIT ?`
  ).bind(limit);

  const res = await stmt.all<{
    appid: number;
    name: string;
    slug: string | null;
    latest_players: number | null;
    last_observed_at: string | null;
  }>();

  const games: RankedGame[] = [];
  const rows = res.results ?? [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    games.push({
      rank: i + 1,
      appid: row.appid,
      name: row.name,
      slug: row.slug || toSlug(row.name),
      current_players: row.latest_players,
      last_observed_at: row.last_observed_at,
      relative_age: formatRelativeAge(row.last_observed_at, now),
      exact_utc: formatExactUtc(row.last_observed_at),
    });
  }

  return games;
}

/**
 * Retrieves Observed Peak rankings across retained raw observations and rollups.
 * Evaluates the specified period (24h, 7d, 30d, 90d, all).
 */
export async function getPeakRankings(
  db: AppDatabase,
  periodInput: unknown = "all",
  options: { limit?: number; anchorTime?: Date } = {}
): Promise<PeakRankedGame[]> {
  const period = parseHistoryRange(periodInput);
  const limit = options.limit ?? 100;
  const anchorTime = options.anchorTime ?? new Date();
  const earliestObservation = period === "all" ? await getEarliestObservationDate(db) : null;
  const cutoff = getRangeCutoffDate(period, anchorTime, earliestObservation);
  const cutoffIso = cutoff ? cutoff.toISOString() : null;
  const cutoffDate = cutoffIso ? cutoffIso.substring(0, 10) : null;
  const anchorTimeIso = anchorTime.toISOString();
  const anchorDateStr = anchorTimeIso.substring(0, 10);

  let query: string;
  let stmt;

  if (period !== "all" && cutoffIso) {
    if (period === "24h") {
      // The exact 24-hour window must use raw observations only.
      query = `
        SELECT
          a.appid,
          a.name,
          a.slug,
          MAX(o.current_players) AS peak_players
        FROM apps a
        JOIN observations o ON o.appid = a.appid
        WHERE a.is_playable = 1
          AND a.is_eligible = 1
          AND o.observed_at >= ?
          AND o.observed_at <= ?
        GROUP BY a.appid
        ORDER BY peak_players DESC, a.appid ASC
        LIMIT ?
      `;
      stmt = db.prepare(query).bind(cutoffIso, anchorTimeIso, limit);
    } else {
      // Use raw observations for the exact cutoff day and durable rollups for older days.
      query = `
        SELECT
          a.appid,
          a.name,
          a.slug,
          MAX(combined.players) AS peak_players
        FROM apps a
        JOIN (
          SELECT appid, current_players AS players
          FROM observations
          WHERE observed_at >= ? AND observed_at <= ?
          UNION ALL
          SELECT appid, max_players AS players
          FROM player_rollups
          WHERE date > ? AND date <= ?
        ) combined ON combined.appid = a.appid
        WHERE a.is_playable = 1 AND a.is_eligible = 1
        GROUP BY a.appid
        ORDER BY peak_players DESC, a.appid ASC
        LIMIT ?
      `;
      stmt = db.prepare(query).bind(cutoffIso, anchorTimeIso, cutoffDate!, anchorDateStr, limit);
    }
  } else {
    // For All: combine raw observations and historical daily rollups bounded to anchorTime.
    query = `
      SELECT
        a.appid,
        a.name,
        a.slug,
        MAX(combined.players) AS peak_players
      FROM apps a
      JOIN (
        SELECT appid, current_players AS players FROM observations WHERE observed_at <= ?
        UNION ALL
        SELECT appid, max_players AS players FROM player_rollups WHERE date <= ?
      ) combined ON combined.appid = a.appid
      WHERE a.is_playable = 1 AND a.is_eligible = 1
      GROUP BY a.appid
      ORDER BY peak_players DESC, a.appid ASC
      LIMIT ?
    `;
    stmt = db.prepare(query).bind(anchorTimeIso, anchorDateStr, limit);
  }
  const res = await stmt.all<{
    appid: number;
    name: string;
    slug: string | null;
    peak_players: number;
  }>();

  const peaks: PeakRankedGame[] = [];
  const rows = res.results ?? [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    peaks.push({
      rank: i + 1,
      appid: row.appid,
      name: row.name,
      slug: row.slug || toSlug(row.name),
      peak_players: row.peak_players,
      period,
    });
  }

  return peaks;
}
/**
 * Retrieves Trending games: exactly the top 10 tracked playable games
 * ordered by latest successful current player count.
 * Never uses momentum scores or player count floors.
 */
export async function getTrendingGames(
  db: AppDatabase,
  options: { now?: Date } = {}
): Promise<RankedGame[]> {
  return getMostPlayedRankings(db, { limit: 10, now: options.now });
}
