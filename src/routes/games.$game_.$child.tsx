import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getChildGameDetail } from "../lib/catalog";
import { getCanonicalChildPath } from "../lib/related";
import {
  getCurrentPrice,
  getPriceHistory,
  type PriceHistoryRange,
} from "../lib/prices";
import { parseGameSlug, toSlug } from "../lib/slug";
import {
  parseNumericPriceRange,
  cleanGameSearchParams,
  NUMERIC_TO_PRICE_RANGE,
  DEFAULT_NUMERIC_PRICE_RANGE,
  PRICE_TO_NUMERIC_RANGE,
  type NumericPriceRange,
} from "../lib/game-params";
import { CACHE_POLICIES, getEntityCacheHeaders } from "../lib/cache";
import { AppLink } from "../components/app-link";
import { RouteDataError, RouteLoading } from "../components/route-state";
import { GamePageSkeleton } from "../components/route-skeletons";
import { ChildAppPageView } from "../components/child-app-page";
import { getMediaGameMatches, getMediaGameMatchPaths } from "../lib/media-similarity";
import { getMediaSources } from "../lib/media-discovery";
import { getMediaOverview } from "../lib/media-overview";

const getChildData = createServerFn({ method: "GET" })
  .validator((data: { parentAppId: number; childAppId: number; priceRange: PriceHistoryRange }) => {
    if (
      !data ||
      !Number.isInteger(data.parentAppId) ||
      data.parentAppId <= 0 ||
      !Number.isInteger(data.childAppId) ||
      data.childAppId <= 0 ||
      !["30d", "6m", "1y", "all"].includes(data.priceRange)
    ) {
      throw new Error("Invalid related app IDs or price range");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const db = await getDb();
    const result = await getChildGameDetail(db, data.parentAppId, data.childAppId);
    if (!result) return null;
    const [currentPrice, mediaMatches, sources, mediaOverview] = await Promise.all([
      getCurrentPrice(db, result.game.appid),
      getMediaGameMatches(db, result.game.appid),
      getMediaSources(db, result.game.appid),
      getMediaOverview(db, result.game.appid),
    ]);
    const [priceHistory, mediaMatchPaths] = await Promise.all([
      getPriceHistory(db, result.game.appid, data.priceRange, { currentPrice }),
      getMediaGameMatchPaths(db, mediaMatches),
    ]);
    return {
      parent: result.parent,
      child: result.child,
      game: result.game,
      price: currentPrice,
      priceHistory,
      sources,
      mediaOverview,
      mediaMatches,
      mediaMatchPaths,
    };
  });

export function childQueryOptions(
  parentAppId: number,
  childAppId: number,
  priceRange: PriceHistoryRange = "all",
) {
  return {
    queryKey: ["child-app", parentAppId, childAppId, priceRange],
    queryFn: () => getChildData({ data: { parentAppId, childAppId, priceRange } }),
  };
}

export const Route = createFileRoute("/games/$game_/$child")({
  headers: () => getEntityCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => {
    const result: { pricerange?: number } = {};
    if (search.pricerange !== undefined) {
      const parsed = parseNumericPriceRange(search.pricerange);
      if (parsed !== DEFAULT_NUMERIC_PRICE_RANGE) result.pricerange = parsed;
    }
    return result;
  },
  loaderDeps: ({ search }) => ({
    pricerange: parseNumericPriceRange(search.pricerange),
  }),
  loader: ({ params, deps, context }) => {
    const p = parseGameSlug(params.game);
    const c = parseGameSlug(params.child);
    if (!p || !c) {
      throw notFound();
    }

    void context.queryClient.prefetchQuery(
      childQueryOptions(p.appid, c.appid, NUMERIC_TO_PRICE_RANGE[deps.pricerange]),
    );
    return {
      parentAppId: p.appid,
      childAppId: c.appid,
      requestPath: "/games/" + params.game + "/" + params.child,
    };
  },
  component: ChildRouteComponent,
  notFoundComponent: ChildNotFoundComponent,
});

function ChildRouteComponent() {
  const { parentAppId, childAppId, requestPath } = Route.useLoaderData();
  const search = Route.useSearch();
  const numericPriceRange = parseNumericPriceRange(search.pricerange);
  const priceRange = NUMERIC_TO_PRICE_RANGE[numericPriceRange];
  const { data, isLoading, isError } = useQuery(childQueryOptions(parentAppId, childAppId, priceRange));
  const navigate = Route.useNavigate();

  React.useEffect(() => {
    if (!data) return;
    const canonicalPath = getCanonicalChildPath(
      data.parent.appid,
      data.parent.name,
      data.child.appid,
      data.child.name
    );
    if (requestPath !== canonicalPath) {
      void navigate({ to: canonicalPath, search, replace: true, resetScroll: false });
    }
  }, [data, navigate, requestPath, search]);

  if (isLoading) {
    return <GamePageSkeleton />;
  }
  if (isError) {
    return <RouteDataError />;
  }
  if (!data) {
    return <ChildNotFoundComponent />;
  }

  const canonicalPath = getCanonicalChildPath(
    data.parent.appid,
    data.parent.name,
    data.child.appid,
    data.child.name
  );
  if (requestPath !== canonicalPath) {
    return <RouteLoading label="Redirecting to the canonical related app page..." />;
  }

  const handlePriceRangeChange = (nextPriceRange: NumericPriceRange) => {
    void navigate({
      search: cleanGameSearchParams({ pricerange: nextPriceRange }),
      replace: true,
      resetScroll: false,
    });
  };

  return (
    <ChildAppPageView
      parent={data.parent}
      child={data.child}
      game={data.game}
      price={data.price}
      priceHistory={data.priceHistory}
      sources={data.sources}
      mediaOverview={data.mediaOverview}
      mediaMatches={data.mediaMatches}
      mediaMatchPaths={data.mediaMatchPaths}
      pricerange={numericPriceRange}
      onPriceRangeChange={handlePriceRangeChange}
    />
  );
}


function ChildNotFoundComponent() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4 font-mono">
      <div className="text-4xl font-bold text-orange-500">404</div>
      <h1 className="text-xl text-zinc-200">Related App Not Found</h1>
      <p className="text-xs text-zinc-500 max-w-md mx-auto">
        The requested subordinate app does not exist, is ineligible, or is not associated with this parent game.
      </p>
      <div className="pt-4">
        <AppLink
          href="/games"
          className="px-4 py-2 bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs hover:border-orange-500 transition-colors"
        >
          Return to Games Catalog
        </AppLink>
      </div>
    </div>
  );
}


