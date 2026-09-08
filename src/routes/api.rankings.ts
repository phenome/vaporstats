import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  getMostPlayedRankings,
  getPeakRankings,
  getTrendingGames,
  parseHistoryRange,
} from "../lib/player-history";
import {
  getReceptionComparison,
  getReceptionRankings,
} from "../lib/rankings";
import type { ReceptionFilters, ReceptionRankingType } from "../lib/reception-filters";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

const RECEPTION_QUERY_PARAMETERS: Record<string, true> = {
  type: true,
  view: true,
  genre: true,
  feature: true,
  tag: true,
  limit: true,
  offset: true,
  appid: true,
};
const RECEPTION_SINGLETON_PARAMETERS = ["type", "view", "limit", "offset", "appid"] as const;

export type ParsedReceptionRequest =
  | {
      type: ReceptionRankingType;
      view: "list" | "comparison";
      filters: ReceptionFilters;
      appid?: number;
      limit: number;
      offset: number;
    }
  | { error: string };

function jsonError(message: string, status = 400): Response {
  return Response.json(
    { status: "error", message },
    { status, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
  );
}

function jsonReception<T>(data: T, sourceTimestamp: string | null, empty: boolean): Response {
  return Response.json(
    {
      status: empty ? "empty" : "data",
      data,
      source_timestamp: sourceTimestamp,
      generated_at: new Date().toISOString(),
    },
    { status: 200, headers: getLiveApiCacheHeaders() },
  );
}

function positiveDecimal(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeDecimal(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseFacetValues(params: URLSearchParams, name: string): number[] | null {
  const values = params.getAll(name);
  const parsed: number[] = [];
  for (const value of values) {
    const id = positiveDecimal(value);
    if (id === null) return null;
    if (!parsed.includes(id)) parsed.push(id);
  }
  return parsed.sort((left, right) => left - right);
}

export function parseReceptionRequest(url: URL): ParsedReceptionRequest {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!Object.prototype.hasOwnProperty.call(RECEPTION_QUERY_PARAMETERS, key)) {
      return { error: `Parameter is not valid for reception rankings: ${key}` };
    }
  }

  for (const key of RECEPTION_SINGLETON_PARAMETERS) {
    if (params.getAll(key).length > 1) return { error: `Parameter may only be provided once: ${key}` };
  }

  const typeValue = params.get("type");
  if (typeValue !== "top_rated_now" && typeValue !== "top_rated_all_time") {
    return { error: "Reception rankings require a supported type" };
  }
  const viewValue = params.get("view") ?? "list";
  if (viewValue !== "list" && viewValue !== "comparison") return { error: "Unknown reception rankings view" };

  const genres = parseFacetValues(params, "genre");
  const features = parseFacetValues(params, "feature");
  const tags = parseFacetValues(params, "tag");
  if (!genres || !features || !tags) return { error: "Facet IDs must be positive safe decimal integers" };

  const hasPagination = params.has("limit") || params.has("offset");
  if (viewValue === "comparison" && hasPagination) return { error: "Pagination is not valid for comparison" };
  if (viewValue === "list" && params.has("appid")) return { error: "appid is only valid for comparison" };

  let limit = 25;
  if (params.has("limit")) {
    const parsed = nonNegativeDecimal(params.get("limit")!);
    if (parsed === null || parsed < 1 || parsed > 100) return { error: "limit must be an integer from 1 to 100" };
    limit = parsed;
  }
  let offset = 0;
  if (params.has("offset")) {
    const parsed = nonNegativeDecimal(params.get("offset")!);
    if (parsed === null) return { error: "offset must be a non-negative safe integer" };
    offset = parsed;
  }

  let appid: number | undefined;
  if (viewValue === "comparison") {
    if (!params.has("appid")) return { error: "comparison requires appid" };
    const parsedAppid = positiveDecimal(params.get("appid")!);
    if (parsedAppid === null) return { error: "appid must be a positive safe decimal integer" };
    appid = parsedAppid;
  }

  return {
    type: typeValue,
    view: viewValue,
    filters: { genres, features, tags },
    appid,
    limit,
    offset,
  };
}

async function handleReceptionRankingsRequest(
  request: Request,
  db: AppDatabase,
  parsedRequest: ParsedReceptionRequest,
): Promise<Response> {
  if ("error" in parsedRequest) return jsonError(parsedRequest.error);
  const evaluatedAt = new Date();
  try {
    if (parsedRequest.view === "comparison") {
      const appid = parsedRequest.appid;
      if (appid === undefined) return jsonError("comparison requires appid");
      const result = await getReceptionComparison(db, {
        type: parsedRequest.type,
        filters: parsedRequest.filters,
        appid,
        evaluatedAt,
      });
      if (result.data === null) return jsonError("Game not found", 404);
      return jsonReception(result.data, result.sourceTimestamp, !result.data.in_current_group || result.data.points.length === 0);
    }

    const result = await getReceptionRankings(db, {
      type: parsedRequest.type,
      filters: parsedRequest.filters,
      limit: parsedRequest.limit,
      offset: parsedRequest.offset,
      evaluatedAt,
    });
    return jsonReception(result.data, result.sourceTimestamp, result.data.items.length === 0);
  } catch (error) {
    console.error("Reception rankings API failure:", error);
    return jsonError("Live data unavailable", 500);
  }
}

/**
 * Pure HTTP request handler for the rankings API.
 * Existing activity requests intentionally retain their historical defaults and shapes.
 */
export async function handleRankingsRequest(
  request: Request,
  explicitDb?: AppDatabase,
): Promise<Response> {
  const url = new URL(request.url);
  const typeValues = url.searchParams.getAll("type");
  const typeParam = (typeValues[0] || "most_played").toLowerCase();
  const isReception = typeValues.some((value) => value === "top_rated_now" || value === "top_rated_all_time")
    || url.searchParams.has("view")
    || url.searchParams.has("genre")
    || url.searchParams.has("feature")
    || url.searchParams.has("tag")
    || url.searchParams.has("appid");

  if (isReception) {
    const parsed = parseReceptionRequest(url);
    if ("error" in parsed) return jsonError(parsed.error);
    try {
      const db = await getDb(explicitDb);
      return handleReceptionRankingsRequest(request, db, parsed);
    } catch (error) {
      console.error("Reception rankings API failure:", error);
      return jsonError("Live data unavailable", 500);
    }
  }

  const periodParam = url.searchParams.get("period");
  const limitParam = url.searchParams.get("limit");
  let limit = 100;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 500);
  }

  const now = new Date();
  const sourceTimestamp = now.toISOString();
  try {
    const db = await getDb(explicitDb);

    if (typeParam === "trending") {
      const games = await getTrendingGames(db, { now });
      return new Response(JSON.stringify({ status: "data", type: "trending", data: games, source_timestamp: sourceTimestamp }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getLiveApiCacheHeaders() },
      });
    }

    if (typeParam === "peak") {
      const period = parseHistoryRange(periodParam);
      const peaks = await getPeakRankings(db, period, { limit, anchorTime: now });
      return new Response(JSON.stringify({ status: "data", type: "peak", period, data: peaks, source_timestamp: sourceTimestamp }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getLiveApiCacheHeaders() },
      });
    }

    if (typeParam === "most_played") {
      const games = await getMostPlayedRankings(db, { limit, now });
      return new Response(JSON.stringify({ status: "data", type: "most_played", data: games, source_timestamp: sourceTimestamp }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getLiveApiCacheHeaders() },
      });
    }

    return new Response(JSON.stringify({ status: "error", error: `Unknown ranking type: "${typeParam}". Supported: "most_played", "peak", "trending"`, source_timestamp: sourceTimestamp }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  } catch (error) {
    console.error("Rankings API failure:", error);
    return new Response(JSON.stringify({ status: "error", error: "Live data unavailable", source_timestamp: sourceTimestamp }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }
}

export async function GET({ request }: { request: Request }): Promise<Response> {
  return handleRankingsRequest(request);
}

export const Route = createFileRoute("/api/rankings")({
  server: {
    handlers: {
      GET: async ({ request }) => handleRankingsRequest(request),
    },
  },
});

export default handleRankingsRequest;
