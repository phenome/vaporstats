import type {
  ReviewEvidenceWindow,
  ReviewInterval,
  WholeBucketSelection,
} from "./review-evidence";

export const PLAYER_SCORE_FORMULA_VERSION = "steam-player-v1";
export const SCORE_WINDOW_DAYS = 90;
export const HISTORICAL_SUPPORT_CAP = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScoreAnchor {
  category?: number;
  eventType?: number;
  start: string;
  eventId?: string;
  sourceId?: string;
}

export interface ScoreEvidenceInput {
  sourceId?: string | null;
  positiveReviews: number | null;
  negativeReviews?: number | null;
  totalReviews?: number | null;
  selectedIntervals?: readonly ReviewInterval[];
  gaps?: readonly ReviewInterval[];
  requested?: ReviewEvidenceWindow;
  observationTimes?: readonly string[];
  observedAt?: string | null;
}

export interface ScoreEvidenceSnapshot {
  sourceId: string | null;
  positiveReviews: number | null;
  negativeReviews: number | null;
  totalReviews: number | null;
  selectedIntervals: readonly ReviewInterval[];
  gaps: readonly ReviewInterval[];
  requested: ReviewEvidenceWindow | null;
  observationTimes: readonly string[];
  observedAt: string | null;
}

export interface ScoreWindow extends ReviewEvidenceWindow {
  anchor: ScoreAnchor | null;
}

export interface PlayerScoreCalculationInput {
  current: ScoreEvidenceInput | WholeBucketSelection | null | undefined;
  historical?: ScoreEvidenceInput | WholeBucketSelection | null;
  retainedBaseline?: ScoreEvidenceInput | WholeBucketSelection | null;
  evaluatedAt?: string;
  observedAt?: string | null;
  scoreWindow?: ReviewEvidenceWindow;
  anchor?: ScoreAnchor | null;
  formulaVersion?: string;
}

export interface PlayerScoreCandidate {
  readonly score: number;
  readonly formulaVersion: string;
  readonly observedAt: string | null;
  readonly anchor: ScoreAnchor | null;
  readonly scoreWindow: ScoreWindow | null;
  readonly currentReviews: number;
  readonly historicalReviews: number;
  readonly historicalEffectiveReviews: number;
  readonly inputs: Readonly<{
    current: ScoreEvidenceSnapshot;
    historical: ScoreEvidenceSnapshot | null;
  }>;
}

interface NormalizedEvidence extends ScoreEvidenceSnapshot {
  intervalsWithTimes: readonly { startMs: number; endMs: number }[];
}

