import { Readability } from "@mozilla/readability";
import { MIN_USABLE_ARTICLE_CHARS, parseArticleDocument } from "./article-document";
import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import { ENROLLMENT_START_DATE_KEY, isNewReleaseDate } from "./media-enrollment";
import { boundedMediaError } from "./media-error";
import { mainReleasedDate, type MainReleasedFields } from "./lifecycle-history";
import { fetchOutletArticle, finishOutletAttempt, hostInOutlet, isOutletDenialStop, outletDenial, MEDIA_OUTLETS, OUTLET_HTTP_STOPS, OUTLET_STOP_REASONS, reserveOutletAttempt, type MediaOutlet } from "./media-outlet-access";
import { isMediaOverviewPublic, MEDIA_EXPERIMENT_GAMES, PUBLIC_MEDIA_ROOT_SQL } from "./media-publication";
import { parsePreciseReleaseDate } from "./releases";
import { ELIGIBLE_MEDIA_ENTITY_SQL, ELIGIBLE_MEDIA_ROOT_SQL } from "./media-similarity";
import { createTavilyTransport } from "./media-tavily";

import { endPreviewOccurrence, PREVIEW_DEFERRAL_KEY, previewCeilingReached, shiftMediaDay } from "./media-watchlist";

export { MEDIA_GAME_CHOICES, type MediaGameChoice } from "./media-publication";
export { MEDIA_OUTLETS, type MediaOutlet } from "./media-outlet-access";
type AssessmentPass = "initial" | "later";
export type MediaPass = AssessmentPass | "preview";
export type MediaArticleType = "review" | "preview" | "announcement";

export interface MediaOutletShortfall {
  required: number;
  actual: number;
  missing: MediaOutlet[];
}

export interface MediaSource {
  appid: number;
  originalUrl: string;
  discoveryUrl: string | null;
  title: string;
  outlet: MediaOutlet;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  retrievedAt: string;
  type: MediaArticleType;
  handsOn: boolean | null;
  affiliation: string | null;
  platform: string | null;
  buildContext: string | null;
}

export interface MediaRunAuthorization {
  authorized: true;
  runId: number;
  pass: MediaPass;
  games: number[];
  identity: string;
  resumed: boolean;
}

export interface MediaRunSummary {
  runId: number;
  pass: MediaPass;
  status: "completed" | "stopped" | "failed";
  games: number[];
  resumed: boolean;
  newIdentity: boolean;
  /** Queries searched so far in the pass, across every run. */
  queries: number;
  /** Outlet attempts recorded so far in the pass, across every run and stage. */
  attempts: number;
  /** Articles accepted so far in the pass, across every run. */
  articles: number;
  /** What this call itself did: searches issued, outlet attempts reserved and articles accepted. */
  issued: { searches: number; attempts: number; articles: number };
  stopReasons: string[];
  summary: {
    runId: number;
    status: "completed" | "stopped" | "failed";
    discovered: number;
    accepted: number;
    skipped: number;
    sourceFailures: number;
    outletShortfall: MediaOutletShortfall | null;
    stopReason?: string | null;
    error?: string;
    counts?: { discovered: number; accepted: number; skipped: number; sourceFailures: number; queries: number; attempts: number; articles: number };
  };
  usage: { remainingCredits: number | null; plan: "free" | "rejected" | "unknown"; planUsageAtStart: number | null; planUsage: number | null; planLimit: number | null; paygoUsage: number | null; paygoLimit: number | null; searchCreditsConsumed: number };
}

type MediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type MediaClock = () => Date;

export interface MediaDiscoveryOptions {
  runId?: number;
  pass?: MediaPass;
  games?: readonly number[];
  tavilyApiKey?: string;
  fetch?: MediaFetch;
  now?: Date | (() => Date);
}

/** The ceiling of accepted articles per exact entity, shared by the initial and later passes. */
export const MAX_MEDIA_ARTICLES_PER_GAME = 15;

type RunRow = {
  id: number;
  pass: MediaPass;
  identity_key: string;
  selected_games: string;
  status: string;
  resumed: number;
  query_count: number;
  article_count: number;
  attempt_count: number;
  provider_request_ids: string;
  usage: string;
  stop_reason: string | null;
  summary: string;
  origin: string;
  started_at: string | null;
};

type ProgressRow = {
  id: number;
  run_id: number;
  appid: number;
  pass: MediaPass;
  outlet: MediaOutlet;
  status: string;
  query_attempted_at: string | null;
  pass_due_at: string | null;
  occurrence_id: number | null;
  candidate_urls: string;
  candidate_index: number;
  stop_reason: string | null;
  stopped_at: string | null;
  completed_at: string | null;
};

const RUN_COLUMNS = "id, pass, identity_key, selected_games, status, resumed, query_count, article_count, attempt_count, provider_request_ids, usage, stop_reason, summary, origin, started_at";
const PROGRESS_COLUMNS = "id, run_id, appid, pass, outlet, status, query_attempted_at, pass_due_at, occurrence_id, candidate_urls, candidate_index, stop_reason, stopped_at, completed_at";

type TavilyResult = { url?: unknown; published_date?: unknown };

type Candidate = { url: string; publishedDate: string | null };
type MediaTarget = {
  appid: number;
  name: string;
  parentAppid: number | null;
  aliases: readonly string[];
};

type MediaTargetRow = {
  appid: number;
  name: string;
  parent_appid: number | null;
};

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}
function hasEntityAlias(text: string, alias: string): boolean {
  for (let offset = 0; offset <= text.length - alias.length;) {
    const index = text.indexOf(alias, offset);
    if (index < 0) return false;
    const before = text[index - 1];
    const after = text[index + alias.length];
    if ((!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after))) return true;
    offset = index + alias.length;
  }
  return false;
}

function rootAppid(target: MediaTarget): number {
  return target.parentAppid ?? target.appid;
}



async function loadMediaTargets(db: AppDatabase, roots: readonly number[]): Promise<MediaTarget[]> {
  const rootsJson = JSON.stringify(roots);
  const targetRows = await rows<MediaTargetRow>(
    db,
    `SELECT app.appid, app.name, app.parent_appid
     FROM apps AS app
     WHERE COALESCE(app.parent_appid, app.appid) IN (SELECT value FROM json_each(?))
       AND app.is_eligible = 1
       AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
     ORDER BY appid`,
    rootsJson,
  );
  return targetRows.map((row) => {
    const metadata = row.parent_appid === null
      ? MEDIA_EXPERIMENT_GAMES.find((game) => game.appid === row.appid)
      : undefined;
    const normalizedName = normalizeTitle(row.name);
    const parentName = row.parent_appid === null
      ? ""
      : normalizeTitle(targetRows.find((candidate) => candidate.appid === row.parent_appid)?.name ?? "");
    const suffix = parentName ? normalizedName.slice(parentName.length) : "";
    const childName = parentName && normalizedName.startsWith(parentName) && /^[\s:–—-]+/.test(suffix)
      ? suffix.replace(/^[\s:–—-]+/, "").trim()
      : "";
    const aliases = [...new Set([normalizedName, childName, ...(metadata?.aliases ?? []).map(normalizeTitle)].filter(Boolean))];
    return { appid: row.appid, name: row.name, parentAppid: row.parent_appid, aliases };
  });
}


function validGameIds(games: readonly number[]): number[] {
  const valid = new Set(MEDIA_EXPERIMENT_GAMES.map((game) => game.appid));
  if (!Array.isArray(games) || games.length === 0) throw new Error("games must be a non-empty array");
  const result = [...new Set(games)];
  if (result.length !== games.length || result.some((id) => !Number.isInteger(id) || !valid.has(id))) {
    throw new Error("games must contain only the supported game appids");
  }
  return result.sort((a, b) => a - b);
}


function parsePass(pass: unknown): asserts pass is MediaPass {
  if (pass !== "initial" && pass !== "later") throw new Error("Unknown media discovery pass");
}

/** Only the initial pass can be authorized; the later pass runs only from the daily media run. */
function parseAuthorizablePass(pass: unknown): asserts pass is "initial" {
  if (pass !== "initial") throw new Error("Only the initial media discovery pass can be authorized");
}

function identityFor(pass: MediaPass, games: readonly number[]): string {
  return `${pass}:${[...games].sort((a, b) => a - b).join(",")}`;
}

