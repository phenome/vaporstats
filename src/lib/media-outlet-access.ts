import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import type { MediaPass } from "./media-discovery";

/**
 * Outlet access rules shared by every media pass and stage. Discovery
 * searches, discovery fetches and processing article fetches all record their
 * requests in `media_discovery_attempts`, so that log is the one durable
 * source for whether an outlet may be contacted.
 */

export const MEDIA_OUTLETS = [
  { name: "IGN", domain: "ign.com" },
  { name: "Eurogamer", domain: "eurogamer.net" },
  { name: "GameSpot", domain: "gamespot.com" },
  { name: "PC Gamer", domain: "pcgamer.com" },
  { name: "Kotaku", domain: "kotaku.com" },
  { name: "GamesRadar+", domain: "gamesradar.com" },
] as const;

export type MediaOutlet = (typeof MEDIA_OUTLETS)[number]["name"];
export function hostInOutlet(url: string, outlet: (typeof MEDIA_OUTLETS)[number]): boolean {
  try {
    const address = new URL(url);
    if (address.protocol !== "http:" && address.protocol !== "https:") return false;
    const host = address.hostname.toLowerCase();
    const domain = outlet.domain.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

const DEFAULT_ATTEMPTS_PER_OUTLET_DAY = 30;
const OUTLET_DENIAL_STATUSES: readonly number[] = [401, 403];
const OUTLET_DAY_STOP_STATUS = 429;
const MAX_REDIRECTS = 5;

function outletHttpStop(status: number): string | null {
  return OUTLET_DENIAL_STATUSES.includes(status) || status === OUTLET_DAY_STOP_STATUS
    ? `fetch_http_${status}`
    : null;
}

/**
 * Setting that replaces the daily attempt cap per outlet. The default of 30
 * is VaporStats' own conservative policy, not an allowance an outlet granted.
 * An Outlet denial and an outlet's own rate limit apply whatever the cap is.
 */
export const MEDIA_OUTLET_DAILY_ATTEMPTS_ENV = "MEDIA_OUTLET_DAILY_ATTEMPTS";

/** The daily attempt cap per outlet: the setting when it is a positive whole number, otherwise 30. */
export function outletDailyAttemptCap(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): number {
  const value = env[MEDIA_OUTLET_DAILY_ATTEMPTS_ENV];
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : DEFAULT_ATTEMPTS_PER_OUTLET_DAY;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

/**
 * A non-2xx search response or recorded network error belongs to the provider.
 * It uses none of the outlet's attempts, but stays in the log. A reserved
 * search with no recorded outcome may have been served and still counts.
 */
const SERVED_ATTEMPT_SQL = `NOT (kind = 'search' AND (
  (status_code IS NOT NULL AND status_code NOT BETWEEN 200 AND 299)
  OR (status_code IS NULL AND error IS NOT NULL)
))`;

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
    `SELECT status_code FROM media_discovery_attempts WHERE outlet = ? AND kind = 'fetch' AND status_code IN (${OUTLET_DENIAL_STATUSES.join(", ")}) ORDER BY id LIMIT 1`,
    outlet,
  );
  return denied ? outletHttpStop(denied.status_code) : null;
}

/**
 * Why `outlet` must not be contacted during `date`'s UTC day, whichever pass
 * or stage recorded it: the daily attempt cap, or a rate limit the outlet
 * returned to an article fetch that day. Both reopen on the next UTC day.
 */
async function outletDayStop(db: AppDatabase, outlet: MediaOutlet, date: Date): Promise<string | null> {
  if ((await attemptsToday(db, outlet, date)) >= outletDailyAttemptCap()) return "daily_attempt_cap";
  const limited = await first<{ id: number }>(
    db,
    "SELECT id FROM media_discovery_attempts WHERE outlet = ? AND day = ? AND kind = 'fetch' AND status_code = ? LIMIT 1",
    outlet,
    dayKey(date),
    OUTLET_DAY_STOP_STATUS,
  );
  return limited ? outletHttpStop(OUTLET_DAY_STOP_STATUS) : null;
}

/**
 * Whether `stop`, a reason an outlet must not be contacted, is an Outlet
 * denial: an access refusal (HTTP 401 or 403) to an article fetch, which is
 * permanent. Every other stop is a day stop that reopens on the next UTC day.
 */
export function isOutletDenialStop(stop: string): boolean {
  return OUTLET_DENIAL_STATUSES.some((status) => stop === outletHttpStop(status));
}

/** Why `outlet` must not be contacted at `date`: a lasting access denial first, then a same-day stop. */
async function mediaOutletStop(db: AppDatabase, outlet: MediaOutlet, date: Date): Promise<string | null> {
  return (await outletDenial(db, outlet)) ?? outletDayStop(db, outlet, date);
}


type OutletAttemptKind = "search" | "fetch" | "redirect" | "failure";

/**
 * Reserves one attempt on `outlet` for `pass`, the assessment pass the
 * request serves, under `runId` before the outlet is contacted, or returns why
 * it must not be contacted. The stop check and the reservation run in one
 * serialized write transaction, so concurrent passes and stages never admit
 * more than the outlet's remaining allowance.
 */
export async function reserveOutletAttempt(
  db: AppDatabase,
  attempt: { runId: number; pass: MediaPass; appid: number; outlet: MediaOutlet; kind: "search" | "fetch"; url: string | null; date: Date },
): Promise<{ attemptId: number } | { stop: string }> {
  return writeTransaction(db, async () => {
    const stop = await mediaOutletStop(db, attempt.outlet, attempt.date);
    if (stop) return { stop };
    const reserved = await first<{ id: number }>(
      db,
      "INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, succeeded, attempted_at) SELECT ?, ?, ?, ?, ?, ?, 0, ? FROM media_discovery_runs WHERE id = ? RETURNING id",
      attempt.appid, attempt.outlet, attempt.pass, dayKey(attempt.date), attempt.kind, attempt.url, attempt.date.toISOString(), attempt.runId,
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

type ArticleFetchResult = { html: string; finalUrl: string } | { stop: string; contacted: boolean } | null;

type AnsweredAttempt = { status: number; ok: boolean; redirect: boolean };

async function finishFailedAttempt(
  db: AppDatabase, attemptId: number, error: unknown, answered?: AnsweredAttempt, formatError?: (error: unknown) => string,
): Promise<void> {
  const message = (formatError ? formatError(error) : error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 256);
  await finishOutletAttempt(db, attemptId, {
    kind: answered ? (answered.redirect ? "redirect" : "fetch") : "failure",
    statusCode: answered?.status ?? null, succeeded: false, error: message,
  });
}

async function recordAnsweredAttempt<T>(
  db: AppDatabase,
  attemptId: number,
  response: Response,
  read: (answered: AnsweredAttempt) => T | Promise<T>,
  formatError?: (error: unknown) => string,
): Promise<T> {
  let answered: AnsweredAttempt | undefined;
  let result: T;
  try {
    const status = response.status;
    answered = { status, ok: response.ok, redirect: status >= 300 && status < 400 };
    result = await read(answered);
  } catch (error) {
    await finishFailedAttempt(db, attemptId, error, answered, formatError);
    throw error;
  }
  await finishOutletAttempt(db, attemptId, {
    kind: answered.redirect ? "redirect" : "fetch",
    statusCode: answered.status,
    succeeded: answered.ok,
    error: answered.ok ? null : `HTTP ${answered.status}`,
  });
  return result;
}

/** Completes an attempt when only the response metadata is needed. */
export function finishAnsweredAttempt(db: AppDatabase, attemptId: number, response: Response): Promise<AnsweredAttempt> {
  return recordAnsweredAttempt(db, attemptId, response, (answered) => answered);
}

/**
 * Reserves and records each request, following at most five redirects within
 * the Outlet. Network failures skip the article. Exceptions reading a
 * response are recorded and propagated to the caller's item error handler.
 */
export async function fetchOutletArticle(
  db: AppDatabase,
  options: {
    url: string;
    runId: number;
    pass: MediaPass;
    appid: number;
    outlet: MediaOutlet;
    clock: () => Date;
    fetch: (url: string, init?: RequestInit) => Promise<Response | string>;
    onAttempt?: () => void;
    formatError?: (error: unknown) => string;
  },
): Promise<ArticleFetchResult> {
  const { runId, pass, appid, outlet, clock } = options;
  const config = MEDIA_OUTLETS.find((item) => item.name === outlet);
  if (!config) return null;

  let url = options.url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!hostInOutlet(url, config)) return null;
    const reservation = await reserveOutletAttempt(db, { runId, pass, appid, outlet, kind: "fetch", url, date: clock() });
    if ("stop" in reservation) return { stop: reservation.stop, contacted: redirects > 0 };
    const { attemptId } = reservation;

    let response: Response | string;
    try {
      options.onAttempt?.();
      response = await options.fetch(url, { redirect: "manual", headers: { Accept: "text/html,application/xhtml+xml" } });
    } catch (error) {
      await finishFailedAttempt(db, attemptId, error, undefined, options.formatError);
      return null;
    }
    if (typeof response === "string") {
      await finishOutletAttempt(db, attemptId, { kind: "fetch", statusCode: 200, succeeded: true, error: null });
      return { html: response, finalUrl: url };
    }
    const reply = response;
    const result = await recordAnsweredAttempt<ArticleFetchResult | { next: string }>(db, attemptId, reply, async (answered) => {
      const stop = outletHttpStop(answered.status);
      if (stop) return { stop, contacted: true };
      if (answered.redirect && redirects < MAX_REDIRECTS) {
        const location = reply.headers.get("location");
        const next = location ? URL.parse(location, url) : null;
        return next ? { next: next.href } : null;
      }
      return answered.ok ? { html: await reply.text(), finalUrl: url } : null;
    }, options.formatError);
    if (!result || !("next" in result)) return result;
    url = result.next;
  }
  return null;
}
