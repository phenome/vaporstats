import { getGameByAppId, type CatalogEntity } from "./catalog";
import type { AppDatabase } from "./db";
import {
  evaluateCriticAlignment,
  type CriticAlignmentOutcome,
  type CriticRecord,
  type RetainedPlayerSnapshot,
} from "./critics";
import { getCriticRecords } from "./critic-store";
import {
  getGameReceptionEligibility,
  type GameReceptionEligibility,
  type ReceptionPopulationReference,
} from "./rankings";
import type { StoredReviewBucket, StoredScoreHistory, StoredSteamEvent } from "./reception-store";
import {
  evaluateRecentReception,
  type RecentReceptionResult,
} from "./recent-reception";
import {
  selectWholeBuckets,
  type ReviewBucket,
  type ReviewInterval,
  type WholeBucketSelection,
} from "./review-evidence";
import { reconstructPlayerScoreAt } from "./score-reconstruction";
import type { PlayerScoreCandidate, ScoreAnchor } from "./player-score";

import type { HistoryRange } from "./player-history";

export interface ScoreAnchorPayload {
  category: 14;
  start: string;
  event_id: string | null;
  source_id: string | null;
}

export interface ScorePopulationReference extends ReceptionPopulationReference {
  population_flags: Record<string, unknown>;
  interpretation_version: string;
}

export interface ScoreEvidenceWindow {
  start: string | null;
  end: string | null;
}

export interface GameScoreValue {
  value: number;
  observation_id: number;
  observed_at: string;
  formula_version: string;
  anchor: ScoreAnchorPayload | null;
  score_window: ScoreEvidenceWindow;
  evidence_start: string | null;
  evidence_end: string | null;
  current_positive_reviews: number;
  current_total_reviews: number;
  current_reviews: number;
  current_evidence_intervals: readonly ReviewInterval[];
  current_evidence_observed_at: string | null;
  historical_evidence_intervals: readonly ReviewInterval[];
  historical_evidence_window: ScoreEvidenceWindow;
  historical_evidence_observed_at: string | null;
  historical_support: {
    actual_reviews: number;
    effective_reviews: number;
    positive_reviews: number;
    total_reviews: number;
  };
  population_ref: ScorePopulationReference | null;
  historical_population_ref: ScorePopulationReference | null;
  provenance: unknown;
}

export interface ScoreCriticRecord {
  source: CriticRecord["source"];
  source_id: string;
  source_url: string;
  steam_app_id: number;
  title: string;
  slug: string;
  edition: string;
  platforms: readonly string[];
  platform_scope: CriticRecord["platformScope"];
  native_score: number | null;
  score_scale: number | null;
  native_tier: CriticRecord["tier"];
  review_count: number | null;
  percent_recommended: number | null;
  review_period_start: string | null;
  review_period_end: string | null;
  observed_at: string | null;
  collection_basis: CriticRecord["collectionBasis"];
  matched_identity: CriticRecord["matchedIdentity"];
  identity_verified: boolean;
  cadence: CriticRecord["cadence"];
}

export interface ScorePlayerSnapshot {
  score: number | null;
  review_count: number | null;
  observed_at: string | null;
  source?: string;
  population?: string;
}

export interface ScoreCriticAlignment {
  source: CriticAlignmentOutcome["source"];
  state: CriticAlignmentOutcome["state"];
  alignment: CriticAlignmentOutcome["alignment"];
  player_direction: CriticAlignmentOutcome["playerDirection"];
  critic_direction: CriticAlignmentOutcome["criticDirection"];
  current_contrast: {
    state: CriticAlignmentOutcome["currentContrast"]["state"];
    alignment: CriticAlignmentOutcome["currentContrast"]["alignment"];
    player_direction: CriticAlignmentOutcome["currentContrast"]["playerDirection"];
    critic_direction: CriticAlignmentOutcome["currentContrast"]["criticDirection"];
    reasons: readonly string[];
  };
  freshness: CriticAlignmentOutcome["freshness"];
  evidence: {
    critic: ScoreCriticRecord;
    review_time_player_snapshot: ScorePlayerSnapshot | null;
    current_player: ScorePlayerSnapshot | null;
  };
  reasons: readonly string[];
}

export interface RecentReceptionPayload {
  state: RecentReceptionResult["state"];
  evaluated_at: string;
  cutoff: string;
  recent: RecentReceptionPeriodPayload;
  previous: RecentReceptionPeriodPayload;
  delta_pp: number | null;
  reasons: readonly string[];
}

export interface RecentReceptionPeriodPayload {
  start: string;
  end: string;
  positive_reviews: number | null;
  total_reviews: number | null;
  approval: number | null;
  covered_intervals: readonly ReviewInterval[];
  gaps: readonly ReviewInterval[];
  source_id: string | null;
  population_ref: ScorePopulationReference | null;
  observation_times: readonly string[];
  coverage_complete: boolean;
  wilson95: { lower: number; upper: number } | null;
}


export interface GameScoreSummary {
  lifetime_approval: {
    value: number;
    positive_reviews: number;
    total_reviews: number;
    observed_at: string;
    population_ref: ScorePopulationReference | null;
  } | null;
  game: CatalogEntity;
  score: GameScoreValue | null;
  eligibility: GameReceptionEligibility;
  critics: readonly ScoreCriticRecord[];
  alignment: readonly ScoreCriticAlignment[];
  recent_reception: RecentReceptionPayload;
}

