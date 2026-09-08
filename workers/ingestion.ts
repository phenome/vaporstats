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
import { syncReleaseFactsFromApps } from "./release-facts";
import {
  compactReviewEvidence,
  type CompactReviewEvidenceResult,
} from "../src/lib/reception-store";

const INGESTION_DAILY_CHECKPOINT_KEY = "ingestion:last-daily-cycle";
const INGESTION_CRON = "*/15 * * * *";
const UTC = { tz: "UTC" as const };

export interface IngestionTickOptions {
  db: AppDatabase;
  steamApiKey?: string;
  anchorTime?: Date;
  customFetch?: typeof fetch;
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
  reviewCompaction?: CompactReviewEvidenceResult;
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
      rateLimited: result.reviewCollection.rateLimited,
      deferredGames: result.reviewCollection.deferredGames,
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
    },
    tagDictionary: result.tagDictionary && {
      refreshed: result.tagDictionary.refreshed,
      skipped: result.tagDictionary.skipped,
      successful: result.tagDictionary.successful,
      entries: result.tagDictionary.entries,
      date: result.tagDictionary.date,
    },
    reviewCompaction: result.reviewCompaction && {
      monthsCompacted: result.reviewCompaction.monthsCompacted,
      dailyBucketsDeleted: result.reviewCompaction.dailyBucketsDeleted,
      monthlyBucketsWritten: result.reviewCompaction.monthlyBucketsWritten,
    },
    catalogRefresh: result.catalogRefresh,
    error: result.error,
  }));
}

async function performIngestionTick(options: IngestionTickOptions): Promise<IngestionTickResult> {
  const startedAt = Date.now();
  const anchorTime = options.anchorTime ?? new Date();
  const customFetch = options.customFetch ?? fetch;
  const tick = await runPlayerCollectionTick(options.db, { anchorTime, customFetch });
  const reviewCollection = await runReviewCollection(options.db, { anchorTime, customFetch });
  const criticCollection = await runCriticCollection(options.db, { now: anchorTime, fetch: customFetch });

  let discovery: DiscoveryResult | undefined;
  let rollups: RollupJobResult | undefined;
  let tagDictionary: SteamTagDictionaryRefreshResult | undefined;
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
    tagDictionary = await refreshSteamTagDictionary(options.db, { now: anchorTime, fetchFn: customFetch });
    reviewCompaction = await compactReviewEvidence(options.db, anchorTime);
    await setCheckpoint(options.db, INGESTION_DAILY_CHECKPOINT_KEY, targetDate);
  }

  let prices: HourlyPriceFeedTickResult | undefined;
  if (options.steamApiKey) {
    prices = await runHourlyPriceFeedTick(options.db, {
      apiKey: options.steamApiKey,
      customFetch,
      anchorTime,
    });
  }
  if (prices?.changedAppIds?.length) {
    await syncReleaseFactsFromApps(options.db, { appIds: prices.changedAppIds });
  }

  const catalogRefreshResult = await refreshCatalogBatch(options.db, {
    checkpointKey: CATALOG_REFRESH_CHECKPOINT_KEY,
    fetchFn: customFetch,
  });

  const { records: _records, ...catalogRefresh } = catalogRefreshResult;
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
    reviewCompaction,
    catalogRefresh,
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

  activeIngestionTick = run;
  void run.finally(() => {
    if (activeIngestionTick === run) activeIngestionTick = null;
  });
  return run;
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
  if (options.runImmediately) {
    void (async () => {
      try {
        await reRankTrackedTiers(options.db);
      } catch (err) {
        console.error("Startup re-rank error:", err);
      }
      await runIngestionTick(options);
    })();
  }
  return cron;
}
