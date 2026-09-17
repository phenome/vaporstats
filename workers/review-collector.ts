import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AppDatabase } from "../src/lib/db";
import {
  persistReceptionObservation,
  type PersistReceptionObservationInput,
  type PersistReceptionResult,
} from "../src/lib/reception-store";
import {
  fetchSteamReviewHistogram,
  fetchSteamReviewSummary,
  type ReviewHistogramResult,
  type ReviewSourceOptions,
  type ReviewSummaryResult,
} from "./review-source";
import {
  fetchSteamNewsHubEvents,
  type NewsHubOptions,
  type SteamEventsResult,
} from "./steam-events";

export const DEFAULT_REVIEW_MAX_GAMES = 11;
export const DEFAULT_REVIEW_MAX_REQUESTS = 22;
export const DEFAULT_NEWS_HUB_MAX_REQUESTS = 11;
export const REVIEW_CHECKPOINT_PREFIX = "reception:next:";
export const RECEPTION_SCORE_MINIMUM_REVIEWS = 50;
const OPERATOR_ARTIFACT_ROW_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const DORMANT_DUE_AT = "9999-12-31T23:59:59.999Z";

type FailureCategory =
  | "steam_summary"
  | "steam_histogram"
  | "steam_events"
  | "score_calculation"
  | "persistence";

type CandidateRow = {
  appid: number;
  name: string;
  type: string;
  release_date: string | null;
  release_status: string;
  created_at: string;
  next_due_at: string | null;
  latest_summary_at: string | null;
  latest_review_count: number | null;
  previous_review_count: number | null;
  latest_score_history_id: number | null;
  release_signal_at: string | null;
  event_signal_at: string | null;
  major_event_at: string | null;
  lifecycle_event_at: string | null;
  player_tier: string | null;
  first_failed_at: string | null;
  last_failed_at: string | null;
  failure_count: number | null;
  failure_category: FailureCategory | null;
  checkpoint_cursor: number | null;
};

export type ReceptionCandidateReason =
  | "unassessed_active"
  | "active_signal"
  | "unassessed"
  | "stale_active"
  | "catalog_signal"
  | "stale_inactive";

export interface ReceptionCandidate {
  appid: number;
  name: string;
  reason: ReceptionCandidateReason;
  priority: number;
  dueAt: string;
  active: boolean;
  failureCount: number;
  lastFailedAt: string | null;
}

export interface ReviewCollectionOptions {
  anchorTime?: Date;
  maxGames?: number;
  maxReviewRequests?: number;
  maxNewsHubRequests?: number;
  customFetch?: typeof fetch;
  artifactDirectory?: string | null;
}

export interface ReviewCollectionResult {
  anchorTime: string;
  selectedGames: number;
  attemptedGames: number;
  reviewRequests: number;
  newsHubRequests: number;
  persistedGames: number;
  insufficientEvidence: number;
  ordinaryFailures: number;
  rateLimited: boolean;
  deferredGames: number;
  dueRemaining: number;
  oldestDueAt: string | null;
  reasons: Record<string, number>;
}

function checkpointKey(appid: number): string {
  return `${REVIEW_CHECKPOINT_PREFIX}${appid}`;
}

