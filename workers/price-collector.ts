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
  currency: string;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number;
  is_free: boolean;
  is_available: boolean;
  formatted_initial: string | null;
  formatted_final: string | null;
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
      return {
        appid,
        success: false,
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

    const json = (await res.json()) as SteamStoreAppDetails;
    const entry = json[String(appid)];

    if (!entry || !entry.success || !entry.data) {
      return {
        appid,
        success: false,
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

    const details = entry.data;

    // Explicitly free-to-play
    if (details.is_free === true) {
      return {
        appid,
        success: true,
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

    // Priced with price_overview
    if (details.price_overview) {
      const po = details.price_overview;
      return {
        appid,
        success: true,
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

    // Available app metadata exists, but no price overview and not free (e.g. unpriced, coming soon, unlisted)
    return {
      appid,
      success: true,
      currency: "USD",
      initial_price: null,
      final_price: null,
      discount_percent: 0,
      is_free: false,
      is_available: false,
      formatted_initial: null,
      formatted_final: null,
    };
  } catch {
    return {
      appid,
      success: false,
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
  } = {}
): Promise<{
  attempted: number;
  successful: number;
  failed: number;
  changed: number;
}> {
  const customFetch = options.customFetch ?? fetch;
  const anchorTime = options.anchorTime ?? new Date();
  const observedAt = anchorTime.toISOString();

  let attempted = 0;
  let successful = 0;
  let failed = 0;
  let changed = 0;

  for (const appid of appids) {
    attempted++;
    const priceDetails = await fetchSteamPriceDetails(appid, { customFetch });

    if (!priceDetails.success) {
      // Failed refresh: preserve prior state without writing zero or deleting
      failed++;
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

  return { attempted, successful, failed, changed };
}

export interface HourlyPriceFeedTickResult {
  executed: boolean;
  reason?: string;
  appsIndicated: number;
  attempted: number;
  successful: number;
  failed: number;
  changed: number;
  checkpointAdvanced: boolean;
  checkpointCursor: number | null;
}

/**
 * Hourly scheduled tick:
 * - Checks incremental Steam catalog feed when credentials exist
 * - Refreshes details ONLY for indicated apps (no catalog-wide sweep)
 * - Advances checkpoint ONLY on success
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
      changed: 0,
      checkpointAdvanced: false,
      checkpointCursor: null,
    };
  }

  const checkpointKey = options.checkpointKey ?? DEFAULT_PRICE_CHECKPOINT_KEY;
  const customFetch = options.customFetch ?? fetch;
  const anchorTime = options.anchorTime ?? new Date();

  // Read existing checkpoint
  const existingCheckpoint = await getCheckpoint(db, checkpointKey);
  const ifModifiedSince = existingCheckpoint?.cursor ?? undefined;

  const maxToProcess = options.maxAppsToProcess ?? 100;

  const feedResult = await fetchSteamCatalogFeed(apiKey, {
    ifModifiedSince,
    maxResults: maxToProcess,
    customFetch,
  });

  if (!feedResult) {
    // Feed fetch failed: DO NOT advance checkpoint
    return {
      executed: false,
      reason: "feed_fetch_failed",
      appsIndicated: 0,
      attempted: 0,
      successful: 0,
      failed: 0,
      changed: 0,
      checkpointAdvanced: false,
      checkpointCursor: existingCheckpoint?.cursor ?? null,
    };
  }

  const apps = feedResult.apps;
  const indicatedAppIds = apps.map((a) => a.appid);

  // Refresh prices only for indicated apps
  const refreshStats = await refreshIndicatedAppPrices(db, indicatedAppIds, {
    customFetch,
    anchorTime,
  });

  // Do not advance checkpoint if any detail refresh failed
  if (refreshStats.failed > 0) {
    return {
      executed: true,
      appsIndicated: apps.length,
      attempted: refreshStats.attempted,
      successful: refreshStats.successful,
      failed: refreshStats.failed,
      changed: refreshStats.changed,
      checkpointAdvanced: false,
      checkpointCursor: existingCheckpoint?.cursor ?? null,
    };
  }

  // Advance checkpoint only when all indicated apps were successfully processed
  let checkpointAdvanced = false;
  const newCursor = feedResult.lastModified;

  if (apps.length > 0 && refreshStats.successful === apps.length && newCursor !== null) {
    await setCheckpoint(
      db,
      checkpointKey,
      `sync:${new Date().toISOString()}`,
      newCursor
    );
    checkpointAdvanced = true;
  }

  return {
    executed: true,
    appsIndicated: apps.length,
    attempted: refreshStats.attempted,
    successful: refreshStats.successful,
    failed: refreshStats.failed,
    changed: refreshStats.changed,
    checkpointAdvanced,
    checkpointCursor:
      checkpointAdvanced && newCursor !== null
        ? newCursor
        : (existingCheckpoint?.cursor ?? null),
  };
}
