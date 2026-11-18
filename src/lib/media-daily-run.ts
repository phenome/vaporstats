import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import { MEDIA_GAME_CHOICES } from "./media-discovery";
import { dailyCreditCheckDue, type PaidProvider } from "./media-paid-providers";
import { runMediaDailyCreditCheck, type MediaProcessingOptions } from "./media-processing";

/**
 * Automatic media ingestion: the daily media run and the paid-work queue it
 * feeds. One server configuration switch enables it; it is off unless the
 * server sets `MEDIA_AUTOMATIC_INGESTION=true`.
 */
export const MEDIA_AUTOMATIC_INGESTION_ENV = "MEDIA_AUTOMATIC_INGESTION";

/** Whether automatic media ingestion is enabled: only the exact value `true` enables it. */
export function automaticMediaIngestionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[MEDIA_AUTOMATIC_INGESTION_ENV] === "true";
}

const ENROLLMENT_START_DATE_KEY = "media:enrollment-start-date";
/** The games of the bounded media experiment, enrolled with reason `experiment`. */
const EXPERIMENT_GAMES = Object.values(MEDIA_GAME_CHOICES).sort((a, b) => a - b);

export interface DailyMediaRunSummary {
  /** The UTC day this run belongs to. */
  day: string;
  /** The UTC date of the first daily media run while enabled; it never moves. */
  enrollmentStartDate: string;
  /** Entities this run enrolled, in AppID order. */
  enrolled: number[];
  /** The scheduled discovery run this run started, or null when no enrolled root is eligible. */
  discoveryRunId: number | null;
  /** Providers whose pause the credit check lifted, so their next submission probes credit. */
  probe: PaidProvider[];
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The identity of `day`'s scheduled discovery run; at most one exists per UTC day. */
export function scheduledDiscoveryIdentity(day: string): string {
  return `scheduled:${day}`;
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

/**
 * Records the enrollment start date if none is recorded, and enrolls the
 * experiment games present in the catalog that are not enrolled yet, with
 * reason `experiment` and `now` as their enrollment time. Returns the start
 * date and the entities enrolled now.
 */
async function recordEnrollment(db: AppDatabase, now: Date): Promise<{ enrollmentStartDate: string; enrolled: number[] }> {
  let enrollmentStartDate = utcDay(now);
  const enrolled: number[] = [];
  await writeTransaction(db, async () => {
    const recorded = await first<{ value: string }>(db, "SELECT value FROM checkpoints WHERE key = ?", ENROLLMENT_START_DATE_KEY);
    if (recorded) enrollmentStartDate = recorded.value;
    else await db.prepare("INSERT INTO checkpoints (key, value) VALUES (?, ?)").bind(ENROLLMENT_START_DATE_KEY, enrollmentStartDate).run();
    for (const appid of EXPERIMENT_GAMES) {
      const inserted = await db.prepare(
        "INSERT INTO media_enrollments (appid, reason, enrolled_at) SELECT appid, 'experiment', ? FROM apps WHERE appid = ? AND NOT EXISTS (SELECT 1 FROM media_enrollments WHERE appid = ?)",
      ).bind(now.toISOString(), appid, appid).run();
      if (inserted.meta.changes === 1) enrolled.push(appid);
    }
  });
  return { enrollmentStartDate, enrolled };
}

/**
 * Starts `day`'s scheduled discovery run over the passes due at `now` of
 * every eligible enrolled root and its eligible DLC and expansions, initial
 * and later alike. A discovery run still open from an earlier day is closed
 * as superseded: its unserved queries stay due and this run takes them.
 * Returns the run's id, or null when no enrolled root is eligible.
 */
async function startScheduledDiscovery(db: AppDatabase, day: string, now: Date): Promise<number | null> {
  await db.prepare(
    "UPDATE media_discovery_runs SET status = 'stopped', stop_reason = 'superseded_by_daily_media_run', finished_at = ? WHERE status IN ('queued', 'running')",
  ).bind(now.toISOString()).run();
  const roots = await db.prepare(
    `SELECT enrollment.appid FROM media_enrollments AS enrollment
     JOIN apps AS app ON app.appid = enrollment.appid
     WHERE app.type = 'game' AND app.is_playable = 1 AND app.is_eligible = 1 AND app.parent_appid IS NULL
     ORDER BY enrollment.appid`,
  ).all<{ appid: number }>();
  const selected = (roots.results ?? []).map(({ appid }) => appid);
  if (selected.length === 0) return null;
  const identity = scheduledDiscoveryIdentity(day);
  await db.prepare(
    // A scheduled run serves both passes; each query and attempt records its
    // own pass, and the run's pass column keeps its `initial` default.
    "INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status, origin, started_at) VALUES ('initial', ?, ?, 'running', 'scheduled', ?) ON CONFLICT(identity_key) DO NOTHING",
  ).bind(identity, JSON.stringify(selected), now.toISOString()).run();
  return (await first<{ id: number }>(db, "SELECT id FROM media_discovery_runs WHERE identity_key = ?", identity))?.id ?? null;
}

/**
 * The daily media run, in the first ingestion tick at or after 06:00 UTC on
 * each UTC day. It shares the daily credit check's durable checkpoint, so it
 * runs once per UTC day, catches up once after downtime, and never makes up
 * a missed earlier day. In order, it records the enrollment start date and
 * the experiment enrollments, runs the daily provider credit checks, then
 * starts one scheduled discovery run, recorded in the same write as the
 * checkpoint. Returns null when it is not due.
 */
export async function runDailyMediaRun(
  db: AppDatabase,
  now: Date,
  options: Pick<MediaProcessingOptions, "openRouter" | "openRouterApiKey" | "openRouterTimeoutMs" | "providerFetch"> = {},
): Promise<DailyMediaRunSummary | null> {
  if (!await dailyCreditCheckDue(db, now)) return null;
  const day = utcDay(now);
  const { enrollmentStartDate, enrolled } = await recordEnrollment(db, now);
  let discoveryRunId: number | null = null;
  const probe = await runMediaDailyCreditCheck(db, now, options, async () => {
    discoveryRunId = await startScheduledDiscovery(db, day, now);
  });
  if (probe === null) return null;
  return { day, enrollmentStartDate, enrolled, discoveryRunId, probe };
}

/** `now`'s UTC day's scheduled discovery run while it is still open: queued, or interrupted while running. */
export async function openScheduledDiscovery(db: AppDatabase, now: Date): Promise<number | null> {
  const run = await first<{ id: number }>(
    db,
    "SELECT id FROM media_discovery_runs WHERE identity_key = ? AND status IN ('queued', 'running')",
    scheduledDiscoveryIdentity(utcDay(now)),
  );
  return run?.id ?? null;
}

/** The latest scheduled discovery run, which automatic paid work is attributed to. */
export async function latestScheduledDiscovery(db: AppDatabase): Promise<number | null> {
  return (await first<{ id: number }>(db, "SELECT id FROM media_discovery_runs WHERE origin = 'scheduled' ORDER BY id DESC LIMIT 1"))?.id ?? null;
}