export interface RecordedScore {
  observation_id: number;
  observed_at: string;
  value: number;
  formula_version: string;
  anchor: ScoreAnchorPayload | null;
  score_window: ScoreEvidenceWindow;
  evidence_start: string | null;
  evidence_end: string | null;
  current_positive_reviews: number;
  current_total_reviews: number;
  current_reviews: number;
  current_evidence_intervals: readonly ReviewInterval[];
  current_evidence_observed_at: string | null;
  historical_evidence_intervals: readonly ReviewInterval[];
  historical_evidence_window: ScoreEvidenceWindow;
  historical_evidence_observed_at: string | null;
  historical_support: {
    actual_reviews: number;
    effective_reviews: number;
    positive_reviews: number;
    total_reviews: number;
  };
  population_ref: ScorePopulationReference | null;
  historical_population_ref: ScorePopulationReference | null;
  provenance: unknown;
}
export interface ReconstructedScore {
  kind: "reconstructed";
  score_at: string;
  evaluated_at: string;
  observed_at: string | null;
  value: number;
  formula_version: string;
  anchor: ScoreAnchorPayload | null;
  score_window: ScoreEvidenceWindow;
  evidence_start: string | null;
  evidence_end: string | null;
  current_positive_reviews: number;
  current_total_reviews: number;
  current_reviews: number;
  current_evidence_intervals: readonly ReviewInterval[];
  current_evidence_observed_at: string | null;
  historical_evidence_intervals: readonly ReviewInterval[];
  historical_evidence_window: ScoreEvidenceWindow;
  historical_evidence_observed_at: string | null;
  historical_support: {
    actual_reviews: number;
    effective_reviews: number;
    positive_reviews: number;
    total_reviews: number;
  };
  population_ref: ScorePopulationReference | null;
  historical_population_ref: ScorePopulationReference | null;
  provenance: unknown;
}

export interface ApprovalBucket {
  source_id: string;
  granularity: "daily" | "monthly";
  period_start: string;
  period_end: string;
  positive_reviews: number;
  negative_reviews: number;
  total_reviews: number;
  approval: number | null;
  observed_at: string;
  population_ref: ScorePopulationReference | null;
}

export interface ScoreMilestone {
  event_id: string;
  kind: string | null;
  title: string | null;
  event_time: string;
  event_precision: "day" | "instant";
  date_basis: "start_at" | "publication_at";
  source_url: string | null;
  display_label: string;
}

export interface HistoryMetric {
  value: number | null;
  positive_reviews: number | null;
  total_reviews: number | null;
  included_start: string | null;
  included_end: string | null;
  population_ref: ScorePopulationReference | null;
  observed_at: string | null;
  coverage_complete: boolean;
  gaps: readonly ReviewInterval[];
}

export interface GameScoreHistory {
  appid: number;
  range: HistoryRange;
  range_start: string | null;
  range_end: string | null;
  recorded_scores: readonly RecordedScore[];
  reconstructed_scores: readonly ReconstructedScore[];
  approval_buckets: readonly ApprovalBucket[];
  milestones: readonly ScoreMilestone[];
  populations: readonly ScorePopulationReference[];
  metrics: {
    latest_approval: HistoryMetric | null;
    reviews_in_period: HistoryMetric | null;
  };
}

export interface ScoreQueryResult<T> {
  data: T | null;
  sourceTimestamp: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS = 90 * DAY_MS;
const EIGHTY_FOUR_DAYS = 84 * DAY_MS;
const HISTORY_DURATIONS: Record<Exclude<HistoryRange, "all">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": NINETY_DAYS,
};
const HISTORICAL_SUPPORT_CAP = 20;

type SourceRow = {
  id: string;
  endpoint: "appreviews" | "appreviewhistogram";
  request_filter: string;
  language: string | null;
  purchase_type: string | null;
  filter_offtopic_activity: number | null;
  population: string;
  population_flags: string;
  interpretation_version: string;
};

type RawScore = StoredScoreHistory;

type RawSnapshot = Pick<StoredScoreHistory, "observed_at" | "score" | "current_total_count">;

function parseUtc(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value !== "string") return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T00:00:00.000Z" : value;
  if (!/Z$/i.test(normalized)) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function evaluatedAt(value: Date | undefined): string {
  const time = parseUtc(value ?? new Date());
  if (time === null) throw new RangeError("Invalid score evaluation time");
  return iso(time);
}

function maxTimestamp(values: readonly (string | null | undefined)[]): string | null {
  let newest: number | null = null;
  for (const value of values) {
    const time = parseUtc(value);
    if (time !== null && (newest === null || time > newest)) newest = time;
  }
  return newest === null ? null : iso(newest);
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceRef(source: SourceRow | null | undefined): ScorePopulationReference | null {
  if (!source) return null;
  const flags = safeJson(source.population_flags);
  return {
    source_id: source.id,
    endpoint: source.endpoint,
    request_filter: source.request_filter,
    population: source.population,
    language: source.language,
    purchase_type: source.purchase_type,
    filter_offtopic_activity: source.filter_offtopic_activity,
    population_flags: isRecord(flags) ? flags : {},
    interpretation_version: source.interpretation_version,
  };
}

async function rows<T>(db: AppDatabase, query: string, ...params: unknown[]): Promise<T[]> {
  const result = await db.prepare(query).bind(...params).all<T>();
  return result.results ?? [];
}

async function one<T>(db: AppDatabase, query: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...params).first<T>();
}

