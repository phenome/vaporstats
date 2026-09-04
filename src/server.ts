import serverEntry from "@tanstack/react-start/server-entry";

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.vaporstats.com") {
      url.protocol = "https:";
      url.hostname = "vaporstats.com";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith("/assets/")) {
      return env.ASSETS.fetch(request);
    }

    return serverEntry.fetch(request);
  },
};
