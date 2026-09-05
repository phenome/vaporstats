import { Navigate, createFileRoute } from "@tanstack/react-router";
import { getDb, type D1Database } from "../lib/db";
import { getCurrentIsoWeek, parseIsoWeek } from "../lib/releases";
import { handleWeekReleasesHttpRequest } from "./releases.$week";
import { getLiveApiCacheHeaders, getPageCacheHeaders } from "../lib/cache";
import { RouteLoading } from "../components/route-state";

export interface ResolvedReleaseWeek {
  week: string;
  startDate: string;
  endDate: string;
  canonicalPath: string;
}

/**
 * Resolves the current Monday-through-Sunday ISO week.
 */
export function resolveCurrentReleaseWeek(asOfDate?: Date | string): ResolvedReleaseWeek {
  const week = getCurrentIsoWeek(asOfDate);
  const bounds = parseIsoWeek(week)!;
  return {
    week,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    canonicalPath: `/releases/${week}`,
  };
}

/**
 * Pure HTTP request handler for the root /releases endpoint.
 * Resolves current UTC ISO week and redirects (307) to canonical shareable route.
 * If query parameter ?render=true is specified, directly serves current week SSR HTML.
 */
export async function handleReleasesIndexHttpRequest(
  request: Request,
  explicitDb?: D1Database
): Promise<Response> {
  const url = new URL(request.url);
  const asOf = url.searchParams.get("as_of") || undefined;
  const current = resolveCurrentReleaseWeek(asOf);

  if (url.searchParams.get("render") === "true") {
    const db = await getDb(explicitDb);
    return handleWeekReleasesHttpRequest(request, current.week, db);
  }

  return new Response(
    `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${current.canonicalPath}"></head><body>Redirecting to <a href="${current.canonicalPath}">${current.canonicalPath}</a></body></html>`,
    {
      status: 307,
      headers: {
        Location: current.canonicalPath,
        "Content-Type": "text/html; charset=utf-8",
        ...getLiveApiCacheHeaders(),
      },
    }
  );
}

export const Route = createFileRoute("/releases/")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  loader: async () => ({ currentWeek: getCurrentIsoWeek() }),
  pendingComponent: () => <RouteLoading label="Opening the current release week..." />,
  component: ReleasesIndexRoute,
});

function ReleasesIndexRoute() {
  const { currentWeek } = Route.useLoaderData();
  return (
    <Navigate
      to="/releases/$week"
      params={{ week: currentWeek }}
      replace
    />
  );
}

export default handleReleasesIndexHttpRequest;
