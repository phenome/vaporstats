import { createRouter as createTanStackRouter, type Router } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { createQueryClient } from "./lib/query-client";

export type AppRouter = Router<typeof routeTree>;

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value.replace(/^["']|["']$/g, "") : String(value);
    params.set(key, str);
  }
  const res = params.toString();
  return res ? `?${res}` : "";
}

export function parseSearch(searchStr: string): Record<string, unknown> {
  const params = new URLSearchParams(searchStr.replace(/^\?/, ""));
  const res: Record<string, unknown> = {};
  for (const [key, val] of params.entries()) {
    const unquoted = val.replace(/^["']|["']$/g, "");
    if (key === "event") {
      res[key] = unquoted;
    } else if (/^-?\d+$/.test(unquoted) && Number.isSafeInteger(Number(unquoted))) {
      res[key] = Number(unquoted);
    } else if (unquoted === "true") {
      res[key] = true;
    } else if (unquoted === "false") {
      res[key] = false;
    } else {
      res[key] = unquoted;
    }
  }
  return res;
}

export function createRouter(queryClient = createQueryClient()): AppRouter {
  return createTanStackRouter({
    routeTree,
    context: {
      queryClient,
    },
    stringifySearch,
    parseSearch,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultStaleTime: 0,
    defaultPreloadGcTime: 0,
    defaultGcTime: 0,
    scrollRestoration: true,
  });
}

export const getRouter = createRouter;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
