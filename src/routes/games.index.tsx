import React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { type CatalogEntity } from "../lib/catalog";
import { normalizeMediaTag } from "../lib/media-overview";
import { getCanonicalGamePath, getCanonicalPublisherPath } from "../lib/slug";
import { getPageCacheHeaders } from "../lib/cache";
import { RouteDataError } from "../components/route-state";
import { CatalogSkeleton } from "../components/route-skeletons";
import { AppLink } from "../components/app-link";

export async function fetchCatalogGames(mediaTag?: string | null): Promise<CatalogEntity[]> {
  const params = new URLSearchParams({ limit: "500" });
  if (mediaTag) params.set("media_tag", mediaTag);
  const response = await fetch(`/api/catalog?${params.toString()}`);
  if (!response.ok) throw new Error("Catalog request failed");
  const result = (await response.json()) as {
    status?: string;
    data?: CatalogEntity[];
  };
  if (result.status === "error") throw new Error("Catalog request failed");
  return Array.isArray(result.data) ? result.data : [];
}

export function catalogQueryOptions(mediaTag?: string | null) {
  const normalizedTag = mediaTag ? normalizeMediaTag(mediaTag) : null;
  return {
    queryKey: ["catalog-games", normalizedTag?.slug ?? null],
    queryFn: () => fetchCatalogGames(normalizedTag?.label ?? null),
  };
}

export const Route = createFileRoute("/games/")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => {
    const normalized = typeof search.mediaTag === "string" ? normalizeMediaTag(search.mediaTag) : null;
    return { mediaTag: normalized?.label ?? null };
  },
  loaderDeps: ({ search }) => ({ mediaTag: search.mediaTag }),
  loader: ({ context, deps }) => {
    // Start unawaited prefetch so navigation/hover proceeds immediately
    void context.queryClient.prefetchQuery(catalogQueryOptions(deps.mediaTag));
  },
  errorComponent: RouteDataError,
  component: GamesRouteView,
});

function GamesIndexComponent({ games: propGames }: { games?: CatalogEntity[] }) {
  const { mediaTag } = Route.useSearch();
  const selectedTag = mediaTag ? normalizeMediaTag(mediaTag) : null;
  const queryOptions = catalogQueryOptions(selectedTag?.label ?? null);
  const { data: queryGames, isLoading, isError } = useQuery({
    ...queryOptions,
    enabled: !propGames,
  });

  if (!propGames && isError) {
    return <RouteDataError />;
  }

  if (!propGames && (isLoading || !queryGames)) {
    return <CatalogSkeleton />;
  }

  const games = propGames ?? queryGames ?? [];
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      <div className="border border-zinc-800 bg-zinc-950 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 bg-orange-500"></span>
            <span className="text-[11px] font-mono uppercase tracking-widest text-orange-400">
              Steam Game Catalog
            </span>
          </div>
          <h1 className="text-2xl font-mono font-bold text-white tracking-tight">
            Playable Games
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Primary game catalog. DLC, expansions, and dedicated server tools are listed under their parent games.
          </p>
        </div>

        <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2">
          TRACKED PLAYABLE: <span className="text-orange-400 font-bold tabular-nums">{games.length}</span>
        </div>
      </div>
      {selectedTag && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-orange-900/60 bg-orange-950/20 px-4 py-3 text-xs">
          <p className="text-zinc-300">
            Showing games tagged <span className="font-semibold text-orange-300">{selectedTag.label}</span>
          </p>
          <AppLink
            href="/games/"
            aria-label="Clear media tag filter"
            className="inline-flex min-h-[32px] items-center border border-zinc-700 px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-300 transition-colors hover:border-orange-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Clear filter
          </AppLink>
        </div>
      )}


      {games.length === 0 ? (
        <div className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-3">
          <div className="text-sm font-mono text-zinc-400">
            {selectedTag ? `No playable games match the “${selectedTag.label}” media tag.` : "No games imported yet."}
          </div>
          <p className="text-xs text-zinc-600">
            {selectedTag
              ? "Try another media tag or clear the filter to browse the full catalog."
              : "Initial catalog seeding will populate eligible playable titles."}
          </p>
        </div>
      ) : (
        <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400">
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider w-24">AppID</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider">Game Title</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider hidden sm:table-cell">Developer</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider hidden md:table-cell">Released</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {games.map((game: CatalogEntity) => {
                const canonicalUrl = getCanonicalGamePath(game.appid, game.name);
                return (
                  <tr
                    key={game.appid}
                    className="hover:bg-zinc-900/40 transition-colors group"
                  >
                    <td className="py-3 px-4 text-zinc-500 tabular-nums">
                      {game.appid}
                    </td>
                    <td className="py-3 px-4 font-medium text-zinc-200 group-hover:text-orange-400 transition-colors">
                      <AppLink href={canonicalUrl} className="hover:underline">
                        {game.name}
                      </AppLink>
                    </td>
                    <td className="py-3 px-4 text-zinc-400 hidden sm:table-cell truncate max-w-xs">
                      {game.developer ? (
                        <AppLink
                          href={getCanonicalPublisherPath(game.developer)}
                          className="hover:text-orange-400 hover:underline transition-colors"
                        >
                          {game.developer}
                        </AppLink>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-3 px-4 text-zinc-500 hidden md:table-cell">
                      {game.release_date || "—"}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <AppLink
                        href={canonicalUrl}
                        className="px-2.5 py-1 text-[11px] bg-zinc-900 hover:bg-orange-500 hover:text-white border border-zinc-800 text-zinc-300 transition-colors"
                      >
                        View Game
                      </AppLink>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GamesRouteView() {
  return <GamesIndexComponent />;
}
