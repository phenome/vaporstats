import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { searchCatalog, type SearchCatalogResult } from "../lib/related";
import { SearchResultsPageView } from "../components/search-page";
import { CACHE_POLICIES, getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";

import { RouteDataError, RouteLoading } from "../components/route-state";

export async function fetchSearchResults(query: string): Promise<SearchCatalogResult> {
  const trimmed = query.trim();
  if (!trimmed) return { query: "", items: [], total: 0 };

  const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
  if (!response.ok) throw new Error("Search request failed");
  const result = (await response.json()) as {
    status?: string;
    data?: SearchCatalogResult;
  };
  if (result.status === "error") throw new Error("Search request failed");
  return result.data ?? { query: trimmed, items: [], total: 0 };
}

export function searchQueryOptions(query: string) {
  const trimmed = query.trim();
  return {
    queryKey: ["search", trimmed],
    queryFn: () => fetchSearchResults(trimmed),
  };
}
export const Route = createFileRoute("/search")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  loaderDeps: ({ search: { q } }) => ({ q }),
  loader: ({ deps: { q }, context }) => {
    void context.queryClient.prefetchQuery(searchQueryOptions(q));
    return { q };
  },
  pendingComponent: () => <RouteLoading label="Searching Steam catalog..." />,
  errorComponent: RouteDataError,
  component: SearchRouteComponent,
});



function SearchRouteComponent() {
  const { q } = Route.useLoaderData();
  const { data, isLoading, isError } = useQuery(searchQueryOptions(q));

  if (isError) return <RouteDataError />;
  if (isLoading || !data) return <RouteLoading label="Searching Steam catalog..." />;

  return <SearchResultsPageView query={data.query} results={data} />;
}
/**
 * Pure route HTTP request handler for /search.
 * Supports server-rendered search results and live cache headers.
 */
export async function handleSearchHttpRequest(
  request: Request,
  db: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const trimmed = q.trim();

  const results: SearchCatalogResult = trimmed
    ? await searchCatalog(db, trimmed)
    : { query: "", items: [], total: 0 };

  const appHtml = renderToString(
    <SearchResultsPageView query={trimmed} results={results} />
  );

  const title = trimmed ? `Search: ${trimmed} - VaporStats` : "Search Catalog - VaporStats";

  return new Response(wrapHtml(title, appHtml), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...getLiveApiCacheHeaders(),
    },
  });
}

function wrapHtml(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased font-sans">
  ${bodyContent}
</body>
</html>`;
}
