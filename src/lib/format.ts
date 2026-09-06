/**
 * Unified number and currency formatting utilities.
 * Uses Intl.NumberFormat to respect the runtime/browser locale notation for
 * decimals and thousands separators without locking to en-US.
 */

/**
 * Formats a number with browser/runtime default notation for separators and decimals.
 */
export function formatNumber(
  value: number | null | undefined,
  options?: Intl.NumberFormatOptions,
  fallback = "No data"
): string {
  if (value === null || value === undefined || isNaN(value)) return fallback;
  return new Intl.NumberFormat(undefined, options).format(value);
}

/**
 * Formats price in cents into currency notation.
 * If currency is USD, renders as US$ prefix with browser's number notation (decimals, separators).
 */
export function formatPrice(
  cents: number | null | undefined,
  currency = "USD",
  isFree = false
): string {
  if (isFree) return "Free";
  if (cents === null || cents === undefined) return "Unavailable";
  if (cents === 0 && isFree) return "Free";
  const num = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
  return currency === "USD" ? `US$${num}` : `${num} ${currency}`;
}
