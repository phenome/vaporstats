import { useEffect, useState } from "react";
import { getDealPresentation, type DealTiming } from "./price-presentation";

/** Rerenders once at the next deal expiry or freshness boundary, with no idle interval. */
export function useDealClock(prices: readonly (DealTiming | null | undefined)[]): number {
  const [now, setNow] = useState(() => Date.now());
  let nextBoundary: number | null = null;

  for (const price of prices) {
    const boundary = getDealPresentation(price, now).nextBoundary;
    if (boundary !== null && (nextBoundary === null || boundary < nextBoundary)) {
      nextBoundary = boundary;
    }
  }

  useEffect(() => {
    if (nextBoundary === null) return;
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextBoundary - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [nextBoundary]);

  return now;
}
