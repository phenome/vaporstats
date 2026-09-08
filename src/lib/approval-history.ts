import type { ApprovalBucket, ScorePopulationReference } from "./score";
import {
  selectWholeBuckets,
  type ReviewBucket,
  type ReviewGranularity,
} from "./review-evidence";

export interface ApprovalHistoryPoint {
  timestamp: number;
  approval: number | null;
  bucket: ApprovalBucket | null;
}

export interface ApprovalHistorySeries {
  sourceId: string;
  populationRef: ScorePopulationReference | null;
  points: ApprovalHistoryPoint[];
}

function parseUtc(value: string | null): number | null {
  if (typeof value !== "string" || !/Z$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intervalKey(
  sourceId: string,
  granularity: ReviewGranularity,
  start: string,
  end: string,
  observedAt: string | null,
): string | null {
  const startMs = parseUtc(start);
  const endMs = parseUtc(end);
  const observedAtMs = observedAt === null ? null : parseUtc(observedAt);
  if (startMs === null || endMs === null || startMs >= endMs || (observedAt !== null && observedAtMs === null)) return null;
  return `${sourceId}\u0000${granularity}\u0000${startMs}\u0000${endMs}\u0000${observedAtMs ?? ""}`;
}

function reviewBucket(bucket: ApprovalBucket): ReviewBucket {
  return {
    sourceId: bucket.source_id,
    granularity: bucket.granularity === "daily" ? "day" : "month",
    start: bucket.period_start,
    end: bucket.period_end,
    positiveReviews: bucket.positive_reviews,
    negativeReviews: bucket.negative_reviews,
    observedAt: bucket.observed_at,
    complete: true,
  };
}

function midpoint(start: string, end: string): number | null {
  const startMs = parseUtc(start);
  const endMs = parseUtc(end);
  return startMs === null || endMs === null || startMs >= endMs ? null : startMs + (endMs - startMs) / 2;
}

function approvalPoint(bucket: ApprovalBucket, start: string, end: string): ApprovalHistoryPoint | null {
  const timestamp = midpoint(start, end);
  if (timestamp === null) return null;
  return {
    timestamp,
    approval: bucket.total_reviews > 0 && typeof bucket.approval === "number" && Number.isFinite(bucket.approval)
      ? bucket.approval
      : null,
    bucket,
  };
}

export function buildApprovalHistorySeries(
  buckets: readonly ApprovalBucket[],
  rangeStart: string | null,
  rangeEnd: string | null,
): ApprovalHistorySeries[] {
  const startMs = parseUtc(rangeStart);
  const endMs = parseUtc(rangeEnd);
  if (startMs === null || endMs === null || startMs >= endMs) return [];
  const requested = { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };

  const bySource = new Map<string, ApprovalBucket[]>();
  for (const bucket of buckets) {
    if (!bucket || typeof bucket.source_id !== "string" || bucket.source_id.length === 0) continue;
    const sourceBuckets = bySource.get(bucket.source_id);
    if (sourceBuckets) sourceBuckets.push(bucket);
    else bySource.set(bucket.source_id, [bucket]);
  }

  const series: ApprovalHistorySeries[] = [];
  for (const [sourceId, sourceBuckets] of bySource) {
    const originalByInterval = new Map<string, ApprovalBucket>();
    const reviewBuckets = sourceBuckets.map((bucket) => {
      const review = reviewBucket(bucket);
      const key = intervalKey(sourceId, review.granularity, review.start, review.end, review.observedAt);
      if (key !== null) originalByInterval.set(key, bucket);
      return review;
    });
    const selection = selectWholeBuckets(reviewBuckets, requested, { sourceId });
    if (selection.selectedIntervals.length === 0) continue;

    const points: ApprovalHistoryPoint[] = [];
    let previousEnd: string | null = null;
    let populationRef: ScorePopulationReference | null = null;
    for (const provenance of selection.provenance) {
      const granularity = provenance.granularity;
      const key = intervalKey(sourceId, granularity, provenance.start, provenance.end, provenance.observedAt);
      const bucket = key === null ? undefined : originalByInterval.get(key);
      if (!bucket) continue;

      if (previousEnd !== null && parseUtc(previousEnd) !== parseUtc(provenance.start)) {
        const gapTimestamp = midpoint(previousEnd, provenance.start);
        if (gapTimestamp !== null) points.push({ timestamp: gapTimestamp, approval: null, bucket: null });
      }
      const point = approvalPoint(bucket, provenance.start, provenance.end);
      if (point) points.push(point);
      if (populationRef === null) populationRef = bucket.population_ref;
      previousEnd = provenance.end;
    }

    if (points.length > 0) series.push({ sourceId, populationRef, points });
  }
  return series;
}