async function loadSources(db: AppDatabase, ids: readonly string[]): Promise<Map<string, SourceRow>> {
  const result = new Map<string, SourceRow>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(",");
  const values = await rows<SourceRow>(db, `SELECT id, endpoint, request_filter, language, purchase_type, filter_offtopic_activity, population, population_flags, interpretation_version FROM review_sources WHERE id IN (${placeholders})`, ...ids);
  for (const value of values) result.set(value.id, value);
  return result;
}

async function loadBucketsInRange(
  db: AppDatabase,
  appid: number,
  start: string,
  end: string,
  asOf: string,
): Promise<StoredReviewBucket[]> {
  return rows(db, `SELECT appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance
    FROM review_buckets
    WHERE appid = ? AND period_end > ? AND period_start < ? AND period_end <= ? AND observed_at <= ?
    ORDER BY period_start, period_end, source_id`, appid, start, end, asOf, asOf);
}


async function loadLatestScore(db: AppDatabase, appid: number, asOf: string): Promise<RawScore | null> {
  return one<RawScore>(db, `SELECT id, appid, observed_at, score, formula_version, current_positive_count, current_total_count,
      historical_positive_count, historical_total_count, current_window_start, current_window_end,
      historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
      current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at,
      anchor_event_id, anchor_at, provenance, created_at
    FROM player_score_history
    WHERE appid = ? AND observed_at <= ?
    ORDER BY observed_at DESC, id DESC LIMIT 1`, appid, asOf);
}

async function loadScoresInRange(db: AppDatabase, appid: number, start: string, end: string): Promise<RawScore[]> {
  return rows<RawScore>(db, `SELECT id, appid, observed_at, score, formula_version, current_positive_count, current_total_count,
      historical_positive_count, historical_total_count, current_window_start, current_window_end,
      historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
      current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at,
      anchor_event_id, anchor_at, provenance, created_at
    FROM player_score_history
    WHERE appid = ? AND observed_at >= ? AND observed_at < ?
    ORDER BY observed_at, id`, appid, start, end);
}

async function loadScoresThrough(db: AppDatabase, appid: number, asOf: string): Promise<RawScore[]> {
  return rows<RawScore>(db, `SELECT id, appid, observed_at, score, formula_version, current_positive_count, current_total_count,
      historical_positive_count, historical_total_count, current_window_start, current_window_end,
      historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
      current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at,
      anchor_event_id, anchor_at, provenance, created_at
    FROM player_score_history
    WHERE appid = ? AND observed_at <= ?
    ORDER BY observed_at, id`, appid, asOf);
}

async function loadBucketsThrough(db: AppDatabase, appid: number, asOf: string): Promise<StoredReviewBucket[]> {
  return rows<StoredReviewBucket>(db, `SELECT appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance
    FROM review_buckets
    WHERE appid = ? AND period_end <= ? AND observed_at <= ?
    ORDER BY period_start, period_end, source_id`, appid, asOf, asOf);
}

async function loadLatestSummaries(db: AppDatabase, appid: number, asOf: string): Promise<Array<{
  appid: number;
  source_id: string;
  observed_at: string;
  lifetime_positive_count: number;
  lifetime_total_count: number;
  source: SourceRow;
}>> {
  const result = await rows<{
    appid: number;
    source_id: string;
    observed_at: string;
    lifetime_positive_count: number;
    lifetime_total_count: number;
    source_id_joined: string;
    endpoint: SourceRow["endpoint"];
    request_filter: string;
    language: string | null;
    purchase_type: string | null;
    filter_offtopic_activity: number | null;
    population: string;
    population_flags: string;
    interpretation_version: string;
  }>(db, `SELECT r.appid, r.source_id, r.observed_at, r.lifetime_positive_count, r.lifetime_total_count,
      s.id AS source_id_joined, s.endpoint, s.request_filter, s.language, s.purchase_type,
      s.filter_offtopic_activity, s.population, s.population_flags, s.interpretation_version
    FROM review_summary_snapshots r JOIN review_sources s ON s.id = r.source_id
    WHERE r.appid = ? AND r.observed_at <= ? AND s.endpoint = 'appreviews'
      AND s.language = 'all' AND s.purchase_type = 'all' AND s.filter_offtopic_activity = 1
      AND s.request_filter LIKE '%filter=all%'
      AND r.observed_at = (
        SELECT MAX(newer.observed_at) FROM review_summary_snapshots newer
        WHERE newer.appid = r.appid AND newer.source_id = r.source_id AND newer.observed_at <= ?
      )
    ORDER BY r.observed_at DESC, r.source_id`, appid, asOf, asOf);
  return result.map((row) => ({
    appid: row.appid,
    source_id: row.source_id,
    observed_at: row.observed_at,
    lifetime_positive_count: row.lifetime_positive_count,
    lifetime_total_count: row.lifetime_total_count,
    source: {
      id: row.source_id_joined,
      endpoint: row.endpoint,
      request_filter: row.request_filter,
      language: row.language,
      purchase_type: row.purchase_type,
      filter_offtopic_activity: row.filter_offtopic_activity,
      population: row.population,
      population_flags: row.population_flags,
      interpretation_version: row.interpretation_version,
    },
  }));
}

