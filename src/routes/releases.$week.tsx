import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { getDb, type D1Database } from "../lib/db";
import {
  getReleasesForWeek,
  parseIsoWeek,
  type IsoWeekBounds,
  type WeeklyReleasesResult,
} from "../lib/releases";
import { ReleaseCalendar } from "../components/release-calendar";
import { CACHE_POLICIES, getEntityCacheHeaders, getPageCacheHeaders } from "../lib/cache";

export interface ReleasesWeekPageViewProps {
  data: WeeklyReleasesResult;
}

export function ReleasesWeekPageView({ data }: ReleasesWeekPageViewProps) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      <ReleaseCalendar
        data={data}
        showNavigation={true}
        title={`Release Calendar: Week ${data.weekNumber}`}
        description={`${data.startDate} through ${data.endDate} (UTC)`}
      />
    </div>
  );
}

export function ReleaseWeekNotFoundView({ week }: { week: string }) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4 font-mono">
      <div className="text-2xl font-bold text-zinc-100">Invalid Release Week</div>
      <p className="text-sm text-zinc-400 max-w-md mx-auto">
        The requested week <span className="text-orange-400 font-bold">"{week}"</span> is not a valid ISO-8601 calendar week format (expected YYYY-Www).
      </p>
      <div className="pt-4">
        <a
          href="/releases"
          className="px-4 py-2 text-xs uppercase tracking-wider font-semibold border border-orange-500 text-orange-400 bg-orange-950/40 hover:bg-orange-900/40 transition-colors inline-block"
        >
          Go to Current Week
        </a>
      </div>
    </div>
  );
}


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

/**
 * Pure HTTP request handler for /releases/$week.
 * Validates ISO-week parameter strictly and renders weekly discovery calendar.
 */
export async function handleWeekReleasesHttpRequest(
  request: Request,
  weekParam: string,
  explicitDb?: D1Database
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

  // If week exists in calendar, render calendar (even if 0 releases, it shows the 7 days)
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
  loader: async ({ params }) => loadReleaseWeekData(params.week),
  component: ReleasesWeekRouteComponent,
});

function ReleasesWeekRouteComponent() {
  const loaderData = Route.useLoaderData();
  return <ReleasesWeekPageView data={loaderData.data!} />;
}

export default ReleasesWeekPageView;
