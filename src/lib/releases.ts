import type { D1Database } from "./db";
import { toSlug, getCanonicalGamePath } from "./slug";
import { normalizeAppType, getCanonicalChildPath } from "./related";
import { getLiveApiCacheHeaders, CACHE_POLICIES } from "./cache";

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Parses a source release date string into an exact ISO YYYY-MM-DD date.
 * Strictly returns null for imprecise dates (e.g. "2026", "Q3 2026", "Coming soon", "Sep 2026").
 * Never invents or assumes missing day/month values.
 */
export function parsePreciseReleaseDate(rawDate: string | null | undefined): string | null {
  if (!rawDate || typeof rawDate !== "string") {
    return null;
  }

  const trimmed = rawDate.trim();
  if (!trimmed) {
    return null;
  }

  // Reject obvious imprecise patterns immediately
  // 1. Year only (e.g. "2026")
  if (/^\d{4}$/.test(trimmed)) {
    return null;
  }
  // 2. Quarter + Year (e.g. "Q1 2026", "Q4 2025")
  if (/^q[1-4]\s+\d{4}$/i.test(trimmed)) {
    return null;
  }
  // 3. Month + Year only (e.g. "September 2026", "Sep 2026", "Early 2026", "Fall 2026")
  if (/^[a-z]+\s+\d{4}$/i.test(trimmed)) {
    return null;
  }
  // 4. Phrases (e.g. "Coming soon", "TBA", "To be announced", "Wishlist now")
  if (!/\d{4}/.test(trimmed)) {
    return null;
  }

  let year = 0;
  let month = 0;
  let day = 0;

  // Format 1: ISO YYYY-MM-DD or YYYY-M-D
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    year = parseInt(isoMatch[1], 10);
    month = parseInt(isoMatch[2], 10);
    day = parseInt(isoMatch[3], 10);
  }

  // Format 2: "18 Aug, 2020" or "4 Sep 2026" or "15 March 2024"
  if (!isoMatch) {
    const dmyMatch = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
    if (dmyMatch) {
      day = parseInt(dmyMatch[1], 10);
      const mName = dmyMatch[2].toLowerCase();
      month = MONTH_MAP[mName] || 0;
      year = parseInt(dmyMatch[3], 10);
    }
  }

  // Format 3: "Aug 18, 2020" or "September 4, 2026"
  if (!isoMatch && month === 0) {
    const mdyMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (mdyMatch) {
      const mName = mdyMatch[1].toLowerCase();
      month = MONTH_MAP[mName] || 0;
      day = parseInt(mdyMatch[2], 10);
      year = parseInt(mdyMatch[3], 10);
    }
  }

  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  // Validate exact calendar day (avoid Feb 30 or Apr 31 overflows)
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }

  const yStr = year.toString().padStart(4, "0");
  const mStr = month.toString().padStart(2, "0");
  const dStr = day.toString().padStart(2, "0");
  return `${yStr}-${mStr}-${dStr}`;
}

/**
 * Calculates the UTC ISO 8601 week string (e.g. "2026-W36") for a given date.
 */
export function getIsoWeekString(dateInput: Date | string): string {
  const date = typeof dateInput === "string" ? new Date(`${dateInput.slice(0, 10)}T00:00:00Z`) : dateInput;
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  
  // ISO day: 1 = Monday, ..., 7 = Sunday
  const dayNr = (target.getUTCDay() + 6) % 7 + 1;
  // Thursday of this week determines the ISO year
  target.setUTCDate(target.getUTCDate() - dayNr + 4);
  const isoYear = target.getUTCFullYear();
  
  // First Thursday of the ISO year
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNr = (firstThursday.getUTCDay() + 6) % 7 + 1;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNr + 4);
  
  const weekNumber = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  const weekStr = weekNumber.toString().padStart(2, "0");
  return `${isoYear}-W${weekStr}`;
}

/**
 * Returns current UTC ISO week.
 */
export function getCurrentIsoWeek(asOfDate?: Date | string): string {
  const now = asOfDate
    ? typeof asOfDate === "string"
      ? new Date(`${asOfDate.slice(0, 10)}T00:00:00Z`)
      : asOfDate
    : new Date();
  return getIsoWeekString(now);
}

