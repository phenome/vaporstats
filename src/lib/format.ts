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

/**
 * Matches SQLite CURRENT_TIMESTAMP output ("YYYY-MM-DD HH:mm:ss[.fff]")
 * which records UTC without an explicit offset.
 */
const naiveUtcPattern = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Parses a stored observation timestamp as the UTC instant it records.
 * Explicit-offset ISO strings parse as-is; naive space-separated SQLite
 * timestamps are normalized to UTC so browsers in any zone read the same
 * instant the server recorded.
 */
function parseStoredTimestamp(value: string): Date {
  return new Date(naiveUtcPattern.test(value) ? value.replace(" ", "T") + "Z" : value);
}

/**
 * Formats an observation instant in the visitor's locale and time zone,
 * using the runtime default notation like the number/currency formatters.
 */
export function formatLocalDateTime(
  value: string | Date | null | undefined,
  fallback = "No data yet"
): string {
  if (!value) return fallback;
  const date = typeof value === "string" ? parseStoredTimestamp(value) : value;
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