function intervalBounds(intervals: readonly ReviewInterval[]): ScoreEvidenceWindow {
  let start: number | null = null;
  let end: number | null = null;
  for (const interval of intervals) {
    const intervalStart = parseUtc(interval.start);
    const intervalEnd = parseUtc(interval.end);
    if (intervalStart === null || intervalEnd === null || intervalStart >= intervalEnd) continue;
    start = start === null ? intervalStart : Math.min(start, intervalStart);
    end = end === null ? intervalEnd : Math.max(end, intervalEnd);
  }
  return { start: start === null ? null : iso(start), end: end === null ? null : iso(end) };
}
function isReviewInterval(value: unknown): value is ReviewInterval {
  if (!isRecord(value)) return false;
  return typeof value.start === "string" && typeof value.end === "string" && (value.granularity === "day" || value.granularity === "month");
}

function intervals(value: string): ReviewInterval[] {
  const parsed = safeJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isReviewInterval).map((entry) => ({ start: entry.start, end: entry.end, granularity: entry.granularity }));
}

function scoreAnchor(row: RawScore): ScoreAnchorPayload | null {
  if (!row.anchor_at) return null;
  const start = parseUtc(row.anchor_at);
  if (start === null) return null;
  const provenance = safeJson(row.provenance);
  const anchor = isRecord(provenance) && isRecord(provenance.anchor) ? provenance.anchor : null;
  const sourceValue = anchor?.sourceId;
  const sourceId = typeof sourceValue === "string" && sourceValue.length > 0 ? sourceValue : null;
  return { category: 14, start: iso(start), event_id: row.anchor_event_id, source_id: sourceId };
}

function scorePayload(row: RawScore, sources: ReadonlyMap<string, SourceRow>): GameScoreValue {
  const currentIntervals = intervals(row.current_evidence_intervals);
  const historicalIntervals = intervals(row.historical_evidence_intervals);
  const currentEvidence = intervalBounds(currentIntervals);
  return {
    value: row.score,
    observation_id: row.id,
    observed_at: row.observed_at,
    formula_version: row.formula_version,
    anchor: scoreAnchor(row),
    score_window: { start: row.current_window_start, end: row.current_window_end },
    evidence_start: currentEvidence.start,
    evidence_end: currentEvidence.end,
    current_positive_reviews: row.current_positive_count,
    current_total_reviews: row.current_total_count,
    current_reviews: row.current_total_count,
    current_evidence_intervals: currentIntervals,
    current_evidence_observed_at: row.current_evidence_observed_at,
    historical_evidence_intervals: historicalIntervals,
    historical_evidence_window: { start: row.historical_window_start, end: row.historical_window_end },
    historical_evidence_observed_at: row.historical_evidence_observed_at,
    historical_support: {
      actual_reviews: row.historical_total_count,
      effective_reviews: Math.min(HISTORICAL_SUPPORT_CAP, row.historical_total_count),
      positive_reviews: row.historical_positive_count,
      total_reviews: row.historical_total_count,
    },
    population_ref: sourceRef(sources.get(row.current_source_id ?? "")),
    historical_population_ref: sourceRef(sources.get(row.historical_source_id ?? "")),
    provenance: safeJson(row.provenance),
  };
}
function anchorPayload(anchor: ScoreAnchor | null): ScoreAnchorPayload | null {
  if (!anchor) return null;
  const start = parseUtc(anchor.start);
  if (start === null) return null;
  return {
    category: 14,
    start: iso(start),
    event_id: anchor.eventId ?? null,
    source_id: anchor.sourceId ?? null,
  };
}

function reconstructedPayload(
  candidate: PlayerScoreCandidate,
  evaluatedAt: string,
  source: SourceRow | null,
): ReconstructedScore | null {
  const scoreWindow = candidate.scoreWindow;
  if (!scoreWindow) return null;
  const current = candidate.inputs.current;
  const historical = candidate.inputs.historical;
  const currentEvidence = intervalBounds(current.selectedIntervals);
  const historicalWindow = historical?.requested ?? {
    start: iso(parseUtc(scoreWindow.start)! - NINETY_DAYS),
    end: scoreWindow.start,
  };
  const currentObservedAt = current.observedAt ?? current.observationTimes.at(-1) ?? null;
  const historicalObservedAt = historical?.observedAt ?? historical?.observationTimes.at(-1) ?? null;
  return {
    kind: "reconstructed",
    score_at: scoreWindow.end,
    evaluated_at: evaluatedAt,
    observed_at: candidate.observedAt,
    value: candidate.score,
    formula_version: candidate.formulaVersion,
    anchor: anchorPayload(candidate.anchor),
    score_window: { start: scoreWindow.start, end: scoreWindow.end },
    evidence_start: currentEvidence.start,
    evidence_end: currentEvidence.end,
    current_positive_reviews: current.positiveReviews ?? 0,
    current_total_reviews: candidate.currentReviews,
    current_reviews: candidate.currentReviews,
    current_evidence_intervals: [...current.selectedIntervals],
    current_evidence_observed_at: currentObservedAt,
    historical_evidence_intervals: historical ? [...historical.selectedIntervals] : [],
    historical_evidence_window: historicalWindow,
    historical_evidence_observed_at: historicalObservedAt,
    historical_support: {
      actual_reviews: candidate.historicalReviews,
      effective_reviews: candidate.historicalEffectiveReviews,
      positive_reviews: historical?.positiveReviews ?? 0,
      total_reviews: candidate.historicalReviews,
    },
    population_ref: sourceRef(source),
    historical_population_ref: historical ? sourceRef(source) : null,
    provenance: {
      kind: "reconstructed",
      evaluated_at: evaluatedAt,
      score_at: scoreWindow.end,
      observed_at: candidate.observedAt,
      source_id: source?.id ?? current.sourceId,
      current_source_id: current.sourceId,
      historical_source_id: historical?.sourceId ?? null,
      score_window: { start: scoreWindow.start, end: scoreWindow.end },
      historical_window: historicalWindow,
      current_evidence_intervals: [...current.selectedIntervals],
      current_observation_times: [...current.observationTimes],
      historical_observation_times: historical ? [...historical.observationTimes] : [],
      current_gaps: [...current.gaps],
      historical_evidence_intervals: historical ? [...historical.selectedIntervals] : [],
      historical_gaps: historical ? [...historical.gaps] : [],
      formula_version: candidate.formulaVersion,
    },
  };
}


