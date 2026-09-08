export type ReceptionRankingType = "top_rated_now" | "top_rated_all_time";

export interface ReceptionFilters {
  genres: number[];
  features: number[];
  tags: number[];
}

/** Returns canonical filter arrays for URLs, query keys, and domain calls. */
export function normalizeReceptionFilters(
  filters: {
    genres?: readonly unknown[];
    features?: readonly unknown[];
    tags?: readonly unknown[];
  } | null | undefined,
): ReceptionFilters {
  const normalize = (values: readonly unknown[] | null | undefined): number[] =>
    [...new Set((values ?? []).filter((value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    ))].sort((a, b) => a - b);

  return {
    genres: normalize(filters?.genres),
    features: normalize(filters?.features),
    tags: normalize(filters?.tags),
  };
}
