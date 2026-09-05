import { createFileRoute } from "@tanstack/react-router";
import { listPlayableGames } from "../lib/catalog";
import { getDb, type AppDatabase } from "../lib/db";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

export async function handleCatalogRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit
    ? Math.min(Math.max(Number.parseInt(rawLimit, 10) || 100, 1), 500)
    : 100;

  try {
    const db = await getDb(explicitDb);
    const games = await listPlayableGames(db, { limit });
    return Response.json(
      {
        status: games.length > 0 ? "data" : "empty",
        data: games,
        source_timestamp: new Date().toISOString(),
      },
      { headers: getLiveApiCacheHeaders() }
    );
  } catch {
    return Response.json(
      {
        status: "error",
        error: "Live data unavailable",
        source_timestamp: new Date().toISOString(),
      },
      {
        status: 500,
        headers: { "Cache-Control": CACHE_POLICIES.noStore },
      }
    );
  }
}

export const Route = createFileRoute("/api/catalog")({
  server: {
    handlers: {
      GET: async ({ request }) => handleCatalogRequest(request),
    },
  },
});
