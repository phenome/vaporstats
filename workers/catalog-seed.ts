import type { D1Database } from "../src/lib/db";
import { getCheckpoint, setCheckpoint, upsertApp, type ReleaseDateSource } from "../src/lib/catalog";
import { toSlug } from "../src/lib/slug";
import { upsertAppRelationship } from "../src/lib/related";
import { syncReleaseFactsFromApps } from "./release-facts";

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
  original_release_date?: string | null;
  steam_release_date?: string | null;
  original_steam_release_date?: string | null;
  release_from_early_access_date?: string | null;
  appdetails_release_date?: string | null;
  release_date_source?: ReleaseDateSource;
  is_coming_soon?: boolean | null;
  is_early_access?: boolean | null;
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
    appid: 740,
    parentAppId: 730,
    name: "Counter-Strike Dedicated Server",
    relationshipType: "server",
    prominence: 0,
    release_date: "2004-10-07",
  },
  {
    appid: 2138330,
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

export const INITIAL_SEED_APP_IDS: number[] = [
  730,
  1091500,
  570,
  440,
  1086940,
  1245620,
  252490,
  271590,
  1172470,
  550,
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

interface StoreBrowseRelease {
  original_release_date?: number | string | null;
  steam_release_date?: number | string | null;
  original_steam_release_date?: number | string | null;
  release_from_early_access_date?: number | string | null;
  is_coming_soon?: boolean | null;
  is_early_access?: boolean | null;
  [key: string]: unknown;
}

interface StoreBrowseItem {
  appid?: number | string;
  id?: number | string;
  release?: StoreBrowseRelease | null;
}

interface StoreBrowseResponse {
  response?: {
    store_items?: StoreBrowseItem[];
  };
  store_items?: StoreBrowseItem[];
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
const STORE_BROWSE_BATCH_SIZE = 50;
const STORE_BROWSE_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";

const losAngelesDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function unixSeconds(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function unixSecondsToLosAngelesDate(value: number | string | null | undefined): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const seconds = unixSeconds(value);
  if (seconds === null) {
    return null;
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = losAngelesDateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function storeBrowseAppId(item: StoreBrowseItem): number | null {
  const value = item.appid ?? item.id;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function releaseFields(
  release: StoreBrowseRelease | null | undefined,
  appdetailsReleaseDate: string | null
): Pick<
  SeedAppInput,
  | "release_date"
  | "release_date_source"
  | "original_release_date"
  | "steam_release_date"
  | "original_steam_release_date"
  | "release_from_early_access_date"
  | "appdetails_release_date"
  | "is_coming_soon"
  | "is_early_access"
> {
  const originalReleaseDate = unixSecondsToLosAngelesDate(
    release?.original_release_date ?? (release?.["originalReleaseDate"] as number | string | null | undefined)
  );
  const steamReleaseDate = unixSecondsToLosAngelesDate(
    release?.steam_release_date ?? (release?.["steamReleaseDate"] as number | string | null | undefined)
  );
  const originalSteamReleaseDate = unixSecondsToLosAngelesDate(
    release?.original_steam_release_date ?? (release?.["originalSteamReleaseDate"] as number | string | null | undefined)
  );
  const releaseFromEarlyAccessDate = unixSecondsToLosAngelesDate(
    release?.release_from_early_access_date ?? (release?.["releaseFromEarlyAccessDate"] as number | string | null | undefined)
  );

  const releaseDate = originalReleaseDate ?? steamReleaseDate ?? appdetailsReleaseDate;
  const releaseDateSource: ReleaseDateSource = originalReleaseDate
    ? "original_release_date"
    : steamReleaseDate
      ? "steam_release_date"
      : appdetailsReleaseDate
        ? "appdetails"
        : null;

  const rawEarlyAccess = release?.is_early_access ?? release?.["isEarlyAccess"];
  const isEarlyAccess = typeof rawEarlyAccess === "boolean" ? rawEarlyAccess : null;

  const rawComingSoon = release?.is_coming_soon ?? release?.["isComingSoon"];
  const isComingSoon = typeof rawComingSoon === "boolean" ? rawComingSoon : null;

  return {
    release_date: releaseDate,
    release_date_source: releaseDateSource,
    original_release_date: originalReleaseDate,
    steam_release_date: steamReleaseDate,
    original_steam_release_date: originalSteamReleaseDate,
    release_from_early_access_date: releaseFromEarlyAccessDate,
    appdetails_release_date: appdetailsReleaseDate,
    is_coming_soon: isComingSoon,
    is_early_access: isEarlyAccess,
  };
}

/**
 * Obtains Steam catalog metadata for one AppID. Release lifecycle metadata is
 * attached by the batched StoreBrowse request used by the import/refresh paths.
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
  const appdetailsReleaseDate = details.release_date?.date ?? null;
  return {
    appid: details.steam_appid,
    name: details.name,
    type: details.type,
    is_eligible: true,
    is_playable: details.type === "game",
    parent_appid: null,
    ...releaseFields(null, appdetailsReleaseDate),
    release_status: details.release_date?.coming_soon ? "upcoming" : "released",
    description: details.short_description ?? "",
    header_image: details.header_image ?? "",
    developer: details.developers?.[0] ?? "",
    publisher: details.publishers?.[0] ?? "",
  };
}

async function fetchStoreBrowseReleases(
  appIds: number[],
  customFetch: typeof fetch
): Promise<Map<number, StoreBrowseRelease | null>> {
  const releases = new Map<number, StoreBrowseRelease | null>();
  if (appIds.length === 0) {
    return releases;
  }

  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: {
      language: "english",
      country_code: "US",
      steam_realm: 1,
    },
    data_request: {
      include_release: true,
    },
  };
  const url = `${STORE_BROWSE_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await customFetch(url);
  if (!response.ok) {
    if (response.status === 429) {
      throw new SteamRateLimitError();
    }
    return releases;
  }

  try {
    const data = (await response.json()) as StoreBrowseResponse;
    const items = data.response?.store_items ?? data.store_items ?? [];
    for (const item of items) {
      const appid = storeBrowseAppId(item);
      if (appid !== null) {
        releases.set(appid, item.release ?? null);
      }
    }
  } catch {
    // Non-JSON or malformed StoreBrowse response
  }
  return releases;
}

async function fetchCatalogRecords(
  appIds: number[],
  customFetch: typeof fetch
): Promise<{ records: Map<number, SeedAppInput | null>; rateLimited: boolean }> {
  const records = new Map<number, SeedAppInput | null>();
  let rateLimited = false;

  for (let offset = 0; offset < appIds.length; offset += STORE_BROWSE_BATCH_SIZE) {
    const batch = appIds.slice(offset, offset + STORE_BROWSE_BATCH_SIZE);
    let releases = new Map<number, StoreBrowseRelease | null>();
    try {
      releases = await fetchStoreBrowseReleases(batch, customFetch);
    } catch (error) {
      if (isSteamRateLimitError(error)) {
        rateLimited = true;
        break;
      }
    }

    for (const appid of batch) {
      let record: SeedAppInput | null = null;
      try {
        record = await fetchSteamAppDetails(appid, customFetch);
      } catch (error) {
        if (isSteamRateLimitError(error)) {
          rateLimited = true;
          break;
        }
        records.set(appid, null);
        continue;
      }

      if (!record) {
        records.set(appid, null);
        continue;
      }

      const lifecycle = releaseFields(
        releases.get(appid),
        record.appdetails_release_date ?? record.release_date ?? null
      );
      records.set(appid, {
        ...record,
        ...lifecycle,
        release_status:
          lifecycle.is_coming_soon === true
            ? "upcoming"
            : lifecycle.is_coming_soon === false
              ? "released"
              : record.release_status,
      });
    }

    if (rateLimited) {
      break;
    }
  }

  return { records, rateLimited };
}

interface CatalogRefreshCheckpoint {
  pending: number[];
}

function normalizeAppIds(values: unknown[]): number[] {
  const seen = new Set<number>();
  const appIds: number[] = [];
  for (const value of values) {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : null;
    if (parsed !== null && Number.isInteger(parsed) && parsed > 0 && !seen.has(parsed)) {
      seen.add(parsed);
      appIds.push(parsed);
    }
  }
  return appIds;
}

function readCatalogRefreshCheckpoint(checkpoint: { value: string } | null): CatalogRefreshCheckpoint {
  if (!checkpoint) {
    return { pending: [] };
  }
  try {
    const value = JSON.parse(checkpoint.value) as { pending?: unknown };
    return {
      pending: Array.isArray(value.pending) ? normalizeAppIds(value.pending) : [],
    };
  } catch {
    return { pending: [] };
  }
}

export interface CatalogRefreshQueueResult {
  queued: number;
  alreadyQueued: boolean;
}

export interface CatalogRefreshQueueOptions {
  checkpointKey?: string;
  appIds?: number[];
}

/** Queues selected AppIDs, or the whole eligible catalog when appIds is omitted. */
export async function queueCatalogRefresh(
  db: D1Database,
  options: CatalogRefreshQueueOptions | string = {}
): Promise<CatalogRefreshQueueResult> {
  const normalizedOptions = typeof options === "string" ? { checkpointKey: options } : options;
  const checkpointKey = normalizedOptions.checkpointKey ?? CATALOG_REFRESH_CHECKPOINT_KEY;
  const existing = readCatalogRefreshCheckpoint(await getCheckpoint(db, checkpointKey));
  let requested: number[];

  if (normalizedOptions.appIds === undefined) {
    const result = await db
      .prepare("SELECT appid FROM apps WHERE is_eligible = 1 ORDER BY appid ASC")
      .all<{ appid: number }>();
    requested = normalizeAppIds((result.results ?? []).map((row) => row.appid));
  } else {
    requested = normalizeAppIds(normalizedOptions.appIds);
  }

  const pending = normalizeAppIds([...existing.pending, ...requested]);
  const alreadyQueued =
    requested.length > 0 && requested.every((appid) => existing.pending.includes(appid));
  await setCheckpoint(db, checkpointKey, JSON.stringify({ pending }), null);
  return { queued: pending.length, alreadyQueued };
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
 * Refreshes a bounded queue. Successful appdetails responses count toward the
 * target; ordinary failures rotate to the tail and 429 stops immediately.
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
  const working = [...checkpoint.pending];
  const retained: number[] = [];
  const records: SeedAppInput[] = [];
  let attempted = 0;
  let successful = 0;
  let failed = 0;
  let rateLimited = false;

  while (working.length > 0 && attempted < attemptCap && successful < successTarget) {
    const capacity = Math.min(
      STORE_BROWSE_BATCH_SIZE,
      working.length,
      attemptCap - attempted,
      successTarget - successful
    );
    const batchIds = working.splice(0, capacity);
    let releases: Map<number, StoreBrowseRelease | null>;
    try {
      releases = await fetchStoreBrowseReleases(batchIds, fetchFn);
    } catch (error) {
      if (isSteamRateLimitError(error)) {
        rateLimited = true;
        attempted += Math.min(1, batchIds.length);
        working.unshift(...batchIds);
        break;
      }
      retained.push(...batchIds);
      failed += batchIds.length;
      attempted += batchIds.length;
      continue;
    }

    let stoppedAt = batchIds.length;
    for (let index = 0; index < batchIds.length; index++) {
      const appid = batchIds[index];
      const existing = await db
        .prepare("SELECT appid, parent_appid, is_eligible, is_playable FROM apps WHERE appid = ?")
        .bind(appid)
        .first<{
          appid: number;
          parent_appid: number | null;
          is_eligible: number;
          is_playable: number;
        }>();

      if (!existing) {
        failed++;
        attempted++;
        retained.push(appid);
        continue;
      }

      let record: SeedAppInput | null;
      try {
        attempted++;
        record = await fetchSteamAppDetails(appid, fetchFn);
      } catch (error) {
        if (isSteamRateLimitError(error)) {
          rateLimited = true;
          stoppedAt = index;
          break;
        }
        failed++;
        retained.push(appid);
        continue;
      }

      if (!record) {
        failed++;
        retained.push(appid);
        continue;
      }

      const lifecycle = releaseFields(
        releases.get(appid),
        record.appdetails_release_date ?? record.release_date ?? null
      );
      const refreshedRecord = {
        ...record,
        type: record.type ?? (record.is_playable ? "game" : "accessory"),
        ...lifecycle,
        release_status:
          lifecycle.is_coming_soon === true
            ? "upcoming"
            : lifecycle.is_coming_soon === false
              ? "released"
              : record.release_status,
        parent_appid: existing.parent_appid,
        is_eligible: existing.is_eligible === 1,
        is_playable: existing.is_playable === 1,
      };

      try {
        await upsertApp(db, refreshedRecord);
        await syncReleaseFactsFromApps(db, { apps: [refreshedRecord] });
        successful++;
        records.push(refreshedRecord);
      } catch (error) {
        if (isSteamRateLimitError(error)) {
          rateLimited = true;
          stoppedAt = index;
          break;
        }
        failed++;
        retained.push(appid);
        continue;
      }
    }

    if (rateLimited) {
      working.unshift(...batchIds.slice(stoppedAt));
      break;
    }
  }

  const pending = normalizeAppIds([...working, ...retained]);
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

/** Runs bounded initial catalog seeding with Steam-derived records. */
export async function runBoundedCatalogImport(
  db: D1Database,
  options: SeedOptions = {}
): Promise<SeedResult> {
  let limit = DEFAULT_SEED_LIMIT;
  if (typeof options.limit === "number") {
    limit = Number.isFinite(options.limit)
      ? Math.min(50, Math.max(1, Math.floor(options.limit)))
      : DEFAULT_SEED_LIMIT;
  }

  const checkpointKey = options.checkpointKey ?? "initial_catalog_seed";
  const fetchFn = options.fetchFn ?? fetch;
  const candidateChildren = options.children ?? (options.appIds ? [] : CURATED_SEED_CHILDREN);
  let rateLimited = false;
  let recordsToImport: SeedAppInput[] = [];

  if (options.apps) {
    recordsToImport = options.apps.slice(0, limit);
  } else {
    const maxChildrenBudget = options.appIds
      ? 0
      : Math.min(candidateChildren.length, Math.floor(limit / 2));
    const rootLimit = Math.max(1, limit - maxChildrenBudget);
    const sourceIds = normalizeAppIds(options.appIds ?? INITIAL_SEED_APP_IDS).slice(0, rootLimit);
    const fetched = await fetchCatalogRecords(sourceIds, fetchFn);
    rateLimited = fetched.rateLimited;
    recordsToImport = sourceIds
      .map((appid) => fetched.records.get(appid) ?? null)
      .filter((record): record is SeedAppInput => record !== null);
  }

  let seededCount = 0;
  let playableCount = 0;
  let accessoryCount = 0;
  let lastAppId: number | null = null;
  const allImportedRecords: SeedAppInput[] = [];
  const importedAppIdSet = new Set<number>();

  for (const app of recordsToImport) {
    const isPlayable = app.is_playable ?? (app.type === "game" && !app.parent_appid);
    const isEligible = app.is_eligible ?? true;
    const type = app.type ?? (isPlayable ? "game" : "accessory");
    const record: SeedAppInput = {
      ...app,
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
      original_release_date: app.original_release_date ?? null,
      steam_release_date: app.steam_release_date ?? null,
      original_steam_release_date: app.original_steam_release_date ?? null,
      release_from_early_access_date: app.release_from_early_access_date ?? null,
      release_date_source: app.release_date_source ?? null,
      is_early_access: app.is_early_access ?? null,
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

  const remainingCapacity = Math.max(0, limit - allImportedRecords.length);
  const eligibleChildren = candidateChildren.filter((child) => importedAppIdSet.has(child.parentAppId));
  const childrenToImport = eligibleChildren.slice(0, remainingCapacity);
  let childRecords = new Map<number, SeedAppInput | null>();
  if (!options.apps && !rateLimited && childrenToImport.length > 0) {
    const fetchedChildren = await fetchCatalogRecords(
      childrenToImport.map((child) => child.appid),
      fetchFn
    );
    if (fetchedChildren.rateLimited) {
      rateLimited = true;
    }
    childRecords = fetchedChildren.records;
  }

  for (const child of childrenToImport) {
    if (rateLimited) {
      break;
    }
    const childRecord = childRecords.get(child.appid) ?? null;
    const childInput: SeedAppInput = {
      ...childRecord,
      appid: child.appid,
      name: childRecord?.name || child.name || `App ${child.appid}`,
      slug: toSlug(childRecord?.name || child.name || `App ${child.appid}`),
      type: child.relationshipType,
      is_eligible: true,
      is_playable: false,
      parent_appid: child.parentAppId,
      release_date: childRecord?.release_date || child.release_date || null,
      release_status: childRecord?.release_status || "released",
      description: childRecord?.description || "",
      header_image:
        childRecord?.header_image ||
        `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${child.appid}/header.jpg`,
      developer: childRecord?.developer || "",
      publisher: childRecord?.publisher || "",
      original_release_date: childRecord?.original_release_date ?? null,
      steam_release_date: childRecord?.steam_release_date ?? null,
      original_steam_release_date: childRecord?.original_steam_release_date ?? null,
      release_from_early_access_date: childRecord?.release_from_early_access_date ?? null,
      release_date_source: childRecord?.release_date_source ?? null,
      is_early_access: childRecord?.is_early_access ?? null,
    };

    await upsertApp(db, childInput);
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