export interface IsoWeekBounds {
  week: string;
  year: number;
  weekNumber: number;
  startDate: string; // Monday YYYY-MM-DD
  endDate: string;   // Sunday YYYY-MM-DD
  days: string[];    // 7 YYYY-MM-DD dates from Monday to Sunday
  prevWeek: string;
  nextWeek: string;
}

/**
 * Parses and strictly validates an ISO week string (e.g. "2026-W36").
 * Returns week bounds, 7 daily dates, and previous/next week identifiers.
 * Throws or returns null if invalid format or impossible week.
 */
export function parseIsoWeek(weekStr: string): IsoWeekBounds | null {
  if (!weekStr || typeof weekStr !== "string") {
    return null;
  }

  const match = weekStr.trim().toUpperCase().match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = parseInt(match[1], 10);
  const weekNumber = parseInt(match[2], 10);

  if (year < 1970 || year > 2100 || weekNumber < 1 || weekNumber > 53) {
    return null;
  }

  // Calculate Monday of week 1 for this ISO year:
  // Jan 4th is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNr = (jan4.getUTCDay() + 6) % 7 + 1; // 1 = Mon, 7 = Sun
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (jan4DayNr - 1)));

  // Monday of target week
  const monday = new Date(week1Monday.getTime() + (weekNumber - 1) * 7 * 86400000);

  // Verify that computing week for this Monday returns the exact same week and year
  const checkWeek = getIsoWeekString(monday);
  const expectedWeek = `${year}-W${weekNumber.toString().padStart(2, "0")}`;
  if (checkWeek !== expectedWeek) {
    // Week 53 does not exist for this year
    return null;
  }

  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 86400000);
    const y = d.getUTCFullYear().toString().padStart(4, "0");
    const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const dt = d.getUTCDate().toString().padStart(2, "0");
    days.push(`${y}-${m}-${dt}`);
  }

  // Previous week (7 days before Monday)
  const prevDate = new Date(monday.getTime() - 7 * 86400000);
  const prevWeek = getIsoWeekString(prevDate);

  // Next week (7 days after Monday)
  const nextDate = new Date(monday.getTime() + 7 * 86400000);
  const nextWeek = getIsoWeekString(nextDate);

  return {
    week: expectedWeek,
    year,
    weekNumber,
    startDate: days[0],
    endDate: days[6],
    days,
    prevWeek,
    nextWeek,
  };
}

/**
 * Checks whether an entity type is eligible for independent release calendar cards.
 * Only playable games and consumer DLC / expansions are eligible.
 * Dedicated servers, tools, demos, tests, and soundtracks are accessories and excluded.
 */
export function isReleaseEntityEligible(
  type: string,
  isEligible = true,
  isPlayable = true,
  parentAppId: number | null = null
): boolean {
  if (!isEligible) return false;

  const norm = normalizeAppType(type);
  const lower = type.toLowerCase().trim();

  // Accessory exclusion: dedicated servers, tools, demos, tests, soundtracks
  if (
    norm === "server" ||
    norm === "tool" ||
    norm === "demo" ||
    norm === "test" ||
    norm === "soundtrack" ||
    lower === "server" ||
    lower === "tool" ||
    lower === "demo" ||
    lower === "test" ||
    lower === "soundtrack" ||
    lower === "music"
  ) {
    return false;
  }

  // 1. Playable root games: must be type "game", playable, and have no parent
  if (lower === "game" && isPlayable && !parentAppId) {
    return true;
  }

  // 2. Consumer DLC and expansions: must be DLC/expansion AND have a parent game
  if (
    (norm === "expansion" || norm === "dlc" || lower === "dlc" || lower === "expansion") &&
    parentAppId !== null
  ) {
    return true;
  }

  return false;
}

/**
 * Derives Released or Upcoming status based on comparison with calendar date in UTC.
 */
