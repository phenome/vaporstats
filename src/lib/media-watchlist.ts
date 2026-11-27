import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import { mainReleasedDate, type MainReleasedFields } from "./lifecycle-history";
import { isOutletDenialStop, MEDIA_OUTLETS, servedPreviewSearches } from "./media-outlet-access";
import { ELIGIBLE_MEDIA_ENTITY_SQL, ELIGIBLE_MEDIA_ROOT_SQL } from "./media-similarity";
import { MONTH_MAP, parsePreciseReleaseDate } from "./releases";

export const PREVIEW_CEILING = 15;
export const PREVIEW_DEFERRAL_KEY = "media:preview-deferred-month";

/** The percentage of the Search provider's monthly plan credits that preview searches may use before the review reservation can defer them. */
export const PREVIEW_MONTHLY_CREDIT_SHARE_PERCENT = 10;

/**
 * Preview searches a UTC month allows before the review reservation applies:
 * 10% of the plan limit the usage endpoint reports, rounded down. With no
 * reported plan limit the share is 0, so the reservation applies from the
 * first preview search.
 */
export function previewMonthlyCreditShare(planLimit: number | null): number {
  return planLimit === null || !Number.isFinite(planLimit) || planLimit <= 0 ? 0 : Math.floor((planLimit * PREVIEW_MONTHLY_CREDIT_SHARE_PERCENT) / 100);
}

/**
 * Whether the deferral recorded for `month` holds previews in the schedule
 * a status reports. The schedule has no usage reading of its own, so it uses
 * the plan limit the latest scheduled discovery run recorded; a deferral
 * holds only once the month's preview searches reach their share of it.
 */
async function previewDeferralHolds(db: AppDatabase, month: string): Promise<boolean> {
  const recorded = await db.prepare(
    `SELECT json_extract(usage, '$.planLimit') AS plan_limit FROM media_discovery_runs
     WHERE origin = 'scheduled' AND json_valid(usage) AND json_extract(usage, '$.planLimit') IS NOT NULL ORDER BY id DESC LIMIT 1`,
  ).first<{ plan_limit: number }>();
  return await servedPreviewSearches(db, month) >= previewMonthlyCreditShare(recorded?.plan_limit ?? null);
}

const PERIOD_STARTS: Readonly<Record<string, string>> = {
  q1: "01-01", q2: "04-01", q3: "07-01", q4: "10-01",
  early: "01-01", spring: "03-20", summer: "06-21", fall: "09-22", autumn: "09-22",
  winter: "12-21", mid: "07-01", late: "09-01",
};

export function expectedMediaReleaseDate(value: string | null): string | null {
  const precise = parsePreciseReleaseDate(value);
  if (precise) return precise;
  const date = value?.trim().toLowerCase() ?? "";
  if (/^\d{4}$/.test(date)) return `${date}-01-01`;
  const match = /^([a-z]+|q[1-4])\s+(\d{4})$/.exec(date);
  if (!match) return null;
  const [, period, year] = match;
  const month = period === "sept" ? 9 : Object.hasOwn(MONTH_MAP, period) ? MONTH_MAP[period] : null;
  const start = month ? `${String(month).padStart(2, "0")}-01` : PERIOD_STARTS[period];
  return typeof start === "string" ? `${year}-${start}` : null;
}