function domainBucket(row: StoredReviewBucket): ReviewBucket {
  return {
    sourceId: row.source_id,
    granularity: row.granularity === "monthly" ? "month" : "day",
    start: row.period_start,
    end: row.period_end,
    positiveReviews: row.positive_count,
    negativeReviews: row.negative_count,
    observedAt: row.observed_at,
  };
}

function sourceChoice(buckets: readonly ReviewBucket[], asOf: string): string | null {
  const newest = new Map<string, string>();
  for (const bucket of buckets) {
    if (bucket.observedAt && parseUtc(bucket.observedAt) !== null && bucket.observedAt <= asOf) {
      const old = newest.get(bucket.sourceId);
      if (!old || bucket.observedAt > old) newest.set(bucket.sourceId, bucket.observedAt);
    }
  }
  const ordered = [...newest.entries()].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]));
  if (ordered.length === 0) return null;
  if (ordered.length > 1 && ordered[0]![1] === ordered[1]![1]) return null;
  return ordered[0]![0];
}

function selectedForRange(
  buckets: readonly ReviewBucket[],
  start: string,
  end: string,
  asOf: string,
): WholeBucketSelection {
  const sourceId = sourceChoice(buckets, asOf);
  return selectWholeBuckets(buckets, { start, end }, sourceId ? { sourceId, asOf } : { asOf });
}

function aggregateMetric(selection: WholeBucketSelection, source: SourceRow | null): HistoryMetric | null {
  if (selection.selectedIntervals.length === 0 || !selection.countsComplete) return null;
  const first = selection.selectedIntervals[0]!;
  const last = selection.selectedIntervals[selection.selectedIntervals.length - 1]!;
  const observedAt = selection.observationTimes.at(-1) ?? null;
  const approval = selection.totalReviews !== null && selection.totalReviews > 0
    ? (100 * selection.positiveReviews!) / selection.totalReviews
    : null;
  return {
    value: approval,
    positive_reviews: selection.positiveReviews,
    total_reviews: selection.totalReviews,
    included_start: first.start,
    included_end: last.end,
    population_ref: sourceRef(source),
    observed_at: observedAt,
    coverage_complete: selection.covered,
    gaps: [...selection.gaps],
  };
}

function approvalBucket(row: StoredReviewBucket, source: SourceRow | undefined): ApprovalBucket {
  const total = row.positive_count + row.negative_count;
  return {
    source_id: row.source_id,
    granularity: row.granularity,
    period_start: row.period_start,
    period_end: row.period_end,
    positive_reviews: row.positive_count,
    negative_reviews: row.negative_count,
    total_reviews: total,
    approval: total > 0 ? (100 * row.positive_count) / total : null,
    observed_at: row.observed_at,
    population_ref: sourceRef(source),
  };
}

function milestone(row: StoredSteamEvent): ScoreMilestone | null {
  const dateBasis: "start_at" | "publication_at" = row.start_at ? "start_at" : "publication_at";
  const eventTime = row.start_at ?? row.publication_at;
  if (!eventTime || parseUtc(eventTime) === null) return null;
  const normalized = iso(parseUtc(eventTime)!);
  const precision: "day" | "instant" = /^\d{4}-\d{2}-\d{2}$/.test(eventTime) ? "day" : "instant";
  const kind = row.category;
  const displayLabel = kind === "major_update" || kind === "14" ? "Major update" : kind === "early_access" ? "Early access" : kind === "full_release" ? "Full release" : kind === "patch" ? "Patch" : "News";
  return {
    event_id: row.event_id,
    kind,
    title: row.title,
    event_time: normalized,
    event_precision: precision,
    date_basis: dateBasis,
    source_url: row.url,
    display_label: displayLabel,
  };
}
function reconstructionAnchor(row: StoredSteamEvent): ScoreAnchor | null {
  let rawCategory: unknown = null;
  const provenance = safeJson(row.provenance);
  if (isRecord(provenance)) rawCategory = provenance.rawCategory;
  const major = row.category === "major_update" || row.category === "14" || rawCategory === 14 || rawCategory === "14";
  const start = row.start_at ? parseUtc(row.start_at) : null;
  if (!major || start === null) return null;
  return { category: 14, start: iso(start), eventId: row.event_id, sourceId: row.source };
}

