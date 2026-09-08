import { describe, expect, test } from "bun:test";
import { reconstructPlayerScoreAt } from "../src/lib/score-reconstruction";
import type { ReviewBucket } from "../src/lib/review-evidence";

const SOURCE = "histogram:all";
const DAY = 24 * 60 * 60 * 1000;

function day(
  start: string,
  positiveReviews: number,
  negativeReviews: number,
  observedAt = "2026-09-08T12:00:00.000Z",
  sourceId = SOURCE,
): ReviewBucket {
  const startMs = Date.parse(start);
  return {
    sourceId,
    granularity: "day",
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + DAY).toISOString(),
    positiveReviews,
    negativeReviews,
    observedAt,
  };
}

describe("retrospective player score", () => {
  test("selects only complete whole buckets without prorating an open day", () => {
    const candidate = reconstructPlayerScoreAt([
      day("2026-09-07T00:00:00.000Z", 8, 2),
      day("2026-09-08T00:00:00.000Z", 100, 0),
    ], [], "2026-09-08T12:00:00.000Z", SOURCE);

    expect(candidate?.inputs.current.selectedIntervals).toEqual([{
      start: "2026-09-07T00:00:00.000Z",
      end: "2026-09-08T00:00:00.000Z",
      granularity: "day",
    }]);
    expect(candidate?.inputs.current.totalReviews).toBe(10);
  });

  test("keeps later source observation time and never mixes populations", () => {
    const candidate = reconstructPlayerScoreAt([
      day("2026-09-07T00:00:00.000Z", 8, 2, "2026-09-10T00:00:00.000Z", SOURCE),
      day("2026-09-07T00:00:00.000Z", 0, 100, "2026-09-10T00:00:00.000Z", "histogram:filtered"),
    ], [], "2026-09-08T12:00:00.000Z", SOURCE);

    expect(candidate?.observedAt).toBe("2026-09-10T00:00:00.000Z");
    expect(candidate?.inputs.current.sourceId).toBe(SOURCE);
    expect(candidate?.inputs.current.positiveReviews).toBe(8);
  });

  test("falls back to an earlier supported endpoint when the current window runs out", () => {
    const candidate = reconstructPlayerScoreAt([
      day("2026-05-01T00:00:00.000Z", 8, 2, "2026-05-02T00:00:00.000Z"),
    ], [], "2026-09-08T12:00:00.000Z", SOURCE);

    expect(candidate?.scoreWindow?.end).toBe("2026-05-02T00:00:00.000Z");
    expect(candidate?.observedAt).toBe("2026-05-02T00:00:00.000Z");
  });

  test("retains the latest supported score after zero-review buckets", () => {
    const candidate = reconstructPlayerScoreAt([
      day("2026-01-01T00:00:00.000Z", 8, 2),
      day("2026-04-01T00:00:00.000Z", 0, 0),
    ], [], "2026-04-02T00:00:00.000Z", SOURCE);

    expect(candidate?.score).toBeCloseTo(77.2727272727);
    expect(candidate?.scoreWindow?.end).toBe("2026-01-02T00:00:00.000Z");
  });

  test("does not manufacture a score from a complete zero-review bucket alone", () => {
    expect(reconstructPlayerScoreAt([
      day("2026-09-07T00:00:00.000Z", 0, 0),
    ], [], "2026-09-08T12:00:00.000Z", SOURCE)).toBeNull();
  });
});
