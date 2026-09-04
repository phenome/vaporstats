import { createRouter as createTanStackRouter, type Router } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export type AppRouter = Router<typeof routeTree>;

export function createRouter(): AppRouter {
  return createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}

export const getRouter = createRouter;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
