import type { D1Database } from "../src/lib/db";
import { getCheckpoint, setCheckpoint, upsertApp } from "../src/lib/catalog";
import { toSlug } from "../src/lib/slug";
import { upsertAppRelationship } from "../src/lib/related";

export interface SeedAppInput {
  appid: number;
  name: string;
  slug?: string;
  type?: string;
  is_eligible?: boolean;
  is_playable?: boolean;
  parent_appid?: number | null;
  release_date?: string | null;
  release_status?: string;
  description?: string;
  header_image?: string;
  developer?: string;
  publisher?: string;
}

export interface CuratedChildSeed {
  appid: number;
  parentAppId: number;
  name: string;
  relationshipType: "server" | "expansion" | "dlc";
  prominence: number;
  release_date?: string | null;
}

export const CURATED_SEED_CHILDREN: CuratedChildSeed[] = [
  {
    appid: 740, // Counter-Strike Dedicated Server under 730
    parentAppId: 730,
    name: "Counter-Strike Dedicated Server",
    relationshipType: "server",
    prominence: 0,
    release_date: "2004-10-07",
  },
  {
    appid: 2138330, // Cyberpunk 2077: Phantom Liberty under 1091500
    parentAppId: 1091500,
    name: "Cyberpunk 2077: Phantom Liberty",
    relationshipType: "expansion",
    prominence: 1,
    release_date: "2023-09-26",
  },
];

export interface SeedOptions {
  limit?: number;
  checkpointKey?: string;
  apps?: SeedAppInput[];
  appIds?: number[];
  children?: CuratedChildSeed[];
  fetchFn?: typeof fetch;
}

export interface SeedResult {
  seededCount: number;
  playableCount: number;
  accessoryCount: number;
  lastAppId: number | null;
  checkpointKey: string;
  records: SeedAppInput[];
  importedAppIds: number[];
}

export const DEFAULT_SEED_LIMIT = 50;

/**
 * Curated bounded AppID list for initial seed discovery.
 * Bounds initial seed to high-value titles without unbounded catalog scanning.
 * Curated parents (730 and 1091500) lead the list so children can attach within small budgets.
 */
export const INITIAL_SEED_APP_IDS: number[] = [
  730,     // Counter-Strike 2 (parent of 740)
  1091500, // Cyberpunk 2077 (parent of 2138330)
  570,     // Dota 2
  440,     // Team Fortress 2
  1086940, // Baldur's Gate 3
  1245620, // ELDEN RING
  252490,  // Rust
  271590,  // Grand Theft Auto V
  1172470, // Apex Legends
  550,     // Left 4 Dead 2
];

interface SteamAppDetailsResponse {
  [appid: string]: {
    success: boolean;
    data?: {
      type: string;
      name: string;
      steam_appid: number;
      is_free?: boolean;
      short_description?: string;
      header_image?: string;
      developers?: string[];
      publishers?: string[];
      release_date?: {
        coming_soon: boolean;
        date: string;
      };
    };
  };
}

class SteamRateLimitError extends Error {
  constructor() {
    super("Steam rate limit reached");
    this.name = "SteamRateLimitError";
  }
}

function isSteamRateLimitError(error: unknown): error is SteamRateLimitError {
  return error instanceof SteamRateLimitError;
}

export const CATALOG_REFRESH_CHECKPOINT_KEY = "catalog_metadata_refresh";
export const CATALOG_REFRESH_SUCCESS_TARGET = 10;
export const CATALOG_REFRESH_ATTEMPT_CAP = 20;

/**
 * Obtains the storefront's displayed original release date.
 * Steam's appdetails endpoint can expose a later re-release date instead.
 */
function parseStorefrontReleaseDate(html: string): string | null {
  const match = html.match(
    /<div class="subtitle column">\s*Release Date:\s*<\/div>\s*<div class="date">\s*([^<]+?)\s*<\/div>/i
  );
  return match?.[1]?.trim() || null;
}

/**
 * Obtains Steam-derived app record for a specific AppID via Steam store API.
 * Supports injectable fetchFn for tests and worker runtime.
 */
