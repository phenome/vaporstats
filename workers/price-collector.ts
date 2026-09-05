import type { AppDatabase } from "../src/lib/db";
import { getCheckpoint, setCheckpoint, upsertApp } from "../src/lib/catalog";
import { recordPriceObservation, type PriceState } from "../src/lib/prices";

export const DEFAULT_PRICE_CHECKPOINT_KEY = "steam_catalog_feed";
const INITIAL_CATALOG_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;

export interface CatalogFeedApp {
  appid: number;
  name?: string;
  last_modified?: number;
  price_change_number?: number;
}

export interface CatalogFeedResponse {
  response?: {
    apps?: CatalogFeedApp[];
    have_more_results?: boolean;
    last_appid?: number;
  };
}

export interface SteamPriceOverview {
  currency: string;
  initial: number;
  final: number;
  discount_percent: number;
  initial_formatted?: string;
  final_formatted?: string;
}

export interface SteamStoreAppData {
  type?: string;
  name?: string;
  steam_appid?: number;
  is_free?: boolean;
  short_description?: string;
  header_image?: string;
  developers?: string[];
  publishers?: string[];
  fullgame?: { appid?: number; name?: string };
  release_date?: {
    coming_soon?: boolean;
    date?: string;
  };
  price_overview?: SteamPriceOverview;
}

export interface SteamStoreAppDetails {
  [appid: string]: {
    success: boolean;
    data?: SteamStoreAppData;
  };
}

export interface PriceDetailsResult {
  appid: number;
  success: boolean;
  rateLimited: boolean;
  currency: string;
  catalogApp: Parameters<typeof upsertApp>[1] | null;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number;
  is_free: boolean;
  is_available: boolean;
  formatted_initial: string | null;
  formatted_final: string | null;
}

function toCatalogApp(details: SteamStoreAppData): Parameters<typeof upsertApp>[1] | null {
  const appid = details.steam_appid;
  const name = details.name?.trim();
  const type = details.type?.toLowerCase() ?? "";
  if (!Number.isInteger(appid) || !appid || !name) return null;

  const parentAppId =
    type === "dlc" && Number.isInteger(details.fullgame?.appid)
      ? details.fullgame!.appid!
      : null;
  const isPlayable = type === "game";
  const isEligible = isPlayable || (type === "dlc" && parentAppId !== null);

  return {
    appid,
    name,
    type: type || "unknown",
    is_eligible: isEligible,
    is_playable: isPlayable,
    parent_appid: parentAppId,
    release_date: details.release_date?.date || null,
    release_status: details.release_date?.coming_soon ? "upcoming" : "released",
    description: details.short_description ?? "",
    header_image:
      details.header_image ||
      `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    developer: details.developers?.[0] ?? "",
    publisher: details.publishers?.[0] ?? "",
  };
}

function unavailablePriceDetails(
  appid: number,
  success: boolean,
  rateLimited = false
): PriceDetailsResult {
  return {
    appid,
    success,
    catalogApp: null,
    rateLimited,
    currency: "USD",
    initial_price: null,
    final_price: null,
    discount_percent: 0,
    is_free: false,
    is_available: false,
    formatted_initial: null,
    formatted_final: null,
  };
}

/**
 * Fetches incremental catalog updates from documented Steam IStoreService/GetAppList endpoint.
 * Requires valid Steam API key; returns empty/null if key is missing or request fails.
 */
export async function fetchSteamCatalogFeed(
  apiKey: string | undefined,
  options: {
    ifModifiedSince?: number;
    lastAppId?: number;
    maxResults?: number;
    customFetch?: typeof fetch;
  } = {}
): Promise<{
  apps: CatalogFeedApp[];
  lastModified: number | null;
  haveMoreResults: boolean;
  lastAppId: number | null;
} | null> {
  if (!apiKey) {
    return null;
  }

  const customFetch = options.customFetch ?? fetch;
  const maxResults = options.maxResults ?? 10000;

  const url = new URL("https://api.steampowered.com/IStoreService/GetAppList/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("include_games", "1");
  url.searchParams.set("include_dlc", "1");
  url.searchParams.set("include_software", "0");
  url.searchParams.set("include_videos", "0");
  url.searchParams.set("include_hardware", "0");
  url.searchParams.set("max_results", String(maxResults));

  if (options.ifModifiedSince !== undefined && options.ifModifiedSince > 0) {
    url.searchParams.set("if_modified_since", String(options.ifModifiedSince));
  }
  if (options.lastAppId !== undefined && options.lastAppId > 0) {
    url.searchParams.set("last_appid", String(options.lastAppId));
  }

  try {
    const res = await customFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.error(`Steam catalog feed fetch failed: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as CatalogFeedResponse;
    const apps = data?.response?.apps ?? [];

    let highestModified: number | null = null;
    for (const app of apps) {
      if (typeof app.last_modified === "number") {
        if (highestModified === null || app.last_modified > highestModified) {
          highestModified = app.last_modified;
        }
      }
    }

    return {
      apps,
      lastModified: highestModified,
      haveMoreResults: data.response?.have_more_results === true,
      lastAppId:
        typeof data.response?.last_appid === "number" ? data.response.last_appid : null,
    };
  } catch (err: unknown) {
    console.error(`Steam catalog feed fetch threw: ${err}`);
    return null;
  }
}

