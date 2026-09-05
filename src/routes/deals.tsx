import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getDeals, type DealItem } from "../lib/prices";
import { DealsPageView } from "../components/deals-page";
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

type DealFilters = {
  type: "all" | "game" | "dlc" | "expansion";
  sort: "discount" | "price" | "recent";
};

export const Route = createFileRoute("/deals")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>): DealFilters => ({
    type:
      search.type === "game" || search.type === "dlc" || search.type === "expansion"
        ? search.type
        : "all",
    sort: search.sort === "price" || search.sort === "recent" ? search.sort : "discount",
  }),
  loaderDeps: ({ search: { type, sort } }) => ({ type, sort }),
  loader: ({ deps: { type, sort }, context }) => {
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

  if (isError) {
    return <RouteDataError />;
  }

  if (isLoading || !data) {
    return <DealsSkeleton />;
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