/**
 * Pure route HTTP request handler for the canonical child route.
 * Handles AppID-authoritative routing, stale slug redirects (301),
 * unknown/mismatched 404s, and cached SSR responses using React SSR.
 */
export async function handleChildHttpRequest(
  request: Request,
  db: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/games\/([^/]+)\/([^/]+)$/);

  if (!match) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const parentParam = match[1];
  const childParam = match[2];

  const p = parseGameSlug(parentParam);
  const c = parseGameSlug(childParam);

  if (!p || !c) {
    const notFoundHtml = renderToString(<ChildNotFoundComponent />);
    return new Response(wrapHtml("Related App Not Found", notFoundHtml), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const numericPriceRange = parseNumericPriceRange(url.searchParams.get("pricerange"));
  const priceRange = NUMERIC_TO_PRICE_RANGE[numericPriceRange];
  const result = await getChildGameDetail(db, p.appid, c.appid);
  if (!result) {
    const notFoundHtml = renderToString(<ChildNotFoundComponent />);
    return new Response(wrapHtml("Related App Not Found", notFoundHtml), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const canonicalParentSlug = toSlug(result.parent.name);
  const canonicalChildSlug = toSlug(result.child.name);

  if (p.slug !== canonicalParentSlug || c.slug !== canonicalChildSlug) {
    const canonicalPath = getCanonicalChildPath(
      result.parent.appid,
      result.parent.name,
      result.child.appid,
      result.child.name
    );
    const location = numericPriceRange !== DEFAULT_NUMERIC_PRICE_RANGE
      ? `${canonicalPath}?pricerange=${numericPriceRange}`
      : canonicalPath;
    return new Response(null, {
      status: 301,
      headers: {
        Location: location,
        "Cache-Control": CACHE_POLICIES.entity,
      },
    });
  }

  const [currentPrice, mediaMatches, sources, mediaOverview] = await Promise.all([
    getCurrentPrice(db, result.game.appid),
    getMediaGameMatches(db, result.game.appid),
    getMediaSources(db, result.game.appid),
    getMediaOverview(db, result.game.appid),
  ]);
  const [priceHistory, mediaMatchPaths] = await Promise.all([
    getPriceHistory(db, result.game.appid, priceRange, { currentPrice }),
    getMediaGameMatchPaths(db, mediaMatches),
  ]);
  const appHtml = renderToString(
    <ChildAppPageView
      parent={result.parent}
      child={result.child}
      game={result.game}
      price={currentPrice}
      priceHistory={priceHistory}
      sources={sources}
      mediaOverview={mediaOverview}
      mediaMatches={mediaMatches}
      mediaMatchPaths={mediaMatchPaths}
      pricerange={numericPriceRange}
    />
  );
  return new Response(wrapHtml(`${result.child.name} - ${result.parent.name} - VaporStats`, appHtml), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...getEntityCacheHeaders(),
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