/**
 * Fetches store price details for a specific AppID from Steam Storefront API.
 * Accurately models free vs unpriced/unavailable vs priced.
 * Returns success: false on network/API failure so callers preserve prior state.
 */
export async function fetchSteamPriceDetails(
  appid: number,
  options: { customFetch?: typeof fetch } = {}
): Promise<PriceDetailsResult> {
  const customFetch = options.customFetch ?? fetch;
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;

  try {
    const res = await customFetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      return unavailablePriceDetails(appid, false, res.status === 429);
    }

    const json = (await res.json()) as SteamStoreAppDetails;
    const entry = json[String(appid)];

    if (entry && !entry.success) {
      return unavailablePriceDetails(appid, true);
    }
    if (!entry?.data) {
      return unavailablePriceDetails(appid, false);
    }

    const details = entry.data;
    const catalogApp = toCatalogApp(details);

    if (details.is_free === true) {
      return {
        appid,
        success: true,
        rateLimited: false,
        catalogApp,
        currency: "USD",
        initial_price: 0,
        final_price: 0,
        discount_percent: 0,
        is_free: true,
        is_available: true,
        formatted_initial: "Free",
        formatted_final: "Free",
      };
    }

    if (details.price_overview) {
      const po = details.price_overview;
      return {
        appid,
        success: true,
        rateLimited: false,
        catalogApp,
        currency: po.currency || "USD",
        initial_price: po.initial,
        final_price: po.final,
        discount_percent: po.discount_percent ?? 0,
        is_free: false,
        is_available: true,
        formatted_initial: po.initial_formatted ?? null,
        formatted_final: po.final_formatted ?? null,
      };
    }

    return { ...unavailablePriceDetails(appid, true), catalogApp };
  } catch {
    return unavailablePriceDetails(appid, false);
  }
}

/**
 * Refreshes prices strictly for the indicated AppIDs.
 * NEVER sweeps or iterates across the whole catalog.
 * Preserves prior state on failed refresh.
 */
export async function refreshIndicatedAppPrices(
  db: AppDatabase,
  appids: number[],
  options: {
    customFetch?: typeof fetch;
    anchorTime?: Date;
    successTarget?: number;
    attemptCap?: number;
  } = {}
): Promise<{
  attempted: number;
  successful: number;
  failed: number;
  changed: number;
  changedAppIds: number[];
  rateLimited: boolean;
  pendingAppIds: number[];
}> {
  const customFetch = options.customFetch ?? fetch;
  const anchorTime = options.anchorTime ?? new Date();
  const observedAt = anchorTime.toISOString();
  const successTarget = Math.max(0, Math.floor(options.successTarget ?? appids.length));
  const attemptCap = Math.max(0, Math.floor(options.attemptCap ?? appids.length));

  let attempted = 0;
  let successful = 0;
  let failed = 0;
  let changed = 0;
  let rateLimited = false;
  const pendingAppIds: number[] = [];
  const changedAppIds: number[] = [];

  let index = 0;
  for (; index < appids.length && attempted < attemptCap && successful < successTarget; index++) {
    const appid = appids[index];
    attempted++;
    const priceDetails = await fetchSteamPriceDetails(appid, { customFetch });

    if (!priceDetails.success) {
      failed++;
      pendingAppIds.push(appid);
      if (priceDetails.rateLimited) {
        rateLimited = true;
        index++;
        break;
      }
      continue;
    }

    if (priceDetails.catalogApp) {
      const existingApp = await db
        .prepare("SELECT appid FROM apps WHERE appid = ?")
        .bind(appid)
        .first<{ appid: number }>();
      if (!existingApp) {
        await upsertApp(db, priceDetails.catalogApp);
      }
    }
    successful++;
    const recordResult = await recordPriceObservation(db, {
      appid,
      currency: priceDetails.currency,
      initial_price: priceDetails.initial_price,
      final_price: priceDetails.final_price,
      discount_percent: priceDetails.discount_percent,
      is_free: priceDetails.is_free,
      is_available: priceDetails.is_available,
      formatted_initial: priceDetails.formatted_initial,
      formatted_final: priceDetails.formatted_final,
      observed_at: observedAt,
    });

    if (recordResult.stateChanged) {
      changed++;
      changedAppIds.push(appid);
    }
  }
  for (; index < appids.length; index++) {
    pendingAppIds.push(appids[index]);
  }

  return { attempted, successful, failed, changed, changedAppIds, rateLimited, pendingAppIds };
}

