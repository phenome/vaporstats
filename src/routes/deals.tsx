import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getDeals, type DealItem } from "../lib/prices";
import { DealsList } from "../components/deals";
import { getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";
import { RouteDataError } from "../components/route-state";
import { DealsSkeleton } from "../components/route-skeletons";

export interface DealsData {
  deals: DealItem[];
  total: number;
}

export async function fetchDeals(type: string, sort: string): Promise<DealsData> {
  const params = new URLSearchParams({ type, sort, limit: "100" });
  const response = await fetch(`/api/deals?${params}`);
  if (!response.ok) throw new Error("Deals request failed");
  const result = (await response.json()) as {
    status?: string;
    data?: { deals: DealItem[]; total: number };
  };
  if (result.status === "error") throw new Error("Deals request failed");
  return {
    deals: result.data?.deals ?? [],
    total: result.data?.total ?? 0,
  };
}

export function dealsQueryOptions(type: string, sort: string) {
  return {
    queryKey: ["deals", type, sort],
    queryFn: () => fetchDeals(type, sort),
  };
}

export const Route = createFileRoute("/deals")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  loader: ({ location, context }) => {
    const search = location.search as {
      type?: "game" | "dlc" | "expansion" | "all";
      sort?: "discount" | "price" | "recent";
    };
    const type = search.type ?? "all";
    const sort = search.sort ?? "discount";
    // Start unawaited prefetch so navigation/hover proceeds immediately
    void context.queryClient.prefetchQuery(dealsQueryOptions(type, sort));
    return { type, sort };
  },
  errorComponent: RouteDataError,
  component: DealsRouteComponent,
});

function DealsRouteComponent() {
  const { type, sort } = Route.useLoaderData();
  const { data, isLoading, isError } = useQuery(dealsQueryOptions(type, sort));

  if (isLoading || !data) {
    return <DealsSkeleton />;
  }

  if (isError) {
    return <RouteDataError />;
  }

  return (
    <DealsPageView
      deals={data.deals}
      total={data.total}
      currentType={type}
      currentSort={sort}
    />
  );
}

export interface DealsPageViewProps {
  deals?: DealItem[];
  total?: number;
  currentType?: "all" | "game" | "dlc" | "expansion";
  currentSort?: "discount" | "price" | "recent";
}

/**
 * Public deals page presenting discounted playable games, consumer DLC, and expansions.
 * Accessories are excluded from top-level discovery.
 */
export function DealsPageView({
  deals = [],
  total,
  currentType = "all",
  currentSort = "discount",
}: DealsPageViewProps) {
  const count = total ?? deals.length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Top Banner */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-900 pb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 bg-emerald-500 inline-block"></span>
              <span className="text-xs font-mono uppercase tracking-wider text-emerald-400">
                Steam Store Discounts
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-mono font-bold text-zinc-100 tracking-tight">
              Steam Deals & Price Cuts
            </h1>
            <p className="text-xs text-zinc-400 mt-1 font-mono">
              Live discount tracker for playable games, official expansions, and consumer DLC.
            </p>
          </div>

          <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2">
            ACTIVE DEALS: <span className="text-emerald-400 font-bold tabular-nums">{count}</span>
          </div>
        </div>
      </div>

      {/* Deals Listing */}
      <DealsList
        deals={deals}
        total={count}
        currentType={currentType}
        currentSort={currentSort}
      />
    </div>
  );
}

/**
 * Pure HTTP request handler for /deals SSR.
 */
export async function handleDealsHttpRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const rawType = url.searchParams.get("type");
  const rawSort = url.searchParams.get("sort");

  let type: "game" | "dlc" | "expansion" | "all" = "all";
  if (rawType === "game" || rawType === "dlc" || rawType === "expansion") {
    type = rawType;
  }

  let sort: "discount" | "price" | "recent" = "discount";
  if (rawSort === "price" || rawSort === "recent") {
    sort = rawSort;
  }

  const db = await getDb(explicitDb);
  const result = await getDeals(db, { type, sort, limit: 100 });

  const appHtml = renderToString(
    <DealsPageView
      deals={result.deals}
      total={result.total}
      currentType={type}
      currentSort={sort}
    />
  );
  const title = "Steam Deals & Price Cuts - VaporStats";

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

export default DealsPageView;
