import { describe, expect, test } from "bun:test";
import {
  cleanGameSearchParams,
  DEFAULT_NUMERIC_PRICE_RANGE,
  DEFAULT_NUMERIC_RANGE,
  HISTORY_TO_NUMERIC_RANGE,
  isEventWithinHistoryRange,
  NUMERIC_TO_HISTORY_RANGE,
  NUMERIC_TO_PRICE_RANGE,
  parseNumericPriceRange,
  parseNumericRange,
  PRICE_TO_NUMERIC_RANGE,
} from "../src/lib/game-params";

describe("Numeric Range Mappings", () => {
  test("maps 1-5 correctly to HistoryRange", () => {
    expect(NUMERIC_TO_HISTORY_RANGE[1]).toBe("24h");
    expect(NUMERIC_TO_HISTORY_RANGE[2]).toBe("7d");
    expect(NUMERIC_TO_HISTORY_RANGE[3]).toBe("30d");
    expect(NUMERIC_TO_HISTORY_RANGE[4]).toBe("90d");
    expect(NUMERIC_TO_HISTORY_RANGE[5]).toBe("all");

    expect(HISTORY_TO_NUMERIC_RANGE["24h"]).toBe(1);
    expect(HISTORY_TO_NUMERIC_RANGE["7d"]).toBe(2);
    expect(HISTORY_TO_NUMERIC_RANGE["30d"]).toBe(3);
    expect(HISTORY_TO_NUMERIC_RANGE["90d"]).toBe(4);
    expect(HISTORY_TO_NUMERIC_RANGE.all).toBe(5);
  });

  test("maps 1-4 correctly to PriceHistoryRange", () => {
    expect(NUMERIC_TO_PRICE_RANGE[1]).toBe("30d");
    expect(NUMERIC_TO_PRICE_RANGE[2]).toBe("6m");
    expect(NUMERIC_TO_PRICE_RANGE[3]).toBe("1y");
    expect(NUMERIC_TO_PRICE_RANGE[4]).toBe("all");

    expect(PRICE_TO_NUMERIC_RANGE["30d"]).toBe(1);
    expect(PRICE_TO_NUMERIC_RANGE["6m"]).toBe(2);
    expect(PRICE_TO_NUMERIC_RANGE["1y"]).toBe(3);
    expect(PRICE_TO_NUMERIC_RANGE.all).toBe(4);
  });

  test("parses numeric range with fallback to default 3 (30d)", () => {
    expect(parseNumericRange(1)).toBe(1);
    expect(parseNumericRange("2")).toBe(2);
    expect(parseNumericRange(3)).toBe(3);
    expect(parseNumericRange("4")).toBe(4);
    expect(parseNumericRange(5)).toBe(5);
    expect(parseNumericRange(0)).toBe(DEFAULT_NUMERIC_RANGE);
    expect(parseNumericRange(6)).toBe(DEFAULT_NUMERIC_RANGE);
    expect(parseNumericRange("invalid")).toBe(DEFAULT_NUMERIC_RANGE);
    expect(parseNumericRange(undefined)).toBe(DEFAULT_NUMERIC_RANGE);
  });

  test("parses numeric price range with fallback to default 4 (all)", () => {
    expect(parseNumericPriceRange(1)).toBe(1);
    expect(parseNumericPriceRange("2")).toBe(2);
    expect(parseNumericPriceRange(3)).toBe(3);
    expect(parseNumericPriceRange("4")).toBe(4);
    expect(parseNumericPriceRange(0)).toBe(DEFAULT_NUMERIC_PRICE_RANGE);
    expect(parseNumericPriceRange(5)).toBe(DEFAULT_NUMERIC_PRICE_RANGE);
    expect(parseNumericPriceRange(undefined)).toBe(DEFAULT_NUMERIC_PRICE_RANGE);
  });
});

describe("URL Search Params Cleaning", () => {
  test("omits default range 3 and default pricerange 4", () => {
    const cleaned = cleanGameSearchParams({
      range: 3,
      pricerange: 4,
      event: null,
    });
    expect(cleaned).toEqual({});
  });

  test("preserves non-default search params", () => {
    const cleaned = cleanGameSearchParams({
      range: 1,
      pricerange: 2,
      event: "major-update-123",
    });
    expect(cleaned).toEqual({
      range: 1,
      pricerange: 2,
      event: "major-update-123",
    });
  });

  test("trims and omits empty event id", () => {
    const cleaned = cleanGameSearchParams({
      range: 2,
      pricerange: 4,
      event: "   ",
    });
    expect(cleaned).toEqual({ range: 2 });
  });
});

describe("Event Out-of-Bounds Detection", () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;

  test("detects events within and outside fixed durations", () => {
    const event2HoursAgo = new Date(now - 2 * hourMs).toISOString();
    const event5DaysAgo = new Date(now - 5 * dayMs).toISOString();
    const event20DaysAgo = new Date(now - 20 * dayMs).toISOString();
    const event60DaysAgo = new Date(now - 60 * dayMs).toISOString();
    const event200DaysAgo = new Date(now - 200 * dayMs).toISOString();

    // 24h window
    expect(isEventWithinHistoryRange(event2HoursAgo, "24h", null, null, now)).toBe(true);
    expect(isEventWithinHistoryRange(event5DaysAgo, "24h", null, null, now)).toBe(false);

    // 7d window
    expect(isEventWithinHistoryRange(event5DaysAgo, "7d", null, null, now)).toBe(true);
    expect(isEventWithinHistoryRange(event20DaysAgo, "7d", null, null, now)).toBe(false);

    // 30d window
    expect(isEventWithinHistoryRange(event20DaysAgo, "30d", null, null, now)).toBe(true);
    expect(isEventWithinHistoryRange(event60DaysAgo, "30d", null, null, now)).toBe(false);

    // 90d window
    expect(isEventWithinHistoryRange(event60DaysAgo, "90d", null, null, now)).toBe(true);
    expect(isEventWithinHistoryRange(event200DaysAgo, "90d", null, null, now)).toBe(false);

    // all window
    expect(isEventWithinHistoryRange(event200DaysAgo, "all", null, null, now)).toBe(true);
  });

  test("uses explicit range_start and range_end when provided", () => {
    const start = "2026-08-01T00:00:00.000Z";
    const end = "2026-09-01T00:00:00.000Z";
    const inside = "2026-08-15T12:00:00.000Z";
    const before = "2026-07-31T23:59:59.000Z";
    const after = "2026-09-02T00:00:00.000Z";

    expect(isEventWithinHistoryRange(inside, "30d", start, end)).toBe(true);
    expect(isEventWithinHistoryRange(before, "30d", start, end)).toBe(false);
    expect(isEventWithinHistoryRange(after, "30d", start, end)).toBe(false);
  });
});