interface PriceFeedCheckpointValue {
  pending: number[];
  catalogBackfillQueued: boolean;
  continuationAppId: number | null;
  continuationLastModified: number | null;
  orphanRecoveryCursor: number | null;
  orphanRecoveryComplete: boolean;
}

function readPriceFeedCheckpoint(checkpoint: { value: string } | null): PriceFeedCheckpointValue {
  if (!checkpoint) {
    return {
      pending: [],
      catalogBackfillQueued: false,
      continuationAppId: null,
      continuationLastModified: null,
      orphanRecoveryCursor: null,
      orphanRecoveryComplete: false,
    };
  }
  try {
    const value = JSON.parse(checkpoint.value) as {
      pending?: unknown;
      catalogBackfillQueued?: unknown;
      continuationAppId?: unknown;
      continuationLastModified?: unknown;
      orphanRecoveryCursor?: unknown;
      orphanRecoveryComplete?: unknown;
    };
    return {
      pending: Array.isArray(value.pending)
        ? value.pending.filter((appid): appid is number => Number.isInteger(appid) && appid > 0)
        : [],
      catalogBackfillQueued: value.catalogBackfillQueued === true,
      continuationAppId:
        typeof value.continuationAppId === "number" ? value.continuationAppId : null,
      continuationLastModified:
        typeof value.continuationLastModified === "number"
          ? value.continuationLastModified
          : null,
      orphanRecoveryCursor:
        typeof value.orphanRecoveryCursor === "number" ? value.orphanRecoveryCursor : null,
      orphanRecoveryComplete: value.orphanRecoveryComplete === true,
    };
  } catch {
    return {
      pending: [],
      catalogBackfillQueued: false,
      continuationAppId: null,
      continuationLastModified: null,
      orphanRecoveryCursor: null,
      orphanRecoveryComplete: false,
    };
  }
}

async function getOrphanedPriceAppIds(
  db: AppDatabase,
  afterAppId: number | null,
  limit = 200
): Promise<{ appids: number[]; cursor: number | null; complete: boolean }> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await db
    .prepare(
      `SELECT p.appid
       FROM app_prices p
       LEFT JOIN apps a ON a.appid = p.appid
       WHERE a.appid IS NULL
         AND (? IS NULL OR p.appid > ?)
       ORDER BY p.appid ASC
       LIMIT ?`
    )
    .bind(afterAppId, afterAppId, boundedLimit)
    .all<{ appid: number }>();
  const appids = (result.results ?? []).map((row) => row.appid);
  const cursor = appids.at(-1) ?? afterAppId;
  return { appids, cursor, complete: appids.length < boundedLimit };
}


export interface HourlyPriceFeedTickResult {
  executed: boolean;
  reason?: string;
  appsIndicated: number;
  attempted: number;
  successful: number;
  failed: number;
  changed: number;
  changedAppIds: number[];
  rateLimited: boolean;
  pending: number;
  checkpointAdvanced: boolean;
  checkpointCursor: number | null;
}

/**
 * Ten-minute scheduled tick:
 * - Drains retained work before requesting more catalog changes
 * - Checks the incremental Steam catalog feed when credentials exist
 * - Refreshes details ONLY for indicated apps (no catalog-wide sweep)
 * - Advances the feed cursor while retaining failed/unprocessed app IDs
 */
