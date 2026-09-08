import {
  calculatePlayerScoreCandidate,
  getPlayerScoreWindow,
  type PlayerScoreCandidate,
  type ScoreAnchor,
} from "./player-score";
import {
  selectWholeBuckets,
  type ReviewBucket,
  type ReviewEvidenceWindow,
} from "./review-evidence";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseUtc(value: string): number | null {
  if (typeof value !== "string") return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T00:00:00.000Z" : value;
  if (!/Z$/i.test(normalized)) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function anchorCategory(anchor: ScoreAnchor): number | undefined {
  return anchor.category ?? anchor.eventType;
}

function latestAnchor(anchors: readonly ScoreAnchor[], cutoff: number): ScoreAnchor | null {
  let latest: ScoreAnchor | null = null;
  let latestStart = Number.NEGATIVE_INFINITY;
  for (const anchor of anchors) {
    if (anchorCategory(anchor) !== 14) continue;
    const start = parseUtc(anchor.start);
    if (start === null || start >= cutoff || start < latestStart) continue;
    latest = { ...anchor, start: iso(start) };
    latestStart = start;
  }
  return latest;
}

function historicalWindow(currentStart: string): ReviewEvidenceWindow {
  const start = parseUtc(currentStart);
  if (start === null) throw new RangeError("Invalid score evidence window");
  return { start: iso(start - 90 * DAY_MS), end: currentStart };
}

function supportedEndpoints(
  buckets: readonly ReviewBucket[],
  sourceId: string,
  cutoff: number,
): string[] {
  const endpoints = new Set<number>();
  for (const bucket of buckets) {
    if (bucket.sourceId !== sourceId) continue;
    if (bucket.complete === false) continue;
    const positive = bucket.positiveReviews;
    const negative = bucket.negativeReviews;
    if (typeof positive !== "number" || !Number.isSafeInteger(positive) || positive < 0) continue;
    if (typeof negative !== "number" || !Number.isSafeInteger(negative) || negative < 0) continue;
    const total = positive + negative;
    if (!Number.isSafeInteger(total) || total <= 0) continue;
    const end = parseUtc(bucket.end);
    const start = parseUtc(bucket.start);
    if (start === null || end === null || start >= end || end > cutoff) continue;
    endpoints.add(end);
  }
  return [...endpoints].sort((left, right) => left - right).map(iso);
}

function calculateAt(
  buckets: readonly ReviewBucket[],
  anchors: readonly ScoreAnchor[],
  cutoff: string,
  sourceId: string,
): PlayerScoreCandidate | null {
  const cutoffMs = parseUtc(cutoff);
  if (cutoffMs === null) throw new RangeError("Invalid score evaluation time");
  const anchor = latestAnchor(anchors, cutoffMs);
  const window = getPlayerScoreWindow(cutoff, anchor);
  const current = selectWholeBuckets(buckets, window, { sourceId });
  if (
    current.selectedIntervals.length === 0
    || !current.countsComplete
    || current.totalReviews === null
    || current.totalReviews <= 0
  ) return null;
  const latest = current.selectedIntervals.at(-1);
  if (!latest || latest.end !== window.end) return null;
  const latestEvidence = selectWholeBuckets(buckets, latest, { sourceId });
  if (
    latestEvidence.selectedIntervals.length !== 1
    || latestEvidence.selectedIntervals[0]?.start !== latest.start
    || latestEvidence.selectedIntervals[0]?.end !== latest.end
    || latestEvidence.selectedIntervals[0]?.granularity !== latest.granularity
    || !latestEvidence.countsComplete
    || latestEvidence.totalReviews === null
    || latestEvidence.totalReviews <= 0
  ) return null;
  const historical = selectWholeBuckets(buckets, historicalWindow(window.start), { sourceId });
  return calculatePlayerScoreCandidate({
    current,
    historical,
    evaluatedAt: window.end,
    observedAt: current.observationTimes.at(-1) ?? null,
    anchor,
  });
}

/** Reconstructs a read-only player score from one histogram population. */
export function reconstructPlayerScoreAt(
  buckets: readonly ReviewBucket[],
  anchors: readonly ScoreAnchor[],
  evaluatedAt: string,
  sourceId: string,
): PlayerScoreCandidate | null {
  const cutoff = parseUtc(evaluatedAt);
  if (cutoff === null) throw new RangeError("Invalid score evaluation time");
  if (typeof sourceId !== "string" || sourceId.length === 0) return null;

  const endpoints = supportedEndpoints(buckets, sourceId, cutoff);
  for (let index = endpoints.length - 1; index >= 0; index -= 1) {
    const endpoint = endpoints[index]!;
    const candidate = calculateAt(buckets, anchors, endpoint, sourceId);
    if (candidate) return candidate;
  }
  return null;
}