function isoNow(value: Date | (() => Date) | undefined): Date {
  const result = typeof value === "function" ? value() : value;
  const date = result ?? new Date();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Invalid media discovery clock");
  return new Date(date.getTime());
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function json<T>(value: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(value ?? "") as T;
  } catch {
    return fallback;
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function rows<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T[]> {
  const result = await db.prepare(query).bind(...values).all<T>();
  return result.results ?? [];
}

function transaction<T>(db: AppDatabase, work: () => Promise<T>): Promise<T> {
  return writeTransaction(db, work);
}

async function prepareProgressForAuthorization(
  db: AppDatabase,
  runId: number,
  pass: MediaPass,
  games: readonly number[],
  includeCompleted: boolean,
): Promise<void> {
  const statusFilter = includeCompleted ? "" : " AND status <> 'completed'";
  const gamesJson = JSON.stringify(games);
  await db.prepare(
    `UPDATE media_discovery_progress
     SET run_id = ?,
         status = CASE
           WHEN status IN ('queued', 'searching', 'fetching')
             THEN CASE WHEN query_attempted_at IS NULL THEN 'queued' ELSE 'fetching' END
           ELSE status
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE pass = ?
       AND appid IN (SELECT value FROM json_each(?))
       ${statusFilter}`,
  ).bind(runId, pass, gamesJson).run();
}

/**
 * Stops that hold a query only for the rest of their UTC day: an Outlet day
 * stop (the daily attempt cap or an outlet rate limit) or the search
 * provider's rate limit. Any other stop, an Outlet denial, never reopens.
 */
const DAY_SCOPED_STOPS = [OUTLET_STOP_REASONS.DAILY_ATTEMPT_CAP, "search_http_429", OUTLET_HTTP_STOPS[429], "tavily_search_http_429"] as const;
const DAY_SCOPED_STOPS_SQL = DAY_SCOPED_STOPS.map((reason) => `'${reason}'`).join(", ");
const ENTITY_INELIGIBLE = "entity_ineligible";

/** Preserve finished queries and stop pending queries for enrollments that lost catalog eligibility. */
export async function skipIneligibleMediaPasses(db: AppDatabase, runId: number, at: Date): Promise<void> {
  const outlets = JSON.stringify(MEDIA_OUTLETS.map(({ name }) => name));
  const stoppedAt = at.toISOString();
  await db.prepare(
    `INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, status, stop_reason, stopped_at)
     SELECT ?, app.appid, pass.value, outlet.value, 'stopped', ?, ?
     FROM media_enrollments AS enrollment
     JOIN apps AS app ON app.appid = enrollment.appid
     CROSS JOIN json_each('["initial","later"]') AS pass
     CROSS JOIN json_each(?) AS outlet
     WHERE NOT (${ELIGIBLE_MEDIA_ROOT_SQL})
     ON CONFLICT(appid, outlet, pass) WHERE occurrence_id IS NULL DO NOTHING`,
  ).bind(runId, ENTITY_INELIGIBLE, stoppedAt, outlets).run();
  await db.prepare(
    `UPDATE media_discovery_progress
     SET status = 'stopped', stop_reason = ?, stopped_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE (status IN ('queued', 'searching', 'fetching') OR (status = 'stopped' AND stop_reason IN (${DAY_SCOPED_STOPS_SQL})))
       AND EXISTS (
         SELECT 1 FROM apps AS app
         WHERE app.appid = media_discovery_progress.appid AND (
           EXISTS (SELECT 1 FROM media_enrollments WHERE appid = app.appid AND NOT (${ELIGIBLE_MEDIA_ROOT_SQL}))
           OR (
             EXISTS (SELECT 1 FROM media_enrollments WHERE appid = app.parent_appid)
             AND NOT (app.is_eligible = 1 AND ${ELIGIBLE_MEDIA_ENTITY_SQL})
           )
         )
       )`,
  ).bind(ENTITY_INELIGIBLE, stoppedAt).run();
}

/**
 * Reopens the queries of `passes` for `games` that a day-scoped stop held on
 * an earlier UTC day than `day`. Reopening depends only on the day of the
 * stop; whether a search or fetch is then admitted is decided by the
 * outlet's rules for `day`. An Outlet denial never reopens.
 */
async function reopenDayScopedProgress(
  db: AppDatabase,
  runId: number,
  passes: readonly MediaPass[],
  games: readonly number[],
  day: string,
): Promise<void> {
  await db.prepare(
    `UPDATE media_discovery_progress
     SET run_id = ?,
         status = CASE WHEN query_attempted_at IS NULL THEN 'queued' ELSE 'fetching' END,
         stop_reason = NULL,
         stopped_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE pass IN (SELECT value FROM json_each(?))
       AND appid IN (SELECT value FROM json_each(?))
       AND status = 'stopped'
       AND stop_reason IN (${DAY_SCOPED_STOPS_SQL})
       AND (stopped_at IS NULL OR substr(stopped_at, 1, 10) < ?)`,
  ).bind(runId, JSON.stringify(passes), JSON.stringify(games), day).run();
}

/** A pass of one entity that a discovery run serves, and since when it has been due. */
type DuePass = { target: MediaTarget; pass: AssessmentPass; dueAt: string; pendingInitial?: true };

/** A recorded time as an ISO timestamp; SQLite's `CURRENT_TIMESTAMP` form is UTC. */
function isoTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}.000Z` : new Date(Date.parse(value)).toISOString();
}

/**
 * When `outlets`' queries of one entity's pass have all finished, or null
 * while any of them has not: a query finishes when it completes or meets a
 * stop that never reopens, an Outlet denial. A query held by a day-scoped
 * stop, kept by a Provider stop, or never created is unfinished. A finished
 * pass with no recorded time counts as finished at the earliest time.
 */
function passFinishedAt(progress: readonly ProgressRow[], outlets: readonly MediaOutlet[]): string | null {
  let finishedAt = "";
  for (const outlet of outlets) {
    const row = progress.find((item) => item.outlet === outlet);
    if (!row) return null;
    const lastingStop = row.status === "stopped" && !(DAY_SCOPED_STOPS as readonly string[]).includes(row.stop_reason ?? "");
    if (row.status !== "completed" && !lastingStop) return null;
    const at = row.status === "completed" ? row.completed_at ?? row.query_attempted_at : row.stopped_at ?? row.query_attempted_at;
    if (at && isoTimestamp(at) > finishedAt) finishedAt = isoTimestamp(at);
  }
  return finishedAt;
}

const INITIAL_PASS_RELEASE_AGE_DAYS = 7;
const LATER_PASS_RELEASE_AGE_DAYS = 90;
const ASSESSMENT_OUTLETS = MEDIA_OUTLETS.map(({ name }) => name);

function releaseAgeDueAt(releasedOn: string, days: number): string {
  return new Date(Date.parse(`${releasedOn}T00:00:00.000Z`) + days * 86_400_000).toISOString();
}

function laterPassDueAt(initialFinishedAt: string, releasedOn: string | null, experiment: boolean): string | null {
  if (experiment) return initialFinishedAt;
  if (!releasedOn) return null;
  const releaseDueAt = releaseAgeDueAt(releasedOn, LATER_PASS_RELEASE_AGE_DAYS);
  return initialFinishedAt > releaseDueAt ? initialFinishedAt : releaseDueAt;
}

type AssessmentProgress = { initial: ProgressRow[]; later: ProgressRow[]; laterOutlets: MediaOutlet[] };
type MediaRelease = MainReleasedFields & { appid: number };

function startedDueAt(progress: readonly ProgressRow[], calculated: string | null): string | null {
  const recorded = progress.find((row) => row.pass_due_at)?.pass_due_at;
  if (recorded) return recorded;
  // Retained queries predate the due-time column. A correction must still
  // leave their unserved queries able to finish.
  const attempt = progress.find((row) => row.query_attempted_at)?.query_attempted_at;
  const attemptedAt = attempt ? isoTimestamp(attempt) : null;
  return attemptedAt && (!calculated || attemptedAt < calculated) ? attemptedAt : calculated;
}

/** An unwatched child is in scope if released by the day both root passes finished. */
function childWithinAssessmentWindow(
  app: MediaRelease | undefined,
  releasedOn: string | null,
  rootFinishedAt: string | null,
  experiment: boolean,
  asOfDay: string,
): boolean {
  if (app?.release_status !== "released") return false;
  // Preserve the experiment's existing coverage of released children whose
  // catalog dates cannot establish whether they preceded the cutoff.
  if (!releasedOn) return experiment;
  return releasedOn <= asOfDay && (rootFinishedAt === null || releasedOn <= rootFinishedAt.slice(0, 10));
}

/** The initial and later passes due at the start of this run, ordered by due time and entity. */
async function duePasses(db: AppDatabase, targets: readonly MediaTarget[], asOf: string, through = asOf): Promise<DuePass[]> {
  const appids = JSON.stringify(targets.map(({ appid }) => appid));
  const roots = JSON.stringify(targets.filter(({ parentAppid }) => parentAppid === null).map(({ appid }) => appid));
  const enrollments = new Map((await rows<{ appid: number; reason: string; enrolled_at: string; empty_later_finished_at: string | null }>(
    db,
    "SELECT appid, reason, enrolled_at, empty_later_finished_at FROM media_enrollments WHERE appid IN (SELECT value FROM json_each(?))",
    roots,
  )).map((row) => [row.appid, row]));
  const progress = new Map<number, AssessmentProgress>(
    targets.map(({ appid }) => [appid, { initial: [], later: [], laterOutlets: [] }]),
  );
  for (const row of await rows<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress WHERE pass <> 'preview' AND appid IN (SELECT value FROM json_each(?))`, appids)) {
    if (row.pass === "initial" || row.pass === "later") progress.get(row.appid)?.[row.pass].push(row);
  }
  for (const row of await rows<{ appid: number; outlet: MediaOutlet }>(
    db,
    "SELECT DISTINCT appid, outlet FROM media_sources WHERE pass = 'initial' AND appid IN (SELECT value FROM json_each(?))",
    appids,
  )) {
    progress.get(row.appid)?.laterOutlets.push(row.outlet);
  }
  const releases = new Map((await rows<MediaRelease>(
    db,
    "SELECT appid, release_status, release_date, release_date_source, steam_release_date, original_release_date FROM apps WHERE appid IN (SELECT value FROM json_each(?))",
    appids,
  )).map((app) => [app.appid, { app, releasedOn: parsePreciseReleaseDate(mainReleasedDate(app)?.date) }]));
  const covered = new Map((await rows<{ appid: number; root_appid: number; covered_at: string; observed_released_on: string | null }>(
    db, "SELECT appid, root_appid, covered_at, observed_released_on FROM media_watch_coverage WHERE appid IN (SELECT value FROM json_each(?))", appids,
  )).map((row) => [row.appid, row]));
  const enrollmentStart = await first<{ value: string }>(db, "SELECT value FROM checkpoints WHERE key = ?", ENROLLMENT_START_DATE_KEY);
  const asOfDay = asOf.slice(0, 10);
  const cappedRoots = new Map((await rows<{ appid: number; capped_at: string }>(
    db,
    `SELECT appid, MAX(retrieved_at) AS capped_at
     FROM media_sources
     WHERE pass <> 'preview' AND appid IN (SELECT value FROM json_each(?))
     GROUP BY appid HAVING COUNT(*) >= ?`,
    roots,
    MAX_MEDIA_ARTICLES_PER_GAME,
  )).map(({ appid, capped_at }) => [appid, isoTimestamp(capped_at)]));

  const rootCutoffs = new Map([...cappedRoots].filter(([, cappedAt]) => cappedAt <= asOf));
  const deferredRoots = new Set<number>();
  for (const [appid, enrollment] of enrollments) {
    const own = progress.get(appid)!;
    const initialFinishedAt = passFinishedAt(own.initial, ASSESSMENT_OUTLETS);
    const releasedOn = covered.get(appid)?.observed_released_on ?? releases.get(appid)?.releasedOn ?? null;
    const experiment = enrollment.reason === "experiment";
    if (!covered.has(appid) && initialFinishedAt === null && !experiment && !own.initial.some((row) => row.query_attempted_at !== null) &&
        enrollmentStart && !isNewReleaseDate(releasedOn, enrollmentStart.value, asOfDay)) deferredRoots.add(appid);
    if (initialFinishedAt === null) continue;
    const laterFinishedAt = passFinishedAt(own.later, own.laterOutlets);
    if (laterFinishedAt === null && enrollment.empty_later_finished_at === null) continue;
    // With zero represented outlets, the later pass has no searches to run.
    // Persist its cutoff before release corrections can move it.
    let finishedAt = enrollment.empty_later_finished_at ?? (laterFinishedAt || laterPassDueAt(initialFinishedAt, releasedOn, experiment));
    if (asOf === through && own.laterOutlets.length === 0 && enrollment.empty_later_finished_at === null && finishedAt !== null && finishedAt <= asOf) {
      const recorded = await first<{ empty_later_finished_at: string }>(
        db,
        `UPDATE media_enrollments
         SET empty_later_finished_at = COALESCE(empty_later_finished_at, ?)
         WHERE appid = ? RETURNING empty_later_finished_at`,
        finishedAt || asOf,
        appid,
      );
      finishedAt = recorded?.empty_later_finished_at ?? finishedAt;
    }
    const cutoff = rootCutoffs.get(appid);
    if (finishedAt !== null && finishedAt <= asOf && (!cutoff || finishedAt < cutoff)) rootCutoffs.set(appid, finishedAt);
  }

  const due: DuePass[] = [];
  for (const target of targets) {
    const enrollment = enrollments.get(rootAppid(target));
    if (!enrollment) continue;
    const own = progress.get(target.appid)!;
    const coverage = covered.get(target.appid);
    const watched = coverage?.root_appid === rootAppid(target) ? coverage : null;
    const release = releases.get(target.appid);
    const experiment = enrollment.reason === "experiment" && (!watched || target.parentAppid === null ||
      own.initial.some((row) => row.query_attempted_at !== null && row.query_attempted_at < watched.covered_at) ||
      childWithinAssessmentWindow(release?.app, release?.releasedOn ?? watched.observed_released_on, rootCutoffs.get(target.parentAppid) ?? null,
        true, watched.covered_at.slice(0, 10)));
    if (watched && (watched.covered_at > asOf || release?.app.release_status !== "released")) continue;
    const releasedOn = watched?.observed_released_on ?? release?.releasedOn ?? null;
    const initialFinishedAt = passFinishedAt(own.initial, ASSESSMENT_OUTLETS);
    const initialStarted = own.initial.some((row) => row.query_attempted_at !== null);
    if (!watched && deferredRoots.has(rootAppid(target))) {
      const currentPass = initialFinishedAt === null ? own.initial : own.later;
      if (target.parentAppid === null || !currentPass.some((row) => row.query_attempted_at !== null)) continue;
    }
    if (target.parentAppid !== null && !watched && !initialStarted && initialFinishedAt === null &&
        !childWithinAssessmentWindow(release?.app, releasedOn, rootCutoffs.get(target.parentAppid) ?? null, experiment, through.slice(0, 10))) continue;

    if (initialFinishedAt === null) {
      const releaseDue = releasedOn && releaseAgeDueAt(releasedOn, INITIAL_PASS_RELEASE_AGE_DAYS);
      const calculated = experiment ? isoTimestamp(enrollment.enrolled_at)
        : releaseDue && watched
          ? [releaseDue, `${watched.covered_at.slice(0, 10)}T00:00:00.000Z`].sort()[1]!
          : releaseDue;
      const dueAt = experiment ? calculated : startedDueAt(own.initial, calculated);
      if (dueAt !== null && dueAt <= through) {
        due.push({ target, pass: "initial", dueAt });
        const projected = asOf !== through && dueAt.slice(0, 10) < through.slice(0, 10)
          ? laterPassDueAt(dueAt, releasedOn, experiment) : null;
        if (projected && projected <= through) {
          due.push({ target, pass: "later", dueAt: projected, pendingInitial: true });
        }
      }
      continue;
    }
    if (own.laterOutlets.length === 0 || (target.parentAppid === null && enrollment.empty_later_finished_at !== null) ||
        passFinishedAt(own.later, own.laterOutlets) !== null) continue;
    const calculated = laterPassDueAt(initialFinishedAt, releasedOn, experiment);
    const dueAt = experiment ? calculated : startedDueAt(own.later, calculated);
    if (dueAt !== null && dueAt <= through) due.push({ target, pass: "later", dueAt });
  }
  return due.sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.target.appid - right.target.appid || left.pass.localeCompare(right.pass));
}

