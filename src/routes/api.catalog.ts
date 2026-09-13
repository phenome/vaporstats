import { createFileRoute } from "@tanstack/react-router";
import { listPlayableGames } from "../lib/catalog";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { normalizeMediaTag } from "../lib/media-overview";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

export async function handleCatalogRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const allowedParameters: Record<string, true> = { limit: true, media_tag: true };
  for (const key of params.keys()) {
    if (!allowedParameters[key]) {
      return Response.json(
        { status: "error", error: `Unknown catalog parameter: ${key}` },
        { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
      );
    }
  }

  const limitValues = params.getAll("limit");
  const mediaTagValues = params.getAll("media_tag");
  if (limitValues.length > 1 || mediaTagValues.length > 1) {
    return Response.json(
      { status: "error", error: "Duplicate catalog parameter" },
      { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
    );
  }

  const rawLimit = limitValues[0];
  let limit = 100;
  if (rawLimit !== undefined) {
    if (!/^[1-9]\d*$/.test(rawLimit)) {
      return Response.json(
        { status: "error", error: "Invalid catalog limit" },
        { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
      );
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > 500) {
      return Response.json(
        { status: "error", error: "Invalid catalog limit" },
        { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
      );
    }
  }

  const rawMediaTag = mediaTagValues[0];
  let mediaTag: string | undefined;
  if (rawMediaTag !== undefined) {
    const normalized = /[\u0000-\u001f\u007f]/.test(rawMediaTag)
      ? null
      : normalizeMediaTag(rawMediaTag);
    if (!normalized) {
      return Response.json(
        { status: "error", error: "Invalid media_tag" },
        { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
      );
    }
    mediaTag = normalized.label;
  }

  try {
    const db = await getDb(explicitDb);
    const games = await listPlayableGames(db, { limit, mediaTag });
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
