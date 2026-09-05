/**
 * HTTP Cache-Control headers for VaporStats routes and APIs.
 *
 * Fixed route shells: generated at deployment.
 * Parameterized entity SSR: 1-hour shared CDN cache, 24-hour stale-while-revalidate.
 * Live APIs: 5-minute shared cache, 1-minute stale-while-revalidate.
 */

export const CACHE_POLICIES = {
  /** Parameterized entity pages (SSR): 1 hour s-maxage, 24 hours SWR */
  entity: "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
  /** Live overview / player / price data APIs: 5 min s-maxage, 1 min SWR */
  liveApi: "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
  /** Home page: 30s browser & CDN cache for fast refreshes */
  homePage: "public, max-age=30, s-maxage=30, stale-while-revalidate=30",
  /** Standard discovery pages: 60s browser & CDN cache */
  page: "public, max-age=60, s-maxage=60, stale-while-revalidate=60",
  /** Immutable fingerprinted static assets */
  immutableAsset: "public, max-age=31536000, immutable",
  noStore: "no-store, no-cache, must-revalidate",
} as const;

export function getEntityCacheHeaders(): Record<string, string> {
  return {
    "Cache-Control": CACHE_POLICIES.entity,
    "Vary": "Accept-Encoding",
  };
}

export function getLiveApiCacheHeaders(): Record<string, string> {
  return {
    "Cache-Control": CACHE_POLICIES.liveApi,
    "Vary": "Accept-Encoding",
  };
}

export function getHomeCacheHeaders(): Record<string, string> {
  return {
    "Cache-Control": CACHE_POLICIES.homePage,
    "Vary": "Accept-Encoding",
  };
}

export function getPageCacheHeaders(): Record<string, string> {
  return {
    "Cache-Control": CACHE_POLICIES.page,
    "Vary": "Accept-Encoding",
  };
}