export async function nextMediaAssessment(db: AppDatabase, root: number, now: Date) {
  const targets = await loadMediaTargets(db, [root]);
  const upcoming = await duePasses(db, targets, now.toISOString(), "9999-12-31T23:59:59.999Z");
  const next = new Map<number, { pass: AssessmentPass; dueAt: string }>();
  for (const { target, pass, dueAt, pendingInitial } of upcoming) {
    if (!pendingInitial && !await articleCeiling(db, target.appid, pass)) next.set(target.appid, { pass, dueAt });
  }
  return next;
}

type PreviewOccurrence = { id: number; appid: number; due_at: string };

async function pendingPreviews(db: AppDatabase, targetAppids: number[], day: string): Promise<PreviewOccurrence[]> {
  return rows(db,
    `SELECT occurrence.id, occurrence.appid, occurrence.due_at FROM media_preview_occurrences AS occurrence
     JOIN media_watch_coverage AS coverage ON coverage.appid = occurrence.appid
     JOIN media_watches AS watch ON watch.appid = coverage.root_appid
     JOIN apps AS app ON app.appid = occurrence.appid
     WHERE occurrence.ended_at IS NULL AND occurrence.scheduled_on <= ? AND watch.unwatched_at IS NULL
       AND DATE(watch.watched_at) <= occurrence.scheduled_on AND app.release_status <> 'released'
       AND occurrence.appid IN (SELECT value FROM json_each(?))
     ORDER BY occurrence.due_at, occurrence.appid`, day, JSON.stringify(targetAppids));
}

async function previewOpen(db: AppDatabase, id: number, allowCompleted = false): Promise<boolean> {
  return await first(db, `SELECT occurrence.id FROM media_preview_occurrences AS occurrence
    JOIN media_watch_coverage AS coverage ON coverage.appid = occurrence.appid
    JOIN media_watches AS watch ON watch.appid = coverage.root_appid
    JOIN apps AS app ON app.appid = occurrence.appid
    WHERE occurrence.id = ? AND (occurrence.ended_at IS NULL OR (? AND occurrence.end_reason = 'completed'))
      AND watch.unwatched_at IS NULL AND (occurrence.ended_at IS NULL OR watch.watched_at <= occurrence.ended_at)
      AND app.release_status <> 'released' AND app.is_eligible = 1 AND ${ELIGIBLE_MEDIA_ENTITY_SQL}`, id, Number(allowCompleted)) !== null;
}

function needsSearch(progress: ProgressRow | undefined): boolean {
  return !progress || (!progress.query_attempted_at && progress.status !== "completed" &&
    (progress.status !== "stopped" || DAY_SCOPED_STOPS.some((stop) => stop === progress.stop_reason)));
}

/** Until initial discovery finishes, reserve room for any outlet that can still admit an initial source. */
async function canRequireLaterSearch(db: AppDatabase, appid: number, outlet: MediaOutlet, initialPending: boolean, initial?: ProgressRow): Promise<boolean> {
  return await first(db, "SELECT 1 FROM media_sources WHERE appid = ? AND outlet = ? AND pass = 'initial'", appid, outlet) !== null ||
    (initialPending && (!initial || initial.status === "queued" || initial.status === "searching" || initial.status === "fetching" ||
      (initial.status === "stopped" && DAY_SCOPED_STOPS.some((stop) => stop === initial.stop_reason))));
}

async function reviewSearchReservation(
  db: AppDatabase, targets: MediaTarget[], at: string, progress: ProgressRow[], denied: ReadonlySet<MediaOutlet>,
): Promise<number> {
  const monthEnd = `${shiftMediaDay(`${at.slice(0, 7)}-01`, 32).slice(0, 7)}-01T00:00:00.000Z`;
  const through = new Date(Date.parse(monthEnd) - 1).toISOString();
  const forecast = await duePasses(db, targets, at, through);
  const find = (appid: number, pass: MediaPass, outlet: MediaOutlet) =>
    progress.find((item) => item.appid === appid && item.pass === pass && item.outlet === outlet);
  let count = 0;
  for (const { target, pass, pendingInitial } of forecast) {
    if (await articleCeiling(db, target.appid, pass)) continue;
    for (const { name } of MEDIA_OUTLETS) {
      if (denied.has(name) || !needsSearch(find(target.appid, pass, name))) continue;
      if (pass === "later") {
        const initial = find(target.appid, "initial", name);
        if (!await canRequireLaterSearch(db, target.appid, name, pendingInitial === true, initial)) continue;
      }
      count += 1;
    }
  }
  return count;
}

