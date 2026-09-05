import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getGameByAppId, type GameDetail } from "../lib/catalog";
import { getRelatedApps, type GroupedRelatedApps } from "../lib/related";
import { getPlayerHistory, type PlayerHistoryResult } from "../lib/player-history";
import { getCurrentPrice, getPriceHistory, type PriceState, type PriceHistoryResult } from "../lib/prices";
import { CACHE_POLICIES, getEntityCacheHeaders } from "../lib/cache";

export interface GameDetailResponseData {
  game: GameDetail;
  related: GroupedRelatedApps;
  playerHistory: PlayerHistoryResult;
  price: PriceState | null;
  priceHistory: PriceHistoryResult | null;
}

export async function handleGameDetailRequest(
  request: Request,
  db: AppDatabase,
  explicitAppid?: number
): Promise<Response> {
  let appid = explicitAppid;

  if (appid === undefined) {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/api\/games\/([^/]+)\/detail/);
    if (!match) {
      return new Response(
        JSON.stringify({ status: "error", error: "Missing AppID in request URL" }),
        { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": CACHE_POLICIES.noStore } }
      );
    }
    const rawAppid = match[1];
    if (!/^\d+$/.test(rawAppid)) {
      return new Response(
        JSON.stringify({ status: "error", error: "Invalid AppID parameter" }),
        { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": CACHE_POLICIES.noStore } }
      );
    }
    appid = parseInt(rawAppid, 10);
  }

  if (!Number.isInteger(appid) || appid <= 0) {
    return new Response(
      JSON.stringify({ status: "error", error: "Invalid AppID parameter" }),
      { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": CACHE_POLICIES.noStore } }
    );
  }

  const game = await getGameByAppId(db, appid);
  if (!game) {
    return new Response(
      JSON.stringify({ status: "error", error: "Game not found" }),
      { status: 404, headers: { "Content-Type": "application/json", "Cache-Control": CACHE_POLICIES.noStore } }
    );
  }

  const [related, playerHistory, currentPrice] = await Promise.all([
    getRelatedApps(db, game.appid),
    getPlayerHistory(db, game.appid, "30d"),
    getCurrentPrice(db, game.appid),
  ]);
  const priceHistory = await getPriceHistory(db, game.appid, "all", { currentPrice });

  const responseData: GameDetailResponseData = {
    game,
    related,
    playerHistory,
    price: currentPrice,
    priceHistory,
  };

  return Response.json(
    { status: "ok", data: responseData },
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...getEntityCacheHeaders(),
      },
    }
  );
}

export const Route = createFileRoute("/api/games/$appid/detail")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const rawAppid =
          params && typeof params === "object" && "appid" in params && typeof params.appid === "string"
            ? params.appid
            : undefined;
        if (!rawAppid || !/^\d+$/.test(rawAppid)) {
          return Response.json(
            { status: "error", error: "Invalid AppID" },
            { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } }
          );
        }
        const appid = parseInt(rawAppid, 10);
        if (isNaN(appid) || appid <= 0) {
          return Response.json(
            { status: "error", error: "Invalid AppID" },
            { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } }
          );
        }
        const db = await getDb();
        return handleGameDetailRequest(request, db, appid);
      },
    },
  },
});
