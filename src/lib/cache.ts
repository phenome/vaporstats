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
  /** Immutable fingerprinted static assets */
  immutableAsset: "public, max-age=31536000, immutable",
  /** No store for non-cacheable or error states */
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
