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

const RETRY_DELAY_MS = 15 * 60 * 1000;

type CandidateGame = { appid: number; slot: number };

export interface ReviewCollectionOptions {
  anchorTime?: Date;
  maxGames?: number;
  maxReviewRequests?: number;
  maxNewsHubRequests?: number;
  customFetch?: typeof fetch;
}

export interface ReviewCollectionResult {
  anchorTime: string;
  selectedGames: number;
  attemptedGames: number;
  reviewRequests: number;
  newsHubRequests: number;
  persistedGames: number;
  ordinaryFailures: number;
  rateLimited: boolean;
  deferredGames: number;
}



function checkpointKey(appid: number): string {
  return `${REVIEW_CHECKPOINT_PREFIX}${appid}`;
}

function iso(value: Date): string {
  return value.toISOString();
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRateLimited(result: ReviewSummaryResult | ReviewHistogramResult | SteamEventsResult): boolean {
  return !result.ok && result.rateLimited;
}

function succeededSummary(result: ReviewSummaryResult) {
  return result.ok ? result.value : null;
}

function succeededHistogram(result: ReviewHistogramResult) {
  return result.ok ? result.value : null;
}

function succeededEvents(result: SteamEventsResult) {
  return result.ok ? result.value.events : [];
}

function successfulObservationTime(
  anchor: string,
  summary: ReviewSummaryResult,
  histogram: ReviewHistogramResult,
  events: SteamEventsResult,
): string {
  const times = [
    summary.ok ? summary.value.observedAt : null,
    histogram.ok ? histogram.value.observedAt : null,
    events.ok ? events.value.observedAt : null,
  ].filter((value): value is string => validIso(value));
  return times.sort().at(-1) ?? anchor;
}

async function dueCandidates(db: AppDatabase, anchor: string, limit: number): Promise<CandidateGame[]> {
  const result = await db.prepare(
    `SELECT tg.appid, tg.slot
     FROM tracked_games AS tg
     LEFT JOIN checkpoints AS cp ON cp.key = ? || CAST(tg.appid AS TEXT)
     WHERE cp.key IS NULL OR cp.value <= ?
     ORDER BY CASE WHEN cp.key IS NULL THEN 0 ELSE 1 END, tg.slot, tg.appid
     LIMIT ?`,
  ).bind(REVIEW_CHECKPOINT_PREFIX, anchor, limit).all<CandidateGame>();
  return result.results ?? [];
}



async function writeCheckpoint(db: AppDatabase, appid: number, nextDueAt: string): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO checkpoints (key, value, cursor)
       VALUES (?, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(checkpointKey(appid), nextDueAt),
  ]);
}

function nextDailyDue(anchorTime: Date, appid: number): string {
  const day = 24 * 60 * 60 * 1000;
  const nextDay = (Math.floor(anchorTime.getTime() / day) + 1) * day;
  const slot = Math.abs(appid) % 96;
  return new Date(nextDay + slot * 15 * 60 * 1000).toISOString();
}

function retryDue(anchorTime: Date): string {
  return new Date(anchorTime.getTime() + RETRY_DELAY_MS).toISOString();
}