function criticPayload(record: CriticRecord): ScoreCriticRecord {
  return {
    source: record.source,
    source_id: record.sourceId,
    source_url: record.sourceUrl,
    steam_app_id: record.steamAppId,
    title: record.title,
    slug: record.slug,
    edition: record.edition,
    platforms: [...record.platforms],
    platform_scope: record.platformScope,
    native_score: record.score,
    score_scale: record.score === null ? null : 100,
    native_tier: record.tier,
    review_count: record.reviewCount,
    percent_recommended: record.percentRecommended,
    review_period_start: record.reviewPeriodStart,
    review_period_end: record.reviewPeriodEnd,
    observed_at: record.observedAt,
    collection_basis: record.collectionBasis,
    matched_identity: record.matchedIdentity,
    identity_verified: record.identityVerified,
    cadence: record.cadence,
  };
}

function playerSnapshotPayload(value: RetainedPlayerSnapshot | null): ScorePlayerSnapshot | null {
  if (!value) return null;
  return {
    score: value.score,
    review_count: value.reviewCount,
    observed_at: value.observedAt,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.population === undefined ? {} : { population: value.population }),
  };
}

function alignmentPayload(outcome: CriticAlignmentOutcome): ScoreCriticAlignment {
  const currentPlayer = outcome.evidence.currentPlayer;
  const currentPlayerPayload = currentPlayer === null ? null : {
    score: currentPlayer.score,
    review_count: currentPlayer.reviewCount,
    observed_at: currentPlayer.observedAt ?? null,
    ...(currentPlayer.source === undefined ? {} : { source: currentPlayer.source }),
    ...(currentPlayer.population === undefined ? {} : { population: currentPlayer.population }),
  };
  return {
    source: outcome.source,
    state: outcome.state,
    alignment: outcome.alignment,
    player_direction: outcome.playerDirection,
    critic_direction: outcome.criticDirection,
    current_contrast: {
      state: outcome.currentContrast.state,
      alignment: outcome.currentContrast.alignment,
      player_direction: outcome.currentContrast.playerDirection,
      critic_direction: outcome.currentContrast.criticDirection,
      reasons: [...outcome.currentContrast.reasons],
    },
    freshness: outcome.freshness,
    evidence: {
      critic: criticPayload(outcome.evidence.critic),
      review_time_player_snapshot: playerSnapshotPayload(outcome.evidence.reviewTimePlayerSnapshot),
      current_player: currentPlayerPayload,
    },
    reasons: [...outcome.reasons],
  };
}

function recentPeriodPayload(
  value: RecentReceptionResult["recent"],
  sources: ReadonlyMap<string, SourceRow>,
): RecentReceptionPeriodPayload {
  return {
    start: value.start,
    end: value.end,
    positive_reviews: value.positiveReviews,
    total_reviews: value.totalReviews,
    approval: value.approval,
    covered_intervals: [...value.coveredIntervals],
    gaps: [...value.gaps],
    source_id: value.sourceId,
    population_ref: sourceRef(value.sourceId ? sources.get(value.sourceId) : null),
    observation_times: [...value.observationTimes],
    coverage_complete: value.coverageComplete,
    wilson95: value.wilson95 ? { ...value.wilson95 } : null,
  };
}

function recentPayload(result: RecentReceptionResult, sources: ReadonlyMap<string, SourceRow>): RecentReceptionPayload {
  return {
    state: result.state,
    evaluated_at: result.evaluatedAt,
    cutoff: result.cutoff,
    recent: recentPeriodPayload(result.recent, sources),
    previous: recentPeriodPayload(result.previous, sources),
    delta_pp: result.deltaPp,
    reasons: [...result.reasons],
  };
}

async function loadCriticSnapshots(
  db: AppDatabase,
  appid: number,
  records: readonly CriticRecord[],
  asOf: string,
): Promise<RetainedPlayerSnapshot[]> {
  const dates = records.flatMap((record) => [record.reviewPeriodStart, record.reviewPeriodEnd])
    .map((value) => parseUtc(value))
    .filter((value): value is number => value !== null);
  if (dates.length === 0) return [];
  const start = iso(Math.min(...dates));
  const snapshotRows = await rows<RawSnapshot>(db, `SELECT observed_at, score, current_total_count
    FROM player_score_history
    WHERE appid = ? AND observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at, id`, appid, start, asOf);
  return snapshotRows.map((row) => ({
    score: row.score,
    reviewCount: row.current_total_count,
    observedAt: row.observed_at,
    source: "player_score_history",
    population: "score-current-window",
  }));
}

async function loadMilestones(
  db: AppDatabase,
  appid: number,
  start: string | null,
  end: string | null,
  asOf: string,
): Promise<StoredSteamEvent[]> {
  if (start === null || end === null) {
    return rows<StoredSteamEvent>(db, `SELECT event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance
      FROM steam_events
      WHERE appid = ? AND COALESCE(start_at, publication_at) <= ? AND observed_at <= ?
      ORDER BY COALESCE(start_at, publication_at), event_id`, appid, asOf, asOf);
  }
  return rows<StoredSteamEvent>(db, `SELECT event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance
    FROM steam_events
    WHERE appid = ? AND COALESCE(start_at, publication_at) >= ? AND COALESCE(start_at, publication_at) < ? AND observed_at <= ?
    ORDER BY COALESCE(start_at, publication_at), event_id`, appid, start, end, asOf);
}

