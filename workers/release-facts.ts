import type { D1Database } from "../src/lib/db";
import {
  parsePreciseReleaseDate,
  isReleaseEntityEligible,
  upsertReleaseFact,
  getCurrentIsoWeek,
} from "../src/lib/releases";


export interface SyncReleaseFactsOptions {
  limit?: number;
  offset?: number;
  asOfDate?: Date | string;
  apps?: Array<{
    appid: number;
    name: string;
    slug?: string;
    type: string;
    parent_appid?: number | null;
    release_date?: string | null;
    header_image?: string;
    is_eligible?: boolean;
    is_playable?: boolean;
  }>;
}

export interface SyncReleaseFactsResult {
  processedCount: number;
  persistedCount: number;
  skippedImpreciseCount: number;
  skippedIneligibleCount: number;
  currentIsoWeek: string;
}

interface RawCatalogAppRow {
  appid: number;
  name: string;
  slug: string;
  type: string;
  parent_appid: number | null;
  release_date: string | null;
  header_image: string;
  is_eligible: number;
  is_playable: number;
}

/**
 * Ingests and synchronizes precise release facts for eligible catalog entities.
 * Playable root games and consumer DLC / expansions are persisted.
 * Entities with imprecise dates (e.g. "2026", "Q3 2026", "Coming soon", null) are never invented and skipped.
 * Accessory apps (servers, tools, demos, tests, soundtracks) remain attached to parent pages and are excluded.
 */
export async function syncReleaseFactsFromApps(
  db: D1Database,
  options: SyncReleaseFactsOptions = {}
): Promise<SyncReleaseFactsResult> {
  const asOfDate = options.asOfDate ?? new Date();
  const currentIsoWeek = getCurrentIsoWeek(asOfDate);
  // Sanitize and clamp limit to finite integer in range 1..500
  let limit = 500;
  if (typeof options.limit === "number") {
    if (isNaN(options.limit) || !Number.isFinite(options.limit)) {
      limit = 500;
    } else {
      limit = Math.min(500, Math.max(1, Math.floor(options.limit)));
    }
  }

  // Sanitize and clamp offset to non-negative integer >= 0
  let offset = 0;
  if (typeof options.offset === "number") {
    if (isNaN(options.offset) || !Number.isFinite(options.offset)) {
      offset = 0;
    } else {
      offset = Math.max(0, Math.floor(options.offset));
    }
  }

  let candidateApps: Array<{
    appid: number;
    name: string;
    slug?: string;
    type: string;
    parent_appid?: number | null;
    release_date?: string | null;
    header_image?: string;
    is_eligible?: boolean;
    is_playable?: boolean;
  }> = [];

  if (options.apps) {
    // Strictly bound injected apps to sanitized limit
    candidateApps = options.apps.slice(0, limit);
  } else {
    const stmt = db
      .prepare(
        `SELECT appid, name, slug, type, parent_appid, release_date, header_image, is_eligible, is_playable
         FROM apps
         WHERE release_date IS NOT NULL
           AND is_eligible = 1
         ORDER BY appid ASC
         LIMIT ? OFFSET ?`
      )
      .bind(limit, offset);

    const res = await stmt.all<RawCatalogAppRow>();
    const rows = res.results || [];
    candidateApps = rows.map((r) => ({
      appid: r.appid,
      name: r.name,
      slug: r.slug,
      type: r.type,
      parent_appid: r.parent_appid,
      release_date: r.release_date,
      header_image: r.header_image,
      is_eligible: r.is_eligible === 1,
      is_playable: r.is_playable === 1,
    }));
  }

  let processedCount = 0;
  let persistedCount = 0;
  let skippedImpreciseCount = 0;
  let skippedIneligibleCount = 0;

  for (const app of candidateApps) {
    processedCount++;

    const isEligible = app.is_eligible !== false;
    const isPlayable = app.is_playable !== false;
    const parentAppId = app.parent_appid ?? null;

    if (!isReleaseEntityEligible(app.type, isEligible, isPlayable, parentAppId)) {
      skippedIneligibleCount++;
      continue;
    }

    const preciseDate = parsePreciseReleaseDate(app.release_date);
    if (!preciseDate) {
      skippedImpreciseCount++;
      continue;
    }

    const success = await upsertReleaseFact(
      db,
      {
        appid: app.appid,
        name: app.name,
        slug: app.slug,
        type: app.type,
        parent_appid: parentAppId,
        release_date: preciseDate,
        header_image: app.header_image,
        is_eligible: isEligible,
        is_playable: isPlayable,
      },
      asOfDate
    );

    if (success) {
      persistedCount++;
    }
  }

  return {
    processedCount,
    persistedCount,
    skippedImpreciseCount,
    skippedIneligibleCount,
    currentIsoWeek,
  };
}
