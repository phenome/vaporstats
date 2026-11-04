export type ReviewGranularity = "day" | "week" | "month";

export interface ReviewBucket {
  sourceId: string;
  granularity: ReviewGranularity;
  start: string;
  end: string;
  positiveReviews: number | null;
  negativeReviews: number | null;
  observedAt: string | null;
  complete?: boolean;
}

export interface ReviewInterval {
  start: string;
  end: string;
  granularity: ReviewGranularity;
}

export interface ReviewBucketProvenance extends ReviewInterval {
  sourceId: string;
  observedAt: string | null;
}

export interface ReviewEvidenceWindow {
  start: string;
  end: string;
}

export interface WholeBucketSelectionOptions {
  sourceId?: string;
  asOf?: string;
}

export interface WholeBucketSelection {
  sourceId: string | null;
  requested: ReviewEvidenceWindow;
  selectedIntervals: readonly ReviewInterval[];
  gaps: readonly ReviewInterval[];
  provenance: readonly ReviewBucketProvenance[];
  observationTimes: readonly string[];
  positiveReviews: number | null;
  negativeReviews: number | null;
  totalReviews: number | null;
  knownPositiveReviews: number;
  knownNegativeReviews: number;
  knownTotalReviews: number;
  countsComplete: boolean;
  countOverflow: boolean;
  covered: boolean;
  hasCompatibleSource: boolean;
  unknownCountIntervals: readonly ReviewInterval[];
}

interface NormalizedBucket {
  sourceId: string;
  granularity: ReviewGranularity;
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  positive: number | null;
  negative: number | null;
  total: number | null;
  observedAt: string | null;
  observedAtMs: number | null;
  complete: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseUtc(value: string): number | null {
  if (typeof value !== "string" || !/Z$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeBucket(bucket: ReviewBucket): NormalizedBucket | null {
  if (!bucket || typeof bucket.sourceId !== "string" || bucket.sourceId.length === 0) return null;
  if (bucket.granularity !== "day" && bucket.granularity !== "week" && bucket.granularity !== "month") return null;
  const startMs = parseUtc(bucket.start);
  const endMs = parseUtc(bucket.end);
  if (startMs === null || endMs === null || startMs >= endMs) return null;
  if (startMs % DAY_MS !== 0) return null;
  const duration = endMs - startMs;
  if (bucket.granularity === "day" && duration !== DAY_MS) return null;
  if (bucket.granularity === "week" && duration !== 7 * DAY_MS) return null;
  if (bucket.granularity === "month") {
    const start = new Date(startMs);
    if (start.getUTCDate() !== 1 || endMs !== Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) return null;
  }
  const positive = bucket.positiveReviews === null || bucket.positiveReviews === undefined ? null : isSafeCount(bucket.positiveReviews) ? bucket.positiveReviews : null;
  const negative = bucket.negativeReviews === null || bucket.negativeReviews === undefined ? null : isSafeCount(bucket.negativeReviews) ? bucket.negativeReviews : null;
  const total = positive !== null && negative !== null ? positive + negative : null;
  if (total !== null) {
    if (!isSafeCount(total) || positive === null || negative === null) return null;
    if (positive > total || negative > total) return null;
  }
  const observedAtMs = bucket.observedAt === null || bucket.observedAt === undefined ? null : parseUtc(bucket.observedAt);
  if (bucket.observedAt !== null && bucket.observedAt !== undefined && observedAtMs === null) return null;
  return {
    sourceId: bucket.sourceId,
    granularity: bucket.granularity,
    startMs,
    endMs,
    start: iso(startMs),
    end: iso(endMs),
    positive,
    negative,
    total,
    observedAt: observedAtMs === null ? null : iso(observedAtMs),
    observedAtMs,
    complete: bucket.complete !== false,
  };
}


function intervalKey(bucket: NormalizedBucket): string {
  return `${bucket.granularity}|${bucket.startMs}|${bucket.endMs}`;
}

function chooseNewest(a: NormalizedBucket, b: NormalizedBucket): NormalizedBucket {
  return (b.observedAtMs ?? -Infinity) >= (a.observedAtMs ?? -Infinity) ? b : a;
}

interface BucketPath {
  monthlyCoveredMs: number;
  coveredMs: number;
  dailyMs: number;
  weeklyMs: number;
  bucket: NormalizedBucket | null;
  previous: BucketPath | null;
}

/** Preserves available monthly coverage before maximizing total coverage and preferring finer evidence. */
function selectNonOverlapping(buckets: NormalizedBucket[]): NormalizedBucket[] {
  const sorted = buckets.sort((a, b) => a.endMs - b.endMs || a.startMs - b.startMs);
  const months = sorted.filter((bucket) => bucket.granularity === "month");
  const best: BucketPath[] = [{ monthlyCoveredMs: 0, coveredMs: 0, dailyMs: 0, weeklyMs: 0, bucket: null, previous: null }];
  for (let index = 0; index < sorted.length; index++) {
    const bucket = sorted[index];
    let low = 0;
    let high = index;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle].endMs <= bucket.startMs) low = middle + 1;
      else high = middle;
    }
    const previous = best[low];
    const duration = bucket.endMs - bucket.startMs;
    // Calendar months never overlap. Coverage outside one cannot compensate for a hole inside it.
    let monthLow = 0;
    let monthHigh = months.length;
    while (monthLow < monthHigh) {
      const middle = (monthLow + monthHigh) >>> 1;
      if (months[middle].endMs <= bucket.startMs) monthLow = middle + 1;
      else monthHigh = middle;
    }
    let monthlyCoveredMs = previous.monthlyCoveredMs;
    for (let monthIndex = monthLow; monthIndex < months.length && months[monthIndex].startMs < bucket.endMs; monthIndex++) {
      const month = months[monthIndex];
      monthlyCoveredMs += Math.min(bucket.endMs, month.endMs) - Math.max(bucket.startMs, month.startMs);
    }
    const coveredMs = previous.coveredMs + duration;
    const dailyMs = previous.dailyMs + (bucket.granularity === "day" ? duration : 0);
    const weeklyMs = previous.weeklyMs + (bucket.granularity === "week" ? duration : 0);
    const skipped = best[index];
    const preferred = monthlyCoveredMs > skipped.monthlyCoveredMs ||
      (monthlyCoveredMs === skipped.monthlyCoveredMs && (coveredMs > skipped.coveredMs ||
        (coveredMs === skipped.coveredMs && (dailyMs > skipped.dailyMs ||
          (dailyMs === skipped.dailyMs && weeklyMs > skipped.weeklyMs)))));
    best.push(preferred ? { monthlyCoveredMs, coveredMs, dailyMs, weeklyMs, bucket, previous } : skipped);
  }
  const selected: NormalizedBucket[] = [];
  for (let path = best[sorted.length]; path.bucket; path = path.previous!) selected.push(path.bucket);
  return selected.reverse();
}

