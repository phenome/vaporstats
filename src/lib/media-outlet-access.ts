import type { AppDatabase } from "./db";

/**
 * Outlet access rules shared by every media pass and stage. Discovery
 * searches, discovery fetches and processing article fetches all record their
 * requests in `media_discovery_attempts`, so that log is the one durable
 * source for whether an outlet may be contacted.
 */

export const MAX_ATTEMPTS_PER_OUTLET_DAY = 30;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

/** Search, fetch, redirect and failed attempts on `outlet` during `date`'s UTC day, from every pass and stage. */
async function attemptsToday(db: AppDatabase, outlet: string, date: Date): Promise<number> {
  const row = await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = ? AND day = ?", outlet, dayKey(date));
  return Number(row?.count ?? 0);
}

/**
 * The first access denial `outlet` itself returned to an article fetch in any
 * pass or stage. A denial never reopens, and its original reason is kept.
 * Search attempts go to the search provider, so a 401 or 403 there is a
 * provider stop, not an outlet denial.
 */
async function outletDenial(db: AppDatabase, outlet: string): Promise<string | null> {
  const denied = await first<{ status_code: number }>(
    db,
    "SELECT status_code FROM media_discovery_attempts WHERE outlet = ? AND kind = 'fetch' AND status_code IN (401, 403) ORDER BY id LIMIT 1",
    outlet,
  );
  return denied ? `fetch_http_${denied.status_code}` : null;
}

/**
 * Why `outlet` must not be contacted during `date`'s UTC day, whichever pass
 * or stage recorded it: the daily attempt cap, or a rate limit that day.
 * Both reopen on the next UTC day.
 */
async function outletDayStop(db: AppDatabase, outlet: string, date: Date): Promise<string | null> {
  if ((await attemptsToday(db, outlet, date)) >= MAX_ATTEMPTS_PER_OUTLET_DAY) return "daily_attempt_cap";
  const limited = await first<{ kind: string }>(
    db,
    "SELECT kind FROM media_discovery_attempts WHERE outlet = ? AND day = ? AND status_code = 429 ORDER BY id LIMIT 1",
    outlet,
    dayKey(date),
  );
  if (!limited) return null;
  return limited.kind === "search" ? "search_http_429" : "fetch_http_429";
}

/** Why `outlet` must not be contacted at `date`: a lasting access denial first, then a same-day stop. */
export async function mediaOutletStop(db: AppDatabase, outlet: string, date: Date): Promise<string | null> {
  return (await outletDenial(db, outlet)) ?? outletDayStop(db, outlet, date);
}

