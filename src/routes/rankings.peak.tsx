import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  getPeakRankings,
  parseHistoryRange,
  type PeakRankedGame,
  type HistoryRange,
} from "../lib/player-history";
import { PeakRankingsPageView } from "../components/peak-rankings-page";
import { CACHE_POLICIES, getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";

import { RouteDataError, RouteLoading } from "../components/route-state";
import { RankingsSkeleton } from "../components/route-skeletons";

export async function fetchPeakRankings(period: string): Promise<{
  peaks: PeakRankedGame[];
  period: HistoryRange;
}> {
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
}

export function peakRankingsQueryOptions(period: string) {
  const validPeriod = parseHistoryRange(period);
  return {
    queryKey: ["rankings", "peak", validPeriod],
    queryFn: () => fetchPeakRankings(validPeriod),
  };
}
export const Route = createFileRoute("/rankings/peak")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => ({
    period: typeof search.period === "string" ? search.period : "all",
  }),
  loaderDeps: ({ search: { period } }) => ({ period }),
  loader: ({ deps: { period }, context }) => {
    void context.queryClient.prefetchQuery(peakRankingsQueryOptions(period));
    return { period };
  },
  pendingComponent: () => <RouteLoading label="Loading peak rankings..." />,
  errorComponent: RouteDataError,
  component: PeakRankingsRouteComponent,
});

function PeakRankingsRouteComponent() {
  const { period } = Route.useLoaderData();
  const { data, isLoading, isError } = useQuery(peakRankingsQueryOptions(period));

  if (isError) return <RouteDataError />;
  if (isLoading || !data) return <RankingsSkeleton />;

  return <PeakRankingsPageView peaks={data.peaks} period={data.period} />;
}


/**
 * Pure HTTP request handler for /rankings/peak.
 */
export async function handlePeakRankingsHttpRequest(
  request: Request,
  explicitDb?: AppDatabase
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

