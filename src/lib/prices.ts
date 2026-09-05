import type { AppDatabase } from "./db";
import { toSlug } from "./slug";

export type PriceHistoryRange = "30d" | "6m" | "1y" | "all";

export const VALID_PRICE_RANGES: Record<string, true> = {
  "30d": true,
  "6m": true,
  "1y": true,
  "all": true,
};

export const DEFAULT_PRICE_RANGE: PriceHistoryRange = "all";

export const EXCLUDED_DEAL_ACCESSORY_TYPES: Record<string, true> = {
  server: true,
  tool: true,
  demo: true,
  test: true,
  soundtrack: true,
  music: true,
};

export interface PriceState {
  appid: number;
  currency: string;
  initial_price: number | null; // in cents, e.g. 5999
  final_price: number | null; // in cents, e.g. 2999, 0 for free
  discount_percent: number;
  is_free: boolean;
  is_available: boolean;
  formatted_initial: string | null;
  formatted_final: string | null;
  observed_at: string;
  created_at?: string;
  updated_at?: string;
}

export interface PriceHistoryEntry {
  id?: number;
  appid: number;
  currency: string;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number;
  is_free: boolean;
  is_available: boolean;
  formatted_price: string | null;
  observed_at: string;
  created_at?: string;
}

export interface DealItem {
  appid: number;
  name: string;
  slug: string;
  type: string;
  parent_appid: number | null;
  parent_name: string | null;
  parent_slug: string | null;
  initial_price: number;
  final_price: number;
  discount_percent: number;
  currency: string;
  is_free: boolean;
  formatted_initial: string;
  formatted_final: string;
  header_image: string;
  observed_at: string;
}

export interface PriceHistoryResult {
  appid: number;
  range: PriceHistoryRange;
  earliest_observation: string | null;
  current_price: PriceState | null;
  history: PriceHistoryEntry[];
  source_timestamp: string;
  anchor_timestamp?: string;
}

export interface DealsResult {
  deals: DealItem[];
  total: number;
  source_timestamp: string;
}

/**
 * Case-insensitively parses price history range: "30d", "6m", "1y", "all".
 * Defaults to "all".
 */
export function parsePriceRange(raw: unknown): PriceHistoryRange {
  if (typeof raw !== "string") {
    return DEFAULT_PRICE_RANGE;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized in VALID_PRICE_RANGES) {
    return normalized as PriceHistoryRange;
  }
  return DEFAULT_PRICE_RANGE;
}

/**
 * Formats price in cents to human-readable string (e.g. $29.99 or Free).
 * Returns "Unavailable" when price is null or unpriced.
 */
export function formatPriceCents(
  cents: number | null | undefined,
  currency = "USD",
  isFree = false
): string {
  if (isFree) return "Free";
  if (cents === null || cents === undefined) return "Unavailable";
  if (cents === 0) return "Free";
  const dollars = (cents / 100).toFixed(2);
  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;
}
/**
 * Formats observation timestamp to an explicit UTC string: "YYYY-MM-DD HH:mm:ss UTC".
 * Returns "No data yet" when timestamp is absent or invalid.
 */
