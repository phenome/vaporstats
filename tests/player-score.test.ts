import { describe, expect, test } from "bun:test";
import {
  calculatePlayerScoreCandidate,
  calculatePlayerScore,
  getPlayerScoreWindow,
  type PlayerScoreCalculationInput,
} from "../src/lib/player-score";
import {
  evaluateRecentReception,
  type RecentReceptionInput,
} from "../src/lib/recent-reception";
import type { ReviewBucket, ReviewInterval } from "../src/lib/review-evidence";

const DAY = 24 * 60 * 60 * 1000;
const SOURCE = "steam:all:en:offtopic";

function interval(start: string, end: string): ReviewInterval {
  return { start, end, granularity: "day" };
}

function evidence(
  positiveReviews: number,
  totalReviews: number,
  start: string,
  end: string,
  sourceId = SOURCE,
) {
  return {
    sourceId,
    positiveReviews,
    totalReviews,
    selectedIntervals: [interval(start, end)],
    observationTimes: ["2025-04-01T00:00:00.000Z"],
  };
}

function dailyBuckets(
  start: string,
  days: number,
  positiveFirst: number,
  negativeFirst: number,
  sourceId = SOURCE,
): ReviewBucket[] {
  const startMs = Date.parse(start);
  return Array.from({ length: days }, (_, index) => {
    const dayStart = new Date(startMs + index * DAY).toISOString();
    const dayEnd = new Date(startMs + (index + 1) * DAY).toISOString();
    return {
      sourceId,
      granularity: "day" as const,
      start: dayStart,
      end: dayEnd,
      positiveReviews: index === 0 ? positiveFirst : 0,
      negativeReviews: index === 0 ? negativeFirst : 0,
      observedAt: "2025-04-01T00:00:00.000Z",
    };
  });
}

