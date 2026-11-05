import { useHydrated } from "@tanstack/react-router";
import { formatDateOnly } from "../lib/format";

/** Keep SSR deterministic, then use the browser's locale after hydration. */
export function ReleaseDate({ value }: { value: string | null | undefined }) {
  const hydrated = useHydrated();
  if (!value) return <>—</>;
  // Month/year windows and source labels must not acquire an invented day.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return <>{value}</>;
  return <time dateTime={value}>{hydrated ? formatDateOnly(value, value) : value}</time>;
}