export async function runHourlyPriceFeedTick(
  db: AppDatabase,
  options: {
    apiKey?: string;
    customFetch?: typeof fetch;
    anchorTime?: Date;
    checkpointKey?: string;
    maxAppsToProcess?: number;
  } = {}
): Promise<HourlyPriceFeedTickResult> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    return {
      executed: false,
      reason: "missing_credentials",
      appsIndicated: 0,
      attempted: 0,
      successful: 0,
      failed: 0,
      rateLimited: false,
      pending: 0,
      changed: 0,
      changedAppIds: [],
      checkpointAdvanced: false,
      checkpointCursor: null,
    };
  }

  const checkpointKey = options.checkpointKey ?? DEFAULT_PRICE_CHECKPOINT_KEY;
  const customFetch = options.customFetch ?? fetch;
  const anchorTime = options.anchorTime ?? new Date();
  const existingCheckpoint = await getCheckpoint(db, checkpointKey);
  const checkpointValue = readPriceFeedCheckpoint(existingCheckpoint);
  let pendingBeforeFeed = checkpointValue.pending;
  let orphanRecoveryCursor = checkpointValue.orphanRecoveryCursor;
  let orphanRecoveryComplete = checkpointValue.orphanRecoveryComplete;
  const storedCursor = existingCheckpoint?.cursor ?? null;
  const recoveryCutoff =
    Math.floor(anchorTime.getTime() / 1000) - INITIAL_CATALOG_LOOKBACK_SECONDS;
  const feedCursor =
    !checkpointValue.catalogBackfillQueued &&
    (storedCursor === null || storedCursor > recoveryCutoff)
      ? recoveryCutoff
      : storedCursor;

  if (!orphanRecoveryComplete && pendingBeforeFeed.length === 0) {
    const orphaned = await getOrphanedPriceAppIds(db, orphanRecoveryCursor);
    pendingBeforeFeed = orphaned.appids;
    orphanRecoveryCursor = orphaned.cursor;
    orphanRecoveryComplete = orphaned.complete;
    await setCheckpoint(
      db,
      checkpointKey,
      JSON.stringify({
        pending: pendingBeforeFeed,
        catalogBackfillQueued: true,
        orphanRecoveryCursor,
        orphanRecoveryComplete,
        ...(checkpointValue.continuationAppId !== null
          ? { continuationAppId: checkpointValue.continuationAppId }
          : {}),
        ...(checkpointValue.continuationLastModified !== null
          ? { continuationLastModified: checkpointValue.continuationLastModified }
          : {}),
      }),
      storedCursor
    );
  }

  const fetchedPage = pendingBeforeFeed.length === 0;
  const feedResult = fetchedPage
    ? await fetchSteamCatalogFeed(apiKey, {
        ifModifiedSince: feedCursor ?? undefined,
        lastAppId: checkpointValue.continuationAppId ?? undefined,
        maxResults: options.maxAppsToProcess ?? 200,
        customFetch,
      })
    : { apps: [], lastModified: null, haveMoreResults: false, lastAppId: null };

  if (!feedResult) {
    return {
      executed: false,
      reason: "feed_fetch_failed",
      appsIndicated: pendingBeforeFeed.length,
      attempted: 0,
      successful: 0,
      failed: 0,
      rateLimited: false,
      pending: pendingBeforeFeed.length,
      changed: 0,
      changedAppIds: [],
      checkpointAdvanced: false,
      checkpointCursor: existingCheckpoint?.cursor ?? null,
    };
  }

  const indicatedAppIds = [
    ...new Set([...pendingBeforeFeed, ...feedResult.apps.map((app) => app.appid)]),
  ];
  const refreshStats = await refreshIndicatedAppPrices(db, indicatedAppIds, {
    customFetch,
    anchorTime,
    successTarget: 100,
    attemptCap: 200,
  });
  const pending = refreshStats.pendingAppIds;
  const previousCursor = feedCursor;
  let nextCursor = previousCursor;
  let continuationAppId = checkpointValue.continuationAppId;
  let continuationLastModified = checkpointValue.continuationLastModified;
  let cursorAdvanced = false;

  if (fetchedPage) {
    if (
      feedResult.lastModified !== null &&
      (continuationLastModified === null ||
        feedResult.lastModified > continuationLastModified)
    ) {
      continuationLastModified = feedResult.lastModified;
    }

    if (feedResult.haveMoreResults) {
      continuationAppId = feedResult.lastAppId;
    } else {
      continuationAppId = null;
      if (
        continuationLastModified !== null &&
        (previousCursor === null || continuationLastModified > previousCursor)
      ) {
        nextCursor = continuationLastModified;
        cursorAdvanced = true;
      }
      continuationLastModified = null;
    }
  }

  const checkpointAdvanced = cursorAdvanced && pending.length === 0;
  await setCheckpoint(
    db,
    checkpointKey,
    JSON.stringify({
      pending: [...new Set(pending)],
      catalogBackfillQueued: true,
      orphanRecoveryCursor,
      orphanRecoveryComplete,
      ...(continuationAppId !== null ? { continuationAppId } : {}),
      ...(continuationLastModified !== null ? { continuationLastModified } : {}),
    }),
    nextCursor
  );

  return {
    executed: true,
    appsIndicated: indicatedAppIds.length,
    attempted: refreshStats.attempted,
    successful: refreshStats.successful,
    failed: refreshStats.failed,
    rateLimited: refreshStats.rateLimited,
    changed: refreshStats.changed,
    changedAppIds: refreshStats.changedAppIds,
    pending: pending.length,
    checkpointCursor: nextCursor,
    checkpointAdvanced,
  };
}
