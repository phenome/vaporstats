import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import type { MediaOutlet } from "./media-discovery";

/**
 * Outlet access rules shared by every media pass and stage. Discovery
 * searches, discovery fetches and processing article fetches all record their
 * requests in `media_discovery_attempts`, so that log is the one durable
 * source for whether an outlet may be contacted.
 */

const MAX_ATTEMPTS_PER_OUTLET_DAY = 30;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

/**
 * A search the provider refused (401, 403 or 429) was never served, so it is
 * not anything the outlet did: it uses none of the outlet's attempts and never
 * limits or denies it. The attempt stays in the log as the provider stop's record.
 */
const SERVED_ATTEMPT_SQL = "NOT (kind = 'search' AND COALESCE(status_code, 0) IN (401, 403, 429))";

/** Search, fetch, redirect and failed attempts on `outlet` during `date`'s UTC day, from every pass and stage. */
async function attemptsToday(db: AppDatabase, outlet: MediaOutlet, date: Date): Promise<number> {
  const row = await first<{ count: number }>(db, `SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = ? AND day = ? AND ${SERVED_ATTEMPT_SQL}`, outlet, dayKey(date));
  return Number(row?.count ?? 0);
}

/**
 * The first access denial `outlet` itself returned to an article fetch in any
 * pass or stage. A denial never reopens, and its original reason is kept.
 * Search attempts go to the search provider, so a 401 or 403 there is a
 * provider stop, not an outlet denial.
 */
async function outletDenial(db: AppDatabase, outlet: MediaOutlet): Promise<string | null> {
  const denied = await first<{ status_code: number }>(
    db,
    "SELECT status_code FROM media_discovery_attempts WHERE outlet = ? AND kind = 'fetch' AND status_code IN (401, 403) ORDER BY id LIMIT 1",
    outlet,
  );
  return denied ? `fetch_http_${denied.status_code}` : null;
}

/**
 * Why `outlet` must not be contacted during `date`'s UTC day, whichever pass
 * or stage recorded it: the daily attempt cap, or a rate limit the outlet
 * returned to an article fetch that day. Both reopen on the next UTC day.
 */
async function outletDayStop(db: AppDatabase, outlet: MediaOutlet, date: Date): Promise<string | null> {
  if ((await attemptsToday(db, outlet, date)) >= MAX_ATTEMPTS_PER_OUTLET_DAY) return "daily_attempt_cap";
  const limited = await first<{ id: number }>(
    db,
    "SELECT id FROM media_discovery_attempts WHERE outlet = ? AND day = ? AND kind = 'fetch' AND status_code = 429 LIMIT 1",
    outlet,
    dayKey(date),
  );
  return limited ? "fetch_http_429" : null;
}

/** Why `outlet` must not be contacted at `date`: a lasting access denial first, then a same-day stop. */
async function mediaOutletStop(db: AppDatabase, outlet: MediaOutlet, date: Date): Promise<string | null> {
  return (await outletDenial(db, outlet)) ?? outletDayStop(db, outlet, date);
}


type OutletAttemptKind = "search" | "fetch" | "redirect" | "failure";

/**
 * Reserves one attempt on `outlet` under `runId`'s pass before the outlet is
 * contacted, or returns why it must not be contacted. The stop check and the
 * reservation run in one serialized write transaction, so concurrent passes
 * and stages never admit more than the outlet's remaining allowance.
 */
export async function reserveOutletAttempt(
  db: AppDatabase,
  attempt: { runId: number; appid: number; outlet: MediaOutlet; kind: "search" | "fetch"; url: string | null; date: Date },
): Promise<{ attemptId: number } | { stop: string }> {
  return writeTransaction(db, async () => {
    const stop = await mediaOutletStop(db, attempt.outlet, attempt.date);
    if (stop) return { stop };
    const reserved = await first<{ id: number }>(
      db,
      "INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, succeeded, attempted_at) SELECT ?, ?, pass, ?, ?, ?, 0, ? FROM media_discovery_runs WHERE id = ? RETURNING id",
      attempt.appid, attempt.outlet, dayKey(attempt.date), attempt.kind, attempt.url, attempt.date.toISOString(), attempt.runId,
    );
    if (!reserved) throw new Error(`Unable to reserve a media outlet attempt: run ${attempt.runId} not found`);
    await db.prepare("UPDATE media_discovery_runs SET attempt_count = attempt_count + 1 WHERE id = ?").bind(attempt.runId).run();
    return { attemptId: reserved.id };
  });
}

/** Records how a reserved attempt ended. */
export async function finishOutletAttempt(
  db: AppDatabase,
  attemptId: number,
  outcome: { kind: OutletAttemptKind; statusCode: number | null; succeeded: boolean; error: string | null },
): Promise<void> {
  await db.prepare("UPDATE media_discovery_attempts SET kind = ?, status_code = ?, succeeded = ?, error = ? WHERE id = ?")
    .bind(outcome.kind, outcome.statusCode, outcome.succeeded ? 1 : 0, outcome.error, attemptId).run();
}
