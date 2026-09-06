import { createDailySnapshot, type AppDatabase } from "../src/lib/db";
import {
  computeDailyRollups,
  cleanExpiredRawObservations,
  RAW_OBSERVATION_RETENTION_DAYS,
  type RollupRecord,
} from "../src/lib/player-history";

export interface RollupJobResult {
  anchorTime: string;
  targetDate: string;
  rolledUpCount: number;
  cleanedObservationsCount: number;
  snapshotPath: string;
  records: RollupRecord[];
}

/**
 * Executes the UTC daily player rollup cycle. The prior UTC day is rolled up,
 * then thirty-day raw observations are removed, and one dated snapshot is made.
 * Cleanup and snapshot are reached only after rollup persistence succeeds.
 */
export async function runDailyRollupJob(
  db: AppDatabase,
  options: {
    anchorTime?: Date;
    targetDate?: string;
    retentionDays?: number;
    snapshot?: (db: AppDatabase, date: string) => Promise<string>;
  } = {}
): Promise<RollupJobResult> {
  const anchorTime = options.anchorTime ?? new Date();
  const targetDate = options.targetDate ?? previousUtcDate(anchorTime);
  const retentionDays = options.retentionDays ?? RAW_OBSERVATION_RETENTION_DAYS;

  const rollupResult = await computeDailyRollups(db, {
    targetDate,
    anchorTime,
  });
  const cleanedCount = await cleanExpiredRawObservations(db, anchorTime, retentionDays);
  const snapshotPath = await (options.snapshot ?? createDailySnapshot)(db, targetDate);

  return {
    anchorTime: anchorTime.toISOString(),
    targetDate,
    rolledUpCount: rollupResult.rolledUpCount,
    cleanedObservationsCount: cleanedCount,
    snapshotPath,
    records: rollupResult.records,
  };
}

function previousUtcDate(anchorTime: Date): string {
  const date = new Date(
    Date.UTC(anchorTime.getUTCFullYear(), anchorTime.getUTCMonth(), anchorTime.getUTCDate() - 1)
  );
  return date.toISOString().slice(0, 10);
}

export { computeDailyRollups, cleanExpiredRawObservations };
