import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getLifecycleHistory } from "../lib/lifecycle-history";
import { CACHE_POLICIES, getEntityCacheHeaders } from "../lib/cache";

function errorResponse(error: string, status: number): Response {
  return Response.json(
    { status: "error", error },
    { status, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
  );
}

export async function handleGameLifecycleRequest(
  request: Request,
  db: AppDatabase,
  explicitAppid?: number,
): Promise<Response> {
  let appid = explicitAppid;

  if (appid === undefined) {
    const match = new URL(request.url).pathname.match(/\/api\/games\/([^/]+)\/lifecycle/);
    if (!match || !/^\d+$/.test(match[1])) {
      return errorResponse("Invalid AppID", 400);
    }
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return errorResponse("Invalid AppID", 400);
    }
    appid = parsed;
  }

  if (!Number.isSafeInteger(appid) || appid <= 0) {
    return errorResponse("Invalid AppID", 400);
  }

  const game = await db
    .prepare(
      `SELECT appid FROM apps
       WHERE appid = ?
         AND is_playable = 1
         AND is_eligible = 1
         AND parent_appid IS NULL`,
    )
    .bind(appid)
    .first<{ appid: number }>();

  if (!game) {
    return errorResponse("Game not found", 404);
  }

  return Response.json(
    { status: "ok", data: await getLifecycleHistory(db, appid) },
    { headers: getEntityCacheHeaders() },
  );
}

export const Route = createFileRoute("/api/games/$appid/lifecycle")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const rawAppid =
          params && typeof params === "object" && "appid" in params && typeof params.appid === "string"
            ? params.appid
            : undefined;
        if (!rawAppid || !/^\d+$/.test(rawAppid)) {
          return errorResponse("Invalid AppID", 400);
        }
        const appid = Number(rawAppid);
        if (!Number.isSafeInteger(appid) || appid <= 0) {
          return errorResponse("Invalid AppID", 400);
        }
        const db = await getDb();
        return handleGameLifecycleRequest(request, db, appid);
      },
    },
  },
});
