import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getGameByAppId } from "../lib/catalog";
import { getRelatedApps } from "../lib/related";
import { getPlayerHistory } from "../lib/player-history";
import { getDb, type D1Database } from "../lib/db";
import { getCurrentPrice, getPriceHistory } from "../lib/prices";
import { parseGameSlug, toSlug, getCanonicalGamePath } from "../lib/slug";
import { CACHE_POLICIES, getEntityCacheHeaders } from "../lib/cache";
import { GamePageView } from "../components/game-page";

export const Route = createFileRoute("/games/$game")({
  headers: () => getEntityCacheHeaders(),
  loader: async ({ params }) => {
    const parsed = parseGameSlug(params.game);
    if (!parsed) {
      throw notFound();
    }

    const db = await getDb();
    const game = await getGameByAppId(db, parsed.appid);
    if (!game) {
      throw notFound();
    }

    const canonicalSlug = toSlug(game.name);
    if (parsed.slug !== canonicalSlug) {
      const canonicalPath = getCanonicalGamePath(game.appid, game.name);
      throw redirect({
        href: canonicalPath,
        statusCode: 301,
      });
    }
    const [related, playerHistory, price, priceHistory] = await Promise.all([
      getRelatedApps(db, game.appid),
      getPlayerHistory(db, game.appid, "30d"),
      getCurrentPrice(db, game.appid),
      getPriceHistory(db, game.appid, "all"),
    ]);
    return { game, related, playerHistory, price, priceHistory };
  },
  component: GameRouteComponent,
  notFoundComponent: GameNotFoundComponent,
});

function GameRouteComponent() {
  const { game, related, playerHistory, price, priceHistory } = Route.useLoaderData();
  return (
    <GamePageView
      game={game}
      related={related}
      playerHistory={playerHistory}
      price={price}
      priceHistory={priceHistory}
    />
  );
}

function GameNotFoundComponent() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4 font-mono">
      <div className="text-4xl font-bold text-orange-500">404</div>
      <h1 className="text-xl text-zinc-200">Game Not Found</h1>
      <p className="text-xs text-zinc-500 max-w-md mx-auto">
        The requested AppID does not exist in the catalog or is an ineligible entity.
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

/**
 * Pure route HTTP request handler for the canonical game route.
 * Handles AppID-authoritative routing, stale slug redirects (301),
 * unknown/ineligible 404s, and cached SSR responses using React SSR.
 */
export async function handleGameHttpRequest(
  request: Request,
  db: D1Database
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/games\/([^/]+)$/);

  if (!match) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const rawParam = match[1];
  const parsed = parseGameSlug(rawParam);

  if (!parsed) {
    const notFoundHtml = renderToString(<GameNotFoundComponent />);
    return new Response(wrapHtml("Game Not Found", notFoundHtml), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const game = await getGameByAppId(db, parsed.appid);
  if (!game) {
    const notFoundHtml = renderToString(<GameNotFoundComponent />);
    return new Response(wrapHtml("Game Not Found", notFoundHtml), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const canonicalSlug = toSlug(game.name);
  if (parsed.slug !== canonicalSlug) {
    const canonicalPath = getCanonicalGamePath(game.appid, game.name);
    return new Response(null, {
      status: 301,
      headers: {
        Location: canonicalPath,
        "Cache-Control": CACHE_POLICIES.entity,
      },
    });
  }
  const [related, playerHistory, price, priceHistory] = await Promise.all([
    getRelatedApps(db, game.appid),
    getPlayerHistory(db, game.appid, "30d"),
    getCurrentPrice(db, game.appid),
    getPriceHistory(db, game.appid, "all"),
  ]);
  const appHtml = renderToString(
    <GamePageView
      game={game}
      related={related}
      playerHistory={playerHistory}
      price={price}
      priceHistory={priceHistory}
    />
  );
  return new Response(wrapHtml(`${game.name} - VaporStats`, appHtml), {
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
