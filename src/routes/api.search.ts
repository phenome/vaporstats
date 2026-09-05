import { createFileRoute } from "@tanstack/react-router";
import { getDb, type AppDatabase } from "../lib/db";
import {
  searchCatalog,
  createApiDataResponse,
  createApiEmptyResponse,
  createApiErrorResponse,
  type SearchCatalogResult,
} from "../lib/related";

/**
 * Handles /api/search HTTP requests.
 * Distinguishes data, empty, and error outcomes with source timestamps and live API cache policy.
 */
export async function handleSearchApiRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const trimmed = q.trim();

  if (!trimmed) {
    return createApiEmptyResponse("No search query provided");
  }

  try {
    const db = await getDb(explicitDb);
    const results: SearchCatalogResult = await searchCatalog(db, trimmed);

    if (results.items.length === 0) {
      return createApiEmptyResponse(`No results found for "${trimmed}"`);
    }

    return createApiDataResponse(results);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Live data unavailable";
    return createApiErrorResponse(message, 500);
  }
}

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = await getDb();
        return handleSearchApiRequest(request, db);
      },
    },
  },
});

export async function GET({ request }: { request: Request }): Promise<Response> {
  const db = await getDb();
  return handleSearchApiRequest(request, db);
}

export default handleSearchApiRequest;
