import type { AppDatabase } from "../src/lib/db";
import { getCheckpoint, setCheckpoint } from "../src/lib/catalog";
import {
  runPlayerCollectionTick,
  runDailyDiscoveryAndReRanking,
  type CollectionTickResult,
  type DiscoveryResult,
} from "./player-collector";
import {
  runReviewCollection,
  type ReviewCollectionResult,
} from "./review-collector";
import {
  runCriticCollection,
  type CriticCollectionResult,
} from "./critic-collector";
import { reRankTrackedTiers } from "../src/lib/player";
import { runDailyRollupJob, type RollupJobResult } from "./player-rollups";
import {
  runHourlyPriceFeedTick,
  type HourlyPriceFeedTickResult,
} from "./price-collector";
import {
  CATALOG_REFRESH_CHECKPOINT_KEY,
  refreshCatalogBatch,
  refreshSteamTagDictionary,
  type SteamTagDictionaryRefreshResult,
} from "./catalog-seed";
import {
  runSerializedMediaDiscovery,
  type MediaRunSummary,
} from "../src/lib/media-discovery";
import {
  advanceMediaProcessing,
  recheckPausedProvidersAtStartup,
  type MediaProcessingSummary,
} from "../src/lib/media-processing";
import {
  automaticMediaIngestionEnabled,
  latestScheduledDiscovery,
  openScheduledDiscovery,
  runDailyMediaRun,
  type DailyMediaRunSummary,
} from "../src/lib/media-daily-run";
import {
  compactReviewEvidence,
  type CompactReviewEvidenceResult,
} from "../src/lib/reception-store";
import { syncReleaseFactsFromApps } from "./release-facts";
import { upgradeRetainedPlayerScores, type PlayerScoreUpgradeResult } from "../src/lib/player-score-upgrade";
import {
  publishReceptionProjection,
  type ReceptionPublicationProgress,
} from "../src/lib/reception-publication";

const INGESTION_DAILY_CHECKPOINT_KEY = "ingestion:last-daily-cycle";
const INGESTION_CRON = "*/15 * * * *";
const UTC = { tz: "UTC" as const };

export interface IngestionTickOptions {
  db: AppDatabase;
  steamApiKey?: string;
  anchorTime?: Date;
  customFetch?: typeof fetch;
  tavilyApiKey?: string;
  geminiApiKey?: string;
  /** The OpenRouter key that text generation (extraction and Overviews) uses. */
  openRouterApiKey?: string;
  /** How long one OpenRouter request may take before its outcome becomes unknown. */
  openRouterTimeoutMs?: number;
  /** How many paid media items each provider may take from the queue per tick. */
  paidSubmissionsPerTick?: number;
  /** How long one tick may spend taking paid media items from the queue. */
  paidWorkTimeBudgetMs?: number;
  /** A monotonic clock in milliseconds that measures `paidWorkTimeBudgetMs`. */
  paidWorkClock?: () => number;
  stalePriceDealsOnly?: boolean;
  /**
   * Whether automatic media ingestion is enabled; defaults to the server's
   * `MEDIA_AUTOMATIC_INGESTION` setting, which is off unless it is `true`.
   */
  mediaAutomaticIngestion?: boolean;
}

export interface IngestionTickResult {
  status: "completed" | "skipped" | "error";
  anchorTime: string;
  durationMs: number;
  reason?: "run_in_progress" | "error";
  tick?: CollectionTickResult;
  reviewCollection?: ReviewCollectionResult;
  criticCollection?: CriticCollectionResult;
  discovery?: DiscoveryResult;
  rollups?: RollupJobResult;
  prices?: HourlyPriceFeedTickResult;
  tagDictionary?: SteamTagDictionaryRefreshResult;
  mediaDailyRun?: DailyMediaRunSummary;
  mediaDiscovery?: MediaRunSummary;
  mediaProcessing?: MediaProcessingSummary;
  reviewCompaction?: CompactReviewEvidenceResult;
  scoreUpgrade?: PlayerScoreUpgradeResult;
  receptionPublication?: ReceptionPublicationProgress;
  catalogRefresh?: {
    active: boolean;
    attempted: number;
    successful: number;
    failed: number;
    rateLimited: boolean;
    pending: number;
  };
  error?: string;
}