describe("player score domain", () => {
  test("keeps all-positive cold starts at 100 as actual reviews accumulate", () => {
    const scores = [1, 2, 10, 100].map((totalReviews) =>
      calculatePlayerScore({ current: { positiveReviews: totalReviews, totalReviews } }));
    expect(scores).toEqual([100, 100, 100, 100]);
  });

  test("keeps all-negative cold starts at zero and mixed samples at actual approval", () => {
    expect(calculatePlayerScore({ current: { positiveReviews: 0, totalReviews: 1 } })).toBe(0);
    expect(calculatePlayerScore({ current: { positiveReviews: 3, totalReviews: 4 } })).toBe(75);
  });

  test("does not invent a score without real evidence", () => {
    expect(calculatePlayerScore({ current: null })).toBeNull();
    expect(calculatePlayerScore({ current: { positiveReviews: 0, totalReviews: 0 } })).toBeNull();
    expect(calculatePlayerScore({ current: { positiveReviews: null, totalReviews: 10 } })).toBeNull();
  });

  test("caps historical support at 20 actual reviews and keeps positive and negative evidence symmetric", () => {
    const input: PlayerScoreCalculationInput = {
      current: evidence(10, 10, "2025-03-31T00:00:00.000Z", "2025-04-01T00:00:00.000Z"),
      historical: evidence(60, 100, "2025-01-01T00:00:00.000Z", "2025-03-31T00:00:00.000Z"),
    };
    const candidate = calculatePlayerScoreCandidate(input);
    expect(candidate?.historicalReviews).toBe(100);
    expect(candidate?.historicalEffectiveReviews).toBe(20);
    expect(candidate?.score).toBeCloseTo(73.33333333333333, 12);

    const falling = calculatePlayerScore({
      current: evidence(0, 10, "2025-03-31T00:00:00.000Z", "2025-04-01T00:00:00.000Z"),
      historical: evidence(60, 100, "2025-01-01T00:00:00.000Z", "2025-03-31T00:00:00.000Z"),
    });
    expect(falling).toBeCloseTo(40, 12);
  });

  test("does not increase a small historical sample to the support cap", () => {
    const candidate = calculatePlayerScoreCandidate({
      current: evidence(1, 1, "2025-03-31T00:00:00.000Z", "2025-04-01T00:00:00.000Z"),
      historical: evidence(1, 4, "2025-03-01T00:00:00.000Z", "2025-03-02T00:00:00.000Z"),
    });
    expect(candidate?.score).toBe(40);
    expect(candidate?.historicalEffectiveReviews).toBe(4);
  });

  test("rejects historical support without known nonoverlapping intervals", () => {
    const current = evidence(3, 4, "2025-03-20T00:00:00.000Z", "2025-03-21T00:00:00.000Z");
    const unknown = calculatePlayerScoreCandidate({
      current,
      historical: { sourceId: SOURCE, positiveReviews: 0, totalReviews: 100 },
    });
    expect(unknown?.score).toBe(75);
    expect(unknown?.historicalReviews).toBe(0);
    const overlapping = calculatePlayerScoreCandidate({
      current,
      historical: {
        ...evidence(0, 100, "2025-03-17T00:00:00.000Z", "2025-03-24T00:00:00.000Z"),
        selectedIntervals: [{ start: "2025-03-17T00:00:00.000Z", end: "2025-03-24T00:00:00.000Z", granularity: "week" }],
      },
    });
    expect(overlapping?.score).toBe(75);
    expect(overlapping?.historicalReviews).toBe(0);
  });

  test("rejects incompatible or overlapping retained evidence instead of blending it", () => {
    const candidate = calculatePlayerScoreCandidate({
      current: evidence(80, 100, "2025-03-20T00:00:00.000Z", "2025-03-21T00:00:00.000Z"),
      historical: evidence(100, 100, "2025-03-19T00:00:00.000Z", "2025-03-20T00:00:00.000Z", "other-source"),
      retainedBaseline: evidence(60, 100, "2025-03-01T00:00:00.000Z", "2025-03-02T00:00:00.000Z"),
    });
    expect(candidate?.historicalReviews).toBe(100);
    expect(candidate?.inputs.historical?.sourceId).toBe(SOURCE);
    expect(candidate?.score).toBeCloseTo(76.66666666666667, 12);
  });

  test("retains historical approval when the current completed interval has zero reviews", () => {
    const score = calculatePlayerScore({
      current: evidence(0, 0, "2025-03-31T00:00:00.000Z", "2025-04-01T00:00:00.000Z"),
      historical: evidence(60, 100, "2025-01-01T00:00:00.000Z", "2025-03-01T00:00:00.000Z"),
    });
    expect(score).toBe(60);
  });

  test("versions new candidates as v2 and preserves weekly evidence provenance", () => {
    const selectedInterval: ReviewInterval = {
      start: "2025-03-24T00:00:00.000Z",
      end: "2025-03-31T00:00:00.000Z",
      granularity: "week",
    };
    const candidate = calculatePlayerScoreCandidate({
      current: {
        ...evidence(1, 1, selectedInterval.start, selectedInterval.end),
        selectedIntervals: [selectedInterval],
      },
      evaluatedAt: "2025-04-01T00:00:00.000Z",
    });
    expect(candidate?.score).toBe(100);
    expect(candidate?.formulaVersion).toBe("steam-player-v2");
    expect(candidate?.inputs.current.selectedIntervals).toEqual([selectedInterval]);
    selectedInterval.start = "2025-03-23T00:00:00.000Z";
    expect(candidate?.inputs.current.selectedIntervals[0]?.start).toBe("2025-03-24T00:00:00.000Z");
  });

  test("anchors only on active category-14 events and captures immutable inputs", () => {
    const active = getPlayerScoreWindow("2025-04-01T12:00:00Z", {
      category: 14,
      start: "2025-03-01T00:00:00Z",
      eventId: "event-1",
    });
    expect(active.start).toBe("2025-03-01T00:00:00.000Z");
    expect(active.anchor?.eventId).toBe("event-1");

    const ordinary = getPlayerScoreWindow("2025-04-01T12:00:00Z", {
      category: 12,
      start: "2025-03-01T00:00:00Z",
    });
    expect(ordinary.start).toBe("2025-01-01T12:00:00.000Z");

    const current = evidence(80, 100, "2025-03-20T00:00:00.000Z", "2025-03-21T00:00:00.000Z");
    const candidate = calculatePlayerScoreCandidate({ current, evaluatedAt: "2025-04-01T00:00:00Z" });
    current.positiveReviews = 0;
    expect(candidate?.inputs.current.positiveReviews).toBe(80);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate?.inputs.current)).toBe(true);
    const corrected = calculatePlayerScoreCandidate({ current, evaluatedAt: "2025-04-01T00:00:00Z" });
    expect(corrected?.score).not.toBe(candidate?.score);
  });
});

