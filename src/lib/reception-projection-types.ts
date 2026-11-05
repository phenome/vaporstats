import type {
  ReceptionComparisonPoint,
  ReceptionMetric,
  ReceptionPopulationReference,
} from "./rankings";
import type { ReceptionRankingType } from "./reception-filters";

export const RECEPTION_PROJECTION_VERSION = 1;
export const RECEPTION_EVALUATION_BATCH_SIZE = 32;

export interface ReceptionProjectionMetricState {
  metric: ReceptionMetric | null;
  qualifyingReviews: number | null;
  populationRef: ReceptionPopulationReference | null;
  sourceTimestamp: string | null;
}

export interface ReceptionProjectionGame {
  appid: number;
  nowScoreHistoryId: number | null;
  now: ReceptionProjectionMetricState;
  allTime: ReceptionProjectionMetricState;
  nextEvaluationAt: string | null;
}

export type ReceptionProjectionMonth = Omit<
  ReceptionComparisonPoint,
  "comparison_rank" | "compared_count" | "reconstructed_count"
> & {
  appid: number;
  type: ReceptionRankingType;
  score_history_id: number | null;
};

export interface ReceptionProjectionEvaluation {
  current: ReceptionProjectionGame;
  months: ReceptionProjectionMonth[];
}