export async function fetchSteamAppDetails(
  appid: number,
  customFetch: typeof fetch = fetch
): Promise<SeedAppInput | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;
  const response = await customFetch(url);
  if (!response.ok) {
    if (response.status === 429) {
      throw new SteamRateLimitError();
    }
    return null;
  }

  const data = (await response.json()) as SteamAppDetailsResponse;
  const appData = data[appid.toString()];

  if (!appData || !appData.success || !appData.data) {
    return null;
  }

  const details = appData.data;
  const releaseStatus = details.release_date?.coming_soon ? "upcoming" : "released";
  let releaseDate = details.release_date?.date ?? null;

  try {
    const storefrontResponse = await customFetch(
      `https://store.steampowered.com/app/${appid}/?cc=us&l=english`
    );
    if (storefrontResponse.status === 429) {
      throw new SteamRateLimitError();
    }
    if (storefrontResponse.ok) {
      releaseDate = parseStorefrontReleaseDate(await storefrontResponse.text()) ?? releaseDate;
    }
  } catch (error) {
    if (isSteamRateLimitError(error)) {
      throw error;
    }
    // Keep the API date when the storefront request is unavailable.
  }

  return {
    appid: details.steam_appid,
    name: details.name,
    type: details.type,
    is_eligible: true,
    is_playable: details.type === "game",
    parent_appid: null,
    release_date: releaseDate,
    release_status: releaseStatus,
    description: details.short_description ?? "",
    header_image: details.header_image ?? "",
    developer: details.developers?.[0] ?? "",
    publisher: details.publishers?.[0] ?? "",
  };
}

interface CatalogRefreshCheckpoint {
  pending: number[];
}

function readCatalogRefreshCheckpoint(checkpoint: { value: string } | null): CatalogRefreshCheckpoint {
  if (!checkpoint) {
    return { pending: [] };
  }

  try {
    const value = JSON.parse(checkpoint.value) as { pending?: unknown };
    return {
      pending: Array.isArray(value.pending)
        ? value.pending.filter((appid): appid is number => Number.isInteger(appid) && appid > 0)
        : [],
    };
  } catch {
    return { pending: [] };
  }
}

export interface CatalogRefreshQueueResult {
  queued: number;
  alreadyQueued: boolean;
}

/**
 * Queues every eligible catalog AppID for one bounded metadata refresh pass.
 * The checkpoint is the stale marker; no schema column is needed.
 */
export async function queueCatalogRefresh(
  db: D1Database,
  checkpointKey = CATALOG_REFRESH_CHECKPOINT_KEY
): Promise<CatalogRefreshQueueResult> {
  const existing = readCatalogRefreshCheckpoint(await getCheckpoint(db, checkpointKey));
  if (existing.pending.length > 0) {
    return { queued: existing.pending.length, alreadyQueued: true };
  }

  const result = await db
    .prepare("SELECT appid FROM apps WHERE is_eligible = 1 ORDER BY appid ASC")
    .all<{ appid: number }>();
  const pending = (result.results ?? []).map((row) => row.appid);
  await setCheckpoint(db, checkpointKey, JSON.stringify({ pending }), null);
  return { queued: pending.length, alreadyQueued: false };
}

export interface CatalogRefreshBatchOptions {
  checkpointKey?: string;
  successTarget?: number;
  attemptCap?: number;
  fetchFn?: typeof fetch;
}

export interface CatalogRefreshBatchResult {
  active: boolean;
  attempted: number;
  successful: number;
  failed: number;
  rateLimited: boolean;
  pending: number;
  records: SeedAppInput[];
}

/**
 * Refreshes a bounded number of queued catalog records and leaves the rest checkpointed.
 * Ordinary failures are skipped; a Steam 429 leaves the current AppID queued for retry.
 */
