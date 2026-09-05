import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  getReleasesForWeek,
  parseIsoWeek,
  type IsoWeekBounds,
  type WeeklyReleasesResult,
} from "../lib/releases";
import { ReleasesWeekPageView, ReleaseWeekNotFoundView } from "../components/release-week-page";
import { CACHE_POLICIES, getEntityCacheHeaders, getPageCacheHeaders } from "../lib/cache";
import { RouteDataError, RouteLoading } from "../components/route-state";


function createEmptyWeekResult(
  bounds: IsoWeekBounds,
  asOf?: string
): WeeklyReleasesResult {
  const today = asOf ? asOf.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return {
    week: bounds.week,
    year: bounds.year,
    weekNumber: bounds.weekNumber,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    prevWeek: bounds.prevWeek,
    nextWeek: bounds.nextWeek,
    days: bounds.days.map((date, index) => ({
      date,
      dayOfWeek: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ][index],
      status: date <= today ? "released" : "upcoming",
      entities: [],
    })),
    totalCount: 0,
  };
}

export async function loadReleaseWeekData(
  weekParam: string,
  customFetch: typeof fetch = fetch
): Promise<{ data: WeeklyReleasesResult; week: string }> {
  const bounds = parseIsoWeek(weekParam);
  if (!bounds) throw notFound();

  const response = await customFetch(
    `/api/releases?week=${encodeURIComponent(bounds.week)}`
  );
  const result = (await response.json()) as {
    status?: "data" | "empty" | "error";
    data?: WeeklyReleasesResult | null;
    error?: string;
  };
  if (!response.ok || result.status === "error") {
    throw new Error(result.error || "Release calendar request failed");
  }

  return {
    data: result.status === "data" && result.data
      ? result.data
      : createEmptyWeekResult(bounds),
    week: bounds.week,
  };
}

export function releaseWeekQueryOptions(week: string) {
  return {
    queryKey: ["release-week", week],
    queryFn: () => loadReleaseWeekData(week),
  };
}

/**
 * Pure HTTP request handler for /releases/$week.
 * Validates ISO-week parameter strictly and renders weekly discovery calendar.
 */
export async function handleWeekReleasesHttpRequest(
  request: Request,
  weekParam: string,
  explicitDb?: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const asOf = url.searchParams.get("as_of") || undefined;

  const bounds = parseIsoWeek(weekParam);
  if (!bounds) {
    const notFoundHtml = renderToString(<ReleaseWeekNotFoundView week={weekParam} />);
    return new Response(wrapHtml("Release Week Not Found - VaporStats", notFoundHtml), {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": CACHE_POLICIES.noStore,
      },
    });
  }

  const db = await getDb(explicitDb);
  const data = await getReleasesForWeek(db, bounds.week, { asOfDate: asOf });
  const fallbackData = data || createEmptyWeekResult(bounds, asOf);

  const appHtml = renderToString(<ReleasesWeekPageView data={fallbackData} />);
  const title = `Releases: Week ${bounds.weekNumber} (${bounds.week}) - VaporStats`;

  return new Response(wrapHtml(title, appHtml), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...getEntityCacheHeaders(),
    },
  });
}

function wrapHtml(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased font-sans">
  ${bodyContent}
</body>
</html>`;
}

export const Route = createFileRoute("/releases/$week")({
  ssr: false,
  headers: () => getPageCacheHeaders(),
  loader: ({ params, context }) => {
    if (!parseIsoWeek(params.week)) throw notFound();
    void context.queryClient.prefetchQuery(releaseWeekQueryOptions(params.week));
    return { week: params.week };
  },
  errorComponent: RouteDataError,
  pendingComponent: () => <RouteLoading label="Loading release calendar..." />,
  component: ReleasesWeekRouteComponent,
});

function ReleasesWeekRouteComponent() {
  const { week } = Route.useLoaderData();
  const { data, isLoading, isError } = useQuery(releaseWeekQueryOptions(week));

  if (isError) return <RouteDataError />;
  if (isLoading || !data) return <RouteLoading label="Loading release calendar..." />;

  return <ReleasesWeekPageView data={data.data} />;
}