export function deriveReleaseStatus(
  releaseDate: string,
  asOfDate?: Date | string
): "released" | "upcoming" {
  const asOf = asOfDate
    ? typeof asOfDate === "string"
      ? asOfDate.slice(0, 10)
      : asOfDate.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  return releaseDate <= asOf ? "released" : "upcoming";
}

export interface ReleaseEntity {
  appid: number;
  name: string;
  slug: string;
  type: string;
  parent_appid: number | null;
  release_date: string; // YYYY-MM-DD
  release_year: number;
  release_week: string; // YYYY-Www
  release_status: "released" | "upcoming";
  is_precise: boolean;
  header_image: string;
  parent_name?: string;
  parent_slug?: string;
  canonical_path: string;
}

export interface ReleaseDayGroup {
  date: string; // YYYY-MM-DD
  dayOfWeek: string; // e.g. "Monday"
  status: "released" | "upcoming";
  entities: ReleaseEntity[];
}

export interface WeeklyReleasesResult {
  week: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  prevWeek: string;
  nextWeek: string;
  days: ReleaseDayGroup[];
  totalCount: number;
}

const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

interface RawReleaseRow {
  appid: number;
  name: string;
  slug: string;
  type: string;
  parent_appid: number | null;
  release_date: string;
  release_year: number;
  release_week: string;
  release_status: string;
  is_precise: number;
  header_image: string;
  parent_name?: string | null;
}

function mapRowToReleaseEntity(
  row: RawReleaseRow,
  asOfDate?: Date | string
): ReleaseEntity {
  const preciseDate = row.release_date;
  const status = deriveReleaseStatus(preciseDate, asOfDate);
  const parentAppId = row.parent_appid;
  const parentName = row.parent_name || undefined;
  const parentSlug = parentName ? toSlug(parentName) : undefined;

  let canonicalPath = getCanonicalGamePath(row.appid, row.name);
  if (parentAppId && parentName) {
    canonicalPath = getCanonicalChildPath(parentAppId, parentName, row.appid, row.name);
  } else if (parentAppId) {
    canonicalPath = `/games/${parentAppId}/${row.appid}-${toSlug(row.name)}`;
  }
  return {
    appid: row.appid,
    name: row.name,
    slug: row.slug || toSlug(row.name),
    type: row.type,
    parent_appid: parentAppId,
    release_date: preciseDate,
    release_year: row.release_year,
    release_week: row.release_week,
    release_status: status,
    is_precise: row.is_precise === 1,
    header_image: row.header_image || `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${row.appid}/header.jpg`,
    parent_name: parentName,
    parent_slug: parentSlug,
    canonical_path: canonicalPath,
  };
}

/**
 * Upserts a release fact into release_facts table.
 * Rejects entities without precise dates or ineligible types.
 */
