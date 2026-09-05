import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import {
  getReleasesForWeek,
  getRecentReleases,
  getCurrentIsoWeek,
  parseIsoWeek,
  createReleaseDataResponse,
  createReleaseEmptyResponse,
  createReleaseErrorResponse,
  type WeeklyReleasesResult,
  type ReleaseEntity,
} from "../lib/releases";

/**
 * Pure HTTP request handler for the releases API.
 * Supports:
 * - /api/releases: defaults to current UTC ISO week
 * - /api/releases?week=YYYY-Www: specific ISO week
 * - /api/releases?type=recent&limit=20: recent releases on or before current date
 * - as_of: optional date anchor (e.g. 2026-09-04) for deterministic evaluation
 *
 * Distinguishes data, empty, and error outcomes with live API caching (errors never cached).
 */
export async function handleReleasesApiRequest(
  request: Request,
  explicitDb?: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const typeParam = (url.searchParams.get("type") || "week").toLowerCase();
  const weekParam = url.searchParams.get("week");
  const asOfParam = url.searchParams.get("as_of") || undefined;
  const limitParam = url.searchParams.get("limit");

    if (asOfParam) {
      const d = new Date(asOfParam);
      if (isNaN(d.getTime())) {
        return createReleaseErrorResponse(
          `Invalid as_of date parameter: "${asOfParam}". Expected valid date (e.g. YYYY-MM-DD).`,
          400
        );
      }
    }
  try {
    const db = await getDb(explicitDb);

    if (typeParam === "recent") {
      let limit = 20;
      if (limitParam) {
        const parsed = parseInt(limitParam, 10);
        if (!isNaN(parsed) && parsed > 0) {
          limit = Math.min(parsed, 100);
        }
      }

      const recent = await getRecentReleases(db, { limit, asOfDate: asOfParam });
      if (recent.length === 0) {
        return createReleaseEmptyResponse("No recent releases found");
      }
      return createReleaseDataResponse(recent);
    }

    // Default: ISO week releases
    const targetWeek = weekParam ? weekParam.trim().toUpperCase() : getCurrentIsoWeek(asOfParam);

    const bounds = parseIsoWeek(targetWeek);
    if (!bounds) {
      return createReleaseErrorResponse(`Invalid ISO-8601 week format: "${weekParam}". Expected YYYY-Www.`, 400);
    }

    const result: WeeklyReleasesResult | null = await getReleasesForWeek(db, targetWeek, {
      asOfDate: asOfParam,
    });

    if (!result || result.totalCount === 0) {
      return createReleaseEmptyResponse(`No releases found for week ${targetWeek}`);
    }

    return createReleaseDataResponse(result);
  } catch (err: unknown) {
    console.error("Internal releases API error:", err);
    return createReleaseErrorResponse("Internal releases API error", 500);
  }
}

export const Route = createFileRoute("/api/releases")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = await getDb();
        return handleReleasesApiRequest(request, db);
      },
    },
  },
});

export async function GET({ request }: { request: Request }): Promise<Response> {
  const db = await getDb();
  return handleReleasesApiRequest(request, db);
}

export default handleReleasesApiRequest;