function intervalOf(bucket: NormalizedBucket): ReviewInterval {
  return { start: bucket.start, end: bucket.end, granularity: bucket.granularity };
}

function mergeIntervals(intervals: readonly ReviewInterval[]): ReviewInterval[] {
  const sorted = intervals
    .map((interval) => ({ startMs: parseUtc(interval.start)!, endMs: parseUtc(interval.end)!, granularity: interval.granularity }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: ReviewInterval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || parseUtc(last.end)! < interval.startMs) {
      merged.push({ start: iso(interval.startMs), end: iso(interval.endMs), granularity: interval.granularity });
      continue;
    }
    if (parseUtc(last.end)! < interval.endMs) last.end = iso(interval.endMs);
  }
  return merged;
}

function findGaps(requested: ReviewEvidenceWindow, selected: readonly ReviewInterval[]): ReviewInterval[] {
  const startMs = parseUtc(requested.start)!;
  const endMs = parseUtc(requested.end)!;
  const covered = mergeIntervals(selected)
    .map((interval) => ({ startMs: Math.max(startMs, parseUtc(interval.start)!), endMs: Math.min(endMs, parseUtc(interval.end)!) }))
    .filter((interval) => interval.startMs < interval.endMs)
    .sort((a, b) => a.startMs - b.startMs);
  const gaps: ReviewInterval[] = [];
  let cursor = startMs;
  for (const interval of covered) {
    if (interval.startMs > cursor) gaps.push({ start: iso(cursor), end: iso(interval.startMs), granularity: "day" });
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < endMs) gaps.push({ start: iso(cursor), end: iso(endMs), granularity: "day" });
  return gaps;
}

function emptySelection(requested: ReviewEvidenceWindow, sourceId: string | null, hasCompatibleSource: boolean): WholeBucketSelection {
  return {
    sourceId,
    requested,
    selectedIntervals: [],
    gaps: [{ start: requested.start, end: requested.end, granularity: "day" }],
    provenance: [],
    observationTimes: [],
    positiveReviews: null,
    negativeReviews: null,
    totalReviews: null,
    knownPositiveReviews: 0,
    knownNegativeReviews: 0,
    knownTotalReviews: 0,
    countsComplete: false,
    countOverflow: false,
    covered: false,
    hasCompatibleSource,
    unknownCountIntervals: [],
  };
}

