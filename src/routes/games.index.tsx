import React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { listPlayableGames, type CatalogEntity } from "../lib/catalog";
import { getDb } from "../lib/db";
import { getCanonicalGamePath } from "../lib/slug";
import { getLiveApiCacheHeaders } from "../lib/cache";
import { RouteDataError, RouteLoading } from "../components/route-state";

export const Route = createFileRoute("/games/")({
  ssr: false,
  headers: () => getLiveApiCacheHeaders(),
  loader: async () => {
    const response = await fetch("/api/catalog?limit=500");
    if (!response.ok) throw new Error("Catalog request failed");
    const result = (await response.json()) as {
      status?: string;
      data?: CatalogEntity[];
    };
    if (result.status === "error") throw new Error("Catalog request failed");
    return { games: Array.isArray(result.data) ? result.data : [] };
  },
  pendingComponent: () => <RouteLoading label="Loading playable games..." />,
  errorComponent: RouteDataError,
  component: GamesRouteView,
});

export function GamesIndexComponent({ games: propGames }: { games?: CatalogEntity[] }) {
  const loaderData = !propGames ? Route.useLoaderData() : null;
  const games = propGames ?? loaderData?.games ?? [];

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

      {games.length === 0 ? (
        <div className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-3">
          <div className="text-sm font-mono text-zinc-400">No games imported yet.</div>
          <p className="text-xs text-zinc-600">
            Initial catalog seeding will populate eligible playable titles.
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
                      <a href={canonicalUrl} className="hover:underline">
                        {game.name}
                      </a>
                    </td>
                    <td className="py-3 px-4 text-zinc-400 hidden sm:table-cell truncate max-w-xs">
                      {game.developer || "—"}
                    </td>
                    <td className="py-3 px-4 text-zinc-500 hidden md:table-cell">
                      {game.release_date || "—"}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <a
                        href={canonicalUrl}
                        className="px-2.5 py-1 text-[11px] bg-zinc-900 hover:bg-orange-500 hover:text-white border border-zinc-800 text-zinc-300 transition-colors"
                      >
                        View Game
                      </a>
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
