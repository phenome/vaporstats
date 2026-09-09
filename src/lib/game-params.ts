import type { HistoryRange } from "./player-history";
import type { PriceHistoryRange } from "./prices";

export type NumericRange = 1 | 2 | 3 | 4 | 5;
export type NumericPriceRange = 1 | 2 | 3 | 4;

export const DEFAULT_NUMERIC_RANGE: NumericRange = 3; // "30d"
export const DEFAULT_NUMERIC_PRICE_RANGE: NumericPriceRange = 4; // "all"

export const NUMERIC_TO_HISTORY_RANGE: Record<NumericRange, HistoryRange> = {
  1: "24h",
  2: "7d",
  3: "30d",
  4: "90d",
  5: "all",
};

export const HISTORY_TO_NUMERIC_RANGE: Record<HistoryRange, NumericRange> = {
  "24h": 1,
  "7d": 2,
  "30d": 3,
  "90d": 4,
  all: 5,
};

export const NUMERIC_TO_PRICE_RANGE: Record<NumericPriceRange, PriceHistoryRange> = {
  1: "30d",
  2: "6m",
  3: "1y",
  4: "all",
};

export const PRICE_TO_NUMERIC_RANGE: Record<PriceHistoryRange, NumericPriceRange> = {
  "30d": 1,
  "6m": 2,
  "1y": 3,
  all: 4,
};

export function parseNumericRange(value: unknown): NumericRange {
  let num: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    num = Math.floor(value);
  } else if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) num = Math.floor(parsed);
  }
  if (num !== null && num >= 1 && num <= 5) {
    return num as NumericRange;
  }
  return DEFAULT_NUMERIC_RANGE;
}

export function parseNumericPriceRange(value: unknown): NumericPriceRange {
  let num: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    num = Math.floor(value);
  } else if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) num = Math.floor(parsed);
  }
  if (num !== null && num >= 1 && num <= 4) {
    return num as NumericPriceRange;
  }
  return DEFAULT_NUMERIC_PRICE_RANGE;
}

const RANGE_DURATIONS_MS: Record<HistoryRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
};

/**
 * Checks whether an event timestamp falls within the boundaries of a given history range.
 */
export function isEventWithinHistoryRange(
  eventTime: string | number,
  range: HistoryRange,
  rangeStart?: string | null,
  rangeEnd?: string | null,
  now = Date.now(),
): boolean {
  if (range === "all") return true;

  const timestamp = typeof eventTime === "number" ? eventTime : Date.parse(eventTime);
  if (!Number.isFinite(timestamp)) return false;

  const startMs = rangeStart ? Date.parse(rangeStart) : NaN;
  const endMs = rangeEnd ? Date.parse(rangeEnd) : NaN;

  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    return timestamp >= startMs && timestamp <= endMs;
  }

  const duration = RANGE_DURATIONS_MS[range];
  const windowStart = now - duration;
  return timestamp >= windowStart && timestamp <= now;
}

export interface CleanGameSearchParamsInput {
  range?: NumericRange | null;
  pricerange?: NumericPriceRange | null;
  event?: string | null;
}

export interface CleanGameSearchParamsOutput {
  range?: number;
  pricerange?: number;
  event?: string;
}

/**
 * Normalizes game page search params for clean URLs,
 * omitting range=3 (30d default) and pricerange=4 (all default).
 */
export function cleanGameSearchParams(
  input: CleanGameSearchParamsInput,
): CleanGameSearchParamsOutput {
  const output: CleanGameSearchParamsOutput = {};

  if (input.range !== undefined && input.range !== null && input.range !== DEFAULT_NUMERIC_RANGE) {
    output.range = input.range;
  }

  if (
    input.pricerange !== undefined &&
    input.pricerange !== null &&
    input.pricerange !== DEFAULT_NUMERIC_PRICE_RANGE
  ) {
    output.pricerange = input.pricerange;
  }

  if (input.event && typeof input.event === "string" && input.event.trim().length > 0) {
    output.event = input.event.trim();
  }

  return output;
}
