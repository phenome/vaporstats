export type ReviewGranularity = "day" | "month";

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
  if (bucket.granularity !== "day" && bucket.granularity !== "month") return null;
  const startMs = parseUtc(bucket.start);
  const endMs = parseUtc(bucket.end);
  if (startMs === null || endMs === null || startMs >= endMs) return null;
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

function monthStart(time: number): number {
  const value = new Date(time);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1);
}

function nextMonth(time: number): number {
  const value = new Date(time);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1);
}

function dayStart(time: number): number {
  const value = new Date(time);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function firstWholeDay(time: number): number {
  const start = dayStart(time);
  return time === start ? start : start + DAY_MS;
}

function intervalKey(bucket: NormalizedBucket): string {
  return `${bucket.granularity}|${bucket.startMs}|${bucket.endMs}`;
}

function chooseNewest(a: NormalizedBucket, b: NormalizedBucket): NormalizedBucket {
  return (b.observedAtMs ?? -Infinity) >= (a.observedAtMs ?? -Infinity) ? b : a;
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
  const byDay = new Map<string, NormalizedBucket>();
  const byMonth = new Map<string, NormalizedBucket>();
  for (const bucket of deduped.values()) {
    const key = `${bucket.startMs}|${bucket.endMs}`;
    const target = bucket.granularity === "day" ? byDay : byMonth;
    const prior = target.get(key);
    target.set(key, prior ? chooseNewest(prior, bucket) : bucket);
  }

  const selected: NormalizedBucket[] = [];
  for (let cursor = monthStart(startMs); cursor < endMs; cursor = nextMonth(cursor)) {
    const segmentStart = Math.max(startMs, cursor);
    const segmentEnd = Math.min(endMs, nextMonth(cursor));
    if (segmentStart >= segmentEnd) continue;
    const firstDay = firstWholeDay(segmentStart);
    const daily: NormalizedBucket[] = [];
    for (let day = firstDay; day + DAY_MS <= segmentEnd; day += DAY_MS) {
      const bucket = byDay.get(`${day}|${day + DAY_MS}`);
      if (bucket) daily.push(bucket);
    }
    const expectedDays = firstDay < segmentEnd ? Math.floor((segmentEnd - firstDay) / DAY_MS) : 0;
    if (expectedDays > 0 && daily.length === expectedDays) {
      selected.push(...daily);
      continue;
    }
    const monthly = [...byMonth.values()]
      .filter((bucket) => bucket.startMs === cursor && bucket.endMs === nextMonth(cursor))
      .filter((bucket) => bucket.startMs >= segmentStart && bucket.endMs <= segmentEnd)
      .sort((a, b) => (b.observedAtMs ?? -Infinity) - (a.observedAtMs ?? -Infinity));
    if (monthly.length > 0) {
      selected.push(monthly[0]);
      continue;
    }
    selected.push(...daily);
  }

  selected.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const nonOverlapping: NormalizedBucket[] = [];
  for (const bucket of selected) {
    const previous = nonOverlapping.at(-1);
    if (previous && bucket.startMs < previous.endMs) {
      if (bucket.granularity === "month" && previous.granularity === "day") {
        nonOverlapping.pop();
        while (nonOverlapping.at(-1) && nonOverlapping.at(-1)!.endMs > bucket.startMs) nonOverlapping.pop();
        nonOverlapping.push(bucket);
      }
      continue;
    }
    nonOverlapping.push(bucket);
  }
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