function parseUtc(value: unknown): number | null {
  if (typeof value !== "string" || !/Z$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function copyInterval(interval: ReviewInterval): ReviewInterval | null {
  const start = parseUtc(interval.start);
  const end = parseUtc(interval.end);
  if (start === null || end === null || start >= end) return null;
  if (interval.granularity !== "day" && interval.granularity !== "month") return null;
  return { start: iso(start), end: iso(end), granularity: interval.granularity };
}

function cloneIntervals(value: readonly ReviewInterval[] | undefined): ReviewInterval[] {
  if (!value) return [];
  const copied: ReviewInterval[] = [];
  for (const interval of value) {
    const copy = copyInterval(interval);
    if (copy) copied.push(copy);
  }
  return copied;
}

function normalizeEvidence(input: ScoreEvidenceInput | WholeBucketSelection | null | undefined): NormalizedEvidence | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as ScoreEvidenceInput;
  const positive = raw.positiveReviews === null || raw.positiveReviews === undefined ? null : validCount(raw.positiveReviews) ? raw.positiveReviews : null;
  const negative = raw.negativeReviews === null || raw.negativeReviews === undefined ? null : validCount(raw.negativeReviews) ? raw.negativeReviews : null;
  const suppliedTotal = raw.totalReviews;
  const total = suppliedTotal === null || suppliedTotal === undefined
    ? positive !== null && negative !== null ? positive + negative : null
    : validCount(suppliedTotal) ? suppliedTotal : null;
  if (total !== null && positive !== null && positive > total) return null;
  if (total !== null && negative !== null && negative > total) return null;
  const intervals = cloneIntervals(raw.selectedIntervals);
  const gaps = cloneIntervals(raw.gaps);
  const requestedRaw = raw.requested;
  let requested: ReviewEvidenceWindow | null = null;
  if (requestedRaw) {
    const start = parseUtc(requestedRaw.start);
    const end = parseUtc(requestedRaw.end);
    if (start === null || end === null || start >= end) return null;
    requested = { start: iso(start), end: iso(end) };
  }
  const sourceId = raw.sourceId === undefined || raw.sourceId === null ? null : typeof raw.sourceId === "string" && raw.sourceId.length > 0 ? raw.sourceId : null;
  const observationTimes = (raw.observationTimes ?? [])
    .map(parseUtc)
    .filter((time): time is number => time !== null)
    .map(iso)
    .sort();
  const observedAtMs = raw.observedAt === null || raw.observedAt === undefined ? null : parseUtc(raw.observedAt);
  if (raw.observedAt !== null && raw.observedAt !== undefined && observedAtMs === null) return null;
  return {
    sourceId,
    positiveReviews: positive,
    negativeReviews: negative,
    totalReviews: total,
    selectedIntervals: intervals,
    gaps,
    requested,
    observationTimes: [...new Set(observationTimes)],
    observedAt: observedAtMs === null ? null : iso(observedAtMs),
    intervalsWithTimes: intervals.map((interval) => ({ startMs: parseUtc(interval.start)!, endMs: parseUtc(interval.end)! })),
  };
}

function overlaps(a: NormalizedEvidence, b: NormalizedEvidence): boolean {
  for (const left of a.intervalsWithTimes) {
    for (const right of b.intervalsWithTimes) {
      if (left.startMs < right.endMs && right.startMs < left.endMs) return true;
    }
  }
  return false;
}

function compatibleHistorical(current: NormalizedEvidence, historical: NormalizedEvidence): boolean {
  if (current.sourceId === null || historical.sourceId === null || current.sourceId !== historical.sourceId) return false;
  return !overlaps(current, historical);
}

function activeAnchor(anchor: ScoreAnchor | null | undefined, evaluatedAtMs: number): ScoreAnchor | null {
  if (!anchor) return null;
  const category = anchor.category ?? anchor.eventType;
  const startMs = parseUtc(anchor.start);
  if (category !== 14 || startMs === null || startMs >= evaluatedAtMs) return null;
  return {
    category: 14,
    start: iso(startMs),
    ...(anchor.eventId === undefined ? {} : { eventId: anchor.eventId }),
    ...(anchor.sourceId === undefined ? {} : { sourceId: anchor.sourceId }),
  };
}

/** Returns the rolling 90-day score window, shortened by an active category-14 event. */
export function getPlayerScoreWindow(evaluatedAt: string, anchor?: ScoreAnchor | null): ScoreWindow {
  const evaluatedAtMs = parseUtc(evaluatedAt);
  if (evaluatedAtMs === null) throw new RangeError("Invalid score evaluation time");
  const active = activeAnchor(anchor, evaluatedAtMs);
  const rollingStart = evaluatedAtMs - SCORE_WINDOW_DAYS * DAY_MS;
  const anchorStart = active ? parseUtc(active.start)! : rollingStart;
  return {
    start: iso(Math.max(rollingStart, anchorStart)),
    end: iso(evaluatedAtMs),
    anchor: active,
  };
}

function scoreFor(current: NormalizedEvidence, historical: NormalizedEvidence | null): { score: number; effectiveHistorical: number } | null {
  const positive = current.positiveReviews;
  const total = current.totalReviews;
  if (positive === null || total === null) return null;
  if (historical && historical.positiveReviews !== null && historical.totalReviews !== null && historical.totalReviews > 0) {
    const effectiveHistorical = Math.min(HISTORICAL_SUPPORT_CAP, historical.totalReviews);
    const historicalApproval = historical.positiveReviews / historical.totalReviews;
    return {
      score: 100 * (positive + effectiveHistorical * historicalApproval) / (total + effectiveHistorical),
      effectiveHistorical,
    };
  }
  if (total === 0) return null;
  return { score: 100 * (positive + 0.5) / (total + 1), effectiveHistorical: 0 };
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function snapshotFor(candidate: NormalizedEvidence): ScoreEvidenceSnapshot {
  return {
    sourceId: candidate.sourceId,
    positiveReviews: candidate.positiveReviews,
    negativeReviews: candidate.negativeReviews,
    totalReviews: candidate.totalReviews,
    selectedIntervals: candidate.selectedIntervals.map((interval) => ({ ...interval })),
    gaps: candidate.gaps.map((interval) => ({ ...interval })),
    requested: candidate.requested ? { ...candidate.requested } : null,
    observationTimes: [...candidate.observationTimes],
    observedAt: candidate.observedAt,
  };
}

/** Builds a frozen candidate containing every input needed to reproduce its score. */
export function calculatePlayerScoreCandidate(input: PlayerScoreCalculationInput): PlayerScoreCandidate | null {
  const current = normalizeEvidence(input.current);
  if (!current) return null;
  const historicalInputs = [input.historical, input.retainedBaseline];
  let historical: NormalizedEvidence | null = null;
  for (const item of historicalInputs) {
    const candidate = normalizeEvidence(item);
    if (!candidate || candidate.totalReviews === null || candidate.totalReviews === 0) continue;
    if (!compatibleHistorical(current, candidate)) continue;
    historical = candidate;
    break;
  }
  const result = scoreFor(current, historical);
  if (!result) return null;

  const evaluatedAtMs = input.evaluatedAt === undefined ? null : parseUtc(input.evaluatedAt);
  if (input.evaluatedAt !== undefined && evaluatedAtMs === null) throw new RangeError("Invalid score evaluation time");
  const anchor = evaluatedAtMs === null ? null : activeAnchor(input.anchor, evaluatedAtMs);
  let scoreWindow: ScoreWindow | null = null;
  if (input.scoreWindow) {
    const start = parseUtc(input.scoreWindow.start);
    const end = parseUtc(input.scoreWindow.end);
    if (start === null || end === null || start >= end) throw new RangeError("Invalid score evidence window");
    scoreWindow = { start: iso(start), end: iso(end), anchor };
  } else if (evaluatedAtMs !== null) {
    scoreWindow = getPlayerScoreWindow(iso(evaluatedAtMs), anchor);
  }
  const scoreObservedAt = input.observedAt === undefined ? current.observedAt ?? current.observationTimes.at(-1) ?? null : input.observedAt;
  const observedAtMs = scoreObservedAt === null ? null : parseUtc(scoreObservedAt);
  if (scoreObservedAt !== null && observedAtMs === null) throw new RangeError("Invalid score observation time");
  const candidate: PlayerScoreCandidate = {
    score: result.score,
    formulaVersion: input.formulaVersion ?? PLAYER_SCORE_FORMULA_VERSION,
    observedAt: observedAtMs === null ? null : iso(observedAtMs),
    anchor,
    scoreWindow,
    currentReviews: current.totalReviews!,
    historicalReviews: historical?.totalReviews ?? 0,
    historicalEffectiveReviews: result.effectiveHistorical,
    inputs: {
      current: snapshotFor(current),
      historical: historical ? snapshotFor(historical) : null,
    },
  };
  return freezeDeep(candidate);
}

/** Calculates only the full-precision player estimate; use the candidate for provenance. */
export function calculatePlayerScore(input: PlayerScoreCalculationInput): number | null {
  return calculatePlayerScoreCandidate(input)?.score ?? null;
}
