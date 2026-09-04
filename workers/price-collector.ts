import type { D1Database } from "../src/lib/db";
import { getCheckpoint, setCheckpoint } from "../src/lib/catalog";
import { recordPriceObservation, type PriceState } from "../src/lib/prices";

export const DEFAULT_PRICE_CHECKPOINT_KEY = "steam_catalog_feed";

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

export interface SteamStoreAppDetails {
  [appid: string]: {
    success: boolean;
    data?: {
      type?: string;
      name?: string;
      steam_appid?: number;
      is_free?: boolean;
      price_overview?: SteamPriceOverview;
    };
  };
}

export interface PriceDetailsResult {
  appid: number;
  success: boolean;
  rateLimited: boolean;
  currency: string;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number;
  is_free: boolean;
  is_available: boolean;
  formatted_initial: string | null;
  formatted_final: string | null;
}

function unavailablePriceDetails(
  appid: number,
  success: boolean,
  rateLimited = false
): PriceDetailsResult {
  return {
    appid,
    success,
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
    maxResults?: number;
    customFetch?: typeof fetch;
  } = {}
): Promise<{ apps: CatalogFeedApp[]; lastModified: number | null } | null> {
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

    if (details.is_free === true) {
      return {
        appid,
        success: true,
        rateLimited: false,
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

    return unavailablePriceDetails(appid, true);
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
  db: D1Database,
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
    }
  }
  for (; index < appids.length; index++) {
    pendingAppIds.push(appids[index]);
  }

  return { attempted, successful, failed, changed, rateLimited, pendingAppIds };
}

function readPendingAppIds(checkpoint: { value: string } | null): number[] {
  if (!checkpoint) return [];
  try {
    const value = JSON.parse(checkpoint.value) as { pending?: unknown };
    return Array.isArray(value.pending)
      ? value.pending.filter((appid): appid is number => Number.isInteger(appid) && appid > 0)
      : [];
  } catch {
    return [];
  }
}


export interface HourlyPriceFeedTickResult {
  executed: boolean;
  reason?: string;
  appsIndicated: number;
  attempted: number;
  successful: number;
  failed: number;
  changed: number;
  rateLimited: boolean;
  pending: number;
  checkpointAdvanced: boolean;
  checkpointCursor: number | null;
}

/**
 * Hourly scheduled tick:
 * - Checks incremental Steam catalog feed when credentials exist
 * - Refreshes details ONLY for indicated apps (no catalog-wide sweep)
 * - Advances the feed cursor while retaining failed/unprocessed app IDs
 */
export async function runHourlyPriceFeedTick(
  db: D1Database,
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
      checkpointAdvanced: false,
      checkpointCursor: null,
    };
  }

  const checkpointKey = options.checkpointKey ?? DEFAULT_PRICE_CHECKPOINT_KEY;
  const customFetch = options.customFetch ?? fetch;
  const anchorTime = options.anchorTime ?? new Date();
  const existingCheckpoint = await getCheckpoint(db, checkpointKey);
  const pendingBeforeFeed = readPendingAppIds(existingCheckpoint);
  const feedResult = await fetchSteamCatalogFeed(apiKey, {
    ifModifiedSince: existingCheckpoint?.cursor ?? undefined,
    maxResults: options.maxAppsToProcess ?? 200,
    customFetch,
  });

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
  const newCursor = feedResult.lastModified;
  const previousCursor = existingCheckpoint?.cursor ?? null;
  const cursorAdvanced =
    newCursor !== null && (previousCursor === null || newCursor > previousCursor);
  const checkpointAdvanced = cursorAdvanced && pending.length === 0;

  if (pending.length > 0 || pendingBeforeFeed.length > 0 || cursorAdvanced) {
    await setCheckpoint(
      db,
      checkpointKey,
      JSON.stringify({ pending: [...new Set(pending)] }),
      cursorAdvanced ? newCursor : previousCursor
    );
  }

  return {
    executed: true,
    appsIndicated: indicatedAppIds.length,
    attempted: refreshStats.attempted,
    successful: refreshStats.successful,
    failed: refreshStats.failed,
    rateLimited: refreshStats.rateLimited,
    changed: refreshStats.changed,
    pending: pending.length,
    checkpointCursor: cursorAdvanced ? newCursor : previousCursor,
    checkpointAdvanced,
  };
}
