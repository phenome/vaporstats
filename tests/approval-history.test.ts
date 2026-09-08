import { describe, expect, test } from "bun:test";
import {
  buildApprovalHistorySeries,
  type ApprovalHistorySeries,
} from "../src/lib/approval-history";
import type { ApprovalBucket, ScorePopulationReference } from "../src/lib/score";

const DAY = 24 * 60 * 60 * 1000;
const OBSERVED_AT = "2025-03-01T00:00:00.000Z";

function iso(value: string | number): string {
  return new Date(value).toISOString();
}

function population(sourceId: string): ScorePopulationReference {
  return {
    source_id: sourceId,
    endpoint: "appreviewhistogram",
    request_filter: "all",
    population: "global",
    language: "all",
    purchase_type: "all",
    filter_offtopic_activity: 0,
    population_flags: {},
    interpretation_version: "test-v1",
  };
}

function bucket(
  sourceId: string,
  granularity: ApprovalBucket["granularity"],
  start: string,
  end: string,
  positiveReviews: number,
  negativeReviews: number,
): ApprovalBucket {
  const totalReviews = positiveReviews + negativeReviews;
  return {
    source_id: sourceId,
    granularity,
    period_start: iso(start),
    period_end: iso(end),
    positive_reviews: positiveReviews,
    negative_reviews: negativeReviews,
    total_reviews: totalReviews,
    approval: totalReviews > 0 ? (100 * positiveReviews) / totalReviews : null,
    observed_at: OBSERVED_AT,
    population_ref: population(sourceId),
  };
}

function dailyBuckets(
  sourceId: string,
  start: string,
  days: number,
  positiveReviews = 10,
  negativeReviews = 0,
): ApprovalBucket[] {
  const startMs = Date.parse(start);
  return Array.from({ length: days }, (_, index) => {
    const dayStart = startMs + index * DAY;
    return bucket(
      sourceId,
      "daily",
      iso(dayStart),
      iso(dayStart + DAY),
      positiveReviews,
      negativeReviews,
    );
  });
}

function points(series: readonly ApprovalHistorySeries[]): ApprovalHistorySeries["points"] {
  return series.flatMap((entry) => entry.points);
}

describe("approval history projection", () => {
  test("uses one full-month bucket followed by whole daily buckets in a partial month", () => {
    const monthly = bucket("source-a", "monthly", "2025-01-01", "2025-02-01", 70, 30);
    const february = [
      bucket("source-a", "daily", "2025-02-01", "2025-02-02", 9, 1),
      bucket("source-a", "daily", "2025-02-02", "2025-02-03", 4, 6),
    ];
    const series = buildApprovalHistorySeries(
      [monthly, ...february],
      "2025-01-01T00:00:00Z",
      "2025-02-03T00:00:00Z",
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.sourceId).toBe("source-a");
    expect(series[0]?.populationRef).toEqual(monthly.population_ref);
    expect(series[0]?.points.map((point) => point.approval)).toEqual([70, 90, 40]);
    expect(series[0]?.points.map((point) => point.bucket?.period_start)).toEqual([
      monthly.period_start,
      february[0]!.period_start,
      february[1]!.period_start,
    ]);
    expect(series[0]?.points.map((point) => point.timestamp)).toEqual([
      Date.parse("2025-01-16T12:00:00.000Z"),
      Date.parse("2025-02-01T12:00:00.000Z"),
      Date.parse("2025-02-02T12:00:00.000Z"),
    ]);
  });

  test("prefers complete daily coverage for a month instead of duplicating its monthly bucket", () => {
    const monthly = bucket("source-a", "monthly", "2025-01-01", "2025-02-01", 55, 45);
    const daily = dailyBuckets("source-a", "2025-01-01", 31);
    const series = buildApprovalHistorySeries(
      [monthly, ...daily],
      "2025-01-01T00:00:00Z",
      "2025-02-01T00:00:00Z",
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.points).toHaveLength(31);
    expect(series[0]?.points.every((point) => point.bucket?.granularity === "daily")).toBe(true);
    expect(series[0]?.points.every((point) => point.approval === 100)).toBe(true);
    expect(series[0]?.points.map((point) => point.bucket?.period_start)).toEqual(
      daily.map((entry) => entry.period_start),
    );
  });

  test("keeps same-date source populations in separate series", () => {
    const sourceA = bucket("source-a", "monthly", "2025-01-01", "2025-02-01", 8, 2);
    const sourceB = bucket("source-b", "monthly", "2025-01-01", "2025-02-01", 2, 8);
    const series = buildApprovalHistorySeries(
      [sourceA, sourceB],
      "2025-01-01T00:00:00Z",
      "2025-02-01T00:00:00Z",
    );

    expect(series.map((entry) => entry.sourceId).sort()).toEqual(["source-a", "source-b"]);
    const outputA = series.find((entry) => entry.sourceId === "source-a");
    const outputB = series.find((entry) => entry.sourceId === "source-b");
    expect(outputA?.populationRef).toEqual(sourceA.population_ref);
    expect(outputB?.populationRef).toEqual(sourceB.population_ref);
    expect(outputA?.points).toHaveLength(1);
    expect(outputB?.points).toHaveLength(1);
    expect(outputA?.points[0]?.approval).toBe(80);
    expect(outputB?.points[0]?.approval).toBe(20);
    expect(outputA?.points[0]?.bucket?.source_id).toBe("source-a");
    expect(outputB?.points[0]?.bucket?.source_id).toBe("source-b");
  });

  test("marks absent days and zero-review days so the line cannot bridge them", () => {
    const first = bucket("source-a", "daily", "2025-01-01", "2025-01-02", 9, 1);
    const zeroReviews = bucket("source-a", "daily", "2025-01-03", "2025-01-04", 0, 0);
    const series = buildApprovalHistorySeries(
      [first, zeroReviews],
      "2025-01-01T00:00:00Z",
      "2025-01-04T00:00:00Z",
    );
    const output = series[0]!;

    expect(output.points.map((point) => point.timestamp)).toEqual([
      Date.parse("2025-01-01T12:00:00.000Z"),
      Date.parse("2025-01-02T12:00:00.000Z"),
      Date.parse("2025-01-03T12:00:00.000Z"),
    ]);
    expect(output.points[0]).toMatchObject({ approval: 90, bucket: first });
    expect(output.points[1]).toEqual({
      timestamp: Date.parse("2025-01-02T12:00:00.000Z"),
      approval: null,
      bucket: null,
    });
    expect(output.points[2]).toMatchObject({ approval: null, bucket: zeroReviews });
  });

  test("does not prorate a monthly bucket across a partial month and rejects invalid ranges", () => {
    const monthly = bucket("source-a", "monthly", "2025-01-01", "2025-02-01", 3, 1);
    const partial = buildApprovalHistorySeries(
      [monthly],
      "2025-01-15T00:00:00Z",
      "2025-02-15T00:00:00Z",
    );
    expect(points(partial)).toEqual([]);

    expect(buildApprovalHistorySeries([monthly], null, "2025-02-01T00:00:00Z")).toEqual([]);
    expect(buildApprovalHistorySeries([monthly], "2025-01-01T00:00:00Z", null)).toEqual([]);
    expect(buildApprovalHistorySeries(
      [monthly],
      "2025-02-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
    )).toEqual([]);
  });
});