export type IngestionCron = (
  expression: string,
  handler: () => unknown,
  options: { tz: "UTC" }
) => unknown;

export interface IngestionSchedulerOptions extends IngestionTickOptions {
  runImmediately?: boolean;
  cron?: IngestionCron;
}

let activeIngestionTick: Promise<IngestionTickResult> | null = null;

function previousUtcDate(anchorTime: Date): string {
  const date = new Date(
    Date.UTC(anchorTime.getUTCFullYear(), anchorTime.getUTCMonth(), anchorTime.getUTCDate() - 1)
  );
  return date.toISOString().slice(0, 10);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 256);
}

function logCompletion(result: IngestionTickResult): void {
  console.log(JSON.stringify({
    event: "ingestion_completion",
    status: result.status,
    anchorTime: result.anchorTime,
    durationMs: result.durationMs,
    reason: result.reason,
    scoreUpgrade: result.scoreUpgrade,
    tick: result.tick && {
      attempted: result.tick.attempted,
      succeeded: result.tick.succeeded,
      failed: result.tick.failed,
      dailyCount: result.tick.dailyCount,
    },
    reviewCollection: result.reviewCollection && {
      selectedGames: result.reviewCollection.selectedGames,
      attemptedGames: result.reviewCollection.attemptedGames,
      reviewRequests: result.reviewCollection.reviewRequests,
      newsHubRequests: result.reviewCollection.newsHubRequests,
      persistedGames: result.reviewCollection.persistedGames,
      ordinaryFailures: result.reviewCollection.ordinaryFailures,
      insufficientEvidence: result.reviewCollection.insufficientEvidence,
      rateLimited: result.reviewCollection.rateLimited,
      deferredGames: result.reviewCollection.deferredGames,
      dueRemaining: result.reviewCollection.dueRemaining,
      oldestDueAt: result.reviewCollection.oldestDueAt,
    },
    criticCollection: result.criticCollection && {
      requests: result.criticCollection.requests,
      games: result.criticCollection.games,
      successes: result.criticCollection.successes,
      negativeLookups: result.criticCollection.negativeLookups,
      failures: result.criticCollection.failures,
      rateLimited: result.criticCollection.rateLimited,
      sitemapRefreshed: result.criticCollection.sitemapRefreshed,
    },
    discovery: result.discovery && {
      discovered: result.discovery.discovered,
      initialObservations: result.discovery.initialObservations,
      replacements: result.discovery.replacements,
    },
    rollups: result.rollups && {
      targetDate: result.rollups.targetDate,
      rolledUpCount: result.rollups.rolledUpCount,
      cleanedObservationsCount: result.rollups.cleanedObservationsCount,
      snapshotPath: result.rollups.snapshotPath,
    },
    prices: result.prices && {
      attempted: result.prices.attempted,
      successful: result.prices.successful,
      failed: result.prices.failed,
      changed: result.prices.changed,
      pending: result.prices.pending,
      rateLimited: result.prices.rateLimited,
      revalidationAttempted: result.prices.revalidationAttempted,
      revalidationSuccessful: result.prices.revalidationSuccessful,
      revalidationFailed: result.prices.revalidationFailed,
      revalidationChanged: result.prices.revalidationChanged,
      revalidationPending: result.prices.revalidationPending,
      currentDeals: result.prices.currentDeals,
      dealsWithExactExpiry: result.prices.dealsWithExactExpiry,
    },
    tagDictionary: result.tagDictionary && {
      refreshed: result.tagDictionary.refreshed,
      skipped: result.tagDictionary.skipped,
      successful: result.tagDictionary.successful,
      entries: result.tagDictionary.entries,
      date: result.tagDictionary.date,
    },
    mediaDailyRun: result.mediaDailyRun && {
      day: result.mediaDailyRun.day,
      enrollmentStartDate: result.mediaDailyRun.enrollmentStartDate,
      enrolled: result.mediaDailyRun.enrolled.length,
      discoveryRunId: result.mediaDailyRun.discoveryRunId,
    },
    mediaDiscovery: result.mediaDiscovery && {
      runId: result.mediaDiscovery.runId,
      status: result.mediaDiscovery.status,
      resumed: result.mediaDiscovery.resumed,
      // This tick's discovery work, not the pass's running totals.
      searches: result.mediaDiscovery.issued.searches,
      attempts: result.mediaDiscovery.issued.attempts,
      articles: result.mediaDiscovery.issued.articles,
      tavily: {
        searchCreditsConsumed: result.mediaDiscovery.usage.searchCreditsConsumed,
        planUsage: result.mediaDiscovery.usage.planUsage,
        planLimit: result.mediaDiscovery.usage.planLimit,
        remainingCredits: result.mediaDiscovery.usage.remainingCredits,
      },
      stopReasons: result.mediaDiscovery.stopReasons,
    },
    mediaProcessing: result.mediaProcessing && {
      runId: result.mediaProcessing.runId,
      status: result.mediaProcessing.status,
      submitted: result.mediaProcessing.submitted,
      completed: result.mediaProcessing.completed,
      outputs: result.mediaProcessing.outputs,
      stopReasons: result.mediaProcessing.stopReasons,
      queued: result.mediaProcessing.queued,
      providers: Object.fromEntries(Object.entries(result.mediaProcessing.providers).map(([provider, state]) => [provider, { paused: state.paused, reason: state.reason, pausedAt: state.pausedAt, checkedAt: state.checkedAt, checkOutcome: state.checkOutcome }])),
      cost: result.mediaProcessing.cost,
    },
    reviewCompaction: result.reviewCompaction && {
      monthsCompacted: result.reviewCompaction.monthsCompacted,
      dailyBucketsDeleted: result.reviewCompaction.dailyBucketsDeleted,
      monthlyBucketsWritten: result.reviewCompaction.monthlyBucketsWritten,
    },
    catalogRefresh: result.catalogRefresh,
    receptionPublication: result.receptionPublication,
    error: result.error,
  }));
}

