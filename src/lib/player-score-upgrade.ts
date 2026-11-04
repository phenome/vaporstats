import type { AppDatabase, AppPreparedStatement } from "./db";
import {
  calculatePlayerScoreCandidate,
  PLAYER_SCORE_FORMULA_VERSION,
  type ScoreEvidenceInput,
} from "./player-score";
import type { StoredScoreHistory } from "./reception-store";
import type { ReviewInterval } from "./review-evidence";

const MAX_UPGRADES_PER_TICK = 5_000;
const TRANSACTION_SIZE = 100;
const PREVIOUS_FORMULA_VERSION = "steam-player-v1";

export interface PlayerScoreUpgradeResult {
  inspected: number;
  upgraded: number;
  skipped: number;
  pending: number;
}

function isReviewInterval(value: unknown): value is ReviewInterval {
  return value !== null && typeof value === "object"
    && "start" in value && typeof value.start === "string"
    && "end" in value && typeof value.end === "string"
    && "granularity" in value && (value.granularity === "day" || value.granularity === "week" || value.granularity === "month");
}

function retainedEvidence(row: StoredScoreHistory, historical: boolean): ScoreEvidenceInput {
  const intervals: unknown = JSON.parse(historical ? row.historical_evidence_intervals : row.current_evidence_intervals);
  if (!Array.isArray(intervals) || !intervals.every(isReviewInterval)) throw new RangeError("Invalid retained score intervals");
  const observedAt = historical ? row.historical_evidence_observed_at : row.current_evidence_observed_at;
  return {
    sourceId: historical ? row.historical_source_id : row.current_source_id,
    positiveReviews: historical ? row.historical_positive_count : row.current_positive_count,
    totalReviews: historical ? row.historical_total_count : row.current_total_count,
    selectedIntervals: intervals,
    requested: {
      start: historical ? row.historical_window_start : row.current_window_start,
      end: historical ? row.historical_window_end : row.current_window_end,
    },
    observationTimes: observedAt ? [observedAt] : [],
    observedAt,
  };
}

/** Recalculates retained inputs once per formula, without claiming new review evidence. */
export async function upgradeRetainedPlayerScores(
  db: AppDatabase,
  options: { now?: Date; limit?: number } = {},
): Promise<PlayerScoreUpgradeResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError("Invalid score upgrade time");
  const at = now.toISOString();
  const requestedLimit = options.limit ?? MAX_UPGRADES_PER_TICK;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) throw new RangeError("Invalid score upgrade limit");
  const limit = Math.min(MAX_UPGRADES_PER_TICK, requestedLimit);
  const selected = await db.prepare(
    `SELECT h.* FROM player_score_state s
     JOIN player_score_history h ON h.id = s.latest_score_history_id AND h.appid = s.appid
     WHERE h.formula_version = ? AND h.observed_at <= ?
     ORDER BY h.appid LIMIT ?`,
  ).bind(PREVIOUS_FORMULA_VERSION, at, limit).all<StoredScoreHistory>();
  const result: PlayerScoreUpgradeResult = { inspected: 0, upgraded: 0, skipped: 0, pending: 0 };
  let statements: AppPreparedStatement[] = [];
  let previousIds: number[] = [];

  async function flush(): Promise<void> {
    if (statements.length === 0) return;
    await db.batch(statements);
    const count = await db.prepare(
      `SELECT COUNT(*) AS count FROM player_score_history
       WHERE formula_version = ? AND observed_at = ?
         AND json_extract(provenance, '$.recalculation.previous_observation_id') IN (${previousIds.map(() => "?").join(",")})`,
    ).bind(PLAYER_SCORE_FORMULA_VERSION, at, ...previousIds).first<{ count: number }>();
    result.upgraded += count?.count ?? 0;
    statements = [];
    previousIds = [];
  }

  for (const row of selected.results ?? []) {
    result.inspected++;
    try {
      const priorProvenance: unknown = JSON.parse(row.provenance);
      if (!priorProvenance || typeof priorProvenance !== "object" || Array.isArray(priorProvenance)) {
        result.skipped++;
        continue;
      }
      const current = retainedEvidence(row, false);
      const historical = row.historical_total_count > 0 ? retainedEvidence(row, true) : null;
      const candidate = calculatePlayerScoreCandidate({
        current,
        historical,
        evaluatedAt: row.current_window_end,
        observedAt: at,
        scoreWindow: { start: row.current_window_start, end: row.current_window_end },
        anchor: row.anchor_at ? { category: 14, start: row.anchor_at, ...(row.anchor_event_id ? { eventId: row.anchor_event_id } : {}) } : null,
      });
      // An unsupported retained row remains the last estimate until real collection repairs it.
      if (!candidate || candidate.currentReviews !== row.current_total_count || candidate.historicalReviews !== row.historical_total_count
        || candidate.inputs.current.selectedIntervals.length === 0
        || candidate.inputs.current.selectedIntervals.length !== current.selectedIntervals?.length
        || (historical && (candidate.inputs.historical?.selectedIntervals.length === 0
          || candidate.inputs.historical?.selectedIntervals.length !== historical.selectedIntervals?.length))) {
        result.skipped++;
        continue;
      }
      const provenance = JSON.stringify({
        ...priorProvenance,
        formulaVersion: candidate.formulaVersion,
        inputs: "inputs" in priorProvenance ? priorProvenance.inputs : candidate.inputs,
        recalculation: {
          previous_observation_id: row.id,
          previous_formula_version: row.formula_version,
          calculated_at: at,
        },
      });
      statements.push(db.prepare(
        `INSERT INTO player_score_history
         (appid, observed_at, score, formula_version, current_positive_count, current_total_count,
          historical_positive_count, historical_total_count, current_window_start, current_window_end,
          historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
          current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at,
          anchor_event_id, anchor_at, provenance)
         SELECT h.appid, ?, ?, ?, h.current_positive_count, h.current_total_count,
          h.historical_positive_count, h.historical_total_count, h.current_window_start, h.current_window_end,
          h.historical_window_start, h.historical_window_end, h.current_evidence_intervals, h.historical_evidence_intervals,
          h.current_source_id, h.historical_source_id, h.current_evidence_observed_at, h.historical_evidence_observed_at,
          h.anchor_event_id, h.anchor_at, ?
         FROM player_score_history h JOIN player_score_state s ON s.latest_score_history_id = h.id AND s.appid = h.appid
         WHERE h.id = ?`,
      ).bind(at, candidate.score, candidate.formulaVersion, provenance, row.id));
      statements.push(db.prepare(
        `UPDATE player_score_state SET latest_score_history_id = (
           SELECT id FROM player_score_history
           WHERE appid = ? AND formula_version = ? AND observed_at = ?
             AND json_extract(provenance, '$.recalculation.previous_observation_id') = ?
           ORDER BY id DESC LIMIT 1
         ), updated_at = CURRENT_TIMESTAMP
         WHERE appid = ? AND latest_score_history_id = ?`,
      ).bind(row.appid, candidate.formulaVersion, at, row.id, row.appid, row.id));
      previousIds.push(row.id);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError)) throw error;
      result.skipped++;
    }
    if (previousIds.length >= TRANSACTION_SIZE) await flush();
  }
  await flush();
  const pending = await db.prepare(
    `SELECT COUNT(*) AS count FROM player_score_state s
     JOIN player_score_history h ON h.id = s.latest_score_history_id AND h.appid = s.appid
     WHERE h.formula_version = ? AND h.observed_at <= ?`,
  ).bind(PREVIOUS_FORMULA_VERSION, at).first<{ count: number }>();
  result.pending = pending?.count ?? 0;
  return result;
}
