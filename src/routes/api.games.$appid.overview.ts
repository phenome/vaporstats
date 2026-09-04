import { createFileRoute } from "@tanstack/react-router";
import { getDb, type D1Database } from "../lib/db";
import { getGameOverview, type GameOverviewData } from "../lib/player";
import { getLiveApiCacheHeaders } from "../lib/cache";

/**
 * Pure HTTP request handler for the game overview API.
 * Returns latest player activity, source observation timestamp,
 * and live API cache headers (5 min CDN s-maxage, 1 min SWR).
 */
export async function handleGameOverviewRequest(
  request: Request,
  db: D1Database,
  explicitAppid?: number
): Promise<Response> {
  let appid = explicitAppid;

  if (appid !== undefined) {
    if (
      typeof explicitAppid !== "number" ||
      !Number.isInteger(explicitAppid) ||
      explicitAppid <= 0
    ) {
      return Response.json(
        { error: "Invalid AppID" },
        { status: 400, headers: getLiveApiCacheHeaders() }
      );
    }
  } else {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/api\/games\/([^/]+)\/overview/);
    if (!match) {
      return Response.json(
        { error: "Invalid route" },
        { status: 400, headers: getLiveApiCacheHeaders() }
      );
    }

    const rawAppid = match[1];
    if (!/^\d+$/.test(rawAppid)) {
      return Response.json(
        { error: "Invalid AppID" },
        { status: 400, headers: getLiveApiCacheHeaders() }
      );
    }

    const parsed = parseInt(rawAppid, 10);
    if (isNaN(parsed) || parsed <= 0) {
      return Response.json(
        { error: "Invalid AppID" },
        { status: 400, headers: getLiveApiCacheHeaders() }
      );
    }
    appid = parsed;
  }

  const data = await getGameOverview(db, appid);
  if (!data) {
    return Response.json(
      { error: "Game not found" },
      { status: 404, headers: getLiveApiCacheHeaders() }
    );
  }

  return Response.json(data, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...getLiveApiCacheHeaders(),
    },
  });
}

export const Route = createFileRoute("/api/games/$appid/overview")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const rawAppid =
          params && typeof params === "object" && "appid" in params && typeof params.appid === "string"
            ? params.appid
            : undefined;
        if (!rawAppid || !/^\d+$/.test(rawAppid)) {
          return Response.json(
            { error: "Invalid AppID" },
            { status: 400, headers: getLiveApiCacheHeaders() }
          );
        }
        const appid = parseInt(rawAppid, 10);
        if (isNaN(appid) || appid <= 0) {
          return Response.json(
            { error: "Invalid AppID" },
            { status: 400, headers: getLiveApiCacheHeaders() }
          );
        }
        const db = await getDb();
        return handleGameOverviewRequest(request, db, appid);
      },
    },
  },
});
