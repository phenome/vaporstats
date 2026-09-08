import {
  selectWholeBuckets,
  type ReviewBucket,
  type ReviewEvidenceWindow,
  type ReviewInterval,
  type WholeBucketSelection,
} from "./review-evidence";

export type RecentReceptionState =
  | "more_positive"
  | "less_positive"
  | "no_clear_shift"
  | "insufficient_evidence";
export type RecentReceptionPeriodName = "recent" | "previous";
export type RecentReceptionReasonCode =
  | "missing_coverage"
  | "insufficient_reviews"
  | "unavailable_compatible_evidence";
export type RecentReceptionReason = `${RecentReceptionPeriodName}:${RecentReceptionReasonCode}`;

export interface WilsonInterval {
  lower: number;
  upper: number;
}

export interface RecentReceptionPeriod {
  start: string;
  end: string;
  positiveReviews: number | null;
  totalReviews: number | null;
  approval: number | null;
  coveredIntervals: readonly ReviewInterval[];
  gaps: readonly ReviewInterval[];
  sourceId: string | null;
  observationTimes: readonly string[];
  coverageComplete: boolean;
  wilson95: WilsonInterval | null;
}

export interface RecentReceptionInput {
  buckets: readonly ReviewBucket[];
  evaluatedAt: string;
  sourceId?: string;
}

export interface RecentReceptionResult {
  state: RecentReceptionState;
  evaluatedAt: string;
  cutoff: string;
  recent: RecentReceptionPeriod;
  previous: RecentReceptionPeriod;
  deltaPp: number | null;
  reasons: readonly RecentReceptionReason[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 28;
const PREVIOUS_DAYS = 56;
const MIN_REVIEWS = 50;
const MIN_DELTA_PP = 5;
const WILSON_Z = 1.959963984540054;

function parseUtc(value: string): number | null {
  if (typeof value !== "string" || !/Z$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function utcDayStart(time: number): number {
  const value = new Date(time);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function periodFromSelection(selection: WholeBucketSelection, window: ReviewEvidenceWindow): RecentReceptionPeriod {
  const hasIntervals = selection.selectedIntervals.length > 0;
  const positive = hasIntervals ? selection.knownPositiveReviews : null;
  const total = hasIntervals ? selection.knownTotalReviews : null;
  const approval = selection.countsComplete && selection.covered && total !== null && total > 0 ? 100 * positive! / total : null;
  return {
    start: window.start,
    end: window.end,
    positiveReviews: positive,
    totalReviews: total,
    approval,
    coveredIntervals: [...selection.selectedIntervals],
    gaps: [...selection.gaps],
    sourceId: selection.sourceId,
    observationTimes: [...selection.observationTimes],
    coverageComplete: selection.covered && selection.countsComplete,
    wilson95: selection.countsComplete && selection.covered && total !== null && total > 0 && positive !== null ? wilson95(positive, total) : null,
  };
}

function reasonForPeriod(
  period: RecentReceptionPeriod,
  selection: WholeBucketSelection,
  name: RecentReceptionPeriodName,
  unavailableEvidence: boolean,
): RecentReceptionReason[] {
  const reasons: RecentReceptionReason[] = [];
  if (period.gaps.length > 0) reasons.push(`${name}:missing_coverage`);
  if (selection.countsComplete && period.totalReviews !== null && period.totalReviews < MIN_REVIEWS) reasons.push(`${name}:insufficient_reviews`);
  if (unavailableEvidence || selection.unknownCountIntervals.length > 0 || selection.countOverflow) reasons.push(`${name}:unavailable_compatible_evidence`);
  return reasons;
}

/** Calculates the two-sided 95% Wilson interval in percentage points. */
export function wilson95(positiveReviews: number, totalReviews: number): WilsonInterval | null {
  if (!Number.isSafeInteger(positiveReviews) || !Number.isSafeInteger(totalReviews) || positiveReviews < 0 || totalReviews <= 0 || positiveReviews > totalReviews) return null;
  const proportion = positiveReviews / totalReviews;
  const zSquared = WILSON_Z * WILSON_Z;
  const denominator = 1 + zSquared / totalReviews;
  const center = (proportion + zSquared / (2 * totalReviews)) / denominator;
  const halfWidth = WILSON_Z * Math.sqrt(proportion * (1 - proportion) / totalReviews + zSquared / (4 * totalReviews * totalReviews)) / denominator;
  return { lower: 100 * (center - halfWidth), upper: 100 * (center + halfWidth) };
}

/** Evaluates game-page Recent reception against the latest 28 and preceding 56 UTC days. */
export function evaluateRecentReception(input: RecentReceptionInput): RecentReceptionResult {
  const evaluatedAtMs = parseUtc(input.evaluatedAt);
  if (evaluatedAtMs === null) throw new RangeError("Invalid reception evaluation time");
  const cutoffMs = utcDayStart(evaluatedAtMs);
  const recentWindow = { start: iso(cutoffMs - RECENT_DAYS * DAY_MS), end: iso(cutoffMs) };
  const previousWindow = { start: iso(cutoffMs - (RECENT_DAYS + PREVIOUS_DAYS) * DAY_MS), end: recentWindow.start };
  const selectionOptions = { sourceId: input.sourceId, asOf: iso(evaluatedAtMs) };
  const recentSelection = selectWholeBuckets(input.buckets, recentWindow, selectionOptions);
  const previousSelection = selectWholeBuckets(input.buckets, previousWindow, selectionOptions);
  const recent = periodFromSelection(recentSelection, recentWindow);
  const previous = periodFromSelection(previousSelection, previousWindow);
  const sourceIds = new Set(input.buckets.map((bucket) => bucket.sourceId));
  const sourceMismatch = input.sourceId !== undefined && !sourceIds.has(input.sourceId);
  const mixedSources = input.sourceId === undefined && sourceIds.size > 1;
  const recentUnavailable = sourceMismatch || mixedSources || (recent.coveredIntervals.length > 0 && recent.totalReviews === null);
  const previousUnavailable = sourceMismatch || mixedSources || (previous.coveredIntervals.length > 0 && previous.totalReviews === null);
  const reasons = [
    ...reasonForPeriod(recent, recentSelection, "recent", recentUnavailable),
    ...reasonForPeriod(previous, previousSelection, "previous", previousUnavailable),
  ];
  const supported = reasons.length === 0 && recent.approval !== null && previous.approval !== null && recent.wilson95 !== null && previous.wilson95 !== null;
  const deltaPp = supported ? recent.approval! - previous.approval! : null;
  let state: RecentReceptionState = "insufficient_evidence";
  if (supported) {
    const morePositive = deltaPp! >= MIN_DELTA_PP && recent.wilson95!.lower > previous.wilson95!.upper;
    const lessPositive = deltaPp! <= -MIN_DELTA_PP && recent.wilson95!.upper < previous.wilson95!.lower;
    state = morePositive ? "more_positive" : lessPositive ? "less_positive" : "no_clear_shift";
  }
  return {
    state,
    evaluatedAt: iso(evaluatedAtMs),
    cutoff: iso(cutoffMs),
    recent,
    previous,
    deltaPp,
    reasons,
  };
}
