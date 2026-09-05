import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getPlayerHistory, parseHistoryRange, type HistoryRange } from "../lib/player-history";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

/**
 * Pure HTTP request handler for the player history API.
 * Returns history observations/rollups, range boundaries, gaps, source timestamp,
 * and live API cache headers (5 min CDN s-maxage, 1 min SWR).
 * Errors are explicit and never cached as successful data.
 */
export async function handlePlayerHistoryRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const rawAppid = url.searchParams.get("appid");
  const rawRange = url.searchParams.get("range");

  // Validate AppID parameter
  if (!rawAppid || !/^\d+$/.test(rawAppid)) {
    return new Response(
      JSON.stringify({
        status: "error",
        error: "Invalid or missing AppID",
        source_timestamp: new Date().toISOString(),
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_POLICIES.noStore,
        },
      }
    );
  }

  const appid = parseInt(rawAppid, 10);
  if (isNaN(appid) || appid <= 0) {
    return new Response(
      JSON.stringify({
        status: "error",
        error: "Invalid AppID parameter",
        source_timestamp: new Date().toISOString(),
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_POLICIES.noStore,
        },
      }
    );
  }

  try {
    const db = await getDb(explicitDb);

    // Verify game exists and is eligible/playable
    const gameStmt = db
      .prepare("SELECT appid FROM apps WHERE appid = ? AND is_playable = 1 AND is_eligible = 1")
      .bind(appid);
    const game = await gameStmt.first<{ appid: number }>();

    if (!game) {
      return new Response(
        JSON.stringify({
          status: "error",
          error: "Game not found or ineligible",
          source_timestamp: new Date().toISOString(),
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": CACHE_POLICIES.noStore,
          },
        }
      );
    }

    const range = parseHistoryRange(rawRange);
    const history = await getPlayerHistory(db, appid, range);

    return new Response(
      JSON.stringify({
        status: "data",
        data: history,
        source_timestamp: history.source_timestamp,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...getLiveApiCacheHeaders(),
        },
      }
    );
  } catch (err: unknown) {
    console.error("Player history API failure:", err);
    return new Response(
      JSON.stringify({
        status: "error",
        error: "Live data unavailable",
        source_timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_POLICIES.noStore,
        },
      }
    );
  }
}

export async function GET({ request }: { request: Request }): Promise<Response> {
  return handlePlayerHistoryRequest(request);
}

export const Route = createFileRoute("/api/players/history")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = await getDb();
        return handlePlayerHistoryRequest(request, db);
      },
    },
  },
});

export default handlePlayerHistoryRequest;