async function collectGame(
  db: AppDatabase,
  game: CandidateGame,
  anchorTime: Date,
  customFetch: typeof fetch,
  reviewBudget: { used: number; max: number },
  newsBudget: { used: number; max: number },
): Promise<{ result: PersistReceptionResult | null; rateLimited: boolean; ordinaryFailure: boolean }> {
  if (reviewBudget.used + 2 > reviewBudget.max || newsBudget.used >= newsBudget.max) return { result: null, rateLimited: false, ordinaryFailure: false };
  const observedAt = iso(anchorTime);
  const sourceOptions: ReviewSourceOptions = { customFetch, observedAt };
  reviewBudget.used++;
  const summary = await fetchSteamReviewSummary(game.appid, sourceOptions);
    if (isRateLimited(summary)) return { result: null, rateLimited: true, ordinaryFailure: false };
  reviewBudget.used++;
  const histogram = await fetchSteamReviewHistogram(game.appid, sourceOptions);
  if (isRateLimited(histogram)) {
    const goodSummary = succeededSummary(summary);
    const goodHistogram = succeededHistogram(histogram);
    if (goodSummary || goodHistogram) {
      const input: PersistReceptionObservationInput = {
        appid: game.appid,
        summary: goodSummary,
        histogram: goodHistogram,
        observedAt,
      };
      return {
        result: await persistReceptionObservation(db, input),
        rateLimited: true,
        ordinaryFailure: false,
      };
    }
    return { result: null, rateLimited: true, ordinaryFailure: false };
  }
  newsBudget.used++;
  const events = await fetchSteamNewsHubEvents(game.appid, { customFetch, observedAt } as NewsHubOptions);
  const goodSummary = succeededSummary(summary);
  const goodHistogram = succeededHistogram(histogram);
  const goodEvents = succeededEvents(events);
  const hasGoodComponent = !!goodSummary || !!goodHistogram || goodEvents.length > 0;
  const result = hasGoodComponent
    ? await persistReceptionObservation(db, {
        appid: game.appid,
        summary: goodSummary,
        histogram: goodHistogram,
        events: goodEvents,
        observedAt: successfulObservationTime(observedAt, summary, histogram, events),
      })
    : null;
  return {
    result,
    rateLimited: isRateLimited(events),
    ordinaryFailure: !hasGoodComponent,
  };
}

/** Collects only bounded, due tracked games; player cadence and counters are never written. */
export async function runReviewCollection(
  db: AppDatabase,
  options: ReviewCollectionOptions = {},
): Promise<ReviewCollectionResult> {
  const anchorTime = options.anchorTime ?? new Date();
  if (Number.isNaN(anchorTime.getTime())) throw new RangeError("Invalid review collection time");
  const maxGames = Math.max(0, Math.min(DEFAULT_REVIEW_MAX_GAMES, options.maxGames ?? DEFAULT_REVIEW_MAX_GAMES));
  const maxReviewRequests = Math.max(0, Math.min(DEFAULT_REVIEW_MAX_REQUESTS, options.maxReviewRequests ?? DEFAULT_REVIEW_MAX_REQUESTS));
  const maxNewsHubRequests = Math.max(0, Math.min(DEFAULT_NEWS_HUB_MAX_REQUESTS, options.maxNewsHubRequests ?? DEFAULT_NEWS_HUB_MAX_REQUESTS));
  const candidates = await dueCandidates(db, iso(anchorTime), maxGames);
  const reviewBudget = { used: 0, max: maxReviewRequests };
  const newsBudget = { used: 0, max: maxNewsHubRequests };
  let attemptedGames = 0;
  let persistedGames = 0;
  let ordinaryFailures = 0;
  let rateLimited = false;
  let deferredGames = 0;
  for (const game of candidates) {
    if (reviewBudget.used + 2 > reviewBudget.max || newsBudget.used >= newsBudget.max) {
      deferredGames++;
      continue;
    }
    attemptedGames++;
    try {
      const outcome = await collectGame(db, game, anchorTime, options.customFetch ?? fetch, reviewBudget, newsBudget);
      if (outcome.result) {
        persistedGames++;
        if (!outcome.rateLimited) await writeCheckpoint(db, game.appid, nextDailyDue(anchorTime, game.appid));
      } else if (outcome.ordinaryFailure) {
        ordinaryFailures++;
        await writeCheckpoint(db, game.appid, nextDailyDue(anchorTime, game.appid));
      }
      if (outcome.rateLimited) {
        rateLimited = true;
        await writeCheckpoint(db, game.appid, retryDue(anchorTime));
        deferredGames += candidates.length - attemptedGames;
        break;
      }
    } catch {
      ordinaryFailures++;
      await writeCheckpoint(db, game.appid, nextDailyDue(anchorTime, game.appid));
    }
  }
  return {
    anchorTime: iso(anchorTime),
    selectedGames: candidates.length,
    attemptedGames,
    reviewRequests: reviewBudget.used,
    newsHubRequests: newsBudget.used,
    persistedGames,
    ordinaryFailures,
    rateLimited,
    deferredGames,
  };
}

export { checkpointKey };