async function admitSource(db: AppDatabase, pass: MediaPass, source: MediaSource, root: number): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO media_sources (appid, pass, original_url, discovery_url, title, outlet, author, published_at, updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context)
     SELECT app.appid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM apps AS app
     WHERE app.appid = ? AND app.is_eligible = 1 AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
       AND COALESCE(app.parent_appid, app.appid) = ?
       AND NOT EXISTS (SELECT 1 FROM media_sources WHERE appid = app.appid
         AND (original_url IN (?, ?) OR discovery_url IN (?, ?)))`,
  ).bind(pass, source.originalUrl, source.discoveryUrl, source.title, source.outlet, source.author, source.publishedAt, source.updatedAt,
    source.retrievedAt, source.type, source.handsOn === null ? null : Number(source.handsOn), source.affiliation, source.platform, source.buildContext, source.appid, root,
    source.originalUrl, source.discoveryUrl, source.originalUrl, source.discoveryUrl).run();
  return result.meta.changes === 1;
}

/**
 * Whether a later-pass article qualifies for its entity: the entity has an
 * accepted initial article from the same outlet, the article's URL is not
 * already one of the entity's sources, and a dated article was published
 * after each of that outlet's dated initial articles for the entity. An
 * undated initial article imposes no constraint, and the order between it and
 * the later article stays unknown. An undated article qualifies otherwise and
 * keeps its unknown date.
 */
async function qualifiesForLaterPass(db: AppDatabase, source: MediaSource): Promise<boolean> {
  const existing = await rows<{ pass: MediaPass; outlet: MediaOutlet; original_url: string; discovery_url: string | null; published_at: string | null }>(
    db,
    "SELECT pass, outlet, original_url, discovery_url, published_at FROM media_sources WHERE appid = ?",
    source.appid,
  );
  const urls = new Set(existing.flatMap((row) => [row.original_url, row.discovery_url ?? row.original_url]));
  if (urls.has(source.originalUrl) || (source.discoveryUrl !== null && urls.has(source.discoveryUrl))) return false;
  const initial = existing.filter((row) => row.pass === "initial" && row.outlet === source.outlet);
  if (initial.length === 0) return false;
  if (source.publishedAt === null) return true;
  const publishedAt = source.publishedAt;
  return initial.every((row) => row.published_at === null || Date.parse(row.published_at) < Date.parse(publishedAt));
}

/**
 * The entities a query of `pass` on `outlet` already admitted an article for
 * from its `considered` candidates. A query admits only articles found
 * through its own candidates, and records each one's candidate URL as its
 * discovery URL.
 */
async function admittedEntities(db: AppDatabase, pass: MediaPass, outlet: MediaOutlet, considered: readonly Candidate[]): Promise<Set<number>> {
  if (considered.length === 0) return new Set();
  const admitted = await rows<{ appid: number }>(
    db,
    "SELECT DISTINCT appid FROM media_sources WHERE pass = ? AND outlet = ? AND discovery_url IN (SELECT value FROM json_each(?))",
    pass,
    outlet,
    JSON.stringify(considered.map(({ url }) => url)),
  );
  return new Set(admitted.map(({ appid }) => appid));
}

/** The one query an entity's pass sends to each outlet's domain. */
function passQuery(target: MediaTarget, pass: MediaPass): string {
  if (pass === "preview") return `${target.name} preview hands-on announcement`;
  return pass === "initial" ? `${target.name} review preview` : `${target.name} review revisited`;
}

async function authorizeMediaRunNow(
  db: AppDatabase,
  input: { pass: MediaPass; games: readonly number[] },
): Promise<MediaRunAuthorization> {
  parseAuthorizablePass(input?.pass);
  const pass = input.pass;
  const games = validGameIds(input.games);
  const identity = identityFor(pass, games);
  let result!: MediaRunAuthorization;
  await transaction(db, async () => {
    const existing = await first<RunRow>(
      db,
      `SELECT ${RUN_COLUMNS} FROM media_discovery_runs WHERE identity_key LIKE ? ORDER BY id DESC LIMIT 1`,
      `${identity}:%`,
    );
    if (existing && (existing.status === "queued" || existing.status === "running")) {
      await db.prepare(
        "UPDATE media_discovery_runs SET status = 'running', resumed = 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?",
      ).bind(existing.id).run();
      await prepareProgressForAuthorization(db, existing.id, pass, games, true);
      result = { authorized: true, runId: existing.id, pass, games, identity: existing.identity_key, resumed: true };
      return;
    }
    const reusableProgress = Number((await first<{ count: number }>(
      db,
      "SELECT COUNT(*) AS count FROM media_discovery_progress WHERE pass = ? AND appid IN (SELECT value FROM json_each(?))",
      pass,
      JSON.stringify(games),
    ))?.count ?? 0);
    const identityWithNonce = `${identity}:${crypto.randomUUID()}`;
    const inserted = await db.prepare(
      "INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status, resumed, started_at) VALUES (?, ?, ?, 'running', ?, CURRENT_TIMESTAMP)",
    ).bind(pass, identityWithNonce, JSON.stringify(games), reusableProgress > 0 ? 1 : 0).run();
    if (!inserted.success) throw new Error("Unable to create media discovery run");
    const id = Number((await first<{ id: number }>(db, "SELECT id FROM media_discovery_runs WHERE identity_key = ?", identityWithNonce))?.id ?? 0);
    if (!id) throw new Error("Unable to create media discovery run");
    await prepareProgressForAuthorization(db, id, pass, games, false);
    result = { authorized: true, runId: id, pass, games, identity: identityWithNonce, resumed: reusableProgress > 0 };
  });
  return result;
}


let mediaAuthorizationQueue: Promise<unknown> = Promise.resolve();

export function authorizeMediaRun(
  db: AppDatabase,
  input: { pass: MediaPass; games: readonly number[] },
): Promise<MediaRunAuthorization> {
  const next = mediaAuthorizationQueue
    .catch(() => undefined)
    .then(() => authorizeMediaRunNow(db, input));
  mediaAuthorizationQueue = next;
  return next;
}


function cleanText(value: unknown): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, 500) : null;
}

function dateValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function meta(document: Document, ...names: string[]): string | null {
  for (const name of names) {
    const selector = `meta[property="${name}"],meta[name="${name}"]`;
    const content = document.querySelector(selector)?.getAttribute("content");
    if (content?.trim()) return content.trim();
  }
  return null;
}

function hasRoundupOrComparisonFraming(lead: string, body: string): boolean {
  const roundupLabel = /\b(?:in (?:this|our)|this is (?:a|our)|welcome to (?:this|our))\s+(?:\w+\s+){0,3}(?:round[- ]?up|listicle|ranking|list\s+of)\b/;
  const roundupIntro = /(?:\b(?:headlines?|leads?|opens?|anchors?) (?:this|our|the) round[- ]?up of|^(?:a|our) round[- ]?up of|^(?:here (?:are|is)|we (?:rounded up|ranked|picked|preview))\s+.{0,60}\b(?:games like|best games|top\s+\d+|several games|multiple games)\b)/;
  const comparisonIntro = /^(?:(?:a|our) (?:direct comparison|comparison (?:of|between))|we compare .{1,80} (?:against|and|with) )\b/;
  const comparisonLabel = /\b(?:this is a|in this|in our)\s+(?:direct comparison|comparison\s+(?:of|between)|(?:side[- ]by[- ]side|head[- ]to[- ]head) comparison)\b/;
  return roundupLabel.test(lead) || roundupIntro.test(lead) || comparisonIntro.test(lead) || comparisonLabel.test(body);
}

function parseSource(html: string, finalUrl: string, target: MediaTarget, targets: readonly MediaTarget[], outlet: MediaOutlet, retrievedAt: string, pass: MediaPass): MediaSource | null {
  const document = parseArticleDocument(html);
  if (!document) return null;
  for (const element of Array.from(document.querySelectorAll("script,style,noscript,template"))) element.remove();
  const titleMeta = meta(document, "og:title", "twitter:title");
  const authorMeta = meta(document, "author", "article:author");
  const canonicalMeta = meta(document, "og:url") ?? document.querySelector("link[rel='canonical']")?.getAttribute("href") ?? null;
  const publishedMeta = meta(document, "article:published_time", "datePublished");
  const updatedMeta = meta(document, "article:modified_time", "dateModified");
  const publishedTime = document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
  const platformMeta = meta(document, "game:platform", "article:platform");
  const buildMeta = meta(document, "game:build", "article:build");
  const affiliationMeta = meta(document, "author_affiliation", "article:author_affiliation");
  const gamesRadarReview = outlet === "GamesRadar+" &&
    (meta(document, "mrf:tags")?.split(";").includes("articleType:Reviews") ?? false);
  type ReadableResult = { title?: string; byline?: string; textContent?: string };
  let readable: ReadableResult | null = null;
  try {
    readable = new Readability(document).parse() as ReadableResult | null;
  } catch {
    readable = null;
  }
  const title = cleanText(titleMeta ?? readable?.title ?? document.querySelector("h1")?.textContent ?? document.title);
  const readableArticleText = readable?.textContent ?? document.querySelector("article")?.textContent ?? document.body?.textContent;
  const fullArticleText = typeof readableArticleText === "string" ? readableArticleText.replace(/\s+/g, " ").trim() : "";
  if (!title || fullArticleText.length < MIN_USABLE_ARTICLE_CHARS) return null;
  const titleLower = normalizeTitle(title);
  const bodyLower = normalizeTitle(fullArticleText);
  const articleLeadLower = bodyLower.slice(0, 240);
  const titleMatches = targets.flatMap((candidate) =>
    candidate.aliases.filter((alias) => hasEntityAlias(titleLower, alias)).map((alias) => {
      const parent = candidate.parentAppid === null ? null : targets.find((item) => item.appid === candidate.parentAppid);
      const parentAlias = parent?.aliases.find((parentAlias) => hasEntityAlias(titleLower, parentAlias)) ?? null;
      return { target: candidate, alias, score: alias.length + (parentAlias?.length ?? 0) };
    }),
  ).sort((left, right) => right.score - left.score || right.alias.length - left.alias.length);
  const selected = titleMatches[0];
  if (!selected) return null;
  const titleTargets = [...new Map(titleMatches.map((match) => [match.target.appid, match.target])).values()];
  const selectedRootAppid = rootAppid(selected.target);
  if (titleTargets.some((candidate) => rootAppid(candidate) !== selectedRootAppid)) return null;
  const titleChildren = titleTargets.filter((candidate) => candidate.parentAppid !== null);
  if (titleChildren.length > 1) return null;
  const articleLeadTargets = targets.filter((candidate) => candidate.aliases.some((alias) => hasEntityAlias(articleLeadLower, alias)));
  const articleLeadFamilies = new Set(articleLeadTargets.map(rootAppid));
  if (articleLeadFamilies.size > 1 || [...articleLeadFamilies].some((appid) => appid !== selectedRootAppid)) return null;
  const childMentions = articleLeadTargets.filter((candidate) => candidate.parentAppid !== null);
  if (childMentions.length > 1) return null;
  const titleChild = titleChildren[0] ?? null;
  const leadChild = childMentions[0] ?? null;
  if (titleChild && leadChild && titleChild.appid !== leadChild.appid) return null;
  const attributedTarget = titleChild ?? leadChild ?? selected.target;
  const rootCanAttributeChild = target.parentAppid === null && attributedTarget.parentAppid === target.appid;
  if (attributedTarget.appid !== target.appid && (pass === "preview" || !rootCanAttributeChild)) return null;
  if (/\b(patch notes|update notes|roadmap)\b/.test(titleLower)) return null;
  if (pass === "preview" && /\b(guide|walkthrough)\b/.test(titleLower)) return null;
  const announcement = /\b(announced|announcement|announces|revealed|reveal|trailer|launches)\b/.test(titleLower);
  if (announcement && pass !== "preview") return null;
  const reviewScoreNews = /\b(?:review\s+scores?|(?:gets?|earns?|receives?|scores?|rated)\s+(?:a\s+)?\d+(?:\.\d+)?\s*(?:\/\s*\d+|out of \d+))\b/.test(titleLower);
  const coTitledReview = /\b(?:and|&)\s+.+?\s+reviews?\b/.test(titleLower);
  const coTitledPreview = pass === "preview" && /(?:\band|&)\s+.+?\s+(?:previews?|announcements?)\b/.test(titleLower);
  const reviewRelatedNews = /\breviews?\s*(?:[:\-–—]\s*|\s+)(?:embargo(?:es)?|details?|reactions?|coverage|codes?|copies|policies?|discourse)\b|\b(?:embargo(?:es)?|details?|reactions?|coverage|codes?|copies|policies?|discourse)\s*(?:[:\-–—]\s*|\s+)(?:about|around|for|on|of|to)?\s*reviews?\b/.test(titleLower);
  if (reviewScoreNews || coTitledReview || coTitledPreview || reviewRelatedNews || /\b(round[- ]?up|best games?|games like|versus|\bvs\.?\b|comparison|ranking|ranked|top\s+\d+|lists?(?:icle)?|highest|metacritic|surpasses?|outperforms?|outscores?|beats?|review\s+drama|drama)\b/.test(titleLower)) return null;
  if (hasRoundupOrComparisonFraming(articleLeadLower, bodyLower)) return null;
  const byline = cleanText(authorMeta ?? readable?.byline ?? document.querySelector("[rel='author'],.byline,[class*='author']")?.textContent);
  const affiliation = cleanText(affiliationMeta);
  const developerAuthorship = /developer|official|cd projekt|larian studios|supergiant|valve/i;
  if (developerAuthorship.test(byline ?? "") || developerAuthorship.test(affiliation ?? "")) return null;
  const isReview = gamesRadarReview || /\breview\b/i.test(title) || /\bour review\b/i.test(fullArticleText.slice(0, 3_000));
  const explicitHandsOn = pass === "preview"
    ? !/\b(?:not (?:an? )?hands?[- ]on|non[- ]hands?[- ]on|no hands?[- ]on)\b/i.test(title) && (/\bhands?[- ]on\b/i.test(title) || /\b(?:we (?:played|went hands?[- ]on)|i played|after playing|played for)\b/i.test(fullArticleText.slice(0, 4_000)))
    : /\b(hands?[- ]on|we played|after playing|played for|impressions?)\b/i.test(`${title} ${fullArticleText.slice(0, 4_000)}`);
  const isPreview = /\b(preview|early access)\b/i.test(`${title} ${fullArticleText.slice(0, 4_000)}`);
  if (pass === "preview" ? isReview || !(isPreview || announcement) : !isReview && !(isPreview && explicitHandsOn)) return null;
  const handsOn = explicitHandsOn ? true : pass === "preview" ? false : null;
  const canonical = cleanText(canonicalMeta);
  let normalizedUrl: string;
  try {
    normalizedUrl = canonical ? new URL(canonical, finalUrl).toString() : finalUrl;
  } catch {
    return null;
  }
  const outletConfig = MEDIA_OUTLETS.find((item) => item.name === outlet);
  if (!outletConfig || !hostInOutlet(normalizedUrl, outletConfig)) return null;
  const articleType: MediaArticleType = isReview ? "review" : announcement && !/\bpreview\b/i.test(title) ? "announcement" : "preview";
  const platform = cleanText(platformMeta) ?? (/\b(pc|playstation|xbox|switch)\b/i.exec(fullArticleText.slice(0, 4_000))?.[1] ?? null);
  const buildContext = cleanText(buildMeta) ?? (/\bearly access (?:review|preview|build)\b|\breview(?:ed)? in early access\b/i.test(title) || /\bthis early access (?:review|build|preview)\b/i.test(fullArticleText) ? "Early Access" : null);
  return {
    appid: attributedTarget.appid,
    originalUrl: normalizedUrl,
    discoveryUrl: null,
    title,
    outlet,
    author: byline,
    publishedAt: dateValue(publishedMeta ?? publishedTime),
    updatedAt: dateValue(updatedMeta),
    retrievedAt,
    type: articleType,
    handsOn,
    affiliation,
    platform,
    buildContext,
  };
}

function candidateDate(candidate: MediaSource): number {
  return candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.MAX_SAFE_INTEGER;
}

/** Stops a query for `reason` at `at`, the run's clock, which decides when a day-scoped stop reopens. */
async function stopProgress(db: AppDatabase, progressId: number, reason: string, at: Date): Promise<void> {
  await db.prepare("UPDATE media_discovery_progress SET status = 'stopped', stop_reason = ?, stopped_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (occurrence_id IS NULL OR EXISTS (SELECT 1 FROM media_preview_occurrences WHERE id = occurrence_id AND ended_at IS NULL))").bind(reason.slice(0, 128), at.toISOString(), progressId).run();
}

/**
 * Returns a query the search provider refused, or could not serve, to the
 * row's unsearched state, keeping `reason` on the row until the query is
 * issued again. No search was served, so the entity, outlet and pass keep
 * their one query.
 */
async function releaseRefusedQuery(db: AppDatabase, progressId: number, status: "queued" | "stopped", reason: string, at: Date): Promise<void> {
  await db.prepare("UPDATE media_discovery_progress SET status = ?, stop_reason = ?, stopped_at = ?, query_attempted_at = NULL, pass_due_at = CASE WHEN pass = 'preview' THEN pass_due_at END, candidate_urls = '[]', candidate_index = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (occurrence_id IS NULL OR status = 'searching')").bind(status, reason, status === "stopped" ? at.toISOString() : null, progressId).run();
}

/**
 * Whether the fetch of `url`, a candidate of `appid`'s query of `pass` on
 * `outlet`, already started: its first attempt was reserved before a restart
 * left the candidate unfinished. Any of its attempts the restart left with
 * no recorded outcome is recorded as interrupted; it may have reached the
 * outlet, so it still counts toward the outlet's daily cap.
 */
async function closeInterruptedFetch(db: AppDatabase, pass: MediaPass, appid: number, outlet: MediaOutlet, url: string): Promise<boolean> {
  const started = await first<{ id: number }>(
    db,
    "SELECT id FROM media_discovery_attempts WHERE appid = ? AND outlet = ? AND pass = ? AND kind <> 'search' AND url = ? ORDER BY id LIMIT 1",
    appid,
    outlet,
    pass,
    url,
  );
  if (!started) return false;
  await db.prepare(
    "UPDATE media_discovery_attempts SET kind = 'failure', error = ? WHERE appid = ? AND outlet = ? AND pass = ? AND kind = 'fetch' AND status_code IS NULL AND error IS NULL AND id >= ?",
  ).bind(INTERRUPTED_FETCH, appid, outlet, pass, started.id).run();
  return true;
}

/** Why a candidate was skipped after an unexpected exception while it was handled. */
const CANDIDATE_ERROR = "candidate_error";

/**
 * Skips a candidate whose handling threw an exception no classifier
 * anticipated, such as a defect in parsing its article, so the query's other
 * candidates and the run's other queries still progress. The query moves past
 * it, so it is never fetched again: one occurrence ends it. Its last outlet
 * attempt records the bounded reason and counts as a source failure; an
 * attempt left without a status is recorded as a failure.
 */
async function skipThrowingCandidate(
  db: AppDatabase,
  candidate: { progressId: number; index: number; pass: MediaPass; appid: number; outlet: MediaOutlet; url: string },
  reason: string,
): Promise<void> {
  await transaction(db, async () => {
    await db.prepare("UPDATE media_discovery_progress SET candidate_index = MAX(candidate_index, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(candidate.index + 1, candidate.progressId).run();
    const started = await first<{ id: number }>(
      db,
      "SELECT id FROM media_discovery_attempts WHERE appid = ? AND outlet = ? AND pass = ? AND kind <> 'search' AND url = ? ORDER BY id DESC LIMIT 1",
      candidate.appid,
      candidate.outlet,
      candidate.pass,
      candidate.url,
    );
    if (!started) return;
    await db.prepare(
      "UPDATE media_discovery_attempts SET kind = CASE WHEN status_code IS NULL THEN 'failure' ELSE kind END, succeeded = 0, error = ? WHERE id = (SELECT MAX(id) FROM media_discovery_attempts WHERE appid = ? AND outlet = ? AND pass = ? AND kind <> 'search' AND id >= ?)",
    ).bind(`${CANDIDATE_ERROR}:${reason}`, candidate.appid, candidate.outlet, candidate.pass, started.id).run();
  });
}

/** The recorded outcome of a fetch attempt a restart interrupted. */
const INTERRUPTED_FETCH = "interrupted_by_restart";
const PREVIEW_REPLAY_ORIGIN = "preview_candidate_replay";

async function loadRun(db: AppDatabase, runId?: number): Promise<RunRow> {
  const run = runId
    ? await first<RunRow>(db, `SELECT ${RUN_COLUMNS} FROM media_discovery_runs WHERE id = ?`, runId)
    : await first<RunRow>(db, `SELECT ${RUN_COLUMNS} FROM media_discovery_runs WHERE pass = 'initial' AND origin <> ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`, PREVIEW_REPLAY_ORIGIN);
  if (!run) throw new Error("Media discovery run not found");
  parsePass(run.pass);
  return run;
}

/**
 * Why `appid` can admit no further article, if it cannot: it reached its own
 * 15-article ceiling for its kind of discovery. No total
 * across entities applies.
 */
async function articleCeiling(db: AppDatabase, appid: number, pass: MediaPass): Promise<string | null> {
  if (pass === "preview") return await previewCeilingReached(db, appid) ? "preview_ceiling" : null;
  const row = await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_sources WHERE appid = ? AND pass <> 'preview'", appid);
  return Number(row?.count ?? 0) >= MAX_MEDIA_ARTICLES_PER_GAME ? `article_cap:${appid}` : null;
}

const EMPTY_USAGE_SUMMARY: MediaRunSummary["usage"] = {
  remainingCredits: null,
  plan: "unknown",
  planUsageAtStart: null,
  planUsage: null,
  planLimit: null,
  paygoUsage: null,
  paygoLimit: null,
  searchCreditsConsumed: 0,
};

type MediaRunCounts = {
  discovered: number;
  accepted: number;
  skipped: number;
  sourceFailures: number;
  queries: number;
  attempts: number;
  articles: number;
  outletShortfall: MediaOutletShortfall | null;
};

async function mediaRunCounts(db: AppDatabase, passes: readonly MediaPass[], targetAppids: readonly number[]): Promise<MediaRunCounts> {
  const targetAppidsJson = JSON.stringify(targetAppids);
  const pass = JSON.stringify(passes);
  const articleCount = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_sources WHERE pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const queryCount = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_discovery_progress WHERE query_attempted_at IS NOT NULL AND pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const progressCandidates = await rows<{ candidate_urls: string }>(
    db,
    "SELECT candidate_urls FROM media_discovery_progress WHERE query_attempted_at IS NOT NULL AND pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  );
  const discoveredCount = progressCandidates.reduce((total, row) => total + json<Candidate[]>(row.candidate_urls, []).length, 0);
  const attemptCount = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const sourceFailures = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE pass IN (SELECT value FROM json_each(?)) AND succeeded = 0 AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const acceptedOutlets = await rows<{ outlet: MediaOutlet }>(
    db,
    "SELECT DISTINCT outlet FROM media_sources WHERE pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  );
  const acceptedOutletNames = new Set(acceptedOutlets.map((row) => row.outlet));
  const missingOutlets = MEDIA_OUTLETS.filter((item) => !acceptedOutletNames.has(item.name)).map((item) => item.name);
  const outletShortfall = acceptedOutletNames.size < 3
    ? { required: 3, actual: acceptedOutletNames.size, missing: missingOutlets }
    : null;
  return {
    discovered: discoveredCount,
    accepted: articleCount,
    skipped: Math.max(0, discoveredCount - articleCount),
    sourceFailures,
    queries: queryCount,
    attempts: attemptCount,
    articles: articleCount,
    outletShortfall,
  };
}
export async function runAuthorizedMediaDiscovery(db: AppDatabase, options: MediaDiscoveryOptions = {}): Promise<MediaRunSummary> {
  if (options.pass !== undefined) parsePass(options.pass);
  if (!options.runId && options.games) {
    const authorization = await authorizeMediaRun(db, { pass: options.pass ?? "initial", games: options.games });
    options = { ...options, runId: authorization.runId };
  }
  const run = await loadRun(db, options.runId);
  if (run.origin === PREVIEW_REPLAY_ORIGIN) throw new Error("Use the scoped preview replay for this run");
  const pass = run.pass;
  // A scheduled discovery run serves every pass due when the daily media run
  // started it; an authorized run serves its own pass.
  const scheduled = run.origin === "scheduled";
  const passes: MediaPass[] = scheduled ? ["initial", "later", "preview"] : [pass];
  const selectedGames = json<number[]>(run.selected_games, []);
  const discoveryTargets = await loadMediaTargets(db, selectedGames);
  const targetAppids = discoveryTargets.map((target) => target.appid);
  const fetchFn = options.fetch ?? fetch;
  const apiKey = options.tavilyApiKey ?? process.env.TAVILY_API_KEY;
  const tavily = createTavilyTransport(apiKey, fetchFn);
  let usageSummary: MediaRunSummary["usage"] = { ...EMPTY_USAGE_SUMMARY };
  const issued: MediaRunSummary["issued"] = { searches: 0, attempts: 0, articles: 0 };
  try {
    const clock: MediaClock = () => isoNow(options.now);
    if (scheduled) await transaction(db, () => skipIneligibleMediaPasses(db, run.id, clock()));
    await reopenDayScopedProgress(db, run.id, passes, targetAppids, dayKey(clock()));
    const startedAt = isoTimestamp(run.started_at ?? clock().toISOString());
    const day = startedAt.slice(0, 10);
    const scheduledPasses = scheduled ? await duePasses(db, discoveryTargets, startedAt) : null;
    const previews = scheduled ? await pendingPreviews(db, targetAppids, day) : [];
    const stopReasons = new Set<string>();
    const stoppedOutlets = new Set<MediaOutlet>();
    let searchesStopped = false;
    let searchCreditBudget: number | null = null;
    let searchesIssued = 0;
    let searchCreditsConsumed = 0;
    const usage = await tavily.usage();
    if (usage.details) {
      const { plan, remainingCredits, planUsage, planLimit, paygoUsage, paygoLimit } = usage.details;
      searchCreditBudget = remainingCredits;
      usageSummary = { remainingCredits, plan, planUsageAtStart: planUsage, planUsage, planLimit, paygoUsage, paygoLimit, searchCreditsConsumed: 0 };
      await db.prepare("UPDATE media_discovery_runs SET usage = ? WHERE id = ?").bind(JSON.stringify(usageSummary), run.id).run();
    }
    if (usage.stop) stopReasons.add(usage.stop);
    const progressRows = await rows<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress
      WHERE appid IN (SELECT value FROM json_each(?)) AND (occurrence_id IS NULL OR occurrence_id IN (SELECT value FROM json_each(?)))
      ORDER BY appid, id`, JSON.stringify(targetAppids), JSON.stringify(previews.map(({ id }) => id)));
    // A scheduled run takes its due passes oldest due first, then by entity,
    // each across the outlets in roster order; an authorized run takes its
    // pass outlet by outlet.
    const denied = new Set<MediaOutlet>();
    for (const { name } of previews.length ? MEDIA_OUTLETS : []) {
      const reason = await outletDenial(db, name);
      if (!reason) continue;
      denied.add(name);
      for (const row of progressRows.filter((row) => row.outlet === name && row.occurrence_id !== null)) {
        if (row.status !== "completed") await stopProgress(db, row.id, reason, clock());
      }
    }
    const previewQueries = previews.flatMap(({ id, appid, due_at }) => MEDIA_OUTLETS.map((outlet) => ({
      outlet, target: discoveryTargets.find((target) => target.appid === appid)!, pass: "preview" as const, dueAt: due_at, occurrenceId: id,
    })));
    const pendingPreviewQueries = () => progressRows.filter((row) => row.occurrence_id !== null
      && row.status !== "completed" && !row.query_attempted_at && !denied.has(row.outlet)).length;
    let deferred = previews.length > 0 && (await first<{ value: string }>(db,
      "SELECT value FROM checkpoints WHERE key = ?", PREVIEW_DEFERRAL_KEY))?.value === day.slice(0, 7);
    const checkPreviewCredits = async (progress: ProgressRow[], budget: number) => {
      const pending = pendingPreviewQueries();
      if (deferred || pending === 0) return;
      const reserved = await reviewSearchReservation(db, discoveryTargets, startedAt, progress, denied);
      if (budget - reserved >= pending) return;
      deferred = true;
      await db.prepare(
        "INSERT INTO checkpoints (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(PREVIEW_DEFERRAL_KEY, day.slice(0, 7)).run();
    };
    if (searchCreditBudget !== null && usage.stop === "tavily_credits_exhausted") {
      await checkPreviewCredits(progressRows, searchCreditBudget);
    }
    if (stopReasons.size === 0) {
      const queries = scheduledPasses
        ? [...scheduledPasses.flatMap(({ target, pass, dueAt }) => MEDIA_OUTLETS.map((outlet) => ({ outlet, target, pass, dueAt, occurrenceId: null }))), ...previewQueries]
        : MEDIA_OUTLETS.flatMap((outlet) => discoveryTargets.map((target) => ({ outlet, target, pass, dueAt: null, occurrenceId: null })));
      const dueEntities: Record<MediaPass, Set<number>> = { initial: new Set(), later: new Set(), preview: new Set() };
      for (const { target, pass } of scheduledPasses ?? []) dueEntities[pass].add(target.appid);
      let reviewed = false;
      for (const { outlet, target, pass, dueAt, occurrenceId } of queries) {
        if (occurrenceId !== null && !reviewed) {
          reviewed = true;
          if (searchCreditBudget !== null) {
            const current = await rows<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress WHERE pass <> 'preview'`);
            await checkPreviewCredits(current, searchCreditBudget - Math.max(searchesIssued, searchCreditsConsumed));
          }
        }
        if (occurrenceId !== null && !await previewOpen(db, occurrenceId)) continue;
        const appid = target.appid;
        if (await articleCeiling(db, appid, pass)) continue;
        if (stoppedOutlets.has(outlet.name)) continue;
        // The later pass asks only the outlets with an accepted initial article for the entity.
        if (pass === "later" && !await first<{ id: number }>(db, "SELECT id FROM media_sources WHERE appid = ? AND outlet = ? AND pass = 'initial' LIMIT 1", appid, outlet.name)) continue;
        const progress = progressRows.find((row) => row.appid === appid && row.outlet === outlet.name && row.pass === pass && row.occurrence_id === occurrenceId) ?? null;
        let progressId = progress?.id;
        if (!progressId) {
          const inserted = await db.prepare("INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, status) VALUES (?, ?, ?, ?, 'queued')").bind(run.id, appid, pass, outlet.name).run();
          if (!inserted.success) throw new Error("Unable to create media outlet progress");
          progressId = Number((await first<{ id: number }>(db, "SELECT id FROM media_discovery_progress WHERE appid = ? AND outlet = ? AND pass = ?", appid, outlet.name, pass))?.id ?? 0);
        } else if (progress?.run_id !== run.id) {
          await db.prepare("UPDATE media_discovery_progress SET run_id = ? WHERE id = ?").bind(run.id, progressId).run();
        }
        const current = await first<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress WHERE id = ?`, progressId);
        if (!current || current.status === "completed" || current.status === "stopped") continue;
        let candidates = json<Candidate[]>(current.candidate_urls, []).filter((candidate) => typeof candidate?.url === "string");
        let index = current.candidate_index;
        if (!current.query_attempted_at) {
          if (searchesStopped || (occurrenceId !== null && deferred)) continue;
          if (searchCreditBudget !== null && Math.max(searchesIssued, searchCreditsConsumed) >= searchCreditBudget) {
            // No credit is left for this query: stop searching for the rest of
            // the run as a provider stop and keep the query for the next
            // authorized run.
            await releaseRefusedQuery(db, progressId, "queued", "tavily_credits_exhausted", clock());
            stopReasons.add("tavily_credits_exhausted");
            searchesStopped = true;
            continue;
          }
          // The query bound is one search per eligible entity, outlet and pass, so
          // eligible entities × outlets per pass: progress is unique per entity,
          // outlet and pass, and query_attempted_at is persisted before the
          // search, so reruns and restarts never search that row again.
          const query = passQuery(target, pass);
          const attemptNow = clock();
          const reservation = await reserveOutletAttempt(db, { runId: run.id, pass, appid, outlet: outlet.name, kind: "search", url: null, date: attemptNow });
          if ("stop" in reservation) {
            await stopProgress(db, progressId, reservation.stop, attemptNow);
            stoppedOutlets.add(outlet.name);
            stopReasons.add(`${outlet.name}:${reservation.stop}`);
            continue;
          }
          const attemptId = reservation.attemptId;
          searchesIssued += 1;
          issued.searches += 1;
          issued.attempts += 1;
          const marked = await db.prepare(
            "UPDATE media_discovery_progress SET query_attempted_at = ?, pass_due_at = ?, status = 'searching', stop_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'stopped'",
          ).bind(attemptNow.toISOString(), dueAt, progressId).run();
          if (marked.meta.changes === 0 || (occurrenceId !== null && !await previewOpen(db, occurrenceId))) {
            await finishOutletAttempt(db, attemptId, { kind: "search", statusCode: null, succeeded: false, error: "preview_cancelled" });
            continue;
          }
          const outcome = await tavily.search(query, outlet.domain);
          await finishOutletAttempt(db, attemptId, outcome.attempt);
          if (outcome.class === "provider_stop") {
            if (occurrenceId === null || await previewOpen(db, occurrenceId)) await releaseRefusedQuery(db, progressId, outcome.progress, outcome.reason, attemptNow);
            stopReasons.add(outcome.reason);
            if (outcome.action === "break_run") break;
            searchesStopped = true;
            continue;
          }
          const { body } = outcome;
          const providerRequestId = cleanText(jsonObject(body).request_id ?? jsonObject(body).requestId);
          const usage = jsonObject(jsonObject(body).usage);
          const reportedCredits = usage.credits ?? usage.credits_used;
          if (typeof reportedCredits === "number" && Number.isFinite(reportedCredits) && reportedCredits >= 0) {
            searchCreditsConsumed += reportedCredits;
          }
          candidates = Array.isArray(jsonObject(body).results)
            ? (jsonObject(body).results as TavilyResult[]).slice(0, 10).map((item) => ({ url: typeof item.url === "string" ? item.url : "", publishedDate: dateValue(item.published_date) })).filter((item) => item.url && hostInOutlet(item.url, outlet))
            : [];
          if (occurrenceId !== null && !await previewOpen(db, occurrenceId)) continue;
          await db.prepare("UPDATE media_discovery_progress SET query_attempted_at = ?, status = 'fetching', candidate_urls = ?, candidate_index = 0, provider_request_id = ?, credits_used = ?, usage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'searching'").bind(attemptNow.toISOString(), JSON.stringify(candidates), providerRequestId, typeof (usage.credits ?? usage.credits_used) === "number" ? (usage.credits ?? usage.credits_used) : null, JSON.stringify(usage), progressId).run();
          await db.prepare("UPDATE media_discovery_runs SET query_count = query_count + 1, provider_request_ids = json_insert(provider_request_ids, '$[#]', ?), usage = json_patch(usage, ?) WHERE id = ?").bind(providerRequestId, JSON.stringify(usage), run.id).run();
        }
        const selections = new Map<number, { review: MediaSource | null; preview: MediaSource | null }>();
        // Each query admits at most one article per entity, across resumes: an
        // entity this query already admitted an article for, before an Outlet
        // day stop held it, admits no other.
        const admitted = occurrenceId === null ? await admittedEntities(db, pass, outlet.name, candidates.slice(0, index)) : new Set<number>();
        for (; index < candidates.length; index += 1) {
          if (occurrenceId !== null && !await previewOpen(db, occurrenceId)) break;
          const candidateUrl = candidates[index]!.url;
          if (occurrenceId !== null && await first(db,
            `SELECT 1 FROM media_sources WHERE appid = ? AND (original_url = ? OR discovery_url = ?)
             UNION ALL SELECT 1 FROM media_preview_rejections WHERE appid = ? AND url = ? LIMIT 1`,
            appid, candidateUrl, candidateUrl, appid, candidateUrl)) {
            await db.prepare("UPDATE media_discovery_progress SET candidate_index = ? WHERE id = ?").bind(index + 1, progressId).run();
            continue;
          }
          // A later candidate already among the entity's sources is not fetched again.
          if (pass === "later" && await first<{ id: number }>(db, "SELECT id FROM media_sources WHERE appid = ? AND (original_url = ? OR discovery_url = ?) LIMIT 1", appid, candidates[index]!.url, candidates[index]!.url)) {
            await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(index + 1, progressId).run();
            continue;
          }
          // fetchOutletArticle reserves each attempt before contacting the outlet, so
          // that reservation durably records that this candidate's fetch
          // started. Only the candidate a restart left unfinished can have
          // started; it may have reached its outlet, so it is never fetched
          // again and is skipped.
          if (index === current.candidate_index && await closeInterruptedFetch(db, pass, appid, outlet.name, candidates[index]!.url)) {
            await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(index + 1, progressId).run();
            if (occurrenceId !== null) await db.prepare("INSERT OR IGNORE INTO media_preview_rejections (appid, url) VALUES (?, ?)").bind(appid, candidateUrl).run();
            stopReasons.add(`${outlet.name}:fetch_interrupted`);
            continue;
          }
          let fetched: Awaited<ReturnType<typeof fetchOutletArticle>>;
          let source: MediaSource | null;
          try {
            fetched = await fetchOutletArticle(db, {
              fetch: fetchFn, url: candidates[index]!.url, outlet: outlet.name, runId: run.id, pass, appid, clock,
              onAttempt: () => { issued.attempts += 1; },
              secrets: [apiKey],
            });
            if (fetched && "stop" in fetched) {
              // A candidate the outlet answered is done; one refused before any
              // request is retried when the outlet reopens.
              if (fetched.contacted) await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(index + 1, progressId).run();
              await stopProgress(db, progressId, fetched.stop, clock());
              stoppedOutlets.add(outlet.name);
              stopReasons.add(`${outlet.name}:${fetched.stop}`);
              break;
            }
            if (occurrenceId !== null) {
              const previewSource = fetched ? parseSource(fetched.html, fetched.finalUrl, target, discoveryTargets, outlet.name, clock().toISOString(), pass) : null;
              const accepted = await transaction(db, async () => {
                if (!await previewOpen(db, occurrenceId)) return false;
                if (previewSource) previewSource.discoveryUrl = candidateUrl;
                const accepted = previewSource && await admitSource(db, pass, previewSource, rootAppid(target));
                if (accepted) {
                  // The admission and its occurrence/outlet completion must survive a restart together.
                  await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, status = 'completed', completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(index + 1, clock().toISOString(), progressId).run();
                } else {
                  await db.prepare("INSERT OR IGNORE INTO media_preview_rejections (appid, url) VALUES (?, ?)").bind(appid, candidateUrl).run();
                  await db.prepare("UPDATE media_discovery_progress SET candidate_index = ? WHERE id = ?").bind(index + 1, progressId).run();
                }
                return accepted;
              });
              if (accepted) {
                issued.articles += 1;
                break;
              }
              continue;
            }
            await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(index + 1, progressId).run();
            if (!fetched) continue;
            source = parseSource(fetched.html, fetched.finalUrl, target, discoveryTargets, outlet.name, clock().toISOString(), pass);
            if (!source) continue;
            if (scheduled && source.appid !== appid && !dueEntities[pass].has(source.appid)) continue;
            source.discoveryUrl = candidates[index]!.url;
            if (pass === "later" && !await qualifiesForLaterPass(db, source)) continue;
            if (pass === "initial" && await first(db, `SELECT 1 FROM media_sources WHERE appid = ? AND pass = 'preview'
              AND (original_url IN (?, ?) OR discovery_url IN (?, ?))`, source.appid,
              source.originalUrl, source.discoveryUrl, source.originalUrl, source.discoveryUrl)) continue;
          } catch (error) {
            await skipThrowingCandidate(db, { progressId, index, pass, appid, outlet: outlet.name, url: candidates[index]!.url }, boundedMediaError(error, [apiKey]));
            if (occurrenceId !== null) await db.prepare("INSERT OR IGNORE INTO media_preview_rejections (appid, url) VALUES (?, ?)").bind(appid, candidateUrl).run();
            stopReasons.add(`${outlet.name}:${CANDIDATE_ERROR}`);
            continue;
          }
          if (admitted.has(source.appid)) continue;
          const selection = selections.get(source.appid) ?? { review: null, preview: null };
          if (source.type === "review") {
            selection.review = !selection.review || candidateDate(source) < candidateDate(selection.review) ? source : selection.review;
          } else {
            selection.preview = !selection.preview || candidateDate(source) < candidateDate(selection.preview) ? source : selection.preview;
          }
          selections.set(source.appid, selection);
        }
        for (const selection of selections.values()) {
          const selected = selection.review ?? selection.preview;
          if (!selected) continue;
          const ceiling = await articleCeiling(db, selected.appid, pass);
          if (ceiling) stopReasons.add(ceiling);
          else if (await admitSource(db, pass, selected, rootAppid(target))) issued.articles += 1;
        }
        if (occurrenceId === null && selections.size === 0 && current.status !== "stopped") {
          stopReasons.add(`${outlet.name}:no_qualifying_article`);
        }
        await db.prepare("UPDATE media_discovery_progress SET status = 'completed', completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'stopped'").bind(clock().toISOString(), progressId).run();
      }
    }
    for (const preview of previews) {
      if (!await previewOpen(db, preview.id)) continue;
      const remaining = await rows<{ status: string; stop_reason: string | null }>(db,
        "SELECT status, stop_reason FROM media_discovery_progress WHERE occurrence_id = ?", preview.id);
      const reason = await previewCeilingReached(db, preview.appid) ? "preview_ceiling"
        : remaining.every((row) => row.status === "completed" || (row.status === "stopped" && row.stop_reason && isOutletDenialStop(row.stop_reason))) ? "completed"
        : null;
      if (reason) await transaction(db, async () => {
        if (await previewOpen(db, preview.id)) await endPreviewOccurrence(db, preview.id, clock().toISOString(), reason);
      });
    }
    const counts = await mediaRunCounts(db, passes, targetAppids);
    const providerStopped = [...stopReasons].some((reason) => reason.startsWith("tavily_"));
    const status: MediaRunSummary["status"] = providerStopped ? "stopped" : "completed";
    usageSummary = {
      ...usageSummary,
      searchCreditsConsumed,
      planUsage: usageSummary.planUsageAtStart === null ? null : usageSummary.planUsageAtStart + searchCreditsConsumed,
      remainingCredits: searchCreditBudget === null ? null : Math.max(0, searchCreditBudget - searchCreditsConsumed),
    };
    const stopReason = [...stopReasons][0] ?? null;
    const summary: MediaRunSummary["summary"] = {
      discovered: counts.discovered,
      accepted: counts.accepted,
      skipped: counts.skipped,
      sourceFailures: counts.sourceFailures,
      outletShortfall: counts.outletShortfall,
      runId: run.id,
      status,
      stopReason,
    };
    const durableSummary = {
      ...summary,
      queries: counts.queries,
      attempts: counts.attempts,
      articles: counts.articles,
      stopReasons: [...stopReasons].sort(),
      usage: usageSummary,
    };
    await db.prepare("UPDATE media_discovery_runs SET status = ?, article_count = ?, query_count = ?, attempt_count = ?, stop_reason = ?, summary = ?, usage = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, counts.articles, counts.queries, counts.attempts, stopReason, JSON.stringify(durableSummary), JSON.stringify(usageSummary), run.id).run();
    return { runId: run.id, pass, status, games: selectedGames, resumed: run.resumed === 1, newIdentity: run.resumed !== 1, queries: counts.queries, attempts: counts.attempts, articles: counts.articles, issued, stopReasons: [...stopReasons].sort(), summary, usage: usageSummary };
  } catch (error) {
    const counts = await mediaRunCounts(db, passes, targetAppids);
    const stopReason = "execution_error";
    const failureMessage = boundedMediaError(error, [apiKey]);
    const summary: MediaRunSummary["summary"] = {
      discovered: counts.discovered,
      accepted: counts.accepted,
      skipped: counts.skipped,
      sourceFailures: counts.sourceFailures,
      outletShortfall: counts.outletShortfall,
      runId: run.id,
      status: "failed",
      stopReason,
      error: failureMessage,
      counts: {
        discovered: counts.discovered,
        accepted: counts.accepted,
        skipped: counts.skipped,
        sourceFailures: counts.sourceFailures,
        queries: counts.queries,
        attempts: counts.attempts,
        articles: counts.articles,
      },
    };
    const durableSummary = {
      ...summary,
      queries: counts.queries,
      attempts: counts.attempts,
      articles: counts.articles,
      stopReasons: [stopReason],
      usage: usageSummary,
    };
    await transaction(db, async () => {
      await db.prepare("UPDATE media_discovery_runs SET status = 'failed', article_count = ?, query_count = ?, attempt_count = ?, stop_reason = ?, summary = ?, usage = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").bind(counts.articles, counts.queries, counts.attempts, stopReason, JSON.stringify(durableSummary), JSON.stringify(usageSummary), run.id).run();
    });
    return { runId: run.id, pass, status: "failed", games: selectedGames, resumed: run.resumed === 1, newIdentity: run.resumed !== 1, queries: counts.queries, attempts: counts.attempts, articles: counts.articles, issued, stopReasons: [stopReason], summary, usage: usageSummary };
  }
}

/**
 * Public source metadata is available for the experiment roots independently of synthesis.
 * `appid`'s accepted articles from every assessment pass: dated articles by
 * publication date, then undated articles in the order they were accepted.
 * An undated article keeps its unknown date and is never placed in time by
 * when it was retrieved.
 */
export async function getMediaSources(
  db: AppDatabase,
  appid: number,
  options: { includeUnpublished?: boolean } = {},
): Promise<MediaSource[]> {
  if (!Number.isInteger(appid) || appid <= 0) return [];
  const sourceRows = await rows<{
    appid: number; original_url: string; discovery_url: string | null; title: string; outlet: MediaOutlet;
    author: string | null; published_at: string | null; updated_at: string | null; retrieved_at: string;
    type: MediaArticleType; hands_on: number | null; affiliation: string | null; platform: string | null; build_context: string | null;
  }>(
    db,
    `SELECT source.appid, source.original_url, source.discovery_url, source.title, source.outlet,
            source.author, source.published_at, source.updated_at, source.retrieved_at,
            source.type, source.hands_on, source.affiliation, source.platform, source.build_context
     FROM media_sources AS source
     JOIN apps AS app
       ON app.appid = source.appid
      AND app.is_eligible = 1
      AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
     WHERE source.appid = ?
       ${options.includeUnpublished ? "" : `AND ${PUBLIC_MEDIA_ROOT_SQL}`}
       ${options.includeUnpublished || isMediaOverviewPublic() ? "" : "AND source.pass <> 'preview'"}
     ORDER BY source.published_at IS NULL, source.published_at, source.id`,
    appid,
  );
  return sourceRows.map((row) => ({ appid: row.appid, originalUrl: row.original_url, discoveryUrl: row.discovery_url, title: row.title, outlet: row.outlet, author: row.author, publishedAt: row.published_at, updatedAt: row.updated_at, retrievedAt: row.retrieved_at, type: row.type, handsOn: row.hands_on === null ? null : row.hands_on === 1, affiliation: row.affiliation, platform: row.platform, buildContext: row.build_context }));
}

const activeMediaDiscovery = new Map<number, Promise<MediaRunSummary>>();
let mediaDiscoveryQueue: Promise<unknown> = Promise.resolve();

/** Recheck one fetched and rejected result from a completed outlet query.
 * The replay has its own durable identity and the original query stays intact.
 * Only a stop before contact permits another invocation to attempt the fetch.
 */
export function replayRejectedPreviewCandidate(
  db: AppDatabase,
  options: { progressId: number; url: string; fetch?: MediaFetch; now?: MediaDiscoveryOptions["now"] },
): Promise<{ admitted: boolean; reason: string | null }> {
  const next = mediaDiscoveryQueue.catch(() => undefined).then(() => replayPreview(db, options));
  mediaDiscoveryQueue = next;
  return next;
}

async function replayPreview(
  db: AppDatabase,
  { progressId, url, fetch: fetchFn = fetch, now }: Parameters<typeof replayRejectedPreviewCandidate>[1],
): Promise<{ admitted: boolean; reason: string | null }> {
  const progress = await first<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress WHERE id = ? AND pass = 'preview'`, progressId);
  const occurrenceId = progress?.occurrence_id;
  const outlet = MEDIA_OUTLETS.find(({ name }) => name === progress?.outlet);
  if (!progress || occurrenceId == null || !outlet || !hostInOutlet(url, outlet) ||
      progress.status !== "completed" || !progress.query_attempted_at) {
    return { admitted: false, reason: "not_a_rejected_candidate" };
  }
  const { appid, candidate_index } = progress;
  const considered = json<Candidate[]>(progress.candidate_urls, []).slice(0, candidate_index);
  if (!considered.some((candidate) => candidate.url === url) || !await first(db,
    `SELECT 1 FROM media_preview_rejections WHERE appid = ? AND url = ? AND EXISTS (
       SELECT 1 FROM media_discovery_attempts WHERE appid = ? AND outlet = ? AND pass = 'preview'
       AND kind = 'fetch' AND succeeded = 1 AND (url = ? OR (
         rtrim(url, '/') = rtrim(?, '/') AND EXISTS (
           SELECT 1 FROM media_discovery_attempts AS redirect
           WHERE redirect.appid = media_discovery_attempts.appid AND redirect.outlet = media_discovery_attempts.outlet
             AND redirect.pass = 'preview' AND redirect.kind = 'redirect' AND redirect.url = ?
             AND redirect.id < media_discovery_attempts.id
         )
       ))
     )`, appid, url, appid, outlet.name, url, url, url)) return { admitted: false, reason: "not_a_rejected_candidate" };

  const originalRun = await loadRun(db, progress.run_id);
  const selectedGames = json<number[]>(originalRun.selected_games, []);
  const targets = await loadMediaTargets(db, selectedGames);
  const target = targets.find((candidate) => candidate.appid === appid);
  const admissionStop = async () => {
    if (!target || !await previewOpen(db, occurrenceId, true)) return "preview_closed";
    const ceiling = await articleCeiling(db, appid, "preview");
    if (ceiling) return ceiling;
    if (await first(db, "SELECT 1 FROM media_sources WHERE appid = ? AND (original_url = ? OR discovery_url = ?)", appid, url, url)
        || (await admittedEntities(db, "preview", outlet.name, considered)).has(appid)) return "already_admitted";
    return null;
  };
  const stop = await admissionStop();
  if (stop || !target) return { admitted: false, reason: stop };
  const clock = () => isoNow(now);
  const identity = JSON.stringify([PREVIEW_REPLAY_ORIGIN, appid, outlet.name, url]);
  const run = await first<{ id: number }>(db, `INSERT INTO media_discovery_runs
      (pass, identity_key, selected_games, status, origin, started_at)
      VALUES ('initial', ?, ?, 'running', ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET status = 'running', stop_reason = NULL, finished_at = NULL
        WHERE status = 'stopped' AND stop_reason IN (?, ?) AND attempt_count = 0
      RETURNING id`, identity, JSON.stringify([rootAppid(target)]), PREVIEW_REPLAY_ORIGIN, clock().toISOString(),
    OUTLET_STOP_REASONS.DAILY_ATTEMPT_CAP, OUTLET_HTTP_STOPS[429]);
  if (!run) return { admitted: false, reason: "already_replayed" };
  let reason: string | null = null;
  let admitted = false;
  try {
    const fetched = await fetchOutletArticle(db, { url, runId: run.id, pass: "preview", appid, outlet: outlet.name, clock, fetch: fetchFn });
    if (fetched && "stop" in fetched) {
      reason = fetched.stop;
    } else {
      const source = fetched && parseSource(fetched.html, fetched.finalUrl, target, targets, outlet.name, clock().toISOString(), "preview");
      if (source) {
        source.discoveryUrl = url;
        reason = await transaction(db, async () => {
          const stop = await admissionStop();
          if (stop) return stop;
          admitted = await admitSource(db, "preview", source, rootAppid(target));
          return admitted ? null : "already_admitted";
        });
      } else {
        reason = fetched ? "no_qualifying_article" : "fetch_failed";
      }
    }
  } catch {
    reason = CANDIDATE_ERROR;
  }
  await db.prepare("UPDATE media_discovery_runs SET status = ?, stop_reason = ?, article_count = ?, finished_at = ? WHERE id = ?")
    .bind(reason ? "stopped" : "completed", reason, Number(admitted), clock().toISOString(), run.id).run();
  return { admitted, reason };
}

function enqueueMediaDiscovery(db: AppDatabase, runId: number, options: MediaDiscoveryOptions): Promise<MediaRunSummary> {
  const active = activeMediaDiscovery.get(runId);
  if (active) return active;

  const next = mediaDiscoveryQueue
    .catch(() => undefined)
    .then(() => runAuthorizedMediaDiscovery(db, { ...options, runId }));
  mediaDiscoveryQueue = next;
  activeMediaDiscovery.set(runId, next);
  const clear = () => {
    if (activeMediaDiscovery.get(runId) === next) activeMediaDiscovery.delete(runId);
  };
  void next.then(clear, clear);
  return next;
}

export async function runSerializedMediaDiscovery(
  db: AppDatabase,
  options: MediaDiscoveryOptions = {},
): Promise<MediaRunSummary> {
  if (options.runId !== undefined) return enqueueMediaDiscovery(db, options.runId, options);
  if (options.games) {
    const next = mediaDiscoveryQueue
      .catch(() => undefined)
      .then(async () => {
        const authorization = await authorizeMediaRun(db, { pass: "initial", games: options.games! });
        return runAuthorizedMediaDiscovery(db, { ...options, runId: authorization.runId });
      });
    mediaDiscoveryQueue = next;
    return next;
  }
  const run = await loadRun(db);
  return enqueueMediaDiscovery(db, run.id, { ...options, runId: run.id });
}
