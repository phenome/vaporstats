import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { getEventReader, type EventReaderResult } from "../lib/event-reader";
import { CACHE_POLICIES } from "../lib/cache";

export interface EventReaderApiResponse {
  status: "data" | "fallback" | "error";
  data?: EventReaderResult;
  message?: string;
  generated_at: string;
}

export function parseEventReaderPath(pathname: string): { appid: number; eventId: string } | null {
  const match = pathname.match(/\/api\/games\/([^/]+)\/events\/([^/]+)\/reader\/?$/);
  if (!match) return null;
  const rawAppid = match[1];
  const eventId = decodeURIComponent(match[2].trim());
  if (!/^\d+$/.test(rawAppid) || !eventId) return null;
  const appid = Number(rawAppid);
  if (!Number.isSafeInteger(appid) || appid <= 0) return null;
  return { appid, eventId };
}

export async function handleEventReaderRequest(
  request: Request,
  explicitDb?: AppDatabase,
  explicitAppid?: number,
  explicitEventId?: string,
  options?: { customFetch?: typeof fetch },
): Promise<Response> {
  let appid = explicitAppid;
  let eventId = explicitEventId;

  if (appid === undefined || eventId === undefined) {
    const parsed = parseEventReaderPath(new URL(request.url).pathname);
    if (!parsed) {
      return Response.json(
        { status: "error", message: "Invalid AppID or Event ID in request URL" },
        { status: 400, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
      );
    }
    appid = parsed.appid;
    eventId = parsed.eventId;
  }

  try {
    const db = await getDb(explicitDb);
    const result = await getEventReader(db, appid, eventId, options);

    if (result.status === "not_found") {
      return Response.json(
        { status: "error", message: result.message },
        { status: 404, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
      );
    }

    return Response.json(
      {
        status: result.status === "success" ? "data" : "fallback",
        data: result,
        generated_at: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
          "Vary": "Accept-Encoding",
        },
      },
    );
  } catch (error) {
    console.error("Event reader API failure:", error);
    return Response.json(
      { status: "error", message: "Event reader data unavailable" },
      { status: 500, headers: { "Cache-Control": CACHE_POLICIES.noStore } },
    );
  }
}

export async function GET({ request }: { request: Request }): Promise<Response> {
  return handleEventReaderRequest(request);
}

export const Route = createFileRoute("/api/games/$appid/events/$eventid/reader")({
  server: {
    handlers: {
      GET: async ({ request }) => handleEventReaderRequest(request),
    },
  },
});

export default handleEventReaderRequest;