export function formatPriceUtc(observedAt: string | Date | null | undefined): string {
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
 * Checks if an entity is eligible to be listed as a Deal.
 * Includes playable games, consumer DLC, and expansions.
 * Strictly excludes dedicated servers, tools, demos, tests, and soundtracks.
 */
export function isDealEligible(
  entity: {
    type?: string | null;
    is_playable?: boolean | number | null;
    parent_appid?: number | null;
  },
  relationshipType?: string | null
): boolean {
  const normType = (entity.type || "").toLowerCase().trim();
  const normRel = (relationshipType || "").toLowerCase().trim();

  // Check excluded accessory categories
  if (normType in EXCLUDED_DEAL_ACCESSORY_TYPES) return false;
  if (normRel in EXCLUDED_DEAL_ACCESSORY_TYPES) return false;

  // Root playable games require type=game, is_playable=true, and parent_appid=null
  if (
    normType === "game" &&
    (entity.is_playable === 1 || entity.is_playable === true) &&
    !entity.parent_appid
  ) {
    return true;
  }

  // Consumer DLC and expansions require parent_appid
  if (
    (normType === "dlc" || normType === "expansion" || normRel === "dlc" || normRel === "expansion") &&
    Boolean(entity.parent_appid)
  ) {
    return true;
  }

  return false;
}

/**
 * Determines whether an observed price state is different from the stored state.
 * Returns true if no previous state exists or any tracked pricing property changed.
 */
export function hasPriceStateChanged(
  existing: PriceState | null | undefined,
  incoming: {
    initial_price: number | null;
    final_price: number | null;
    discount_percent: number;
    is_free: boolean;
    is_available: boolean;
  }
): boolean {
  if (!existing) return true;

  return (
    existing.initial_price !== incoming.initial_price ||
    existing.final_price !== incoming.final_price ||
    existing.discount_percent !== incoming.discount_percent ||
    existing.is_free !== incoming.is_free ||
    existing.is_available !== incoming.is_available
  );
}

/**
 * Computes boundary cutoff Date for a given price history range.
 * Range "all" begins at the earliest recorded observation date.
 */
export function getPriceRangeCutoffDate(
  range: PriceHistoryRange,
  anchorTime: Date = new Date(),
  earliestObservation?: string | null
): Date | null {
  switch (range) {
    case "30d":
      return new Date(anchorTime.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "6m":
      return new Date(anchorTime.getTime() - 180 * 24 * 60 * 60 * 1000);
    case "1y":
      return new Date(anchorTime.getTime() - 365 * 24 * 60 * 60 * 1000);
    case "all":
    default:
      return earliestObservation ? new Date(earliestObservation) : null;
  }
}

interface RawHistoryRow {
  id?: number;
  appid: number;
  currency: string;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number;
  is_free: number;
  is_available: number;
  formatted_price: string | null;
  observed_at: string;
  created_at?: string;
}

interface RawDealRow {
  appid: number;
  name: string;
  slug: string | null;
  type: string;
  parent_appid: number | null;
  header_image: string | null;
  parent_name: string | null;
  parent_slug: string | null;
  initial_price: number;
  final_price: number;
  discount_percent: number;
  currency: string;
  is_free: number;
  formatted_initial: string | null;
  formatted_final: string | null;
  observed_at: string;
  total_count: number;
  total_only: number;
}
interface RawPriceRow {
  appid: number;
  currency: string;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number;
  is_free: number;
  is_available: number;
  formatted_initial: string | null;
  formatted_final: string | null;
  observed_at: string;
  created_at?: string;
  updated_at?: string;
}

function mapRowToPriceState(row: RawPriceRow): PriceState {
  return {
    appid: row.appid,
    currency: row.currency || "USD",
    initial_price: row.initial_price,
    final_price: row.final_price,
    discount_percent: row.discount_percent ?? 0,
    is_free: Boolean(row.is_free),
    is_available: Boolean(row.is_available),
    formatted_initial: row.formatted_initial,
    formatted_final: row.formatted_final,
    observed_at: row.observed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Reads the current price state for an app.
 */
export async function getCurrentPrice(
  db: AppDatabase,
  appid: number
): Promise<PriceState | null> {
  const stmt = db
    .prepare(
      `SELECT appid, currency, initial_price, final_price, discount_percent,
              is_free, is_available, formatted_initial, formatted_final,
              observed_at, created_at, updated_at
       FROM app_prices
       WHERE appid = ?`
    )
    .bind(appid);

  const row = await stmt.first<RawPriceRow>();
  return row ? mapRowToPriceState(row) : null;
}

/**
 * Persists an observed price state in the app database:
 * - Upserts app_prices with latest observation
 * - Appends to price_history ONLY when price state changed
 * - Retains sparse changes indefinitely without rollups
 */
export async function recordPriceObservation(
  db: AppDatabase,
  observation: {
    appid: number;
    currency?: string;
    initial_price: number | null;
    final_price: number | null;
    discount_percent: number;
    is_free: boolean;
    is_available: boolean;
    formatted_initial?: string | null;
    formatted_final?: string | null;
    observed_at: string;
  }
): Promise<{ stateChanged: boolean }> {
  const currency = observation.currency || "USD";
  const existing = await getCurrentPrice(db, observation.appid);

  const changed = hasPriceStateChanged(existing, {
    initial_price: observation.initial_price,
    final_price: observation.final_price,
    discount_percent: observation.discount_percent,
    is_free: observation.is_free,
    is_available: observation.is_available,
  });

  const formattedFinal =
    observation.formatted_final ??
    formatPriceCents(observation.final_price, currency, observation.is_free);

  const formattedInitial =
    observation.formatted_initial ??
    (observation.initial_price !== null
      ? formatPriceCents(observation.initial_price, currency)
      : null);

  if (changed) {
    // 1. Prepare app_prices update
    const updatePricesStmt = db
      .prepare(
        `INSERT INTO app_prices (
          appid, currency, initial_price, final_price, discount_percent,
          is_free, is_available, formatted_initial, formatted_final,
          observed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(appid) DO UPDATE SET
          currency = excluded.currency,
          initial_price = excluded.initial_price,
          final_price = excluded.final_price,
          discount_percent = excluded.discount_percent,
          is_free = excluded.is_free,
          is_available = excluded.is_available,
          formatted_initial = excluded.formatted_initial,
          formatted_final = excluded.formatted_final,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at`
      )
      .bind(
        observation.appid,
        currency,
        observation.initial_price,
        observation.final_price,
        observation.discount_percent,
        observation.is_free ? 1 : 0,
        observation.is_available ? 1 : 0,
        formattedInitial,
        formattedFinal,
        observation.observed_at,
        observation.observed_at
      );

    // 2. Prepare sparse price_history append
    const insertHistoryStmt = db
      .prepare(
        `INSERT INTO price_history (
          appid, currency, initial_price, final_price, discount_percent,
          is_free, is_available, formatted_price, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        observation.appid,
        currency,
        observation.initial_price,
        observation.final_price,
        observation.discount_percent,
        observation.is_free ? 1 : 0,
        observation.is_available ? 1 : 0,
        formattedFinal,
        observation.observed_at
      );

    // Atomically commit both writes in a single batch transaction
    await db.batch([updatePricesStmt, insertHistoryStmt]);

    return { stateChanged: true };
  } else {
    // Unchanged state: update observation timestamp on current record only, no history entry
    await db
      .prepare(
        `UPDATE app_prices
         SET observed_at = ?, updated_at = ?
         WHERE appid = ?`
      )
      .bind(observation.observed_at, observation.observed_at, observation.appid)
      .run();

    return { stateChanged: false };
  }
}

/**
 * Retrieves range-aware price history for an app.
 * Preserves step changes and gaps, and defines 'all' as beginning at first observation.
 */
export async function getPriceHistory(
  db: AppDatabase,
  appid: number,
  range: PriceHistoryRange = DEFAULT_PRICE_RANGE,
  options: { anchorTime?: Date; currentPrice?: PriceState | null } = {}
): Promise<PriceHistoryResult> {
  const anchorTime = options.anchorTime ?? new Date();
  const anchorIso = anchorTime.toISOString();
  const current = options.currentPrice === undefined
    ? await getCurrentPrice(db, appid)
    : options.currentPrice;

  // Find earliest observation date bounded by anchorTime
  const earliestStmt = db
    .prepare(
      `SELECT MIN(observed_at) as earliest
       FROM price_history
       WHERE appid = ? AND observed_at <= ?`
    )
    .bind(appid, anchorIso);
  const earliestRow = await earliestStmt.first<{ earliest: string | null }>();
  const earliestObservation = earliestRow?.earliest ?? null;

  const cutoff = getPriceRangeCutoffDate(range, anchorTime, earliestObservation);
  let historyRows: PriceHistoryEntry[] = [];

  if (!cutoff || range === "all") {
    // All observations ordered chronologically bounded by anchorTime
    const allStmt = db
      .prepare(
        `SELECT id, appid, currency, initial_price, final_price, discount_percent,
                is_free, is_available, formatted_price, observed_at, created_at
         FROM price_history
         WHERE appid = ? AND observed_at <= ?
         ORDER BY observed_at ASC`
      )
      .bind(appid, anchorIso);
    const { results } = await allStmt.all<RawHistoryRow>();
    historyRows = (results || []).map((r) => ({
      id: r.id,
      appid: r.appid,
      currency: r.currency || "USD",
      initial_price: r.initial_price,
      final_price: r.final_price,
      discount_percent: r.discount_percent ?? 0,
      is_free: Boolean(r.is_free),
      is_available: Boolean(r.is_available),
      formatted_price: r.formatted_price,
      observed_at: r.observed_at,
      created_at: r.created_at,
    }));
  } else {
    const cutoffIso = cutoff.toISOString();

    // 1. Find the last state immediately before or at the cutoff to anchor the range start
    const anchorStmt = db
      .prepare(
        `SELECT id, appid, currency, initial_price, final_price, discount_percent,
                is_free, is_available, formatted_price, observed_at, created_at
         FROM price_history
         WHERE appid = ? AND observed_at <= ?
         ORDER BY observed_at DESC
         LIMIT 1`
      )
      .bind(appid, cutoffIso);
    const anchorRow = await anchorStmt.first<RawHistoryRow>();

    // 2. Fetch all changes within the cutoff window
    const windowStmt = db
      .prepare(
        `SELECT id, appid, currency, initial_price, final_price, discount_percent,
                is_free, is_available, formatted_price, observed_at, created_at
         FROM price_history
         WHERE appid = ? AND observed_at > ? AND observed_at <= ?
         ORDER BY observed_at ASC`
      )
      .bind(appid, cutoffIso, anchorIso);
    const { results: windowResults } = await windowStmt.all<RawHistoryRow>();

    const combined: RawHistoryRow[] = [];
    if (anchorRow) {
      combined.push(anchorRow);
    }
    if (windowResults && windowResults.length > 0) {
      combined.push(...windowResults);
    }

    historyRows = combined.map((r) => ({
      id: r.id,
      appid: r.appid,
      currency: r.currency || "USD",
      initial_price: r.initial_price,
      final_price: r.final_price,
      discount_percent: r.discount_percent ?? 0,
      is_free: Boolean(r.is_free),
      is_available: Boolean(r.is_available),
      formatted_price: r.formatted_price,
      observed_at: r.observed_at,
      created_at: r.created_at,
    }));
  }

  const sourceTimestamp =
    current?.observed_at ?? earliestObservation ?? new Date().toISOString();

  return {
    appid,
    range,
    earliest_observation: earliestObservation,
    current_price: current,
    history: historyRows,
    source_timestamp: sourceTimestamp,
    anchor_timestamp: anchorIso,
  };
}

/**
 * Queries active Deals:
 * Includes discounted playable games and consumer DLC or expansions.
 * Strictly excludes dedicated servers, tools, demos, tests, and soundtracks.
 */
export async function getDeals(
  db: AppDatabase,
  options: {
    limit?: number;
    offset?: number;
    type?: "game" | "dlc" | "expansion" | "all";
    sort?: "discount" | "price" | "recent";
  } = {}
): Promise<DealsResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const filterType = options.type ?? "all";
  const sort = options.sort ?? "discount";

  let typeCondition = `(
    (a.type = 'game' AND a.is_playable = 1 AND a.parent_appid IS NULL)
    OR (a.type IN ('dlc', 'expansion') AND a.parent_appid IS NOT NULL)
  )`;

  if (filterType === "game") {
    typeCondition = `(a.type = 'game' AND a.is_playable = 1 AND a.parent_appid IS NULL)`;
  } else if (filterType === "dlc") {
    typeCondition = `(a.type = 'dlc' AND a.parent_appid IS NOT NULL)`;
  } else if (filterType === "expansion") {
    typeCondition = `(a.type = 'expansion' AND a.parent_appid IS NOT NULL)`;
  }
  // Base exclusion of accessories from app_relationships as well
  const accessoryExclusion = `NOT EXISTS (
    SELECT 1 FROM app_relationships ar
    WHERE ar.child_appid = a.appid
      AND ar.relationship_type IN ('server', 'tool', 'demo', 'test', 'soundtrack')
  )`;

  let orderClause = `discount_percent DESC, final_price ASC`;
  if (sort === "price") {
    orderClause = `final_price ASC, discount_percent DESC`;
  } else if (sort === "recent") {
    orderClause = `observed_at DESC, discount_percent DESC`;
  }

  // One candidate CTE supplies both the bounded page and its total.
  const dealsQuery = `
    WITH eligible_deals AS MATERIALIZED (
      SELECT
        a.appid,
        a.name,
        a.slug,
        a.type,
        a.parent_appid,
        a.header_image,
        parent.name as parent_name,
        parent.slug as parent_slug,
        p.initial_price,
        p.final_price,
        p.discount_percent,
        p.currency,
        p.is_free,
        p.formatted_initial,
        p.formatted_final,
        p.observed_at
      FROM app_prices p
      JOIN apps a ON p.appid = a.appid
      LEFT JOIN apps parent ON a.parent_appid = parent.appid
      WHERE p.discount_percent > 0
        AND p.is_available = 1
        AND p.final_price IS NOT NULL
        AND p.initial_price IS NOT NULL
        AND ${typeCondition}
        AND ${accessoryExclusion}
    ),
    page AS (
      SELECT *
      FROM eligible_deals
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    ),
    total AS (
      SELECT COUNT(*) AS total_count
      FROM eligible_deals
    )
    SELECT page.*, total.total_count, 0 AS total_only
    FROM page CROSS JOIN total
    UNION ALL
    SELECT
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      total.total_count, 1
    FROM total
    WHERE NOT EXISTS (SELECT 1 FROM page)
  `;

  const { results } = await db.prepare(dealsQuery).bind(limit, offset).all<RawDealRow>();
  const rows = results || [];
  const total = rows.find((row) => row.total_count !== undefined)?.total_count ?? 0;
  let maxObservedTime: string | null = null;
  const deals: DealItem[] = rows.filter((row) => !row.total_only).map((row) => {
    if (!maxObservedTime || row.observed_at > maxObservedTime) {
      maxObservedTime = row.observed_at;
    }
    return {
      appid: row.appid,
      name: row.name,
      slug: row.slug || toSlug(row.name),
      type: row.type,
      parent_appid: row.parent_appid,
      parent_name: row.parent_name,
      parent_slug: row.parent_slug,
      initial_price: row.initial_price,
      final_price: row.final_price,
      discount_percent: row.discount_percent,
      currency: row.currency || "USD",
      is_free: Boolean(row.is_free),
      formatted_initial:
        row.formatted_initial || formatPriceCents(row.initial_price, row.currency),
      formatted_final:
        row.formatted_final || formatPriceCents(row.final_price, row.currency),
      header_image: row.header_image || "",
      observed_at: row.observed_at,
    };
  });

  return {
    deals,
    total,
    source_timestamp: maxObservedTime ?? new Date().toISOString(),
  };
}
