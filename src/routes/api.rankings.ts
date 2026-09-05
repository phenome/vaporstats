import { createFileRoute } from "@tanstack/react-router";
import { getDb, type AppDatabase } from "../lib/db";
import {
  getMostPlayedRankings,
  getPeakRankings,
  getTrendingGames,
  parseHistoryRange,
  type HistoryRange,
} from "../lib/player-history";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

/**
 * Pure HTTP request handler for the rankings API.
 * Supports:
 * - Most Played (/api/rankings?type=most_played): latest count ordering with relative & exact UTC age
 * - Observed Peak (/api/rankings?type=peak&period=30d): highest observed peak across observations and rollups
 * - Trending (/api/rankings?type=trending): top ten tracked playable games by latest count
 *
 * Exposes source timestamps and live API cache headers. Errors are never cached.
 */
export async function handleRankingsRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const typeParam = (url.searchParams.get("type") || "most_played").toLowerCase();
  const periodParam = url.searchParams.get("period");
  const limitParam = url.searchParams.get("limit");

  let limit = 100;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, 500);
    }
  }

  const now = new Date();
  const sourceTimestamp = now.toISOString();

  try {
    const db = await getDb(explicitDb);

    if (typeParam === "trending") {
      const games = await getTrendingGames(db, { now });
      return new Response(
        JSON.stringify({
          status: "data",
          type: "trending",
          data: games,
          source_timestamp: sourceTimestamp,
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

    if (typeParam === "peak") {
      const period = parseHistoryRange(periodParam);
      const peaks = await getPeakRankings(db, period, { limit, anchorTime: now });
      return new Response(
        JSON.stringify({
          status: "data",
          type: "peak",
          period,
          data: peaks,
          source_timestamp: sourceTimestamp,
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

    if (typeParam === "most_played") {
      const games = await getMostPlayedRankings(db, { limit, now });
      return new Response(
        JSON.stringify({
          status: "data",
          type: "most_played",
          data: games,
          source_timestamp: sourceTimestamp,
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

    // Invalid ranking type
    return new Response(
      JSON.stringify({
        status: "error",
        error: `Unknown ranking type: "${typeParam}". Supported: "most_played", "peak", "trending"`,
        source_timestamp: sourceTimestamp,
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_POLICIES.noStore,
        },
      }
    );
  } catch (err: unknown) {
    console.error("Rankings API failure:", err);
    return new Response(
      JSON.stringify({
        status: "error",
        error: "Live data unavailable",
        source_timestamp: sourceTimestamp,
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
  return handleRankingsRequest(request);
}

export const Route = createFileRoute("/api/rankings")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = await getDb();
        return handleRankingsRequest(request, db);
      },
    },
  },
});

export default handleRankingsRequest;
