import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getReceptionRankings } from "../lib/rankings";
import { normalizeReceptionFilters, type ReceptionFilters, type ReceptionRankingType } from "../lib/reception-filters";
import { listFacetDictionary } from "../lib/taxonomy";
import { getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";
import { RouteDataError } from "../components/route-state";
import { RankingsSkeleton } from "../components/route-skeletons";
import { RankingsPageView, type RankingsPageNavigation } from "../components/rankings-page";
import { catalogFacetsQueryOptions, rankingsQueryOptions } from "../lib/rankings-query";

const DEFAULT_LIMIT = 25;

type RankingsSearch = {
  type: ReceptionRankingType;
  genre: number[];
  feature: number[];
  tag: number[];
  limit: number;
  offset: number;
};

function positiveIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  const ids = values.flatMap((entry) => {
    const parts = typeof entry === "string" ? entry.split(",") : [entry];
    return parts.flatMap((part) => {
      const id = typeof part === "number" ? part : typeof part === "string" && /^[1-9]\d*$/.test(part) ? Number(part) : NaN;
      return Number.isSafeInteger(id) && id > 0 ? [id] : [];
    });
  });
  return [...new Set(ids)].sort((a, b) => a - b);
}

function boundedInteger(value: unknown, fallback: number, maximum?: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || (maximum !== undefined && parsed > maximum)) return fallback;
  return parsed;
}

function rankingSearch(search: Record<string, unknown>): RankingsSearch {
  const type = search.type === "top_rated_all_time" ? "top_rated_all_time" : "top_rated_now";
  return {
    type,
    genre: positiveIds(search.genre),
    feature: positiveIds(search.feature),
    tag: positiveIds(search.tag),
    limit: Math.max(1, boundedInteger(search.limit, DEFAULT_LIMIT, 100)),
    offset: boundedInteger(search.offset, 0),
  };
}

function filtersFromSearch(search: RankingsSearch): ReceptionFilters {
  return normalizeReceptionFilters({ genres: search.genre, features: search.feature, tags: search.tag });
}

function requestState(request: Request): RankingsSearch {
  const url = new URL(request.url);
  return rankingSearch({
    type: url.searchParams.get("type") ?? undefined,
    genre: url.searchParams.getAll("genre"),
    feature: url.searchParams.getAll("feature"),
    tag: url.searchParams.getAll("tag"),
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });
}

function nextSearch(current: RankingsSearch, next: RankingsPageNavigation): RankingsSearch {
  const currentFilters = filtersFromSearch(current);
  const filters = normalizeReceptionFilters({
    genres: next.filters?.genres ?? currentFilters.genres,
    features: next.filters?.features ?? currentFilters.features,
    tags: next.filters?.tags ?? currentFilters.tags,
  });
  return {
    type: next.type ?? current.type,
    genre: filters.genres,
    feature: filters.features,
    tag: filters.tags,
    limit: current.limit,
    offset: next.offset ?? current.offset,
  };
}

export const Route = createFileRoute("/rankings/")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => rankingSearch(search),
  search: {
    middlewares: [
      stripSearchParams({
        type: "top_rated_now",
        genre: [],
        feature: [],
        tag: [],
        limit: DEFAULT_LIMIT,
        offset: 0,
      }),
    ],
  },
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps: { search }, context }) => {
    const filters = filtersFromSearch(search);
    void context.queryClient.prefetchQuery(rankingsQueryOptions({ type: search.type, filters, limit: search.limit, offset: search.offset }));
    void context.queryClient.prefetchQuery(catalogFacetsQueryOptions());
  },
  errorComponent: RouteDataError,
  component: RankingsRouteComponent,
});

function RankingsRouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const filters = filtersFromSearch(search);
  const rankingQuery = rankingsQueryOptions({ type: search.type, filters, limit: search.limit, offset: search.offset });
  const ranking = useQuery(rankingQuery);
  const facets = useQuery(catalogFacetsQueryOptions());
  if (ranking.isError) return <RouteDataError />;
  if (!ranking.data) return <RankingsSkeleton />;
  const onNavigate = (next: RankingsPageNavigation) => {
    const target = nextSearch(search, next);
    void navigate({ search: target });
  };
  return <RankingsPageView data={ranking.data} facets={facets.data ?? []} activeType={search.type} activeFilters={filters} activeOffset={search.offset} isFetching={ranking.isFetching} onNavigate={onNavigate} />;
}

/** Pure HTTP request handler for the standalone rankings document. */
export async function handleRankingsHttpRequest(request: Request, explicitDb?: AppDatabase): Promise<Response> {
  const db = await getDb(explicitDb);
  const search = requestState(request);
  const filters = filtersFromSearch(search);
  const [ranking, facets] = await Promise.all([
    getReceptionRankings(db, { type: search.type, filters, limit: search.limit, offset: search.offset }),
    listFacetDictionary(db),
  ]);
  if (!ranking.data) throw new Error("Rankings request failed");
  const appHtml = renderToString(<RankingsPageView data={ranking.data} facets={facets} />);
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Top Rated Games Rankings - VaporStats</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased font-sans">
  ${appHtml}
</body>
</html>`;
  return new Response(fullHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...getLiveApiCacheHeaders() } });
}
