import { formatNumber } from "../lib/format";
import React, { useState, useEffect } from "react";
import { AppLink } from "./app-link";
import type { RankedGame } from "../lib/player-history";
import { getCanonicalGamePath } from "../lib/slug";

export interface TrendingProps {
  initialGames?: RankedGame[];
  customFetch?: typeof fetch;
}

/**
 * Reusable home Trending block.
 * Renders exactly the top ten tracked playable games by latest successful player count.
 * Links directly to /rankings (Most Played).
 * Strictly avoids momentum metrics, minimum-player floors, and separate trending routes.
 */
export function TrendingBlock({ initialGames, customFetch }: TrendingProps) {
  const [games, setGames] = useState<RankedGame[]>(initialGames?.slice(0, 10) ?? []);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    initialGames ? "success" : "idle"
  );

  useEffect(() => {
    if (!initialGames) {
      setStatus("loading");
      const fetchFn = customFetch ?? fetch;
      fetchFn("/api/rankings?type=trending")
        .then((res) => {
          if (!res.ok) throw new Error("Fetch failed");
          return res.json() as Promise<{ status?: string; data?: RankedGame[] }>;
        })
        .then((json) => {
          if (json.status === "data" && Array.isArray(json.data)) {
            setGames(json.data.slice(0, 10));
            setStatus("success");
          } else {
            setGames([]);
            setStatus("success");
          }
        })
        .catch(() => {
          setStatus("error");
        });
    }
  }, [initialGames, customFetch]);

  return (
    <div
      className="border border-zinc-800 bg-zinc-950 p-6 space-y-4 w-full"
      data-testid="trending-block"
    >
      {/* Header section with link to full rankings */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 bg-orange-500 inline-block"></span>
          <div>
            <h2 className="text-sm font-mono font-bold uppercase tracking-wider text-zinc-100">
              Trending
            </h2>
            <p className="text-[11px] font-mono text-zinc-400">
              Top 10 tracked games by latest player activity
            </p>
          </div>
        </div>

        <div>
          <AppLink
            href="/rankings"
            data-testid="trending-rankings-link"
            className="text-xs font-mono text-orange-400 hover:text-orange-300 font-medium transition-colors inline-flex items-center gap-1 min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <span>View Full Rankings</span>
            <span>&rarr;</span>
          </AppLink>
        </div>
      </div>

      {/* Content states */}
      {status === "loading" && (
        <div className="py-8 text-center font-mono text-xs text-zinc-500">
          Loading trending games...
        </div>
      )}

      {status === "error" && (
        <div className="py-8 text-center font-mono text-xs text-amber-500/80">
          Live data unavailable
        </div>
      )}

      {status === "success" && games.length === 0 && (
        <div className="py-8 text-center font-mono text-xs text-zinc-500 space-y-1">
          <div className="text-zinc-300 font-semibold">No data yet</div>
          <div>Awaiting first scheduled player observation probe.</div>
        </div>
      )}

      {status === "success" && games.length > 0 && (
        <div className="overflow-x-auto">
          <ol className="divide-y divide-zinc-900 list-none p-0 m-0">
            {games.map((game, index) => {
              const canonicalUrl = getCanonicalGamePath(game.appid, game.name);
              const rankDisplay = String(index + 1).padStart(2, "0");

              return (
                <li
                  key={game.appid}
                  className="py-2.5 flex items-center justify-between gap-4 hover:bg-zinc-900/30 transition-colors px-2"
                >
                  {/* Rank and Title */}
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-xs font-bold text-zinc-500 tabular-nums w-6">
                      {rankDisplay}
                    </span>
                    <AppLink
                      href={canonicalUrl}
                      className="font-mono text-xs text-zinc-200 hover:text-orange-400 font-medium truncate transition-colors min-h-[44px] inline-flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                    >
                      {game.name}
                    </AppLink>
                  </div>

                  {/* Player Count and Freshness */}
                  <div className="flex items-center gap-4 shrink-0 text-right font-mono text-xs">
                    <div>
                      <span className="text-zinc-100 font-bold tabular-nums block">
                        {formatNumber(game.current_players)}
                      </span>
                      <span className="text-[10px] text-zinc-500 block">
                        {game.relative_age}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

export default TrendingBlock;
