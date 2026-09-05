import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  searchCatalog,
  type SearchCatalogResult,
  type SearchItem,
  type RelatedAppEntity,
  getCanonicalChildPath,
} from "../lib/related";
import { getCanonicalGamePath, getCanonicalPublisherPath, toSlug } from "../lib/slug";
import { CACHE_POLICIES, getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";
import { SearchForm } from "../components/search-form";

import { RouteDataError, RouteLoading } from "../components/route-state";
export const Route = createFileRoute("/search")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  loaderDeps: ({ search: { q } }) => ({ q }),
  loader: async ({ deps: { q } }) => {
    const trimmed = (q || "").trim();
    if (!trimmed) {
      return { query: "", items: [], total: 0 };
    }
    const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
    if (!response.ok) throw new Error("Search request failed");
    const result = (await response.json()) as {
      status?: string;
      data?: SearchCatalogResult;
    };
    if (result.status === "error") throw new Error("Search request failed");
    return result.data ?? { query: trimmed, items: [], total: 0 };
  },
  pendingComponent: () => <RouteLoading label="Searching Steam catalog..." />,
  errorComponent: RouteDataError,
  component: SearchRouteComponent,
});

function SearchRouteComponent() {
  const results = Route.useLoaderData();
  return <SearchResultsPageView query={results.query} results={results} />;
}

export interface SearchResultsPageViewProps {
  query: string;
  results: SearchCatalogResult;
}

export function SearchResultsPageView({ query, results }: SearchResultsPageViewProps) {
  const hasQuery = query.trim().length > 0;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6 font-mono">
      {/* Search Header & Form */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
          <h1 className="text-sm font-bold uppercase tracking-wider text-zinc-100">
            Catalog Search
          </h1>
          <span className="text-xs text-zinc-500 uppercase">
            Playable-first hierarchy
          </span>
        </div>

        <SearchForm initialQuery={query} size="large" />

        <div className="text-[11px] text-zinc-500 leading-relaxed">
          Search matches playable games first. DLC, expansions, soundtracks, and servers appear grouped beneath their parent title.
        </div>
      </div>

      {/* Results Deck */}
      {!hasQuery ? (
        <div className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-2">
          <div className="text-sm text-zinc-300">Enter a game name or numeric AppID above</div>
          <p className="text-xs text-zinc-600 max-w-md mx-auto">
            VaporStats indexes playable Steam games and groups subordinate content under each root title.
          </p>
        </div>
      ) : results.items.length === 0 ? (
        <div className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-3">
          <div className="text-base text-zinc-300">No results found for &ldquo;{query}&rdquo;</div>
          <p className="text-xs text-zinc-600 max-w-md mx-auto">
            No matching playable games or related apps cataloged yet. Try searching by numeric Steam AppID.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-zinc-500 border-b border-zinc-900 pb-2">
            <div>
              RESULTS FOR &ldquo;<span className="text-zinc-200">{query}</span>&rdquo;
            </div>
            <div className="tabular-nums">
              <span className="text-orange-400 font-bold">{results.total}</span> PLAYABLE PARENT{results.total === 1 ? "" : "S"} MATCHED
            </div>
          </div>

          <div className="space-y-4">
            {results.items.map((item) => (
              <SearchResultCard key={item.game.appid} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchResultCard({ item }: { item: SearchItem }) {
  const gameUrl = getCanonicalGamePath(item.game.appid, item.game.name);

  return (
    <article
      aria-label={`Search result: ${item.game.name}`}
      className="border border-zinc-800 bg-zinc-950 p-5 space-y-4 hover:border-zinc-700 transition-colors"
    >
      {/* Primary Playable Game Match */}
      <div className="flex flex-col sm:flex-row gap-4 items-start justify-between">
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-zinc-800 text-zinc-200 border border-zinc-700">
              Playable Game
            </span>
            <span className="text-xs text-zinc-500 tabular-nums">
              #{item.game.appid}
            </span>
          </div>

          <h2 className="text-base sm:text-lg font-bold">
            <a
              href={gameUrl}
              className="text-zinc-100 hover:text-orange-400 transition-colors min-h-[44px] inline-flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {item.game.name}
            </a>
          </h2>

          {item.game.description && (
            <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
              {item.game.description}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-500 pt-1">
            {item.game.release_date && (
              <div>
                RELEASE: <span className="text-zinc-300">{item.game.release_date}</span>
              </div>
            )}
            {item.game.developer && (
              <div>
                DEV:{" "}
                <a
                  href={getCanonicalPublisherPath(item.game.developer)}
                  className="text-zinc-300 hover:text-orange-400 hover:underline transition-colors"
                >
                  {item.game.developer}
                </a>
              </div>
            )}
          </div>
        </div>

        {item.game.header_image && (
          <a href={gameUrl} className="shrink-0 hidden sm:block">
            <img
              src={item.game.header_image}
              alt=""
              className="w-32 h-16 object-cover border border-zinc-800"
              loading="lazy"
            />
          </a>
        )}
      </div>

      {/* Nested Matching Related Apps */}
      {item.matching_related.length > 0 && (
        <div className="border-t border-zinc-900 pt-3 space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-orange-500 inline-block"></span>
            Matching Related Content ({item.matching_related.length})
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {item.matching_related.map((child: RelatedAppEntity) => {
              const childUrl = getCanonicalChildPath(
                item.game.appid,
                item.game.name,
                child.appid,
                child.name
              );
              const isExpansion = child.type === "expansion" || child.prominence > 0;

              return (
                <a
                  key={child.appid}
                  href={childUrl}
                  className={`group flex items-center justify-between gap-2 p-2 border min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                    isExpansion
                      ? "border-orange-500/40 bg-orange-950/10 hover:border-orange-500"
                      : "border-zinc-800/80 bg-zinc-900/40 hover:border-zinc-700"
                  } transition-colors`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`px-1 py-0.2 text-[9px] uppercase font-bold border ${
                          isExpansion
                            ? "bg-orange-500/20 text-orange-400 border-orange-500/40"
                            : "bg-zinc-800 text-zinc-300 border-zinc-700"
                        }`}
                      >
                        {isExpansion ? "Expansion" : child.type}
                      </span>
                      <span className="text-[10px] text-zinc-500 tabular-nums">
                        #{child.appid}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-300 group-hover:text-orange-400 truncate transition-colors">
                      {child.name}
                    </div>
                  </div>
                  {child.release_date && (
                    <div className="text-[10px] text-zinc-500 tabular-nums shrink-0 hidden sm:block">
                      {child.release_date}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
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