export function shiftMediaDay(day: string, days: number): string {
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shiftCalendarMonths(day: string, months: number): string {
  const date = new Date(day);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(originalDay, end.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

export function previewInterval(day: string, expected: string | null): number {
  if (!expected || expected >= shiftCalendarMonths(day, 12)) return 30;
  return expected >= shiftCalendarMonths(day, 1) ? 7 : 1;
}

export function mediaGameIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  // The final negative lookahead requires the actual end, including for JSON
  // strings with a trailing line terminator.
  return /^\d+(?![\s\S])/.test(value)
    ? /^[1-9][0-9]{0,9}(?![\s\S])/.test(value)
    : /^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/.test(value);
}

type Coverage = MainReleasedFields & {
  appid: number;
  name: string;
  storefront_release_date_text: string | null;
  covered_at: string;
  watched_at: string;
  unwatched_at: string | null;
  observed_released_on: string | null;
  review_eligible_at: string | null;
  eligible: number;
};

async function coverageRows(db: AppDatabase, root: number | null = null): Promise<Coverage[]> {
  return (await db.prepare(
    `SELECT app.appid, app.name, app.release_status, app.release_date, app.release_date_source,
            app.steam_release_date, app.original_release_date, app.storefront_release_date_text, coverage.covered_at,
            coverage.observed_released_on, coverage.review_eligible_at, watch.watched_at, watch.unwatched_at,
            app.is_eligible = 1 AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
              AND COALESCE(app.parent_appid, app.appid) = watch.appid
              AND EXISTS (SELECT 1 FROM apps AS app WHERE app.appid = watch.appid AND ${ELIGIBLE_MEDIA_ROOT_SQL}) AS eligible
     FROM media_watch_coverage AS coverage JOIN apps AS app ON app.appid = coverage.appid
     JOIN media_watches AS watch ON watch.appid = coverage.root_appid
     WHERE (? IS NULL OR watch.appid = ?) ORDER BY app.appid`,
  ).bind(root, root).all<Coverage>()).results ?? [];
}

async function recordCoverage(db: AppDatabase, at: string, root: number | null = null): Promise<void> {
  await db.prepare(
    `INSERT INTO media_watch_coverage (appid, root_appid, covered_at)
     SELECT app.appid, watch.appid, ? FROM media_watches AS watch
     JOIN apps AS app ON COALESCE(app.parent_appid, app.appid) = watch.appid
     WHERE watch.unwatched_at IS NULL AND (? IS NULL OR watch.appid = ?)
       AND app.is_eligible = 1 AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
       AND EXISTS (SELECT 1 FROM apps AS app WHERE app.appid = watch.appid AND ${ELIGIBLE_MEDIA_ROOT_SQL})
     ON CONFLICT(appid) DO UPDATE SET root_appid = excluded.root_appid
     WHERE media_watch_coverage.root_appid <> excluded.root_appid`,
  ).bind(at, root, root).run();
  await recordObservedReleaseDates(db, at, root);
}

async function recordObservedReleaseDates(db: AppDatabase, at: string, root: number | null): Promise<void> {
  for (const entity of await coverageRows(db, root)) {
    if (!entity.eligible || entity.release_status !== "released" || entity.review_eligible_at) continue;
    const observed = parsePreciseReleaseDate(mainReleasedDate(entity)?.date) ? null : at.slice(0, 10);
    await db.prepare(
      "UPDATE media_watch_coverage SET review_eligible_at = ?, observed_released_on = ? WHERE appid = ?",
    ).bind(at, observed, entity.appid).run();
  }
}

export async function endPreviewOccurrence(db: AppDatabase, id: number, at: string, reason: string): Promise<void> {
  const pending = await db.prepare(
    "SELECT id, stop_reason FROM media_discovery_progress WHERE occurrence_id = ? AND status <> 'completed'",
  ).bind(id).all<{ id: number; stop_reason: string | null }>();
  for (const query of pending.results ?? []) {
    if (query.stop_reason && isOutletDenialStop(query.stop_reason)) continue;
    await db.prepare("UPDATE media_discovery_progress SET status = 'stopped', stop_reason = ?, stopped_at = ? WHERE id = ?")
      .bind(reason, at, query.id).run();
  }
  await db.prepare(
    "UPDATE media_preview_occurrences SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
  ).bind(at, reason, id).run();
}

async function latestOccurrence(db: AppDatabase, appid: number) {
  return db.prepare(
    "SELECT id, scheduled_on, due_at, ended_at, end_reason FROM media_preview_occurrences WHERE appid = ? ORDER BY scheduled_on DESC LIMIT 1",
  ).bind(appid).first<{ id: number; scheduled_on: string; due_at: string; ended_at: string | null; end_reason: string | null }>();
}

function nextPreviewDay(entity: Coverage, day: string, previous: Awaited<ReturnType<typeof latestOccurrence>>): string {
  const watchedOn = (entity.watched_at > entity.covered_at ? entity.watched_at : entity.covered_at).slice(0, 10);
  if (!previous) return watchedOn;
  if (previous.ended_at !== null && previous.ended_at <= entity.watched_at) return watchedOn;
  const expected = parsePreciseReleaseDate(entity.release_date) ?? parsePreciseReleaseDate(entity.steam_release_date) ??
    expectedMediaReleaseDate(entity.storefront_release_date_text ?? entity.release_date ?? entity.steam_release_date);
  return shiftMediaDay(previous.scheduled_on, previewInterval(day, expected));
}

/** Called at the durable daily checkpoint, before any search can be issued. */
export async function scheduleWatchedMedia(db: AppDatabase, now: Date): Promise<void> {
  const at = now.toISOString();
  const day = at.slice(0, 10);
  await recordCoverage(db, at);
  for (const entity of await coverageRows(db)) {
    const previous = await latestOccurrence(db, entity.appid);
    const capped = await previewCeilingReached(db, entity.appid);
    const stop = !entity.eligible ? "entity_ineligible" : entity.release_status === "released" ? "released"
      : entity.unwatched_at ? "unwatched" : capped ? "preview_ceiling" : null;
    if (stop) {
      if (previous && !previous.ended_at) await endPreviewOccurrence(db, previous.id, at, stop);
      continue;
    }
    const next = nextPreviewDay(entity, day, previous);
    if (next > day || previous?.scheduled_on === day) continue;
    if (previous && !previous.ended_at) await endPreviewOccurrence(db, previous.id, at, "superseded");
    await db.prepare(
      "INSERT INTO media_preview_occurrences (appid, scheduled_on, due_at) VALUES (?, ?, ?)",
    ).bind(entity.appid, day, previous && !previous.ended_at ? previous.due_at : `${next}T06:00:00.000Z`).run();
  }
}

/** Materialize every outlet at the checkpoint so cancellation and superseding retain its outcome. */
export async function preparePreviewQueries(db: AppDatabase, runId: number, day: string): Promise<void> {
  await db.prepare(
    `INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, occurrence_id, pass_due_at)
     SELECT ?, occurrence.appid, 'preview', outlet.value, occurrence.id, occurrence.due_at
     FROM media_preview_occurrences AS occurrence CROSS JOIN json_each(?) AS outlet
     WHERE occurrence.ended_at IS NULL AND occurrence.scheduled_on <= ?
     ON CONFLICT(occurrence_id, outlet) DO NOTHING`,
  ).bind(runId, JSON.stringify(MEDIA_OUTLETS.map(({ name }) => name)), day).run();
}

export async function previewCeilingReached(db: AppDatabase, appid: number): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM media_sources WHERE appid = ? AND pass = 'preview'").bind(appid).first<{ count: number }>();
  return (row?.count ?? 0) >= PREVIEW_CEILING;
}

export async function changeMediaWatch(db: AppDatabase, action: "watch" | "unwatch", game: string, now: Date) {
  return writeTransaction(db, async () => {
    const byAppid = /^\d+$/.test(game);
    const matches = (await db.prepare(
      `SELECT app.appid, app.name, app.release_status, app.parent_appid, app.type, ${ELIGIBLE_MEDIA_ROOT_SQL} AS eligible
       FROM apps AS app WHERE ${byAppid ? "appid" : "slug"} = ? ORDER BY appid`,
    ).bind(byAppid ? Number(game) : game).all<{
      appid: number; name: string; release_status: string; parent_appid: number | null; type: string; eligible: number;
    }>()).results ?? [];
    const root = matches[0];
    if (!root) return { status: 404, body: { error: "Catalog game not found" } };
    if (matches.length > 1) return { status: 409, body: { error: `Ambiguous catalog slug: matching AppIDs ${matches.map(({ appid }) => appid).join(", ")}` } };
    if (root.parent_appid !== null && ["dlc", "expansion"].includes(root.type)) {
      const parent = await db.prepare("SELECT name FROM apps WHERE appid = ?").bind(root.parent_appid).first<{ name: string }>();
      return { status: 422, body: { error: `${root.name} is a DLC of ${parent?.name ?? "the root game"} (AppID ${root.parent_appid}); watch the root game instead` } };
    }
    if (!root.eligible) return { status: 422, body: { error: `${root.name} is ineligible for media discovery: an eligible playable root game is required` } };
    const at = now.toISOString();
    const existing = await db.prepare("SELECT watched_at, unwatched_at FROM media_watches WHERE appid = ?").bind(root.appid)
      .first<{ watched_at: string; unwatched_at: string | null }>();
    const active = existing !== null && existing.unwatched_at === null;
    const watched = action === "watch";
    if (watched && !active) {
      await db.prepare(
        `INSERT INTO media_watches (appid, watched_at) VALUES (?, ?)
         ON CONFLICT(appid) DO UPDATE SET watched_at = excluded.watched_at, unwatched_at = NULL`,
      ).bind(root.appid, at).run();
      await db.prepare(
        "INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (?, 'watchlist', ?) ON CONFLICT(appid) DO NOTHING",
      ).bind(root.appid, at).run();
      await recordCoverage(db, at, root.appid);
    } else if (!watched && active) {
      await recordObservedReleaseDates(db, at, root.appid);
      await db.prepare("UPDATE media_watches SET unwatched_at = ? WHERE appid = ?").bind(at, root.appid).run();
      const open = await db.prepare(
        `SELECT occurrence.id FROM media_preview_occurrences AS occurrence
         JOIN media_watch_coverage AS coverage ON coverage.appid = occurrence.appid
         WHERE coverage.root_appid = ? AND occurrence.ended_at IS NULL`,
      ).bind(root.appid).all<{ id: number }>();
      for (const { id } of open.results ?? []) await endPreviewOccurrence(db, id, at, "unwatched");
    }
    return {
      status: 200,
      body: {
        appid: root.appid, name: root.name, releaseStatus: root.release_status, watched,
        changed: watched !== active,
        watchedAt: watched && !active ? at : existing?.watched_at ?? null,
        unwatchedAt: !watched && active ? at : watched ? null : existing?.unwatched_at ?? null,
      },
    };
  });
}

export async function mediaWatchSchedule(db: AppDatabase, root: number, now: Date, assessments: ReadonlyMap<number, { pass: string; dueAt: string }>) {
  const at = now.toISOString();
  const day = at.slice(0, 10);
  const run = await db.prepare("SELECT status FROM media_discovery_runs WHERE identity_key = ?")
    .bind(`scheduled:${day}`).first<{ status: string }>();
  const nextDaily = run ? shiftMediaDay(day, 1) : day;
  const deferred = await db.prepare("SELECT value FROM checkpoints WHERE key = ?")
    .bind(PREVIEW_DEFERRAL_KEY).first<{ value: string }>();
  const entities = await coverageRows(db, root);
  if (entities.length === 0) {
    const game = await db.prepare(
      `SELECT appid, name, release_status, release_date, release_date_source, steam_release_date, original_release_date
       FROM apps WHERE appid = ?`,
    ).bind(root).first<MainReleasedFields & { appid: number; name: string }>();
    return game ? [assessmentSchedule(game)] : [];
  }

  function assessmentSchedule(entity: MainReleasedFields & { appid: number; name: string; observed_released_on?: string | null }) {
    const assessment = assessments.get(entity.appid);
    return {
      appid: entity.appid,
      name: entity.name,
      releaseStatus: entity.release_status,
      schedulingReleaseDate: entity.observed_released_on ?? parsePreciseReleaseDate(mainReleasedDate(entity)?.date),
      releaseDateSource: entity.observed_released_on ? "observed" : "catalog",
      next: assessment ? { ...assessment, dueAt: `${[assessment.dueAt.slice(0, 10), nextDaily].sort()[1]}T06:00:00.000Z` } : null,
    };
  }

  return Promise.all(entities.map(async (entity) => {
    const next = assessmentSchedule(entity);
    if (!entity.eligible || entity.unwatched_at || entity.release_status === "released" || await previewCeilingReached(db, entity.appid)) return next;
    const previous = await latestOccurrence(db, entity.appid);
    let dueOn = nextDaily;
    if (!previous || previous.ended_at) {
      // Cadence can tighten between today's checkpoint and the projected search.
      while (dueOn < nextPreviewDay(entity, dueOn, previous)) dueOn = shiftMediaDay(dueOn, 1);
    }
    if (deferred?.value === dueOn.slice(0, 7) && await previewDeferralHolds(db, deferred.value)) dueOn = `${shiftMediaDay(`${deferred.value}-01`, 32).slice(0, 7)}-01`;
    return { ...next, next: { pass: "preview", dueAt: `${dueOn}T06:00:00.000Z` } };
  }));
}