/**
 * The media part of a tick. While automatic media ingestion is enabled, the
 * daily media run happens when due, today's scheduled discovery run resumes
 * if a restart interrupted it, and the paid-work queue advances. Ticks never
 * start searches of their own. While it is disabled, only work already
 * submitted to a provider is polled: no daily media run, discovery, credit
 * check, new queue item or paid submission, and queued work and due passes
 * are kept.
 */
async function advanceMedia(
  options: IngestionTickOptions,
  anchorTime: Date,
  customFetch: typeof fetch,
): Promise<Pick<IngestionTickResult, "mediaDailyRun" | "mediaDiscovery" | "mediaProcessing">> {
  const { db } = options;
  const providerOptions = {
    geminiApiKey: options.geminiApiKey ?? process.env.GEMINI_API_KEY,
    openRouterApiKey: options.openRouterApiKey ?? process.env.OPENROUTER_API_KEY,
    openRouterTimeoutMs: options.openRouterTimeoutMs,
    articleFetch: customFetch,
    providerFetch: customFetch,
    now: anchorTime,
  };
  if (!(options.mediaAutomaticIngestion ?? automaticMediaIngestionEnabled())) {
    const submitted = await db.prepare("SELECT id FROM media_processing_jobs WHERE status = 'submitted' LIMIT 1").first<{ id: number }>();
    if (!submitted) return {};
    return { mediaProcessing: await advanceMediaProcessing(db, { ...providerOptions, pollOnly: true }) };
  }
  // The first tick of a started process rechecks paused providers, so a fix
  // deployed for a configuration pause need not wait for the daily check.
  const rechecked = await recheckPausedProvidersAtStartup(db, anchorTime, providerOptions);
  const mediaDailyRun = await runDailyMediaRun(db, anchorTime, providerOptions) ?? undefined;
  let mediaDiscovery: MediaRunSummary | undefined;
  const scheduledRun = await openScheduledDiscovery(db, anchorTime);
  if (scheduledRun !== null) {
    mediaDiscovery = await runSerializedMediaDiscovery(db, {
      runId: scheduledRun,
      tavilyApiKey: options.tavilyApiKey ?? process.env.TAVILY_API_KEY,
      fetch: customFetch,
      now: anchorTime,
    });
  }
  const automaticRunId = await latestScheduledDiscovery(db);
  const pendingAuthorization = await db
    .prepare("SELECT a.run_id FROM media_processing_authorizations AS a JOIN media_discovery_runs AS r ON r.id = a.run_id WHERE a.status IN ('queued', 'waiting') AND r.status NOT IN ('queued', 'running') ORDER BY a.authorized_at LIMIT 1")
    .first<{ run_id: number }>();
  const queuedWork = await db
    .prepare("SELECT run_id FROM media_processing_jobs WHERE status = 'submitted' OR (status = 'queued' AND retained = 0) LIMIT 1")
    .first<{ run_id: number }>();
  if (automaticRunId === null && !pendingAuthorization && !queuedWork) return { mediaDailyRun, mediaDiscovery };
  const mediaProcessing = await advanceMediaProcessing(db, {
    ...providerOptions,
    ...(pendingAuthorization ? { runId: pendingAuthorization.run_id } : {}),
    ...(automaticRunId !== null ? { automaticRunId } : {}),
    probe: [...rechecked, ...(mediaDailyRun?.probe ?? [])],
    submissionsPerTick: options.paidSubmissionsPerTick,
    paidWorkTimeBudgetMs: options.paidWorkTimeBudgetMs,
    paidWorkClock: options.paidWorkClock,
  });
  return { mediaDailyRun, mediaDiscovery, mediaProcessing };
}