export async function refreshCatalogBatch(
  db: D1Database,
  options: CatalogRefreshBatchOptions = {}
): Promise<CatalogRefreshBatchResult> {
  const checkpointKey = options.checkpointKey ?? CATALOG_REFRESH_CHECKPOINT_KEY;
  const checkpoint = readCatalogRefreshCheckpoint(await getCheckpoint(db, checkpointKey));
  if (checkpoint.pending.length === 0) {
    return {
      active: false,
      attempted: 0,
      successful: 0,
      failed: 0,
      rateLimited: false,
      pending: 0,
      records: [],
    };
  }

  const successTarget =
    typeof options.successTarget === "number" && Number.isFinite(options.successTarget)
      ? Math.max(1, Math.min(50, Math.floor(options.successTarget)))
      : CATALOG_REFRESH_SUCCESS_TARGET;
  const attemptCap =
    typeof options.attemptCap === "number" && Number.isFinite(options.attemptCap)
      ? Math.max(successTarget, Math.min(100, Math.floor(options.attemptCap)))
      : CATALOG_REFRESH_ATTEMPT_CAP;
  const fetchFn = options.fetchFn ?? fetch;
  let index = 0;
  let attempted = 0;
  let successful = 0;
  let failed = 0;
  let rateLimited = false;
  const records: SeedAppInput[] = [];

  while (
    index < checkpoint.pending.length &&
    attempted < attemptCap &&
    successful < successTarget
  ) {
    const appid = checkpoint.pending[index];
    const existing = await db
      .prepare(
        "SELECT appid, parent_appid, is_eligible, is_playable FROM apps WHERE appid = ?"
      )
      .bind(appid)
      .first<{
        appid: number;
        parent_appid: number | null;
        is_eligible: number;
        is_playable: number;
      }>();

    if (!existing) {
      index++;
      continue;
    }

    let record: SeedAppInput | null = null;
    try {
      attempted++;
      record = await fetchSteamAppDetails(appid, fetchFn);
    } catch (error) {
      if (isSteamRateLimitError(error)) {
        rateLimited = true;
        break;
      }
      failed++;
      index++;
      continue;
    }

    index++;
    if (!record) {
      failed++;
      continue;
    }

    const refreshedRecord: SeedAppInput = {
      ...record,
      parent_appid: existing.parent_appid,
      is_eligible: existing.is_eligible === 1,
      is_playable: existing.is_playable === 1,
    };
    await upsertApp(db, refreshedRecord);
    records.push(refreshedRecord);
    successful++;
  }

  const pending = checkpoint.pending.slice(index);
  await setCheckpoint(db, checkpointKey, JSON.stringify({ pending }), null);

  return {
    active: pending.length > 0,
    attempted,
    successful,
    failed,
    rateLimited,
    pending: pending.length,
    records,
  };
}


/**
 * Runs bounded initial catalog seeding with Steam-derived records.
 * Hard-clamped to a finite integer in range 1..50 (sanitizes NaN, negative, fractional, huge values).
 * Total imported roots + curated children strictly never exceeds limit.
 * Curated children are only imported if their parent was imported in this run.
 */