/** Selects complete, non-overlapping buckets without prorating or mixing sources. */
export function selectWholeBuckets(
  buckets: readonly ReviewBucket[],
  requested: ReviewEvidenceWindow,
  options: WholeBucketSelectionOptions = {},
): WholeBucketSelection {
  const startMs = parseUtc(requested.start);
  const endMs = parseUtc(requested.end);
  if (startMs === null || endMs === null || startMs >= endMs) throw new RangeError("Invalid UTC evidence interval");
  const normalizedRequested = { start: iso(startMs), end: iso(endMs) };
  const asOfMs = options.asOf === undefined ? Number.POSITIVE_INFINITY : parseUtc(options.asOf);
  if (asOfMs === null) throw new RangeError("Invalid UTC evaluation instant");

  const normalized = (buckets ?? [])
    .map(normalizeBucket)
    .filter((bucket): bucket is NormalizedBucket => bucket !== null);
  const allSources = new Set(normalized.map((bucket) => bucket.sourceId));
  const inferredSource = allSources.size === 1 ? [...allSources][0] ?? null : null;
  const sourceId: string | null = options.sourceId ?? inferredSource;
  if (sourceId === null || (options.sourceId !== undefined && !allSources.has(sourceId))) return emptySelection(normalizedRequested, sourceId, false);
  const usable = normalized
    .filter((bucket) => bucket.sourceId === sourceId && bucket.complete)
    .filter((bucket) => bucket.startMs >= startMs && bucket.endMs <= endMs && bucket.endMs <= asOfMs)
    .filter((bucket) => bucket.observedAtMs === null || bucket.observedAtMs <= asOfMs);
  const compatibleSourcePresent = usable.length > 0;

  const deduped = new Map<string, NormalizedBucket>();
  for (const bucket of usable) {
    const key = intervalKey(bucket);
    const prior = deduped.get(key);
    deduped.set(key, prior ? chooseNewest(prior, bucket) : bucket);
  }
  const nonOverlapping = selectNonOverlapping([...deduped.values()]);
  const selectedIntervals = nonOverlapping.map(intervalOf);
  const gaps = findGaps(normalizedRequested, selectedIntervals);
  const provenance = nonOverlapping.map((bucket) => ({ ...intervalOf(bucket), sourceId: bucket.sourceId, observedAt: bucket.observedAt }));
  const observationTimes = [...new Set(provenance.map((entry) => entry.observedAt).filter((value): value is string => value !== null))].sort();
  const unknownCountIntervals = nonOverlapping.filter((bucket) => bucket.total === null).map(intervalOf);
  let knownPositiveReviews = 0;
  let knownNegativeReviews = 0;
  let knownTotalReviews = 0;
  let countOverflow = false;
  for (const bucket of nonOverlapping) {
    if (bucket.total === null || bucket.positive === null || bucket.negative === null) continue;
    const nextPositive = knownPositiveReviews + bucket.positive;
    const nextNegative = knownNegativeReviews + bucket.negative;
    const nextTotal = knownTotalReviews + bucket.total;
    if (!isSafeCount(nextPositive) || !isSafeCount(nextNegative) || !isSafeCount(nextTotal)) {
      countOverflow = true;
      break;
    }
    knownPositiveReviews = nextPositive;
    knownNegativeReviews = nextNegative;
    knownTotalReviews = nextTotal;
  }
  const countsComplete = nonOverlapping.length > 0 && unknownCountIntervals.length === 0 && !countOverflow;
  return {
    sourceId,
    requested: normalizedRequested,
    selectedIntervals,
    gaps,
    provenance,
    observationTimes,
    positiveReviews: countsComplete ? knownPositiveReviews : null,
    negativeReviews: countsComplete ? knownNegativeReviews : null,
    totalReviews: countsComplete ? knownTotalReviews : null,
    knownPositiveReviews,
    knownNegativeReviews,
    knownTotalReviews,
    countsComplete,
    countOverflow,
    covered: gaps.length === 0,
    hasCompatibleSource: compatibleSourcePresent,
    unknownCountIntervals,
  };
}

export function selectionHasEvidence(selection: WholeBucketSelection): boolean {
  return selection.selectedIntervals.length > 0;
}
