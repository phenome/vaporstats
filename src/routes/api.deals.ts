import { createFileRoute } from "@tanstack/react-router";
import { getDb, type AppDatabase } from "../lib/db";
import { getDeals } from "../lib/prices";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

/**
 * Pure HTTP request handler for the deals API.
 * Returns active discounts on playable games, consumer DLC, and expansions.
 * Strictly excludes dedicated servers, tools, demos, tests, and soundtracks.
 * Exposes live API caching (5 min CDN s-maxage, 1 min SWR) and source timestamps.
 */
export async function handleDealsRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const rawType = url.searchParams.get("type");
  const rawSort = url.searchParams.get("sort");

  const limit = rawLimit ? Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 100) : 50;
  const offset = rawOffset ? Math.max(parseInt(rawOffset, 10) || 0, 0) : 0;

  let type: "game" | "dlc" | "expansion" | "all" = "all";
  if (rawType === "game" || rawType === "dlc" || rawType === "expansion") {
    type = rawType;
  }

  let sort: "discount" | "price" | "recent" = "discount";
  if (rawSort === "price" || rawSort === "recent") {
    sort = rawSort;
  }

  try {
    const db = await getDb(explicitDb);
    const result = await getDeals(db, { limit, offset, type, sort });

    if (result.deals.length === 0) {
      return new Response(
        JSON.stringify({
          status: "empty",
          data: {
            deals: [],
            total: 0,
          },
          message: "No active deals found",
          source_timestamp: result.source_timestamp,
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
        data: result,
        source_timestamp: result.source_timestamp,
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
    const message = err instanceof Error ? err.message : "Deals data unavailable";
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
  return handleDealsRequest(request);
}

export const Route = createFileRoute("/api/deals")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = await getDb();
        return handleDealsRequest(request, db);
      },
    },
  },
});

export default handleDealsRequest;
