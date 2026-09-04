import type { D1Database } from "../src/lib/db";
import {
  computeDailyRollups,
  cleanExpiredRawObservations,
  type RollupRecord,
} from "../src/lib/player-history";

export interface RollupJobResult {
  anchorTime: string;
  rolledUpCount: number;
  cleanedObservationsCount: number;
  records: RollupRecord[];
}

/**
 * Executes daily player rollup computation and 90-day raw observation cleanup.
 * 1. Computes min, max, avg, closing, and sample count for completed raw observation days.
 * 2. Purges raw observations older than retention period (default 90 days).
 *
 * Boring helper designed for the scheduled ingestion worker to invoke daily.
 */
export async function runDailyRollupJob(
  db: D1Database,
  options: {
    anchorTime?: Date;
    targetDate?: string;
    retentionDays?: number;
  } = {}
): Promise<RollupJobResult> {
  const anchorTime = options.anchorTime ?? new Date();
  const retentionDays = options.retentionDays ?? 90;

  // 1. Idempotently persist rollups before purging raw observations
  const rollupResult = await computeDailyRollups(db, {
    targetDate: options.targetDate,
    anchorTime,
  });

  // 2. Clean expired raw observations (retained for 90 days)
  const cleanedCount = await cleanExpiredRawObservations(db, anchorTime, retentionDays);

  return {
    anchorTime: anchorTime.toISOString(),
    rolledUpCount: rollupResult.rolledUpCount,
    cleanedObservationsCount: cleanedCount,
    records: rollupResult.records,
  };
}

export { computeDailyRollups, cleanExpiredRawObservations };