export async function runBoundedCatalogImport(
  db: D1Database,
  options: SeedOptions = {}
): Promise<SeedResult> {
  // Sanitize limit to finite integer in range 1..50
  let limit = DEFAULT_SEED_LIMIT;
  if (typeof options.limit === "number") {
    if (isNaN(options.limit) || !Number.isFinite(options.limit)) {
      limit = DEFAULT_SEED_LIMIT;
    } else {
      limit = Math.min(50, Math.max(1, Math.floor(options.limit)));
    }
  }

  const checkpointKey = options.checkpointKey ?? "initial_catalog_seed";
  const fetchFn = options.fetchFn ?? fetch;

  // Curated children to consider (only if not restricted by explicit appIds)
  const candidateChildren = options.children ?? (options.appIds ? [] : CURATED_SEED_CHILDREN);

  let rateLimited = false;
  let recordsToImport: SeedAppInput[] = [];

  if (options.apps) {
    // Directly provided records (slice against limit)
    recordsToImport = options.apps.slice(0, limit);
  } else {
    // Budget root slots so total (roots + children) never exceeds limit
    const maxChildrenBudget = options.appIds ? 0 : Math.min(candidateChildren.length, Math.floor(limit / 2));
    const rootLimit = Math.max(1, limit - maxChildrenBudget);
    const sourceIds = (options.appIds ?? INITIAL_SEED_APP_IDS).slice(0, rootLimit);

    for (const appid of sourceIds) {
      try {
        const record = await fetchSteamAppDetails(appid, fetchFn);
        if (record) {
          recordsToImport.push(record);
        }
      } catch (error) {
        if (isSteamRateLimitError(error)) {
          rateLimited = true;
          break;
        }
        throw error;
      }
    }
  }

  let seededCount = 0;
  let playableCount = 0;
  let accessoryCount = 0;
  let lastAppId: number | null = null;
  const allImportedRecords: SeedAppInput[] = [];
  const importedAppIdSet = new Set<number>();

  // 1. Upsert root records
  for (const app of recordsToImport) {
    const isPlayable = app.is_playable ?? (app.type === "game" && !app.parent_appid);
    const isEligible = app.is_eligible ?? true;
    const type = app.type ?? (isPlayable ? "game" : "accessory");

    const record: SeedAppInput = {
      appid: app.appid,
      name: app.name,
      slug: toSlug(app.name),
      type,
      is_eligible: isEligible,
      is_playable: isPlayable,
      parent_appid: app.parent_appid ?? null,
      release_date: app.release_date ?? null,
      release_status: app.release_status ?? "released",
      description: app.description ?? "",
      header_image:
        app.header_image ||
        `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${app.appid}/header.jpg`,
      developer: app.developer ?? "",
      publisher: app.publisher ?? "",
    };

    await upsertApp(db, record);

    seededCount++;
    if (isPlayable && isEligible && !app.parent_appid) {
      playableCount++;
    } else {
      accessoryCount++;
    }
    lastAppId = app.appid;
    allImportedRecords.push(record);
    importedAppIdSet.add(app.appid);
  }

  // 2. Curated children are only imported if their parent was imported in this run
  // Slice eligible children against remaining capacity to strictly respect limit
  const remainingCapacity = Math.max(0, limit - allImportedRecords.length);
  const eligibleChildren = candidateChildren.filter((child) => importedAppIdSet.has(child.parentAppId));
  const childrenToImport = eligibleChildren.slice(0, remainingCapacity);

  for (const child of childrenToImport) {
    if (rateLimited) {
      break;
    }
    let childRecord: SeedAppInput | null = null;
    if (!options.apps) {
      try {
        childRecord = await fetchSteamAppDetails(child.appid, fetchFn);
      } catch (error) {
        if (isSteamRateLimitError(error)) {
          break;
        }
        throw error;
      }
    }

    const childInput: SeedAppInput = {
      appid: child.appid,
      name: childRecord?.name || child.name || `App ${child.appid}`,
      slug: toSlug(childRecord?.name || child.name || `App ${child.appid}`),
      type: child.relationshipType,
      is_eligible: true,
      is_playable: false, // Force children non-playable
      parent_appid: child.parentAppId,
      release_date: childRecord?.release_date || child.release_date || null,
      release_status: childRecord?.release_status || "released",
      description: childRecord?.description || "",
      header_image:
        childRecord?.header_image ||
        `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${child.appid}/header.jpg`,
      developer: childRecord?.developer || "",
      publisher: childRecord?.publisher || "",
    };

    // Upsert child app row
    await upsertApp(db, childInput);

    // Upsert relationship between parent and child
    await upsertAppRelationship(db, {
      parent_appid: child.parentAppId,
      child_appid: child.appid,
      relationship_type: child.relationshipType,
      prominence: child.prominence,
    });

    seededCount++;
    accessoryCount++;
    lastAppId = child.appid;
    allImportedRecords.push(childInput);
    importedAppIdSet.add(child.appid);
  }

  // Record checkpoint to persist seeding progress
  await setCheckpoint(db, checkpointKey, `seeded:${seededCount}`, lastAppId);

  return {
    seededCount,
    playableCount,
    accessoryCount,
    lastAppId,
    checkpointKey,
    records: allImportedRecords,
    importedAppIds: Array.from(importedAppIdSet),
  };
}

export const runCatalogSeed = runBoundedCatalogImport;
