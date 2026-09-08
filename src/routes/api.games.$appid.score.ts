import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  getGameScoreHistory,
  getGameScoreSummary,
  type GameScoreHistory,
  type GameScoreSummary,
} from "../lib/score";
import {
  DEFAULT_HISTORY_RANGE,
  VALID_HISTORY_RANGES,
  type HistoryRange,
} from "../lib/player-history";
import { CACHE_POLICIES, getLiveApiCacheHeaders } from "../lib/cache";

const SCORE_QUERY_PARAMETERS: Record<string, true> = { view: true, range: true };

function errorResponse(message: string, status = 400): Response {
  return Response.json(
    { status: "error", message },
    { status, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
  );
}

function pathAppid(request: Request, explicitAppid?: number): number | null {
  if (explicitAppid !== undefined) {
    return Number.isSafeInteger(explicitAppid) && explicitAppid > 0 ? explicitAppid : null;
  }
  const match = new URL(request.url).pathname.match(/\/api\/games\/([^/]+)\/score$/);
  if (!match || !/^\d+$/.test(match[1]!)) return null;
  const appid = Number(match[1]);
  return Number.isSafeInteger(appid) && appid > 0 ? appid : null;
}

function isHistoryRange(value: string): value is HistoryRange {
  return Object.prototype.hasOwnProperty.call(VALID_HISTORY_RANGES, value);
}

function emptySummary(data: GameScoreSummary): boolean {
  return data.score === null;
}

function emptyHistory(data: GameScoreHistory): boolean {
  return data.recorded_scores.length === 0
    && data.approval_buckets.length === 0
    && data.milestones.length === 0
    && data.metrics.latest_approval === null
    && data.metrics.reviews_in_period === null;
}

export async function handleGameScoreRequest(
  request: Request,
  explicitDb?: AppDatabase,
  explicitAppid?: number,
): Promise<Response> {
  const appid = pathAppid(request, explicitAppid);
  if (appid === null) return errorResponse("Invalid AppID");

  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!Object.prototype.hasOwnProperty.call(SCORE_QUERY_PARAMETERS, key)) {
      return errorResponse(`Parameter is not valid for score: ${key}`);
    }
  }
  for (const key of ["view", "range"]) {
    if (params.getAll(key).length > 1) return errorResponse(`Parameter may only be provided once: ${key}`);
  }

  const view = params.get("view") ?? "summary";
  if (view !== "summary" && view !== "history") return errorResponse("Unknown score view");
  if (view === "summary" && params.has("range")) return errorResponse("range is only valid for history");
  const rawRange = params.get("range");
  if (rawRange !== null && !isHistoryRange(rawRange)) return errorResponse("Unknown score history range");
  const range: HistoryRange = rawRange === null ? DEFAULT_HISTORY_RANGE : rawRange;
  const now = new Date();

  try {
    const db = await getDb(explicitDb);
    if (view === "summary") {
      const result = await getGameScoreSummary(db, appid, { now });
      if (result.data === null) return errorResponse("Game not found", 404);
      return Response.json(
        {
          status: emptySummary(result.data) ? "empty" : "data",
          data: result.data,
          source_timestamp: result.sourceTimestamp,
          generated_at: new Date().toISOString(),
        },
        { status: 200, headers: getLiveApiCacheHeaders() },
      );
    }

    const result = await getGameScoreHistory(db, appid, range, { now });
    if (result.data === null) return errorResponse("Game not found", 404);
    return Response.json(
      {
        status: emptyHistory(result.data) ? "empty" : "data",
        data: result.data,
        source_timestamp: result.sourceTimestamp,
        generated_at: new Date().toISOString(),
      },
      { status: 200, headers: getLiveApiCacheHeaders() },
    );
  } catch (error) {
    console.error("Game score API failure:", error);
    return errorResponse("Live data unavailable", 500);
  }
}

export async function GET({ request }: { request: Request }): Promise<Response> {
  return handleGameScoreRequest(request);
}

export const Route = createFileRoute("/api/games/$appid/score")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGameScoreRequest(request),
    },
  },
});

export default handleGameScoreRequest;