function iso(value: Date): string {
  return value.toISOString();
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestTimestamp(...values: (string | null)[]): string | null {
  let latest: { value: string; time: number } | null = null;
  for (const value of values) {
    const time = timestamp(value);
    if (value && time !== null && (!latest || time > latest.time)) latest = { value, time };
  }
  return latest?.value ?? null;
}

function isRateLimited(result: ReviewSummaryResult | ReviewHistogramResult | SteamEventsResult): boolean {
  return !result.ok && result.rateLimited;
}


function successfulObservationTime(
  anchor: string,
  summary: ReviewSummaryResult,
  histogram: ReviewHistogramResult | null,
  events: SteamEventsResult | null,
): string {
  return [
    summary.ok ? summary.value.observedAt : null,
    histogram?.ok ? histogram.value.observedAt : null,
    events?.ok ? events.value.observedAt : null,
  ].filter((value): value is string => timestamp(value) !== null).sort().at(-1) ?? anchor;
}

function isReceptionActive(row: CandidateRow, anchorTime: Date): boolean {
  const now = anchorTime.getTime();
  const release = timestamp(row.release_date);
  const recentRelease = release !== null && release <= now && release >= now - 365 * DAY_MS;
  const imminentRelease = row.release_status === "upcoming" && release !== null && release >= now && release <= now + 90 * DAY_MS;
  const majorUpdate = timestamp(row.major_event_at);
  const recentMajorUpdate = majorUpdate !== null && majorUpdate <= now && majorUpdate >= now - 90 * DAY_MS;
  const lifecycleEvent = timestamp(row.lifecycle_event_at);
  const recentLifecycleEvent = lifecycleEvent !== null && lifecycleEvent <= now && lifecycleEvent >= now - 90 * DAY_MS;
  const charted = row.player_tier === "fast" || row.player_tier === "hourly";
  const latestSummary = timestamp(row.latest_summary_at);
  const recentReviewGrowth =
    latestSummary !== null &&
    latestSummary >= now - 90 * DAY_MS &&
    row.latest_review_count !== null &&
    row.previous_review_count !== null &&
    row.latest_review_count > row.previous_review_count;
  return recentRelease || imminentRelease || recentLifecycleEvent || recentMajorUpdate || charted || recentReviewGrowth;
}

function classifyCandidate(row: CandidateRow, anchorTime: Date): ReceptionCandidate | null {
  const anchor = anchorTime.getTime();
  const latestSummary = timestamp(row.latest_summary_at);
  const signalAt = latestTimestamp(row.release_signal_at, row.event_signal_at);
  const signalTime = timestamp(signalAt);
  const nextDue = timestamp(row.next_due_at);
  const active = isReceptionActive(row, anchorTime);
  const unassessed = latestSummary === null;
  const lastCollectionState =
    row.checkpoint_cursor ??
    latestSummary ??
    Number.NEGATIVE_INFINITY;
  const signaled = !unassessed && signalTime !== null && signalTime <= anchor && signalTime > lastCollectionState;
  const due = nextDue === null || nextDue <= anchor;
  if (!unassessed && !signaled && !due) return null;

  let reason: ReceptionCandidateReason;
  let priority: number;
  if (unassessed && active) [reason, priority] = ["unassessed_active", 0];
  else if (signaled && active && row.latest_score_history_id !== null) [reason, priority] = ["active_signal", 1];
  else if (unassessed) [reason, priority] = ["unassessed", 2];
  else if (signaled && row.latest_score_history_id === null) [reason, priority] = ["catalog_signal", 2];
  else if (active) [reason, priority] = ["stale_active", 3];
  else if (signaled) [reason, priority] = ["catalog_signal", 4];
  else [reason, priority] = ["stale_inactive", 5];

  const dueAt = unassessed
    ? latestTimestamp(row.created_at, signalAt) ?? iso(anchorTime)
    : signaled
      ? signalAt ?? row.latest_summary_at!
      : row.next_due_at ?? row.latest_summary_at!;
  return {
    appid: row.appid,
    name: row.name,
    reason,
    priority,
    dueAt,
    active,
    failureCount: row.failure_count ?? 0,
    lastFailedAt: row.last_failed_at,
  };
}

function compareCandidates(left: ReceptionCandidate, right: ReceptionCandidate): number {
  return left.priority - right.priority ||
    Number(left.failureCount > 0) - Number(right.failureCount > 0) ||
    left.failureCount - right.failureCount ||
    (left.lastFailedAt ?? "").localeCompare(right.lastFailedAt ?? "") ||
    left.dueAt.localeCompare(right.dueAt) ||
    left.appid - right.appid;
}

/** Derives the current reception queue from catalog facts, signals, freshness, and failure streaks. */
export async function listReceptionCandidates(
  db: AppDatabase,
  anchorTime: Date = new Date(),
): Promise<ReceptionCandidate[]> {
  const result = await db.prepare(
    `SELECT a.appid, a.name, a.type, a.release_date, a.release_status, a.created_at,
            cp.value AS next_due_at,
            cp.cursor AS checkpoint_cursor,
            (SELECT r.observed_at FROM review_summary_snapshots r WHERE r.appid = a.appid ORDER BY r.observed_at DESC LIMIT 1) AS latest_summary_at,
            (SELECT r.lifetime_total_count FROM review_summary_snapshots r WHERE r.appid = a.appid ORDER BY r.observed_at DESC LIMIT 1) AS latest_review_count,
            (SELECT r.lifetime_total_count FROM review_summary_snapshots r WHERE r.appid = a.appid ORDER BY r.observed_at DESC LIMIT 1 OFFSET 1) AS previous_review_count,
            pss.latest_score_history_id,
            (SELECT MAX(are.updated_at) FROM app_release_events are WHERE are.appid = a.appid) AS release_signal_at,
            (SELECT MAX(are.event_date) FROM app_release_events are WHERE are.appid = a.appid) AS lifecycle_event_at,
            (SELECT MAX(se.observed_at) FROM steam_events se WHERE se.appid = a.appid) AS event_signal_at,
            (SELECT MAX(COALESCE(se.start_at, se.publication_at)) FROM steam_events se WHERE se.appid = a.appid AND se.category = 'major_update') AS major_event_at,
            tg.tier AS player_tier,
            f.first_failed_at, f.last_failed_at, f.failure_count, f.failure_category
     FROM apps a
     LEFT JOIN checkpoints cp ON cp.key = ? || CAST(a.appid AS TEXT)
     LEFT JOIN player_score_state pss ON pss.appid = a.appid
     LEFT JOIN tracked_games tg ON tg.appid = a.appid
     LEFT JOIN reception_collection_failures f ON f.appid = a.appid
     WHERE a.is_eligible = 1
       AND (a.is_playable = 1 OR a.type IN ('dlc', 'expansion'))`,
  ).bind(REVIEW_CHECKPOINT_PREFIX).all<CandidateRow>();
  return (result.results ?? [])
    .map((row) => classifyCandidate(row, anchorTime))
    .filter((candidate): candidate is ReceptionCandidate => candidate !== null)
    .sort(compareCandidates);
}

async function writeCheckpoint(
  db: AppDatabase,
  appid: number,
  nextDueAt: string,
  collectedAt: Date,
): Promise<void> {
  await db.prepare(
    `INSERT INTO checkpoints (key, value, cursor)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       cursor = excluded.cursor,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(checkpointKey(appid), nextDueAt, collectedAt.getTime()).run();
}

function nextDue(anchorTime: Date, appid: number, days: number): string {
  const nextDay = (Math.floor(anchorTime.getTime() / DAY_MS) + days) * DAY_MS;
  return new Date(nextDay + Math.abs(appid) % 96 * 15 * 60 * 1000).toISOString();
}

async function recordFailure(db: AppDatabase, appid: number, at: string, category: FailureCategory): Promise<void> {
  await db.prepare(
    `INSERT INTO reception_collection_failures
       (appid, first_failed_at, last_failed_at, failure_count, failure_category)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(appid) DO UPDATE SET
       last_failed_at = excluded.last_failed_at,
       failure_count = reception_collection_failures.failure_count + 1,
       failure_category = excluded.failure_category`,
  ).bind(appid, at, at, category).run();
}

async function clearFailure(db: AppDatabase, appid: number): Promise<void> {
  await db.prepare("DELETE FROM reception_collection_failures WHERE appid = ?").bind(appid).run();
}

type CollectionOutcome = {
  result: PersistReceptionResult | null;
  insufficient: boolean;
  rateLimited: boolean;
  failureCategory: FailureCategory | null;
  deferred: boolean;
  observedThrough?: string;
};

async function persistComponents(
  db: AppDatabase,
  input: PersistReceptionObservationInput,
): Promise<{ result: PersistReceptionResult | null; failureCategory: FailureCategory | null }> {
  try {
    return { result: await persistReceptionObservation(db, input), failureCategory: null };
  } catch (error) {
    return {
      result: null,
      failureCategory: error instanceof RangeError ? "score_calculation" : "persistence",
    };
  }
}

async function collectGame(
  db: AppDatabase,
  game: ReceptionCandidate,
  anchorTime: Date,
  customFetch: typeof fetch,
  reviewBudget: { used: number; max: number },
  newsBudget: { used: number; max: number },
): Promise<CollectionOutcome> {
  if (reviewBudget.used >= reviewBudget.max) {
    return { result: null, insufficient: false, rateLimited: false, failureCategory: null, deferred: true };
  }
  const observedAt = iso(anchorTime);
  const sourceOptions: ReviewSourceOptions = { customFetch, observedAt };
  reviewBudget.used++;
  const summary = await fetchSteamReviewSummary(game.appid, sourceOptions);
  if (isRateLimited(summary)) {
    return { result: null, insufficient: false, rateLimited: true, failureCategory: null, deferred: false };
  }
  if (!summary.ok) {
    return { result: null, insufficient: false, rateLimited: false, failureCategory: "steam_summary", deferred: false };
  }
  if (summary.value.lifetimeTotalCount < RECEPTION_SCORE_MINIMUM_REVIEWS) {
    const persisted = await persistComponents(db, { appid: game.appid, summary: summary.value, observedAt });
    return {
      result: persisted.result,
      insufficient: persisted.failureCategory === null,
      rateLimited: false,
      failureCategory: persisted.failureCategory,
      deferred: false,
      observedThrough: summary.value.observedAt,
    };
  }
  if (reviewBudget.used >= reviewBudget.max || newsBudget.used >= newsBudget.max) {
    const persisted = await persistComponents(db, { appid: game.appid, summary: summary.value, observedAt });
    return {
      result: persisted.result,
      insufficient: false,
      rateLimited: false,
      failureCategory: persisted.failureCategory,
      deferred: persisted.failureCategory === null,
    };
  }

  reviewBudget.used++;
  const histogram = await fetchSteamReviewHistogram(game.appid, sourceOptions);
  if (isRateLimited(histogram)) {
    const persisted = await persistComponents(db, { appid: game.appid, summary: summary.value, observedAt });
    return { result: persisted.result, insufficient: false, rateLimited: true, failureCategory: persisted.failureCategory, deferred: false };
  }
  if (!histogram.ok) {
    const persisted = await persistComponents(db, { appid: game.appid, summary: summary.value, observedAt });
    return { result: persisted.result, insufficient: false, rateLimited: false, failureCategory: persisted.failureCategory ?? "steam_histogram", deferred: false };
  }

  newsBudget.used++;
  const events = await fetchSteamNewsHubEvents(game.appid, { customFetch, observedAt } as NewsHubOptions);
  if (isRateLimited(events)) {
    const persisted = await persistComponents(db, { appid: game.appid, summary: summary.value, histogram: histogram.value, observedAt });
    return { result: persisted.result, insufficient: false, rateLimited: true, failureCategory: persisted.failureCategory, deferred: false };
  }
  if (!events.ok) {
    const persisted = await persistComponents(db, { appid: game.appid, summary: summary.value, histogram: histogram.value, observedAt });
    return { result: persisted.result, insufficient: false, rateLimited: false, failureCategory: persisted.failureCategory ?? "steam_events", deferred: false };
  }

  const observedThrough = successfulObservationTime(observedAt, summary, histogram, events);
  const persisted = await persistComponents(db, {
    appid: game.appid,
    summary: summary.value,
    histogram: histogram.value,
    events: events.value.events,
    observedAt: observedThrough,
  });
  return {
    result: persisted.result,
    insufficient: false,
    rateLimited: false,
    failureCategory: persisted.failureCategory,
    deferred: false,
    observedThrough,
  };
}


async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await Bun.write(temporary, content);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeOperatorArtifacts(
  db: AppDatabase,
  artifactDirectory: string,
  candidates: readonly ReceptionCandidate[],
  result: ReviewCollectionResult,
): Promise<void> {
  const renderedCandidates = candidates.slice(0, OPERATOR_ARTIFACT_ROW_LIMIT);
  const omittedCandidates = candidates.length - renderedCandidates.length;
  const queueLines = [
    "# Reception queue",
    "",
    `Generated: ${result.anchorTime}`,
    `Due: ${candidates.length}`,
    `Oldest due: ${result.oldestDueAt ?? "none"}`,
    "",
    "| AppID | Game | Priority | Reason | Due | Failures |",
    "| ---: | --- | ---: | --- | --- | ---: |",
    ...renderedCandidates.map((candidate) =>
      `| ${candidate.appid} | ${candidate.name.replace(/[|\r\n]+/g, " ").trim()} | ${candidate.priority + 1} | ${candidate.reason} | ${candidate.dueAt} | ${candidate.failureCount} |`,
    ),
    ...(omittedCandidates > 0 ? ["", `${omittedCandidates} additional candidates omitted.`] : []),
    "",
    "## Latest pass",
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    "",
  ];
  const failures = await db.prepare(
    `SELECT f.appid, a.name, f.first_failed_at, f.last_failed_at, f.failure_count, f.failure_category
     FROM reception_collection_failures f
     JOIN apps a ON a.appid = f.appid
     ORDER BY f.failure_count DESC, f.first_failed_at, f.appid
     LIMIT ?`,
  ).bind(OPERATOR_ARTIFACT_ROW_LIMIT).all<{ appid: number; name: string; first_failed_at: string; last_failed_at: string; failure_count: number; failure_category: string }>();
  const failureCount = await db.prepare(
    "SELECT COUNT(*) AS count FROM reception_collection_failures",
  ).first<{ count: number }>();
  const omittedFailures = Math.max(0, (failureCount?.count ?? 0) - (failures.results?.length ?? 0));
  const failureLines = [
    "# Reception failures",
    "",
    `Generated: ${result.anchorTime}`,
    "",
    "| AppID | Game | Category | Count | First failure | Last failure |",
    "| ---: | --- | --- | ---: | --- | --- |",
    ...(failures.results ?? []).map((failure) =>
      `| ${failure.appid} | ${failure.name.replace(/[|\r\n]+/g, " ").trim()} | ${failure.failure_category} | ${failure.failure_count} | ${failure.first_failed_at} | ${failure.last_failed_at} |`,
    ),
    ...(omittedFailures > 0 ? ["", `${omittedFailures} additional failures omitted.`] : []),
    "",
  ];
  const historyPath = join(artifactDirectory, "reception-history.jsonl");
  let history: string[] = [];
  try {
    history = (await readFile(historyPath, "utf8")).split(/\r?\n/).filter(Boolean).slice(-49);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  history.push(JSON.stringify({ completedAt: new Date().toISOString(), ...result }));
  await Promise.all([
    atomicWrite(join(artifactDirectory, "reception-queue.md"), queueLines.join("\n")),
    atomicWrite(join(artifactDirectory, "reception-failures.md"), failureLines.join("\n")),
    atomicWrite(historyPath, history.join("\n") + "\n"),
  ]);
}

/** Runs one bounded reception pass without coupling selection to player tracking. */
export async function runReviewCollection(
  db: AppDatabase,
  options: ReviewCollectionOptions = {},
): Promise<ReviewCollectionResult> {
  const anchorTime = options.anchorTime ?? new Date();
  if (Number.isNaN(anchorTime.getTime())) throw new RangeError("Invalid review collection time");
  const maxGames = Math.max(0, Math.min(DEFAULT_REVIEW_MAX_GAMES, options.maxGames ?? DEFAULT_REVIEW_MAX_GAMES));
  const maxReviewRequests = Math.max(0, Math.min(DEFAULT_REVIEW_MAX_REQUESTS, options.maxReviewRequests ?? DEFAULT_REVIEW_MAX_REQUESTS));
  const maxNewsHubRequests = Math.max(0, Math.min(DEFAULT_NEWS_HUB_MAX_REQUESTS, options.maxNewsHubRequests ?? DEFAULT_NEWS_HUB_MAX_REQUESTS));
  const allCandidates = await listReceptionCandidates(db, anchorTime);
  const candidates = allCandidates.slice(0, maxGames);
  const reviewBudget = { used: 0, max: maxReviewRequests };
  const newsBudget = { used: 0, max: maxNewsHubRequests };
  let attemptedGames = 0;
  let persistedGames = 0;
  let insufficientEvidence = 0;
  let ordinaryFailures = 0;
  let rateLimited = false;
  let deferredGames = 0;

  for (let index = 0; index < candidates.length; index++) {
    const game = candidates[index]!;
    if (reviewBudget.used >= reviewBudget.max) {
      deferredGames += candidates.length - index;
      break;
    }
    attemptedGames++;
    try {
      const outcome = await collectGame(db, game, anchorTime, options.customFetch ?? fetch, reviewBudget, newsBudget);
      if (outcome.result) persistedGames++;
      if (outcome.insufficient) insufficientEvidence++;
      if (outcome.failureCategory) {
        ordinaryFailures++;
        await recordFailure(db, game.appid, iso(anchorTime), outcome.failureCategory);
      } else if (!outcome.rateLimited && !outcome.deferred) {
        await clearFailure(db, game.appid);
        await writeCheckpoint(
          db,
          game.appid,
          outcome.insufficient ? DORMANT_DUE_AT : nextDue(anchorTime, game.appid, game.active ? 1 : 7),
          new Date(outcome.observedThrough ?? anchorTime),
        );
      }
      if (outcome.deferred) deferredGames++;
      if (outcome.rateLimited) {
        rateLimited = true;
        deferredGames += candidates.length - index - 1;
        break;
      }
    } catch {
      ordinaryFailures++;
      await recordFailure(db, game.appid, iso(anchorTime), "persistence");
    }
  }

  const remainingCandidates = await listReceptionCandidates(db, anchorTime);
  const reasons = remainingCandidates.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.reason] = (counts[candidate.reason] ?? 0) + 1;
    return counts;
  }, {});
  const result: ReviewCollectionResult = {
    anchorTime: iso(anchorTime),
    selectedGames: candidates.length,
    attemptedGames,
    reviewRequests: reviewBudget.used,
    newsHubRequests: newsBudget.used,
    persistedGames,
    insufficientEvidence,
    ordinaryFailures,
    rateLimited,
    deferredGames,
    dueRemaining: remainingCandidates.length,
    oldestDueAt: remainingCandidates.map((candidate) => candidate.dueAt).sort()[0] ?? null,
    reasons,
  };
  const artifactDirectory = options.artifactDirectory === undefined
    ? process.env.RECEPTION_ARTIFACT_DIR ?? "data"
    : options.artifactDirectory;
  if (artifactDirectory) {
    await writeOperatorArtifacts(db, artifactDirectory, remainingCandidates, result).catch((error) => {
      console.error("Reception artifact update failed", error instanceof Error ? error.message : String(error));
    });
  }
  return result;
}

export { checkpointKey };