async function performIngestionTick(options: IngestionTickOptions): Promise<IngestionTickResult> {
  const startedAt = Date.now();
  const anchorTime = options.anchorTime ?? new Date();
  const customFetch = options.customFetch ?? fetch;
  const scoreUpgrade = await upgradeRetainedPlayerScores(options.db, { now: anchorTime });
  if (scoreUpgrade.inspected > 0) {
    console.log(JSON.stringify({ event: "player_score_formula_upgrade", at: anchorTime.toISOString(), ...scoreUpgrade }));
  }
  const prices = await runHourlyPriceFeedTick(options.db, {
    apiKey: options.steamApiKey,
    customFetch,
    anchorTime,
    staleDealsOnly: options.stalePriceDealsOnly,
  });
  if (prices?.changedAppIds?.length) {
    await syncReleaseFactsFromApps(options.db, { appIds: prices.changedAppIds });
  }
  const tick = await runPlayerCollectionTick(options.db, { anchorTime, customFetch });
  const reviewCollection = await runReviewCollection(options.db, { anchorTime, customFetch });
  const criticCollection = await runCriticCollection(options.db, { now: anchorTime, fetch: customFetch });
  const media = await advanceMedia(options, anchorTime, customFetch);

  let discovery: DiscoveryResult | undefined;
  let rollups: RollupJobResult | undefined;
  let reviewCompaction: CompactReviewEvidenceResult | undefined;
  const targetDate = previousUtcDate(anchorTime);
  const dailyCheckpoint = await getCheckpoint(options.db, INGESTION_DAILY_CHECKPOINT_KEY);
  const trackedGame = await options.db
    .prepare("SELECT appid FROM tracked_games LIMIT 1")
    .first<{ appid: number }>();
  const dailyCycleDue = dailyCheckpoint?.value !== targetDate;
  if (dailyCycleDue || !trackedGame) {
    discovery = await runDailyDiscoveryAndReRanking(options.db, {
      anchorTime,
      budgetTime: anchorTime,
      customFetch,
      alreadyAttemptedInTick: tick.attempted,
    });
  } else if (anchorTime.getUTCMinutes() === 0 && trackedGame) {
    await reRankTrackedTiers(options.db, anchorTime);
  }
  if (dailyCycleDue) {
    rollups = await runDailyRollupJob(options.db, { anchorTime, targetDate });
    reviewCompaction = await compactReviewEvidence(options.db, anchorTime);
    await setCheckpoint(options.db, INGESTION_DAILY_CHECKPOINT_KEY, targetDate);
  }
  const tagDictionary = await refreshSteamTagDictionary(options.db, { now: anchorTime, fetchFn: customFetch });


  const catalogRefreshResult = await refreshCatalogBatch(options.db, {
    checkpointKey: CATALOG_REFRESH_CHECKPOINT_KEY,
    fetchFn: customFetch,
  });

  const { records: _records, ...catalogRefresh } = catalogRefreshResult;
  // Reevaluate elapsed-time eligibility even when every source request was skipped or failed.
  // Without an explicit test anchor, use completion time rather than the tick's start time.
  const receptionPublication = await publishReceptionProjection(options.db, {
    evaluatedAt: options.anchorTime,
  });
  return {
    status: "completed",
    anchorTime: anchorTime.toISOString(),
    durationMs: Date.now() - startedAt,
    tick,
    reviewCollection,
    criticCollection,
    discovery,
    rollups,
    prices,
    tagDictionary,
    ...media,
    reviewCompaction,
    scoreUpgrade,
    catalogRefresh,
    receptionPublication,
  };
}