function allBounds(
  scores: readonly RawScore[],
  buckets: readonly StoredReviewBucket[],
  events: readonly StoredSteamEvent[],
): { start: string | null; end: string | null } {
  const starts = [
    ...scores.map((row) => parseUtc(row.observed_at)),
    ...buckets.map((row) => parseUtc(row.period_start)),
    ...events.map((row) => parseUtc(row.start_at ?? row.publication_at)),
  ].filter((value): value is number => value !== null);
  const ends = [
    ...scores.map((row) => parseUtc(row.observed_at)),
    ...buckets.map((row) => parseUtc(row.period_end)),
    ...events.map((row) => parseUtc(row.start_at ?? row.publication_at)),
  ].filter((value): value is number => value !== null);
  return starts.length === 0 || ends.length === 0
    ? { start: null, end: null }
    : { start: iso(Math.min(...starts)), end: iso(Math.max(...ends)) };
}

async function loadPopulationSources(
  db: AppDatabase,
  scoreRows: readonly RawScore[],
  bucketRows: readonly StoredReviewBucket[],
): Promise<Map<string, SourceRow>> {
  const ids = new Set<string>();
  for (const row of scoreRows) {
    if (row.current_source_id) ids.add(row.current_source_id);
    if (row.historical_source_id) ids.add(row.historical_source_id);
  }
  for (const row of bucketRows) ids.add(row.source_id);
  return loadSources(db, [...ids]);
}

export async function getGameScoreSummary(
  db: AppDatabase,
  appid: number,
  options: { now?: Date } = {},
): Promise<ScoreQueryResult<GameScoreSummary>> {
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new RangeError("Invalid score AppID");
  const at = evaluatedAt(options.now);
  const game = await getGameByAppId(db, appid);
  if (!game) return { data: null, sourceTimestamp: null };
  const atMs = parseUtc(at)!;
  const nowStart = iso(atMs - NINETY_DAYS);
  const recentStart = iso(atMs - EIGHTY_FOUR_DAYS);
  const [scoreRow, bucketRows, summaryRows, critics] = await Promise.all([
    loadLatestScore(db, appid, at),
    loadBucketsInRange(db, appid, nowStart, at, at),
    loadLatestSummaries(db, appid, at),
    getCriticRecords(db, appid),
  ]);
  const allBucketsForRecent = await loadBucketsInRange(db, appid, recentStart, at, at);
  const sources = await loadPopulationSources(db, scoreRow ? [scoreRow] : [], [...bucketRows, ...allBucketsForRecent]);
  const eligibility = await getGameReceptionEligibility(db, appid, at);
  if (!eligibility) return { data: null, sourceTimestamp: null };
  const recentDomain = evaluateRecentReception({
    evaluatedAt: at,
    buckets: allBucketsForRecent.map(domainBucket),
    sourceId: sourceChoice(allBucketsForRecent.map(domainBucket), at) ?? undefined,
  });
  const currentPlayer = scoreRow ? {
    score: scoreRow.score,
    reviewCount: scoreRow.current_total_count,
    observedAt: scoreRow.observed_at,
    source: "player_score_history",
    population: "score-current-window",
  } : null;
  const validCritics = critics.filter((record) => {
    const observed = parseUtc(record.observedAt);
    return observed === null || observed <= atMs;
  });
  const snapshots = await loadCriticSnapshots(db, appid, validCritics, at);
  const alignments = validCritics.map((record) => evaluateCriticAlignment(record, {
    steamAppId: appid,
    currentPlayer,
    retainedPlayerSnapshots: snapshots,
    asOf: at,
  }));
  const sourceTimestamp = maxTimestamp([
    scoreRow?.observed_at,
    ...bucketRows.map((row) => row.observed_at),
    ...allBucketsForRecent.map((row) => row.observed_at),
    ...summaryRows.map((row) => row.observed_at),
    ...validCritics.map((record) => record.observedAt),
  ]);
  const lifetimeSourceId = eligibility.all_time.population_ref?.source_id ?? null;
  const lifetimeRow = lifetimeSourceId
    ? summaryRows.find((row) => row.source_id === lifetimeSourceId && row.lifetime_total_count > 0 && row.lifetime_positive_count >= 0 && row.lifetime_positive_count <= row.lifetime_total_count)
    : undefined;
  const lifetimeApproval = lifetimeRow
    ? {
        value: (100 * lifetimeRow.lifetime_positive_count) / lifetimeRow.lifetime_total_count,
        positive_reviews: lifetimeRow.lifetime_positive_count,
        total_reviews: lifetimeRow.lifetime_total_count,
        observed_at: lifetimeRow.observed_at,
        population_ref: sourceRef(lifetimeRow.source),
      }
    : null;
  return {
    data: {
      game,
      lifetime_approval: lifetimeApproval,
      score: scoreRow ? scorePayload(scoreRow, sources) : null,
      eligibility,
      critics: validCritics.map(criticPayload),
      alignment: alignments.map(alignmentPayload),
      recent_reception: recentPayload(recentDomain, sources),
    },
    sourceTimestamp,
  };
}

