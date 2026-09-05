import { createRouter as createTanStackRouter, type Router } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { queryClient } from "./lib/query-client";

export type AppRouter = Router<typeof routeTree>;

export function createRouter(): AppRouter {
  return createTanStackRouter({
    routeTree,
    context: {
      queryClient,
    },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

export const getRouter = createRouter;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
