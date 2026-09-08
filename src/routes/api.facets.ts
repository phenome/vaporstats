import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { listFacetDictionary, type FacetDictionaryEntry } from "../lib/taxonomy";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

function errorResponse(message: string, status = 400): Response {
  return Response.json(
    { status: "error", message },
    { status, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
  );
}

function isoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = /(?:Z|[+-]\d\d:\d\d)$/i.test(value)
    ? value
    : value.replace(" ", "T") + "Z";
  const time = Date.parse(candidate);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Fetches the shared dictionary in the taxonomy helper's bounded page size. */
export async function listAllNamedFacets(db: AppDatabase): Promise<FacetDictionaryEntry[]> {
  const entries: FacetDictionaryEntry[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await listFacetDictionary(db, { limit: pageSize, offset });
    entries.push(...page);
    if (page.length < pageSize) return entries;
  }
}

export async function handleFacetsRequest(
  request: Request,
  explicitDb?: AppDatabase,
): Promise<Response> {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return errorResponse("The facets endpoint does not accept query parameters");
  }

  try {
    const db = await getDb(explicitDb);
    const data = await listAllNamedFacets(db);
    const timestamp = await db
      .prepare("SELECT MAX(updated_at) AS source_timestamp FROM app_facets WHERE name IS NOT NULL AND length(trim(name)) > 0")
      .first<{ source_timestamp: string | null }>();
    return Response.json(
      {
        status: data.length > 0 ? "data" : "empty",
        data,
        source_timestamp: isoTimestamp(timestamp?.source_timestamp),
        generated_at: new Date().toISOString(),
      },
      { status: 200, headers: getLiveApiCacheHeaders() },
    );
  } catch (error) {
    console.error("Facets API failure:", error);
    return errorResponse("Live data unavailable", 500);
  }
}

export async function GET({ request }: { request: Request }): Promise<Response> {
  return handleFacetsRequest(request);
}

export const Route = createFileRoute("/api/facets")({
  server: {
    handlers: {
      GET: async ({ request }) => handleFacetsRequest(request),
    },
  },
});

export default handleFacetsRequest;