export async function getGameScoreHistory(
  db: AppDatabase,
  appid: number,
  range: HistoryRange,
  options: { now?: Date } = {},
): Promise<ScoreQueryResult<GameScoreHistory>> {
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new RangeError("Invalid score AppID");
  if (!(range in ({ "24h": true, "7d": true, "30d": true, "90d": true, all: true }))) throw new RangeError("Invalid score history range");
  const at = evaluatedAt(options.now);
  const game = await getGameByAppId(db, appid);
  if (!game) return { data: null, sourceTimestamp: null };
  const atMs = parseUtc(at)!;
  let rangeStart: string | null = null;
  let rangeEnd: string | null = null;
  if (range !== "all") {
    rangeStart = iso(atMs - HISTORY_DURATIONS[range]);
    rangeEnd = at;
  }
  const reconstructionStart = rangeStart === null ? null : iso(parseUtc(rangeStart)! - 2 * NINETY_DAYS);
  const [scoreRows, contextBucketRows, events] = range === "all"
    ? await Promise.all([loadScoresThrough(db, appid, at), loadBucketsThrough(db, appid, at), loadMilestones(db, appid, null, null, at)])
    : await Promise.all([loadScoresInRange(db, appid, rangeStart!, rangeEnd!), loadBucketsInRange(db, appid, reconstructionStart!, rangeEnd!, at), loadMilestones(db, appid, reconstructionStart, rangeEnd, at)]);
  const bucketRows = range === "all"
    ? contextBucketRows
    : contextBucketRows.filter((row) => row.period_end > rangeStart! && row.period_start < rangeEnd!);
  if (range === "all") {
    const bounds = allBounds(scoreRows, contextBucketRows, events);
    rangeStart = bounds.start;
    rangeEnd = bounds.end;
  }
  const sources = await loadPopulationSources(db, scoreRows, contextBucketRows);
  const sourceIds = new Set<string>();
  for (const row of scoreRows) {
    if (row.current_source_id) sourceIds.add(row.current_source_id);
    if (row.historical_source_id) sourceIds.add(row.historical_source_id);
  }
  for (const row of bucketRows) sourceIds.add(row.source_id);
  const approval = bucketRows.map((row) => approvalBucket(row, sources.get(row.source_id)));
  let latestApproval: HistoryMetric | null = null;
  let reviewsInPeriod: HistoryMetric | null = null;
  if (rangeStart !== null && rangeEnd !== null && rangeStart < rangeEnd) {
    const selection = selectedForRange(bucketRows.map(domainBucket), rangeStart, rangeEnd, at);
    const source = selection.sourceId ? sources.get(selection.sourceId) ?? null : null;
    const metric = aggregateMetric(selection, source);
    const latestInterval = selection.selectedIntervals.at(-1);
    const latestBucket = latestInterval
      ? approval.find((bucket) => bucket.source_id === selection.sourceId
        && bucket.period_start === latestInterval.start
        && bucket.period_end === latestInterval.end
        && (latestInterval.granularity === "day" ? bucket.granularity === "daily" : bucket.granularity === "monthly"))
      : undefined;
    latestApproval = latestBucket ? {
      value: latestBucket.approval,
      positive_reviews: latestBucket.positive_reviews,
      total_reviews: latestBucket.total_reviews,
      included_start: latestBucket.period_start,
      included_end: latestBucket.period_end,
      population_ref: latestBucket.population_ref,
      observed_at: latestBucket.observed_at,
      coverage_complete: true,
      gaps: [],
    } : null;
    reviewsInPeriod = metric ? { ...metric, value: metric.total_reviews } : null;
  }
  const milestones = events.map(milestone).filter((event): event is ScoreMilestone => event !== null);
  const reconstructionDomains = contextBucketRows.map(domainBucket);
  const reconstructionSourceId = sourceChoice(reconstructionDomains, at);
  const reconstructionAnchors = events
    .map(reconstructionAnchor)
    .filter((anchor): anchor is ScoreAnchor => anchor !== null);
  const reconstructedScores: ReconstructedScore[] = [];
  if (reconstructionSourceId && rangeStart !== null && rangeEnd !== null && rangeStart < rangeEnd) {
    const startMs = parseUtc(rangeStart)!;
    const endMs = parseUtc(rangeEnd)!;
    const endpoints = [...new Set(reconstructionDomains
      .filter((bucket) => bucket.sourceId === reconstructionSourceId)
      .map((bucket) => parseUtc(bucket.end))
      .filter((endpoint): endpoint is number => endpoint !== null && endpoint >= startMs && endpoint <= endMs)
      .map(iso))].sort((left, right) => parseUtc(left)! - parseUtc(right)!);
    for (const endpoint of endpoints) {
      const candidate = reconstructPlayerScoreAt(reconstructionDomains, reconstructionAnchors, endpoint, reconstructionSourceId);
      if (!candidate) continue;
      const payload = reconstructedPayload(candidate, endpoint, sources.get(reconstructionSourceId) ?? null);
      if (payload) reconstructedScores.push(payload);
    }
  }
  const populations = [...sourceIds].map((id) => sourceRef(sources.get(id))).filter((value): value is ScorePopulationReference => value !== null);
  populations.sort((a, b) => a.source_id.localeCompare(b.source_id));
  const data: GameScoreHistory = {
    appid,
    range,
    range_start: rangeStart,
    range_end: rangeEnd,
    recorded_scores: scoreRows.map((row) => scorePayload(row, sources)),
    reconstructed_scores: reconstructedScores,
    approval_buckets: approval,
    milestones,
    populations,
    metrics: { latest_approval: latestApproval, reviews_in_period: reviewsInPeriod },
  };
  return {
    data,
    sourceTimestamp: maxTimestamp([
      ...scoreRows.map((row) => row.observed_at),
      ...bucketRows.map((row) => row.observed_at),
      ...events.map((row) => row.observed_at),
    ]),
  };
}
