import { describe, expect, test } from "bun:test";
import {
  selectWholeBuckets,
  type ReviewBucket,
} from "../src/lib/review-evidence";

const DAY = 24 * 60 * 60 * 1000;
const day = (value: string): string => new Date(value).toISOString();

function bucket(
  start: string,
  positiveReviews: number | null,
  negativeReviews: number | null,
  options: Partial<ReviewBucket> = {},
): ReviewBucket {
  const startMs = Date.parse(start);
  return {
    sourceId: "steam:all:en:offtopic",
    granularity: "day",
    start: day(start),
    end: day(new Date(startMs + DAY).toISOString()),
    positiveReviews,
    negativeReviews,
    observedAt: "2025-02-01T00:00:00.000Z",
    ...options,
  };
}

function week(start: string, positive: number, negative: number, options: Partial<ReviewBucket> = {}): ReviewBucket {
  return bucket(start, positive, negative, {
    granularity: "week",
    end: new Date(Date.parse(start) + 7 * DAY).toISOString(),
    observedAt: "2025-04-01T00:00:00.000Z",
    ...options,
  });
}

describe("whole review-bucket selection", () => {
  test("prefers complete daily coverage and returns counts and provenance", () => {
    const buckets: ReviewBucket[] = [
      bucket("2025-01-01T00:00:00Z", 3, 1),
      bucket("2025-01-02T00:00:00Z", 2, 0),
      {
        sourceId: "steam:all:en:offtopic",
        granularity: "month",
        start: "2025-01-01T00:00:00.000Z",
        end: "2025-02-01T00:00:00.000Z",
        positiveReviews: 99,
        negativeReviews: 1,
        observedAt: "2025-02-01T00:00:00.000Z",
      },
    ];
    const selected = selectWholeBuckets(buckets, { start: "2025-01-01T00:00:00Z", end: "2025-01-03T00:00:00Z" }, {
      asOf: "2025-02-02T00:00:00Z",
    });
    expect(selected.selectedIntervals).toHaveLength(2);
    expect(selected.selectedIntervals.every((interval) => interval.granularity === "day")).toBe(true);
    expect(selected.positiveReviews).toBe(5);
    expect(selected.negativeReviews).toBe(1);
    expect(selected.totalReviews).toBe(6);
    expect(selected.covered).toBe(true);
    expect(selected.gaps).toEqual([]);
    expect(selected.provenance.map((entry) => entry.observedAt)).toEqual([
      "2025-02-01T00:00:00.000Z",
      "2025-02-01T00:00:00.000Z",
    ]);
  });

  test("uses one contained month instead of overlapping incomplete daily buckets", () => {
    const buckets: ReviewBucket[] = [
      bucket("2025-01-01T00:00:00Z", 1, 0),
      {
        sourceId: "steam:all:en:offtopic",
        granularity: "month",
        start: "2025-01-01T00:00:00.000Z",
        end: "2025-02-01T00:00:00.000Z",
        positiveReviews: 70,
        negativeReviews: 30,
        observedAt: "2025-02-02T00:00:00.000Z",
      },
    ];
    const selected = selectWholeBuckets(buckets, { start: "2025-01-01T00:00:00Z", end: "2025-02-01T00:00:00Z" }, {
      asOf: "2025-02-03T00:00:00Z",
    });
    expect(selected.selectedIntervals).toEqual([
      { start: "2025-01-01T00:00:00.000Z", end: "2025-02-01T00:00:00.000Z", granularity: "month" },
    ]);
    expect(selected.totalReviews).toBe(100);
    expect(selected.positiveReviews).toBe(70);
  });

  test("excludes straddling and open buckets while preserving zero as covered evidence", () => {
    const selected = selectWholeBuckets([
      bucket("2024-12-31T00:00:00Z", 5, 5),
      bucket("2025-01-01T00:00:00Z", 0, 0),
      bucket("2025-01-02T00:00:00Z", 4, 1, { complete: false }),
    ], { start: "2025-01-01T12:00:00Z", end: "2025-01-03T00:00:00Z" }, { asOf: "2025-01-03T00:00:00Z" });
    expect(selected.selectedIntervals).toEqual([]);
    expect(selected.totalReviews).toBeNull();
    expect(selected.covered).toBe(false);
    expect(selected.gaps).toEqual([
      { start: "2025-01-01T12:00:00.000Z", end: "2025-01-03T00:00:00.000Z", granularity: "day" },
    ]);

    const zero = selectWholeBuckets([
      bucket("2025-01-01T00:00:00Z", 0, 0, { observedAt: "2025-01-02T00:00:00Z" }),
    ], { start: "2025-01-01T00:00:00Z", end: "2025-01-02T00:00:00Z" }, { asOf: "2025-01-02T00:00:00Z" });
    expect(zero.covered).toBe(true);
    expect(zero.totalReviews).toBe(0);
    expect(zero.gaps).toEqual([]);
  });

  test("never combines opaque source identities", () => {
    const first = bucket("2025-01-01T00:00:00Z", 10, 0, { sourceId: "source-a", observedAt: "2025-01-03T00:00:00Z" });
    const second = bucket("2025-01-02T00:00:00Z", 0, 10, { sourceId: "source-b", observedAt: "2025-01-03T00:00:00Z" });
    const mixed = selectWholeBuckets([first, second], { start: "2025-01-01T00:00:00Z", end: "2025-01-03T00:00:00Z" }, {
      asOf: "2025-01-03T00:00:00Z",
    });
    expect(mixed.selectedIntervals).toEqual([]);
    expect(mixed.sourceId).toBeNull();
    expect(mixed.totalReviews).toBeNull();

    const onlyA = selectWholeBuckets([first, second], { start: "2025-01-01T00:00:00Z", end: "2025-01-03T00:00:00Z" }, {
      sourceId: "source-a",
      asOf: "2025-01-03T00:00:00Z",
    });
    expect(onlyA.totalReviews).toBe(10);
    expect(onlyA.positiveReviews).toBe(10);
  });

  test("does not fabricate counts when aggregate totals overflow safe integers", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const selected = selectWholeBuckets([
      bucket("2025-01-01T00:00:00Z", max - 1, 0, { observedAt: "2025-01-03T00:00:00Z" }),
      bucket("2025-01-02T00:00:00Z", max - 1, 0, { observedAt: "2025-01-03T00:00:00Z" }),
    ], { start: "2025-01-01T00:00:00Z", end: "2025-01-03T00:00:00Z" }, { asOf: "2025-01-03T00:00:00Z" });
    expect(selected.selectedIntervals).toHaveLength(2);
    expect(selected.countOverflow).toBe(true);
    expect(selected.countsComplete).toBe(false);
    expect(selected.totalReviews).toBeNull();
  });
  test("uses the newest correction for one source interval without adding a cohort", () => {
    const selected = selectWholeBuckets([
      bucket("2025-01-01T00:00:00Z", 80, 20, { observedAt: "2025-01-02T00:00:00Z" }),
      bucket("2025-01-01T00:00:00Z", 70, 30, { observedAt: "2025-01-03T00:00:00Z" }),
    ], { start: "2025-01-01T00:00:00Z", end: "2025-01-02T00:00:00Z" }, { asOf: "2025-01-04T00:00:00Z" });
    expect(selected.positiveReviews).toBe(70);
    expect(selected.negativeReviews).toBe(30);
    expect(selected.totalReviews).toBe(100);
    expect(selected.observationTimes).toEqual(["2025-01-03T00:00:00.000Z"]);
  });

  test("keeps cross-month weeks rather than losing coverage to a month or isolated days", () => {
    const weeks = Array.from({ length: 5 }, (_, index) =>
      week(new Date(Date.UTC(2025, 0, 29 + index * 7)).toISOString(), 7, 3));
    const selected = selectWholeBuckets([
      bucket("2025-01-30T00:00:00Z", 1_000, 0),
      bucket("2025-02-01T00:00:00Z", 900, 100, {
        granularity: "month",
        end: "2025-03-01T00:00:00.000Z",
        observedAt: "2025-04-01T00:00:00.000Z",
      }),
      ...weeks,
    ], { start: "2025-01-29T00:00:00Z", end: "2025-03-05T00:00:00Z" });

    expect(selected.selectedIntervals).toEqual(weeks.map(({ start, end }) => ({ start, end, granularity: "week" })));
    expect(selected.positiveReviews).toBe(35);
    expect(selected.negativeReviews).toBe(15);
    expect(selected.totalReviews).toBe(50);
    expect(selected.covered).toBe(true);
    expect(selected.gaps).toEqual([]);
  });

  test("does not trade a hole inside a complete month for weekly coverage outside it", () => {
    const month = bucket("2025-02-01T00:00:00Z", 900, 100, {
      granularity: "month",
      end: "2025-03-01T00:00:00.000Z",
      observedAt: "2025-04-01T00:00:00.000Z",
    });
    const incompleteWeeks = [29, 36, 50, 57].map((date) =>
      week(new Date(Date.UTC(2025, 0, date)).toISOString(), 7, 3));
    const requested = { start: "2025-01-29T00:00:00Z", end: "2025-03-05T00:00:00Z" };
    const selected = selectWholeBuckets([month, ...incompleteWeeks], requested);
    expect(selected.selectedIntervals).toEqual([{ start: month.start, end: month.end, granularity: "month" }]);
    expect(selected.positiveReviews).toBe(900);
    expect(selected.negativeReviews).toBe(100);
    expect(selected.gaps).toEqual([
      { start: "2025-01-29T00:00:00.000Z", end: "2025-02-01T00:00:00.000Z", granularity: "day" },
      { start: "2025-03-01T00:00:00.000Z", end: "2025-03-05T00:00:00.000Z", granularity: "day" },
    ]);

    const alignedWeeks = [1, 8, 15, 22].map((date) =>
      week(new Date(Date.UTC(2025, 1, date)).toISOString(), 7, 3));
    const replaced = selectWholeBuckets([month, ...incompleteWeeks, ...alignedWeeks], requested);
    expect(replaced.selectedIntervals).toEqual(alignedWeeks.map(({ start, end }) => ({ start, end, granularity: "week" })));
    expect(replaced.totalReviews).toBe(40);
    expect(replaced.gaps).toEqual(selected.gaps);
  });

  test("prefers exact daily replacement of a week and exact weekly replacement of a month", () => {
    const weeks = Array.from({ length: 4 }, (_, index) =>
      week(new Date(Date.UTC(2025, 1, 1 + index * 7)).toISOString(), 7, 3));
    const days = Array.from({ length: 7 }, (_, index) =>
      bucket(new Date(Date.UTC(2025, 1, 8 + index)).toISOString(), 2, 1, { observedAt: "2025-04-01T00:00:00.000Z" }));
    const selected = selectWholeBuckets([
      ...weeks,
      ...days,
      bucket("2025-02-01T00:00:00Z", 900, 100, {
        granularity: "month",
        end: "2025-03-01T00:00:00.000Z",
        observedAt: "2025-04-01T00:00:00.000Z",
      }),
    ], { start: "2025-02-01T00:00:00Z", end: "2025-03-01T00:00:00Z" });

    expect(selected.selectedIntervals.map((interval) => interval.granularity)).toEqual([
      "week", ...Array(7).fill("day"), "week", "week",
    ]);
    expect(selected.positiveReviews).toBe(35);
    expect(selected.negativeReviews).toBe(16);
    expect(selected.totalReviews).toBe(51);
    expect(selected.covered).toBe(true);
  });

  test("preserves absent weeks as gaps and never prorates weeks across a window boundary", () => {
    const selected = selectWholeBuckets([
      week("2025-01-29T00:00:00Z", 70, 30),
      week("2025-02-05T00:00:00Z", 0, 0),
      week("2025-02-19T00:00:00Z", 7, 3),
    ], { start: "2025-02-01T00:00:00Z", end: "2025-02-23T00:00:00Z" });

    expect(selected.selectedIntervals).toEqual([
      { start: "2025-02-05T00:00:00.000Z", end: "2025-02-12T00:00:00.000Z", granularity: "week" },
    ]);
    expect(selected.totalReviews).toBe(0);
    expect(selected.covered).toBe(false);
    expect(selected.gaps).toEqual([
      { start: "2025-02-01T00:00:00.000Z", end: "2025-02-05T00:00:00.000Z", granularity: "day" },
      { start: "2025-02-12T00:00:00.000Z", end: "2025-02-23T00:00:00.000Z", granularity: "day" },
    ]);
  });

  test("rejects malformed weekly intervals and respects observation, completion, and population boundaries", () => {
    const valid = week("2025-01-29T00:00:00Z", 7, 3, { observedAt: "2025-02-05T00:00:00.000Z" });
    const selected = selectWholeBuckets([
      valid,
      week("2025-02-05T00:00:00Z", 70, 30, { end: "2025-02-11T00:00:00.000Z", observedAt: "2025-03-01T00:00:00.000Z" }),
      week("2025-02-05T12:00:00Z", 70, 30, { observedAt: "2025-03-01T00:00:00.000Z" }),
      week("2025-02-05T00:00:00.001Z", 70, 30, { observedAt: "2025-03-01T00:00:00.000Z" }),
      week("2025-02-12T00:00:00Z", 70, 30, { complete: false, observedAt: "2025-03-01T00:00:00.000Z" }),
      week("2025-02-19T00:00:00Z", 70, 30, { observedAt: "2025-04-01T00:00:00.000Z" }),
      week("2025-02-26T00:00:00Z", 70, 30, { observedAt: "2025-03-01T00:00:00.000Z" }),
      week("2025-02-05T00:00:00Z", 700, 300, { sourceId: "other-population", observedAt: "2025-02-12T00:00:00.000Z" }),
    ], { start: "2025-01-29T00:00:00Z", end: "2025-03-12T00:00:00Z" }, {
      sourceId: valid.sourceId,
      asOf: "2025-03-01T00:00:00Z",
    });

    expect(selected.selectedIntervals).toEqual([
      { start: valid.start, end: valid.end, granularity: "week" },
    ]);
    expect(selected.totalReviews).toBe(10);
    expect(selected.observationTimes).toEqual(["2025-02-05T00:00:00.000Z"]);
    expect(selected.gaps).toEqual([
      { start: "2025-02-05T00:00:00.000Z", end: "2025-03-12T00:00:00.000Z", granularity: "day" },
    ]);
  });
});
