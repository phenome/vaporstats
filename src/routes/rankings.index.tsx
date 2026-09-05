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
import { getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";
import { RouteDataError } from "../components/route-state";
import { RankingsSkeleton } from "../components/route-skeletons";
import { RankingsPageView } from "../components/rankings-page";

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

  if (isError) {
    return <RouteDataError />;
  }

  if (isLoading || !data) {
    return <RankingsSkeleton />;
  }

  return <RankingsPageView games={data.games} />;
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