export async function upsertReleaseFact(
  db: D1Database,
  app: {
    appid: number;
    name: string;
    slug?: string;
    type: string;
    parent_appid?: number | null;
    release_date?: string | null;
    header_image?: string;
    is_eligible?: boolean;
    is_playable?: boolean;
  },
  asOfDate?: Date | string
): Promise<boolean> {
  const preciseDate = parsePreciseReleaseDate(app.release_date);
  if (!preciseDate) {
    return false;
  }

  const isEligible = app.is_eligible !== false;
  const isPlayable = app.is_playable !== false;
  const parentAppId = app.parent_appid ?? null;

  if (!isReleaseEntityEligible(app.type, isEligible, isPlayable, parentAppId)) {
    return false;
  }

  const week = getIsoWeekString(preciseDate);
  const year = parseInt(preciseDate.slice(0, 4), 10);
  const status = deriveReleaseStatus(preciseDate, asOfDate);
  const slug = app.slug || toSlug(app.name);
  const headerImage = app.header_image || `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${app.appid}/header.jpg`;

  const stmt = db
    .prepare(
      `INSERT INTO release_facts (
        appid, name, slug, type, parent_appid, release_date,
        release_year, release_week, release_status, is_precise,
        header_image, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(appid) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        type = excluded.type,
        parent_appid = excluded.parent_appid,
        release_date = excluded.release_date,
        release_year = excluded.release_year,
        release_week = excluded.release_week,
        release_status = excluded.release_status,
        is_precise = 1,
        header_image = excluded.header_image,
        updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      app.appid,
      app.name,
      slug,
      app.type,
      parentAppId,
      preciseDate,
      year,
      week,
      status,
      headerImage
    );

  await stmt.run();
  return true;
}

/**
 * Retrieves release facts grouped by day for a given ISO week.
 */
export async function getReleasesForWeek(
  db: D1Database,
  weekStr: string,
  options: { asOfDate?: Date | string } = {}
): Promise<WeeklyReleasesResult | null> {
  const bounds = parseIsoWeek(weekStr);
  if (!bounds) {
    return null;
  }

  const stmt = db
    .prepare(
      `SELECT r.*, p.name as parent_name
       FROM release_facts r
       LEFT JOIN apps p ON r.parent_appid = p.appid
       WHERE r.release_week = ?
         AND r.is_precise = 1
       ORDER BY r.release_date ASC, r.name ASC`
    )
    .bind(bounds.week);

  const res = await stmt.all<RawReleaseRow>();
  const rows = res.results || [];
  const entities = rows.map((row) => mapRowToReleaseEntity(row, options.asOfDate));

  // Group entities by the 7 days of this ISO week
  const dayMap = new Map<string, ReleaseEntity[]>();
  for (const day of bounds.days) {
    dayMap.set(day, []);
  }

  for (const entity of entities) {
    const list = dayMap.get(entity.release_date);
    if (list) {
      list.push(entity);
    }
  }

  const days: ReleaseDayGroup[] = bounds.days.map((dateStr, index) => {
    const dayEntities = dayMap.get(dateStr) || [];
    return {
      date: dateStr,
      dayOfWeek: DAY_NAMES[index],
      status: deriveReleaseStatus(dateStr, options.asOfDate),
      entities: dayEntities,
    };
  });

  return {
    week: bounds.week,
    year: bounds.year,
    weekNumber: bounds.weekNumber,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    prevWeek: bounds.prevWeek,
    nextWeek: bounds.nextWeek,
    days,
    totalCount: entities.length,
  };
}

/**
 * Retrieves recent releases (on or before current UTC date).
 */
export async function getRecentReleases(
  db: D1Database,
  options: { limit?: number; asOfDate?: Date | string } = {}
): Promise<ReleaseEntity[]> {
  const limit = options.limit ?? 20;
  const asOf = options.asOfDate
    ? typeof options.asOfDate === "string"
      ? options.asOfDate.slice(0, 10)
      : options.asOfDate.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const stmt = db
    .prepare(
      `SELECT r.*, p.name as parent_name
       FROM release_facts r
       LEFT JOIN apps p ON r.parent_appid = p.appid
       WHERE r.release_date <= ?
         AND r.is_precise = 1
       ORDER BY r.release_date DESC, r.name ASC
       LIMIT ?`
    )
    .bind(asOf, limit);

  const res = await stmt.all<RawReleaseRow>();
  const rows = res.results || [];
  return rows.map((row) => mapRowToReleaseEntity(row, options.asOfDate));
}

/**
 * Retrieves releases for current ISO week.
 */
export async function getCurrentWeekReleases(
  db: D1Database,
  options: { asOfDate?: Date | string } = {}
): Promise<WeeklyReleasesResult | null> {
  const currentWeek = getCurrentIsoWeek(options.asOfDate);
  return getReleasesForWeek(db, currentWeek, options);
}

export type ReleasesApiResponse<T> =
  | { status: "data"; data: T; source_timestamp: string }
  | { status: "empty"; data: T | null; message: string; source_timestamp: string }
  | { status: "error"; error: string; source_timestamp: string };

export function createReleaseDataResponse<T>(data: T, sourceTimestamp?: string): Response {
  const body: ReleasesApiResponse<T> = {
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

export function createReleaseEmptyResponse(
  message = "No releases found for this period",
  sourceTimestamp?: string
): Response {
  const body: ReleasesApiResponse<null> = {
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

export function createReleaseErrorResponse(error: string, status = 500): Response {
  const body: ReleasesApiResponse<null> = {
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
