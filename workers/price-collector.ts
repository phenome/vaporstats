import type { AppDatabase } from "../src/lib/db";
import { getCheckpoint, setCheckpoint, upsertApp } from "../src/lib/catalog";
import { enrichCatalogReleaseFields, hasLeftEarlyAccessAssertion, normalizeSteamReleaseDate } from "./catalog-seed";
import { syncReleaseFactsFromApps } from "./release-facts";
import { recordPriceObservation } from "../src/lib/prices";

export const DEFAULT_PRICE_CHECKPOINT_KEY = "steam_catalog_feed";
const INITIAL_CATALOG_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;
const DEAL_FRESHNESS_MS = 30 * 60 * 1000;
const PRICE_BATCH_SIZE = 50;

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
  detailed_description?: string;
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
type PriceCatalogApp = Parameters<typeof upsertApp>[1] & {
  is_coming_soon?: boolean | null;
};

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
    release_date: normalizeSteamReleaseDate(details.release_date?.date),
    release_status:
      details.release_date?.coming_soon === true
        ? "upcoming"
        : details.release_date?.coming_soon === false
          ? "released"
          : "unannounced",
    description: details.short_description ?? "",
    header_image:
      details.header_image ||
      `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    developer: details.developers?.[0] ?? "",
    publisher: details.publishers?.[0] ?? "",
    ...(hasLeftEarlyAccessAssertion(details.detailed_description)
      ? { has_left_early_access: true }
      : {}),
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

function parsePriceDetails(
  appid: number,
  entry: SteamStoreAppDetails[string] | undefined,
  catalogApp: Parameters<typeof upsertApp>[1] | null = null
): PriceDetailsResult {
  if (entry && !entry.success) return unavailablePriceDetails(appid, true);
  if (!entry?.data) return unavailablePriceDetails(appid, false);

  const details = entry.data;
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
    const price = details.price_overview;
    return {
      appid,
      success: true,
      rateLimited: false,
      catalogApp,
      currency: price.currency || "USD",
      initial_price: price.initial,
      final_price: price.final,
      discount_percent: price.discount_percent ?? 0,
      is_free: false,
      is_available: true,
      formatted_initial: price.initial_formatted ?? null,
      formatted_final: price.final_formatted ?? null,
    };
  }
  return { ...unavailablePriceDetails(appid, true), catalogApp };
}

function collectDealExpirations(
  value: unknown,
  nowSeconds: number,
  expirations: Map<number, string>
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDealExpirations(item, nowSeconds, expirations);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (
    record.type === 0 &&
    typeof record.id === "number" &&
    Number.isInteger(record.id) &&
    record.id > 0 &&
    typeof record.discount_expiration === "number" &&
    Number.isInteger(record.discount_expiration) &&
    record.discount_expiration > nowSeconds
  ) {
    const appid = record.id;
    const expiresAt = new Date(record.discount_expiration * 1000).toISOString();
    const prior = expirations.get(appid);
    if (!prior || expiresAt < prior) expirations.set(appid, expiresAt);
  }
  for (const child of Object.values(record)) {
    collectDealExpirations(child, nowSeconds, expirations);
  }
}

/** Reads exact app deal expirations from Steam's two US-English JSON feeds. */
export async function fetchSteamDealExpirations(
  options: { customFetch?: typeof fetch; now?: Date } = {}
): Promise<{ expirations: Map<number, string>; successfulFeeds: number; rateLimited: boolean }> {
  const customFetch = options.customFetch ?? fetch;
  const now = options.now ?? new Date();
  const urls = [
    "https://store.steampowered.com/api/featured?cc=us&l=english",
    "https://store.steampowered.com/api/featuredcategories?cc=us&l=english",
  ];
  const responses = await Promise.all(urls.map(async (url) => {
    try {
      const response = await customFetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) return { json: null, rateLimited: response.status === 429 };
      return { json: await response.json() as unknown, rateLimited: false };
    } catch {
      return { json: null, rateLimited: false };
    }
  }));
  const expirations = new Map<number, string>();
  for (const response of responses) {
    if (response.json !== null) {
      collectDealExpirations(response.json, Math.floor(now.getTime() / 1000), expirations);
    }
  }
  return {
    expirations,
    successfulFeeds: responses.filter(({ json }) => json !== null).length,
    rateLimited: responses.some(({ rateLimited }) => rateLimited),
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
    return parsePriceDetails(
      appid,
      entry,
      entry?.data ? toCatalogApp(entry.data) : null
    );
  } catch {
    return unavailablePriceDetails(appid, false);
  }
}

/** Fetches price fields only for at most 50 AppIDs in one Storefront request. */
export async function fetchSteamPriceDetailsBatch(
  appids: number[],
  options: { customFetch?: typeof fetch } = {}
): Promise<{ results: PriceDetailsResult[]; rateLimited: boolean }> {
  const ids = [...new Set(appids)].slice(0, PRICE_BATCH_SIZE);
  if (ids.length === 0) return { results: [], rateLimited: false };
  const customFetch = options.customFetch ?? fetch;
  const url =
    `https://store.steampowered.com/api/appdetails?appids=${ids.join(",")}&cc=us&l=english&filters=price_overview`;
  try {
    const response = await customFetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return {
        results: ids.map((appid) =>
          unavailablePriceDetails(appid, false, response.status === 429)
        ),
        rateLimited: response.status === 429,
      };
    }
    const json = await response.json() as SteamStoreAppDetails;
    return {
      results: ids.map((appid) => parsePriceDetails(appid, json[String(appid)])),
      rateLimited: false,
    };
  } catch {
    return {
      results: ids.map((appid) => unavailablePriceDetails(appid, false)),
      rateLimited: false,
    };
  }
}