describe("Recent reception", () => {
  test("uses exact four-week and preceding eight-week windows with inclusive 5pp direction", () => {
    const input: RecentReceptionInput = {
      evaluatedAt: "2025-04-01T12:00:00Z",
      buckets: [
        ...dailyBuckets("2025-03-04T00:00:00Z", 28, 950, 50),
        ...dailyBuckets("2025-01-07T00:00:00Z", 56, 900, 100),
      ],
    };
    const result = evaluateRecentReception(input);
    expect(result.cutoff).toBe("2025-04-01T00:00:00.000Z");
    expect(result.recent.start).toBe("2025-03-04T00:00:00.000Z");
    expect(result.previous.start).toBe("2025-01-07T00:00:00.000Z");
    expect(result.recent.totalReviews).toBe(1000);
    expect(result.previous.totalReviews).toBe(1000);
    expect(result.deltaPp).toBe(5);
    expect(result.state).toBe("more_positive");
    expect(result.reasons).toEqual([]);
  });

  test("uses same-day observations but excludes evidence collected after evaluation", () => {
    const buckets = [
      ...dailyBuckets("2025-03-04T00:00:00Z", 28, 950, 50),
      ...dailyBuckets("2025-01-07T00:00:00Z", 56, 900, 100),
    ].map((bucket) => ({ ...bucket, observedAt: "2025-04-01T08:00:00Z" }));
    const input = { evaluatedAt: "2025-04-01T12:00:00Z", buckets };
    const known = evaluateRecentReception(input);
    expect(known.cutoff).toBe("2025-04-01T00:00:00.000Z");
    expect(known.state).toBe("more_positive");

    buckets[0].observedAt = "2025-04-01T13:00:00Z";
    const future = evaluateRecentReception(input);
    expect(future.recent.coverageComplete).toBe(false);
    expect(future.reasons).toContain("recent:missing_coverage");
    expect(future.state).toBe("insufficient_evidence");
  });

  test("requires full coverage and reports all applicable period-qualified causes", () => {
    const buckets = [
      ...dailyBuckets("2025-03-04T00:00:00Z", 28, 50, 0),
      ...dailyBuckets("2025-01-07T00:00:00Z", 56, 0, 50),
    ];
    buckets.splice(3, 1);
    const result = evaluateRecentReception({ evaluatedAt: "2025-04-01T00:00:00Z", buckets });
    expect(result.state).toBe("insufficient_evidence");
    expect(result.recent.coverageComplete).toBe(false);
    expect(result.recent.totalReviews).toBe(50);
    expect(result.reasons).toContain("recent:missing_coverage");
    expect(result.reasons).not.toContain("recent:insufficient_reviews");
  });

  test("distinguishes complete zero periods from absent evidence and does not manufacture a trend", () => {
    const result = evaluateRecentReception({
      evaluatedAt: "2025-04-01T00:00:00Z",
      buckets: [
        ...dailyBuckets("2025-03-04T00:00:00Z", 28, 0, 0),
      ],
    });
    expect(result.recent.coverageComplete).toBe(true);
    expect(result.recent.totalReviews).toBe(0);
    expect(result.recent.approval).toBeNull();
    expect(result.state).toBe("insufficient_evidence");
    expect(result.reasons).toContain("recent:insufficient_reviews");
    expect(result.reasons).toContain("previous:missing_coverage");
    expect(result.deltaPp).toBeNull();
  });

  test("never treats different source populations as compatible evidence", () => {
    const result = evaluateRecentReception({
      evaluatedAt: "2025-04-01T00:00:00Z",
      buckets: [
        ...dailyBuckets("2025-03-04T00:00:00Z", 28, 100, 0, "source-a"),
        ...dailyBuckets("2025-01-07T00:00:00Z", 56, 100, 0, "source-b"),
      ],
    });
    expect(result.state).toBe("insufficient_evidence");
    expect(result.reasons).toContain("recent:unavailable_compatible_evidence");
    expect(result.reasons).toContain("previous:unavailable_compatible_evidence");
  });
  test("does not score a Recent reception period after count overflow", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const recent = dailyBuckets("2025-03-04T00:00:00Z", 28, max - 1, 0);
    recent[1].positiveReviews = max - 1;
    const result = evaluateRecentReception({
      evaluatedAt: "2025-04-01T00:00:00Z",
      buckets: [...recent, ...dailyBuckets("2025-01-07T00:00:00Z", 56, 0, 50)],
    });
    expect(result.recent.coverageComplete).toBe(false);
    expect(result.recent.approval).toBeNull();
    expect(result.reasons).toContain("recent:unavailable_compatible_evidence");
    expect(result.deltaPp).toBeNull();
  });
});
