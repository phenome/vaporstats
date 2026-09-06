import {
  formatPriceCents,
  type PriceHistoryEntry,
  type PriceState,
} from "./prices";

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
  if (price.final_price === 0) {
    return price.currency === "USD" ? "$0.00" : `0.00 ${price.currency}`;
  }
  return formatPriceCents(price.final_price, price.currency);
}
