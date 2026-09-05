import serverEntry from "@tanstack/react-start/server-entry";
import { CACHE_POLICIES } from "./lib/cache";
export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.vaporstats.com") {
      url.protocol = "https:";
      url.hostname = "vaporstats.com";
      return Response.redirect(url.toString(), 301);
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
