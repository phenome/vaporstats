import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getDb, type D1Database } from "../lib/db";
import type { CatalogEntity } from "../lib/catalog";
import {
  getChildApp,
  getCanonicalChildPath,
  type RelatedAppEntity,
} from "../lib/related";
import {
  getCurrentPrice,
  getPriceHistory,
  formatPriceCents,
  formatPriceUtc,
  type PriceState,
  type PriceHistoryResult,
} from "../lib/prices";
import { PriceHistoryChart } from "../components/price-history";
import { parseGameSlug, toSlug, getCanonicalGamePath } from "../lib/slug";
import { CACHE_POLICIES, getEntityCacheHeaders } from "../lib/cache";

export const Route = createFileRoute("/games/$game_/$child")({
  headers: () => getEntityCacheHeaders(),
  loader: async ({ params }) => {
    const p = parseGameSlug(params.game);
    const c = parseGameSlug(params.child);
    if (!p || !c) {
      throw notFound();
    }

    const db = await getDb();
    const result = await getChildApp(db, p.appid, c.appid);
    if (!result) {
      throw notFound();
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
      throw redirect({
        href: canonicalPath,
        statusCode: 301,
      });
    }

    const [price, priceHistory] = await Promise.all([
      getCurrentPrice(db, result.child.appid),
      getPriceHistory(db, result.child.appid, "all"),
    ]);

    return { parent: result.parent, child: result.child, price, priceHistory };
  },
  component: ChildRouteComponent,
  notFoundComponent: ChildNotFoundComponent,
});

function ChildRouteComponent() {
  const { parent, child, price, priceHistory } = Route.useLoaderData();
  return <ChildAppPageView parent={parent} child={child} price={price} priceHistory={priceHistory} />;
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
        <a
          href="/games"
          className="px-4 py-2 bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs hover:border-orange-500 transition-colors"
        >
          Return to Games Catalog
        </a>
      </div>
    </div>
  );
}

export interface ChildAppPageViewProps {
  parent: CatalogEntity;
  child: RelatedAppEntity;
  price?: PriceState | null;
  priceHistory?: PriceHistoryResult | null;
}

export function ChildAppPageView({
  parent,
  child,
  price,
  priceHistory,
}: ChildAppPageViewProps) {
  const parentUrl = getCanonicalGamePath(parent.appid, parent.name);
  const isExpansion = child.type === "expansion" || child.prominence > 0;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6 font-mono">
      {/* Breadcrumb Hierarchy */}
      <nav aria-label="Breadcrumb" className="text-xs text-zinc-500 flex items-center gap-2">
        <a href="/" className="hover:text-zinc-300 transition-colors">
          HOME
        </a>
        <span>/</span>
        <a href="/games" className="hover:text-zinc-300 transition-colors">
          GAMES
        </a>
        <span>/</span>
        <a href={parentUrl} className="hover:text-orange-400 text-zinc-400 transition-colors truncate max-w-xs">
          {parent.name}
        </a>
        <span>/</span>
        <span className="text-zinc-200 uppercase truncate max-w-xs">{child.name}</span>
      </nav>

      {/* Subordinate Notice Banner */}
      <div className="border border-zinc-800 bg-zinc-950 p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-zinc-600 inline-block"></span>
          <span className="text-zinc-400 uppercase font-bold">Subordinate Related Entity</span>
          <span className="text-zinc-600">—</span>
          <span className="text-zinc-500">Parent playable game:</span>
          <a href={parentUrl} className="text-orange-400 hover:underline">
            {parent.name} (#{parent.appid})
          </a>
        </div>
        <div className="text-zinc-500">
          TYPE: <span className="text-zinc-300 uppercase font-bold">{child.type}</span>
        </div>
      </div>

      {/* Main Child Card */}
      <div className={`border ${isExpansion ? "border-orange-500/60" : "border-zinc-800"} bg-zinc-950 p-6 space-y-6`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 pb-3">
          <div className="flex items-center gap-3">
            <span
              className={`px-2 py-0.5 text-xs uppercase font-bold border ${
                isExpansion
                  ? "bg-orange-500/20 text-orange-400 border-orange-500/40"
                  : "bg-zinc-800 text-zinc-300 border-zinc-700"
              }`}
            >
              {isExpansion ? "Major Expansion" : child.type}
            </span>
            <span className="text-xs text-zinc-500 tabular-nums">{`AppID #${child.appid}`}</span>
          </div>
          {child.release_date && (
            <div className="text-xs text-zinc-400">
              RELEASED: <span className="text-zinc-200">{child.release_date}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col md:flex-row gap-6 items-start">
          {child.header_image ? (
            <img
              src={child.header_image}
              alt=""
              className="w-full md:w-80 h-36 object-cover border border-zinc-800 shrink-0"
            />
          ) : (
            <div className="w-full md:w-80 h-36 bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600 text-xs">
              NO IMAGE AVAILABLE
            </div>
          )}

          <div className="flex-1 space-y-3">
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">{child.name}</h1>

            <p className="text-xs text-zinc-400 leading-relaxed">
              {child.description || "No official description provided."}
            </p>

            <div className="pt-3 border-t border-zinc-900 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div>
                <div className="text-zinc-600 text-[10px] uppercase">Parent Game</div>
                <a href={parentUrl} className="text-zinc-200 hover:text-orange-400 truncate block">
                  {parent.name}
                </a>
              </div>
              <div>
                <div className="text-zinc-600 text-[10px] uppercase">Developer</div>
                <div className="text-zinc-200 truncate">{child.developer || "Unknown"}</div>
              </div>
              <div>
                <div className="text-zinc-600 text-[10px] uppercase">Publisher</div>
                <div className="text-zinc-200 truncate">{child.publisher || "Unknown"}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Child Price History Chart */}
      <PriceHistoryChart
        key={`price-${child.appid}`}
        appid={child.appid}
        initialRange="all"
        initialData={priceHistory ?? undefined}
      />


      {/* Return Navigation */}
      <div className="pt-2">
        <a
          href={parentUrl}
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-orange-500 text-zinc-300 hover:text-white text-xs transition-colors"
        >
          <span>&larr;</span> Return to Parent Game: {parent.name}
        </a>
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
  db: D1Database
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

  const [price, priceHistory] = await Promise.all([
    getCurrentPrice(db, result.child.appid),
    getPriceHistory(db, result.child.appid, "all"),
  ]);
  const appHtml = renderToString(
    <ChildAppPageView parent={result.parent} child={result.child} price={price} priceHistory={priceHistory} />
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
