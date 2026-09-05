import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  getMostPlayedRankings,
  type RankedGame,
} from "../lib/player-history";
import { getCanonicalGamePath } from "../lib/slug";
import { CACHE_POLICIES, getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";
import { RouteDataError } from "../components/route-state";
import { RankingsSkeleton } from "../components/route-skeletons";

export async function fetchMostPlayedRankings(): Promise<{ games: RankedGame[] }> {
  const response = await fetch("/api/rankings?type=most_played&limit=100");
  if (!response.ok) throw new Error("Rankings request failed");
  const result = (await response.json()) as { status?: string; data?: RankedGame[] };
  if (result.status === "error") throw new Error("Rankings request failed");
  return { games: Array.isArray(result.data) ? result.data : [] };
}

export const rankingsQueryOptions = {
  queryKey: ["rankings", "most_played"],
  queryFn: fetchMostPlayedRankings,
};

export const Route = createFileRoute("/rankings/")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  loader: ({ context }) => {
    // Start unawaited prefetch so navigation/hover proceeds immediately
    void context.queryClient.prefetchQuery(rankingsQueryOptions);
  },
  errorComponent: RouteDataError,
  component: RankingsRouteComponent,
});

function RankingsRouteComponent() {
  const { data, isLoading, isError } = useQuery(rankingsQueryOptions);

  if (isLoading || !data) {
    return <RankingsSkeleton />;
  }

  if (isError) {
    return <RouteDataError />;
  }

  return <RankingsPageView games={data.games} />;
}
export interface RankingsPageViewProps {
  games?: RankedGame[];
}

export function RankingsPageView({ games = [] }: RankingsPageViewProps) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Top Banner & Mode Switcher */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-900 pb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 bg-orange-500 inline-block"></span>
              <span className="text-xs font-mono uppercase tracking-wider text-orange-400">
                Steam Player Rankings
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-mono font-bold text-zinc-100 tracking-tight">
              Most Played Games
            </h1>
            <p className="text-xs text-zinc-400 mt-1 font-mono">
              Live leaderboard ordered by latest successful player count.
            </p>
          </div>

          <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2">
            TRACKED: <span className="text-orange-400 font-bold tabular-nums">{games.length}</span>
          </div>
        </div>

        {/* Navigation Tabs: Most Played vs Peak */}
        <div className="flex items-center space-x-2 pt-1 border-b border-zinc-800">
          <a
            href="/rankings"
            aria-current="page"
            className="px-4 py-2 min-h-[44px] inline-flex items-center text-xs font-mono uppercase tracking-wider font-semibold border-b-2 border-orange-500 text-orange-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Most Played
          </a>
          <a
            href="/rankings/peak"
            className="px-4 py-2 min-h-[44px] inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-400 hover:text-zinc-200 border-b-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Highest Observed Peak
          </a>
        </div>
      </div>

      {/* Leaderboard Table */}
      {games.length === 0 ? (
        <div
          className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-3 font-mono"
          data-testid="no-rankings-state"
        >
          <div className="text-sm text-zinc-300 font-semibold">No data yet</div>
          <p className="text-xs text-zinc-500 max-w-md mx-auto">
            Awaiting first scheduled player observation probe for tracked playable games.
          </p>
        </div>
      ) : (
        <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto" data-testid="rankings-table-container">
          <table className="w-full text-left text-xs font-mono" aria-label="Most played games rankings">
            <thead className="bg-zinc-900 text-zinc-400 uppercase text-[11px] border-b border-zinc-800">
              <tr>
                <th scope="col" className="px-4 py-3 w-16 text-center">#</th>
                <th scope="col" className="px-4 py-3">Game</th>
                <th scope="col" className="px-4 py-3 text-right">Current Players</th>
                <th scope="col" className="px-4 py-3 text-right">Last Updated</th>
                <th scope="col" className="px-4 py-3 text-right whitespace-nowrap">Exact UTC Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900 text-zinc-300">
              {games.map((game) => {
                const canonicalUrl = getCanonicalGamePath(game.appid, game.name);
                return (
                  <tr
                    key={game.appid}
                    className="hover:bg-zinc-900/40 transition-colors"
                    data-testid={`rankings-row-${game.appid}`}
                  >
                    <td className="px-4 py-3 text-center text-zinc-500 font-bold tabular-nums">
                      {game.rank}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <a
                        href={canonicalUrl}
                        className="text-zinc-100 hover:text-orange-400 transition-colors min-h-[44px] inline-flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                      >
                        {game.name}
                      </a>
                      <span className="text-[10px] text-zinc-600 block sm:inline sm:ml-2">
                        #{game.appid}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-zinc-100 tabular-nums">
                      {game.current_players !== null
                        ? game.current_players.toLocaleString("en-US")
                        : "No data"}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400 tabular-nums">
                      {game.relative_age}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 tabular-nums text-[11px] whitespace-nowrap">
                      {game.exact_utc}
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

/**
 * Pure HTTP request handler for /rankings.
 */
export async function handleRankingsHttpRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const db = await getDb(explicitDb);
  const games = await getMostPlayedRankings(db, { limit: 100 });

  const appHtml = renderToString(<RankingsPageView games={games} />);
  const title = "Most Played Games Rankings - VaporStats";

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased font-sans">
  ${appHtml}
</body>
</html>`;

  return new Response(fullHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...getLiveApiCacheHeaders(),
    },
  });
}

export default RankingsPageView;
