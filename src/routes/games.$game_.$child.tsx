import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  getChildApp,
  getCanonicalChildPath,
} from "../lib/related";
import {
  getCurrentPrice,
  getPriceHistory,
} from "../lib/prices";
import { parseGameSlug, toSlug } from "../lib/slug";
import { CACHE_POLICIES, getEntityCacheHeaders } from "../lib/cache";
import { AppLink } from "../components/app-link";
import { RouteDataError, RouteLoading } from "../components/route-state";
import { GamePageSkeleton } from "../components/route-skeletons";
import { ChildAppPageView } from "../components/child-app-page";

const getChildData = createServerFn({ method: "GET" })
  .validator((data: { parentAppId: number; childAppId: number }) => {
    if (
      !data ||
      !Number.isInteger(data.parentAppId) ||
      data.parentAppId <= 0 ||
      !Number.isInteger(data.childAppId) ||
      data.childAppId <= 0
    ) {
      throw new Error("Invalid related app IDs");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const db = await getDb();
    const result = await getChildApp(db, data.parentAppId, data.childAppId);
    if (!result) return null;

    const currentPrice = await getCurrentPrice(db, result.child.appid);
    const priceHistory = await getPriceHistory(db, result.child.appid, "all", { currentPrice });
    return { parent: result.parent, child: result.child, price: currentPrice, priceHistory };
  });

export function childQueryOptions(parentAppId: number, childAppId: number) {
  return {
    queryKey: ["child-app", parentAppId, childAppId],
    queryFn: () => getChildData({ data: { parentAppId, childAppId } }),
  };
}

export const Route = createFileRoute("/games/$game_/$child")({
  headers: () => getEntityCacheHeaders(),
  loader: ({ params, context }) => {
    const p = parseGameSlug(params.game);
    const c = parseGameSlug(params.child);
    if (!p || !c) {
      throw notFound();
    }

    void context.queryClient.prefetchQuery(childQueryOptions(p.appid, c.appid));
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
  const { data, isLoading, isError } = useQuery(childQueryOptions(parentAppId, childAppId));
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
      void navigate({ to: canonicalPath, replace: true });
    }
  }, [data, navigate, requestPath]);

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

  return (
    <ChildAppPageView
      parent={data.parent}
      child={data.child}
      price={data.price}
      priceHistory={data.priceHistory}
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

  const result = await getChildApp(db, p.appid, c.appid);
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
    return new Response(null, {
      status: 301,
      headers: {
        Location: canonicalPath,
        "Cache-Control": CACHE_POLICIES.entity,
      },
    });
  }

  const currentPrice = await getCurrentPrice(db, result.child.appid);
  const priceHistory = await getPriceHistory(db, result.child.appid, "all", { currentPrice });
  const appHtml = renderToString(
    <ChildAppPageView parent={result.parent} child={result.child} price={currentPrice} priceHistory={priceHistory} />
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
