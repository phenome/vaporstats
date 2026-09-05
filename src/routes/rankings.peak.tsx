import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { getDb, type D1Database } from "../lib/db";
import {
  getPeakRankings,
  parseHistoryRange,
  type PeakRankedGame,
  type HistoryRange,
} from "../lib/player-history";
import { getCanonicalGamePath } from "../lib/slug";
import { CACHE_POLICIES, getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";

import { RouteDataError, RouteLoading } from "../components/route-state";
export const Route = createFileRoute("/rankings/peak")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => ({
    period: typeof search.period === "string" ? search.period : "all",
  }),
  loaderDeps: ({ search: { period } }) => ({ period }),
  loader: async ({ deps: { period } }) => {
    const validPeriod = parseHistoryRange(period);
    const response = await fetch(
      `/api/rankings?type=peak&period=${encodeURIComponent(validPeriod)}&limit=100`
    );
    if (!response.ok) throw new Error("Peak rankings request failed");
    const result = (await response.json()) as {
      status?: string;
      data?: PeakRankedGame[];
      period?: HistoryRange;
    };
    if (result.status === "error") throw new Error("Peak rankings request failed");
    return {
      peaks: Array.isArray(result.data) ? result.data : [],
      period: result.period ?? validPeriod,
    };
  },
  pendingComponent: () => <RouteLoading label="Loading peak rankings..." />,
  errorComponent: RouteDataError,
  component: PeakRankingsRouteComponent,
});

function PeakRankingsRouteComponent() {
  const data = Route.useLoaderData();
  return <PeakRankingsPageView peaks={data.peaks} period={data.period} />;
}

export interface PeakRankingsPageViewProps {
  peaks?: PeakRankedGame[];
  period?: HistoryRange;
}

export function PeakRankingsPageView({
  peaks = [],
  period = "all",
}: PeakRankingsPageViewProps) {
  const periodOptions: Array<{ id: HistoryRange; label: string }> = [
    { id: "24h", label: "24 Hours" },
    { id: "7d", label: "7 Days" },
    { id: "30d", label: "30 Days" },
    { id: "90d", label: "90 Days" },
    { id: "all", label: "All Time" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Top Banner & Navigation */}
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
              Highest Observed Peak
            </h1>
            <p className="text-xs text-zinc-400 mt-1 font-mono">
              Historical records derived from raw observations and persistent UTC daily rollups.
            </p>
          </div>

          <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2">
            TRACKED: <span className="text-orange-400 font-bold tabular-nums">{peaks.length}</span>
          </div>
        </div>

        {/* Navigation Tabs: Most Played vs Peak */}
        <div className="flex items-center space-x-2 pt-1 border-b border-zinc-800">
          <a
            href="/rankings"
            className="px-4 py-2 min-h-[44px] inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-400 hover:text-zinc-200 border-b-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Most Played
          </a>
          <a
            href="/rankings/peak"
            aria-current="page"
            className="px-4 py-2 min-h-[44px] inline-flex items-center text-xs font-mono uppercase tracking-wider font-semibold border-b-2 border-orange-500 text-orange-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Highest Observed Peak
          </a>
        </div>

        {/* Period selection pills */}
        <div className="pt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-mono text-zinc-500 uppercase tracking-wider mr-1">
            Period:
          </span>
          {periodOptions.map((opt) => {
            const active = period === opt.id;
            return (
              <a
                key={opt.id}
                href={`/rankings/peak?period=${opt.id}`}
                className={`px-3 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-xs font-mono uppercase tracking-wider transition-colors rounded-none border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                  active
                    ? "bg-orange-600 text-white font-semibold border-orange-600"
                    : "bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border-zinc-800"
                }`}
                aria-pressed={active}
              >
                {opt.label}
              </a>
            );
          })}
        </div>
      </div>

      {/* Peak Leaderboard Table */}
      {peaks.length === 0 ? (
        <div
          className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-3 font-mono"
          data-testid="no-peaks-state"
        >
          <div className="text-sm text-zinc-300 font-semibold">No data yet</div>
          <p className="text-xs text-zinc-500 max-w-md mx-auto">
            Awaiting first scheduled player observation probe for tracked playable games.
          </p>
        </div>
      ) : (
        <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto" data-testid="peaks-table-container">
          <table className="w-full text-left text-xs font-mono" aria-label="Highest observed peak rankings">
            <thead className="bg-zinc-900 text-zinc-400 uppercase text-[11px] border-b border-zinc-800">
              <tr>
                <th scope="col" className="px-4 py-3 w-16 text-center">#</th>
                <th scope="col" className="px-4 py-3">Game</th>
                <th scope="col" className="px-4 py-3 text-right">Highest Observed Peak</th>
                <th scope="col" className="px-4 py-3 text-right">Window</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900 text-zinc-300">
              {peaks.map((game) => {
                const canonicalUrl = getCanonicalGamePath(game.appid, game.name);
                return (
                  <tr
                    key={game.appid}
                    className="hover:bg-zinc-900/40 transition-colors"
                    data-testid={`peaks-row-${game.appid}`}
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
                    <td className="px-4 py-3 text-right font-bold text-orange-400 tabular-nums">
                      {game.peak_players.toLocaleString("en-US")}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 uppercase text-[10px]">
                      {periodOptions.find((p) => p.id === game.period)?.label ?? game.period}
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
 * Pure HTTP request handler for /rankings/peak.
 */
export async function handlePeakRankingsHttpRequest(
  request: Request,
  explicitDb?: D1Database
): Promise<Response> {
  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");
  const period = parseHistoryRange(periodParam);

  const db = await getDb(explicitDb);
  const peaks = await getPeakRankings(db, period, { limit: 100 });

  const appHtml = renderToString(<PeakRankingsPageView peaks={peaks} period={period} />);
  const title = `Highest Observed Peak Rankings (${period.toUpperCase()}) - VaporStats`;

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

export default PeakRankingsPageView;