export interface DealRevalidationResult {
  attempted: number;
  successful: number;
  failed: number;
  changed: number;
  rateLimited: boolean;
  pending: number;
  currentDeals: number;
  dealsWithExactExpiry: number;
}

async function getDealExpiryCoverage(
  db: AppDatabase,
  now: Date
): Promise<{ currentDeals: number; dealsWithExactExpiry: number }> {
  const nowIso = now.toISOString();
  const freshAfter = new Date(now.getTime() - DEAL_FRESHNESS_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS current_deals,
              SUM(CASE WHEN deal_expires_at > ? THEN 1 ELSE 0 END) AS exact_expiries
       FROM app_prices
       WHERE discount_percent > 0 AND is_available = 1
         AND observed_at > ?
         AND (deal_expires_at IS NULL OR deal_expires_at > ?)`
    )
    .bind(nowIso, freshAfter, nowIso)
    .first<{ current_deals: number | string; exact_expiries: number | string | null }>();
  return {
    currentDeals: Number(row?.current_deals ?? 0),
    dealsWithExactExpiry: Number(row?.exact_expiries ?? 0),
  };
}

/**
 * Revalidates only already-discounted persisted rows. Successful responses
 * refresh observed_at; failures leave the source state untouched.
 */
export async function revalidateCurrentDeals(
  db: AppDatabase,
  options: {
    customFetch?: typeof fetch;
    anchorTime?: Date;
    staleOnly?: boolean;
    expirations?: ReadonlyMap<number, string>;
  } = {}
): Promise<DealRevalidationResult> {
  const customFetch = options.customFetch ?? fetch;
  const anchorTime = options.anchorTime ?? new Date();
  const cutoff = new Date(anchorTime.getTime() - DEAL_FRESHNESS_MS).toISOString();
  const query = options.staleOnly
    ? `SELECT appid FROM app_prices
       WHERE discount_percent > 0 AND is_available = 1
         AND (observed_at <= ? OR (deal_expires_at IS NOT NULL AND deal_expires_at <= ?))
       ORDER BY observed_at, appid`
    : `SELECT appid FROM app_prices
       WHERE discount_percent > 0 AND is_available = 1
       ORDER BY appid`;
  const rows = await db
    .prepare(query)
    .bind(...(options.staleOnly ? [cutoff, anchorTime.toISOString()] : []))
    .all<{ appid: number }>();
  const appids = (rows.results ?? []).map(({ appid }) => appid);
  const expirations = options.expirations ??
    (await fetchSteamDealExpirations({ customFetch, now: anchorTime })).expirations;
  let attempted = 0;
  let successful = 0;
  let failed = 0;
  let changed = 0;
  let rateLimited = false;
  let index = 0;

  while (index < appids.length) {
    const batchIds = appids.slice(index, index + PRICE_BATCH_SIZE);
    const batch = await fetchSteamPriceDetailsBatch(batchIds, { customFetch });
    attempted += batchIds.length;
    for (const details of batch.results) {
      if (!details.success) {
        failed++;
        continue;
      }
      successful++;
      const result = await recordPriceObservation(db, {
        appid: details.appid,
        currency: details.currency,
        initial_price: details.initial_price,
        final_price: details.final_price,
        discount_percent: details.discount_percent,
        is_free: details.is_free,
        is_available: details.is_available,
        formatted_initial: details.formatted_initial,
        formatted_final: details.formatted_final,
        deal_expires_at: expirations.get(details.appid),
        observed_at: anchorTime.toISOString(),
      });
      if (result.stateChanged) changed++;
    }
    if (batch.rateLimited) {
      rateLimited = true;
      break;
    }
    index += batchIds.length;
  }

  const coverage = await getDealExpiryCoverage(db, anchorTime);
  return {
    attempted,
    successful,
    failed,
    changed,
    rateLimited,
    pending: appids.length - index,
    currentDeals: coverage.currentDeals,
    dealsWithExactExpiry: coverage.dealsWithExactExpiry,
  };
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
    dealExpirations?: ReadonlyMap<number, string>;
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
  while (index < appids.length && attempted < attemptCap && successful < successTarget) {
    const capacity = Math.min(50, appids.length - index, attemptCap - attempted, successTarget - successful);
    const batchIds = appids.slice(index, index + capacity);
    const catalogApps: Array<{ appid: number; app: PriceCatalogApp }> = [];
    let consumed = 0;

    for (const appid of batchIds) {
      consumed++;
      attempted++;
      const priceDetails = await fetchSteamPriceDetails(appid, { customFetch });

      if (!priceDetails.success) {
        failed++;
        pendingAppIds.push(appid);
        if (priceDetails.rateLimited) {
          rateLimited = true;
          break;
        }
        continue;
      }
      successful++;

      if (priceDetails.catalogApp) {
        const existing = await db
          .prepare(
            "SELECT appid, parent_appid, is_eligible, is_playable, release_date, " +
              "steam_release_date, original_release_date, original_steam_release_date, " +
              "release_from_early_access_date, release_date_source, is_early_access, " +
              "release_status FROM apps WHERE appid = ?"
          )
          .bind(appid)
          .first<{
            appid: number;
            parent_appid: number | null;
            is_eligible: number;
            is_playable: number;
            release_date: string | null;
            steam_release_date: string | null;
            original_release_date: string | null;
            original_steam_release_date: string | null;
            release_from_early_access_date: string | null;
            release_date_source: "original_release_date" | "steam_release_date" | "appdetails" | null;
            is_early_access: number | null;
            release_status: string | null;
          }>();

        const existingHasLifecycle =
          existing !== null &&
          (existing.release_date_source !== null ||
            existing.original_release_date !== null ||
            existing.steam_release_date !== null ||
            existing.original_steam_release_date !== null ||
            existing.release_from_early_access_date !== null ||
            existing.is_early_access !== null);
        catalogApps.push({
          appid,
          app: {
            ...priceDetails.catalogApp,
            ...(existing
              ? {
                  parent_appid: existing.parent_appid,
                  is_eligible: existing.is_eligible === 1,
                  is_playable: existing.is_playable === 1,
                }
              : {}),
            ...(existingHasLifecycle
              ? {
                  release_date: existing!.release_date,
                  steam_release_date: existing!.steam_release_date,
                  original_release_date: existing!.original_release_date,
                  original_steam_release_date: existing!.original_steam_release_date,
                  release_from_early_access_date: existing!.release_from_early_access_date,
                  release_date_source: existing!.release_date_source,
                  is_early_access:
                    existing!.is_early_access === null ? null : existing!.is_early_access === 1,
                }
              : {}),
            ...(existing &&
            priceDetails.catalogApp.release_date === null &&
            existing.release_status !== null
              ? { release_status: existing.release_status }
              : {}),
          },
        });
      }

      const recordResult = await recordPriceObservation(db, {
        appid,
        currency: priceDetails.currency,
        initial_price: priceDetails.initial_price,
        final_price: priceDetails.final_price,
        discount_percent: priceDetails.discount_percent,
        deal_expires_at: options.dealExpirations?.get(appid),
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

    index += consumed;
    if (rateLimited) {
      pendingAppIds.push(...catalogApps.map(({ appid }) => appid));
      break;
    }

    if (catalogApps.length > 0) {
      let enrichedApps: PriceCatalogApp[];
      try {
        enrichedApps = await enrichCatalogReleaseFields(
          catalogApps.map(({ app }) => app),
          customFetch
        );
      } catch (error) {
        if (error instanceof Error && error.name === "SteamRateLimitError") {
          rateLimited = true;
          pendingAppIds.push(...catalogApps.map(({ appid }) => appid));
          break;
        }
        throw error;
      }

      for (const app of enrichedApps) {
        const enrichedApp = {
          ...app,
          release_status:
            app.is_coming_soon === true
              ? "upcoming"
              : app.is_coming_soon === false
                ? "released"
                : app.release_status,
        };
        await upsertApp(db, enrichedApp);
      }
      await syncReleaseFactsFromApps(db, {
        appIds: enrichedApps.map((app) => app.appid),
      });
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
  revalidationAttempted: number;
  revalidationSuccessful: number;
  revalidationFailed: number;
  revalidationChanged: number;
  revalidationPending: number;
  currentDeals: number;
  dealsWithExactExpiry: number;
  checkpointAdvanced: boolean;
  checkpointCursor: number | null;
}

/**
 * Fifteen-minute scheduled tick:
 * - Revalidates currently discounted rows with price-only batched requests
 * - Drains retained work before requesting more catalog changes
 * - Checks the incremental Steam catalog feed when credentials exist
 * - Refreshes full details ONLY for indicated apps (no catalog-wide sweep)
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
    staleDealsOnly?: boolean;
  } = {}
): Promise<HourlyPriceFeedTickResult> {
  const apiKey = options.apiKey ?? process.env.STEAM_API_KEY;
  const customFetch = options.customFetch ?? fetch;
  const anchorTime = options.anchorTime ?? new Date();
  const metadata = await fetchSteamDealExpirations({ customFetch, now: anchorTime });
  const revalidation = await revalidateCurrentDeals(db, {
    customFetch,
    anchorTime,
    staleOnly: options.staleDealsOnly,
    expirations: metadata.expirations,
  });
  const revalidationFields = {
    revalidationAttempted: revalidation.attempted,
    revalidationSuccessful: revalidation.successful,
    revalidationFailed: revalidation.failed,
    revalidationChanged: revalidation.changed,
    revalidationPending: revalidation.pending,
    currentDeals: revalidation.currentDeals,
    dealsWithExactExpiry: revalidation.dealsWithExactExpiry,
  };
  if (!apiKey || revalidation.rateLimited) {
    return {
      executed: revalidation.attempted > 0,
      reason: revalidation.rateLimited ? "deal_revalidation_rate_limited" : "missing_credentials",
      appsIndicated: 0,
      attempted: 0,
      successful: 0,
      failed: 0,
      rateLimited: revalidation.rateLimited,
      pending: 0,
      changed: 0,
      changedAppIds: [],
      ...revalidationFields,
      checkpointAdvanced: false,
      checkpointCursor: null,
    };
  }

  const checkpointKey = options.checkpointKey ?? DEFAULT_PRICE_CHECKPOINT_KEY;
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
      ...revalidationFields,
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
    dealExpirations: metadata.expirations,
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
  const finalCoverage = await getDealExpiryCoverage(db, anchorTime);

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
    ...revalidationFields,
    currentDeals: finalCoverage.currentDeals,
    dealsWithExactExpiry: finalCoverage.dealsWithExactExpiry,
    checkpointCursor: nextCursor,
    checkpointAdvanced,
  };
}