/** Runs one bounded ingestion cycle. Concurrent calls are skipped process-wide. */
export function runIngestionTick(options: IngestionTickOptions): Promise<IngestionTickResult> {
  if (activeIngestionTick) {
    const skipped: IngestionTickResult = {
      status: "skipped",
      anchorTime: (options.anchorTime ?? new Date()).toISOString(),
      durationMs: 0,
      reason: "run_in_progress",
    };
    logCompletion(skipped);
    return Promise.resolve(skipped);
  }

  const startedAt = Date.now();
  const run = (async (): Promise<IngestionTickResult> => {
    try {
      const result = await performIngestionTick(options);
      result.durationMs = Date.now() - startedAt;
      logCompletion(result);
      return result;
    } catch (error) {
      const result: IngestionTickResult = {
        status: "error",
        anchorTime: (options.anchorTime ?? new Date()).toISOString(),
        durationMs: Date.now() - startedAt,
        reason: "error",
        error: boundedError(error),
      };
      console.error(JSON.stringify({
        event: "ingestion_error",
        status: result.status,
        anchorTime: result.anchorTime,
        durationMs: result.durationMs,
        error: result.error,
      }));
      return result;
    }
  })();

  const guardedRun = run.finally(() => {
    if (activeIngestionTick === guardedRun) activeIngestionTick = null;
  });
  activeIngestionTick = guardedRun;
  return guardedRun;
}

/** Registers the UTC fifteen-minute scheduler and optionally resumes work immediately. */
export function startIngestionScheduler(options: IngestionSchedulerOptions): unknown {
  const cron = options.cron ?? (Bun.cron as IngestionCron);
  try {
    cron(INGESTION_CRON, () => runIngestionTick(options), UTC);
  } catch (error) {
    console.error(JSON.stringify({
      event: "ingestion_scheduler_error",
      error: boundedError(error),
    }));
  }
  let startupRun: Promise<IngestionTickResult> | null = null;
  if (options.runImmediately) {
    startupRun = (async () => {
      try {
        await reRankTrackedTiers(options.db);
      } catch (err) {
        console.error("Startup re-rank error:", err);
      }
      return runIngestionTick({ ...options, stalePriceDealsOnly: true });
    })();
  }
  return startupRun ?? cron;
}
