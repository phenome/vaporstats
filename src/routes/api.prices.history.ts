import { createFileRoute } from "@tanstack/react-router";
import { getDb, type D1Database } from "../lib/db";
import {
  getPriceHistory,
  parsePriceRange,
  type PriceHistoryRange,
} from "../lib/prices";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

/**
 * Pure HTTP request handler for the price history API.
 * Returns range-aware price history observations, current price, source timestamp,
 * and live API cache headers (5 min CDN s-maxage, 1 min SWR).
 * Distinguishes empty vs error states without confusing failed refreshes with free or zero prices.
 */
export async function handlePriceHistoryRequest(
  request: Request,
  explicitDb?: D1Database
): Promise<Response> {
  const url = new URL(request.url);
  const rawAppid = url.searchParams.get("appid");
  const rawRange = url.searchParams.get("range");

  // Validate AppID parameter
  if (!rawAppid || !/^\d+$/.test(rawAppid)) {
    return new Response(
      JSON.stringify({
        status: "error",
        error: "Valid numeric AppID is required",
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
        error: "Valid numeric AppID is required",
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

    // Verify entity exists in apps catalog
    const appStmt = db
      .prepare("SELECT appid, is_eligible FROM apps WHERE appid = ?")
      .bind(appid);
    const app = await appStmt.first<{ appid: number; is_eligible: number }>();

    if (!app || app.is_eligible === 0) {
      return new Response(
        JSON.stringify({
          status: "error",
          error: "Entity not found or ineligible",
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

    const range = parsePriceRange(rawRange);
    const history = await getPriceHistory(db, appid, range);

    if (!history.current_price && history.history.length === 0) {
      return new Response(
        JSON.stringify({
          status: "empty",
          data: history,
          message: "No price data yet",
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
    }

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
    const message = err instanceof Error ? err.message : "Live price data unavailable";
    return new Response(
      JSON.stringify({
        status: "error",
        error: message,
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
  return handlePriceHistoryRequest(request);
}

export const Route = createFileRoute("/api/prices/history")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = await getDb();
        return handlePriceHistoryRequest(request, db);
      },
    },
  },
});

export default handlePriceHistoryRequest;
