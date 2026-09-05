import serverEntry from "@tanstack/react-start/server-entry";
import { CACHE_POLICIES } from "./lib/cache";
export interface ServerEnv {
  ASSETS: Fetcher;
  API_RATE_LIMITER?: RateLimit;
}

export async function enforceApiRateLimit(
  request: Request,
  limiter?: RateLimit
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
    return null;
  }

  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip || !limiter) {
    return null;
  }

  try {
    const outcome = await limiter.limit({ key: ip });
    if (!outcome.success) {
      return new Response(
        JSON.stringify({
          status: "error",
          error: "Too many requests. Please retry shortly.",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": CACHE_POLICIES.noStore,
            "Retry-After": "10",
          },
        }
      );
    }
  } catch {
    // Fail open if rate limiter errors
  }

  return null;
}

export default {
  async fetch(request: Request, env: ServerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.vaporstats.com") {
      url.protocol = "https:";
      url.hostname = "vaporstats.com";
      return Response.redirect(url.toString(), 301);
    }

    const rateLimitResponse = await enforceApiRateLimit(request, env.API_RATE_LIMITER);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    if (url.pathname.startsWith("/assets/")) {
      const res = await env.ASSETS.fetch(request);
      if (res.ok) {
        const headers = new Headers(res.headers);
        headers.set("Cache-Control", CACHE_POLICIES.immutableAsset);
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
      return res;
    }

    return serverEntry.fetch(request);
  },
};
