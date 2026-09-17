import {
  formatPriceCents,
  type PriceHistoryEntry,
  type PriceState,
} from "./prices";
import { formatLocalDateTime } from "./format";

export const DEAL_FRESHNESS_MS = 30 * 60 * 1000;

export interface DealTiming {
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number;
  is_free: boolean;
  is_available?: boolean;
  observed_at: string;
  deal_expires_at: string | null;
}

export interface DealPresentation {
  active: boolean;
  effectiveFinalPrice: number | null;
  endLabel: string | null;
  endTitle: string | null;
  nextBoundary: number | null;
}

const durationFormatter = new (
  Intl as typeof Intl & {
    DurationFormat: new (
      locales?: Intl.LocalesArgument,
      options?: { style?: "short" },
    ) => { format(value: { hours?: number; minutes?: number }): string };
  }
).DurationFormat(undefined, { style: "short" });
const endDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const naiveUtcPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

function timestampMs(value: string): number {
  return Date.parse(naiveUtcPattern.test(value) ? value.replace(" ", "T") + "Z" : value);
}

/** Resolves a cached current deal to the state that is safe to present now. */
export function getDealPresentation(
  price: DealTiming | null | undefined,
  now = Date.now(),
): DealPresentation {
  if (
    !price ||
    price.is_available === false ||
    price.is_free ||
    price.discount_percent <= 0 ||
    price.initial_price === null ||
    price.final_price === null ||
    price.final_price >= price.initial_price
  ) {
    return {
      active: false,
      effectiveFinalPrice: price?.final_price ?? null,
      endLabel: null,
      endTitle: null,
      nextBoundary: null,
    };
  }

  const observedAt = timestampMs(price.observed_at);
  const staleAt = observedAt + DEAL_FRESHNESS_MS;
  const expiresAt = price.deal_expires_at ? timestampMs(price.deal_expires_at) : Number.NaN;
  const active =
    Number.isFinite(staleAt) &&
    staleAt > now &&
    (!Number.isFinite(expiresAt) || expiresAt > now);

  if (!active) {
    return {
      active: false,
      effectiveFinalPrice: price.initial_price,
      endLabel: null,
      endTitle: null,
      nextBoundary: null,
    };
  }

  let nextBoundary = Number.isFinite(expiresAt)
    ? Math.min(staleAt, expiresAt)
    : staleAt;
  let endLabel: string | null = null;
  let endTitle: string | null = null;

  if (Number.isFinite(expiresAt)) {
    const remainingMs = expiresAt - now;
    const remainingMinutes = Math.ceil(remainingMs / 60_000);
    if (remainingMs <= 24 * 60 * 60_000) {
      const hours = Math.floor(remainingMinutes / 60);
      const minutes = remainingMinutes % 60;
      endLabel = `Ends in ${durationFormatter.format({
        ...(hours ? { hours } : {}),
        ...(minutes || !hours ? { minutes } : {}),
      })}`;
      nextBoundary = Math.min(
        nextBoundary,
        expiresAt - (remainingMinutes - 1) * 60_000,
      );
    } else {
      endLabel = `Ends ${endDateFormatter.format(expiresAt)}`;
      nextBoundary = Math.min(nextBoundary, expiresAt - 24 * 60 * 60_000);
    }
    endTitle = formatLocalDateTime(new Date(expiresAt));
  }

  return {
    active: true,
    effectiveFinalPrice: price.final_price,
    endLabel,
    endTitle,
    nextBoundary,
  };
}

/** Returns true only for an available, non-free state with an actual price reduction. */
export function isPriceDiscounted(
  price: PriceState | PriceHistoryEntry | null | undefined
): boolean {
  return Boolean(
    price &&
      price.is_available &&
      !price.is_free &&
      price.discount_percent > 0 &&
      price.initial_price !== null &&
      price.final_price !== null &&
      price.final_price < price.initial_price
  );
}

/** Formats the currently available price without confusing a temporary $0 offer for free pricing. */
export function formatCurrentPrice(
  price: PriceState | PriceHistoryEntry | null | undefined
): string {
  if (!price) return "No data yet";
  if (!price.is_available) return "Price unavailable";
  if (price.is_free) return "Free";
  return formatPriceCents(price.final_price, price.currency, price.is_free);
}
