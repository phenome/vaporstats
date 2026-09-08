import type {
  ReceptionComparisonData,
  ReceptionRankingData,
} from "./rankings";
import {
  normalizeReceptionFilters,
  type ReceptionFilters,
  type ReceptionRankingType,
} from "./reception-filters";
import type { FacetDictionaryEntry } from "./taxonomy";

export interface RankingListQuery {
  type: ReceptionRankingType;
  filters: ReceptionFilters;
  limit: number;
  offset: number;
}

export interface RankingComparisonQuery {
  type: ReceptionRankingType;
  filters: ReceptionFilters;
  appid: number;
}

type ApiEnvelope<T> = {
  status?: "data" | "empty" | "error";
  data?: T;
  message?: string;
};

export function normalizeRankingFilters(filters?: Partial<ReceptionFilters> | null): ReceptionFilters {
  return normalizeReceptionFilters(filters);
}

export function rankingQueryKey(query: RankingListQuery) {
  const normalized = normalizeRankingFilters(query.filters);
  return ["rankings", query.type, {
    genres: normalized.genres,
    features: normalized.features,
    tags: normalized.tags,
    limit: query.limit,
    offset: query.offset,
  }] as const;
}

export function rankingComparisonQueryKey(query: RankingComparisonQuery) {
  const normalized = normalizeRankingFilters(query.filters);
  return ["ranking-comparison", query.type, {
    genres: normalized.genres,
    features: normalized.features,
    tags: normalized.tags,
  }, query.appid] as const;
}

export const catalogFacetsQueryKey = ["catalog-facets"] as const;

function appendFacetParams(params: URLSearchParams, filters: ReceptionFilters): void {
  for (const id of filters.genres) params.append("genre", String(id));
  for (const id of filters.features) params.append("feature", String(id));
  for (const id of filters.tags) params.append("tag", String(id));
}

async function readApi<T>(response: Response, fallback: string): Promise<T> {
  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok || payload.status === "error") {
    throw new Error(payload.message || fallback);
  }
  if (payload.data === undefined) throw new Error(fallback);
  return payload.data;
}

export async function fetchRankings(query: RankingListQuery): Promise<ReceptionRankingData> {
  const normalized = normalizeRankingFilters(query.filters);
  const params = new URLSearchParams({
    type: query.type,
    view: "list",
    limit: String(query.limit),
    offset: String(query.offset),
  });
  appendFacetParams(params, normalized);
  return readApi<ReceptionRankingData>(
    await fetch(`/api/rankings?${params.toString()}`),
    "Rankings request failed",
  );
}

export async function fetchRankingComparison(query: RankingComparisonQuery): Promise<ReceptionComparisonData> {
  const normalized = normalizeRankingFilters(query.filters);
  const params = new URLSearchParams({
    type: query.type,
    view: "comparison",
    appid: String(query.appid),
  });
  appendFacetParams(params, normalized);
  return readApi<ReceptionComparisonData>(
    await fetch(`/api/rankings?${params.toString()}`),
    "Ranking comparison request failed",
  );
}

export async function fetchCatalogFacets(): Promise<FacetDictionaryEntry[]> {
  return readApi<FacetDictionaryEntry[]>(await fetch("/api/facets"), "Facet request failed");
}

export function rankingsQueryOptions(query: RankingListQuery) {
  const normalized = {
    ...query,
    filters: normalizeRankingFilters(query.filters),
  };
  return {
    queryKey: rankingQueryKey(normalized),
    queryFn: () => fetchRankings(normalized),
  };
}

export function rankingComparisonQueryOptions(query: RankingComparisonQuery) {
  const normalized = {
    ...query,
    filters: normalizeRankingFilters(query.filters),
  };
  return {
    queryKey: rankingComparisonQueryKey(normalized),
    queryFn: () => fetchRankingComparison(normalized),
  };
}

export function catalogFacetsQueryOptions() {
  return {
    queryKey: catalogFacetsQueryKey,
    queryFn: fetchCatalogFacets,
  };
}
