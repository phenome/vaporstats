import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { queryClient, DEFAULT_QUERY_STALE_TIME } from "../src/lib/query-client";
import { createRouter } from "../src/router";
import { Skeleton } from "../src/components/ui/skeleton";
import {
  HomeSkeleton,
  GamePageSkeleton,
  CatalogSkeleton,
  RankingsSkeleton,
  DealsSkeleton,
} from "../src/components/route-skeletons";

const rootDir = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const stepIndex = args.indexOf("--step");
const step = stepIndex !== -1 ? args[stepIndex + 1] : "all";

function fail(message: string): never {
  console.error(`[VERIFY ERROR] ${message}`);
  process.exit(1);
}

function verifyQueryConfig() {
  if (DEFAULT_QUERY_STALE_TIME !== 5 * 60 * 1000) {
    fail(`Expected default query staleTime to be 300000ms (5m), got ${DEFAULT_QUERY_STALE_TIME}`);
  }

  const router = createRouter();
  if (router.options.defaultPreload !== "intent") {
    fail(`Expected router defaultPreload to be 'intent', got ${router.options.defaultPreload}`);
  }
  if (router.options.defaultPreloadStaleTime !== 0) {
    fail(`Expected router defaultPreloadStaleTime to be 0, got ${router.options.defaultPreloadStaleTime}`);
  }
  if (!router.options.context?.queryClient) {
    fail("Expected router context to include queryClient instance");
  }

  const rootContent = readFileSync(resolve(rootDir, "src/routes/__root.tsx"), "utf-8");
  if (!rootContent.includes("QueryClientProvider")) {
    fail("Expected src/routes/__root.tsx to wrap tree with QueryClientProvider");
  }

  console.log("QUERY_CONFIG_VERIFIED");
}

function verifySkeletonComponents() {
  const skeletonHtml = renderToString(React.createElement(Skeleton, { className: "w-10 h-10" }));
  if (!skeletonHtml.includes("animate-pulse") || !skeletonHtml.includes("bg-muted")) {
    fail(`Skeleton did not produce expected markup: ${skeletonHtml}`);
  }

  const homeHtml = renderToString(React.createElement(HomeSkeleton));
  if (!homeHtml.includes("home-skeleton")) {
    fail("HomeSkeleton missing home-skeleton test id");
  }

  const gameHtml = renderToString(React.createElement(GamePageSkeleton));
  if (!gameHtml.includes("game-skeleton")) {
    fail("GamePageSkeleton missing game-skeleton test id");
  }

  const catalogHtml = renderToString(React.createElement(CatalogSkeleton));
  if (!catalogHtml.includes("catalog-skeleton")) {
    fail("CatalogSkeleton missing catalog-skeleton test id");
  }

  const rankingsHtml = renderToString(React.createElement(RankingsSkeleton));
  if (!rankingsHtml.includes("rankings-skeleton")) {
    fail("RankingsSkeleton missing rankings-skeleton test id");
  }

  const dealsHtml = renderToString(React.createElement(DealsSkeleton));
  if (!dealsHtml.includes("deals-skeleton")) {
    fail("DealsSkeleton missing deals-skeleton test id");
  }

  console.log("SKELETON_COMPONENTS_VERIFIED");
}

function verifyHomeRoute() {
  const content = readFileSync(resolve(rootDir, "src/routes/index.tsx"), "utf-8");
  if (!content.includes("context.queryClient.prefetchQuery(homeQueryOptions)")) {
    fail("Home route loader must trigger unawaited prefetchQuery(homeQueryOptions)");
  }
  if (content.includes("await context.queryClient.prefetchQuery")) {
    fail("Home route loader must NOT await prefetchQuery");
  }
  if (!content.includes("HomeSkeleton")) {
    fail("Home route component must render HomeSkeleton while loading");
  }
  if (!content.includes("useQuery(homeQueryOptions)")) {
    fail("Home route component must use useQuery with homeQueryOptions");
  }

  console.log("HOME_ROUTE_VERIFIED");
}

function verifyGameRoute() {
  const content = readFileSync(resolve(rootDir, "src/routes/games.$game.tsx"), "utf-8");
  if (!content.includes("context.queryClient.prefetchQuery(gameDetailQueryOptions")) {
    fail("Game route loader must trigger unawaited prefetchQuery(gameDetailQueryOptions)");
  }
  if (content.includes("await context.queryClient.prefetchQuery")) {
    fail("Game route loader must NOT await prefetchQuery");
  }
  if (!content.includes("GamePageSkeleton")) {
    fail("Game route component must render GamePageSkeleton while loading");
  }
  if (!content.includes("useQuery(gameDetailQueryOptions")) {
    fail("Game route component must use useQuery with gameDetailQueryOptions");
  }

  const apiFile = resolve(rootDir, "src/routes/api.games.$appid.detail.ts");
  if (!existsSync(apiFile)) {
    fail("api.games.$appid.detail.ts must exist for game detail querying");
  }

  console.log("GAME_ROUTE_VERIFIED");
}

function verifySecondaryRoutes() {
  const gamesContent = readFileSync(resolve(rootDir, "src/routes/games.index.tsx"), "utf-8");
  if (!gamesContent.includes("context.queryClient.prefetchQuery(catalogQueryOptions)")) {
    fail("games.index.tsx loader must trigger unawaited prefetchQuery");
  }
  if (!gamesContent.includes("CatalogSkeleton")) {
    fail("games.index.tsx must render CatalogSkeleton");
  }

  const rankingsContent = readFileSync(resolve(rootDir, "src/routes/rankings.index.tsx"), "utf-8");
  if (!rankingsContent.includes("context.queryClient.prefetchQuery(rankingsQueryOptions)")) {
    fail("rankings.index.tsx loader must trigger unawaited prefetchQuery");
  }
  if (!rankingsContent.includes("RankingsSkeleton")) {
    fail("rankings.index.tsx must render RankingsSkeleton");
  }

  const dealsContent = readFileSync(resolve(rootDir, "src/routes/deals.tsx"), "utf-8");
  if (!dealsContent.includes("context.queryClient.prefetchQuery(dealsQueryOptions")) {
    fail("deals.tsx loader must trigger unawaited prefetchQuery");
  }
  if (!dealsContent.includes("DealsSkeleton")) {
    fail("deals.tsx must render DealsSkeleton");
  }

  console.log("SECONDARY_ROUTES_VERIFIED");
}

function verifyProject() {
  console.log("[VERIFY] Running tsc --noEmit...");
  const tsc = spawnSync("bun", ["x", "tsc", "--noEmit"], { stdio: "inherit" });
  if (tsc.status !== 0) fail("tsc --noEmit failed");

  console.log("[VERIFY] Running bun test...");
  const tests = spawnSync("bun", ["test"], { stdio: "inherit" });
  if (tests.status !== 0) fail("bun test failed");

  console.log("[VERIFY] Running bun run build...");
  const build = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) fail("bun run build failed");

  console.log("PROJECT_VERIFY_PASSED");
}

switch (step) {
  case "query-config":
    verifyQueryConfig();
    break;
  case "skeleton-components":
    verifySkeletonComponents();
    break;
  case "home-route":
    verifyHomeRoute();
    break;
  case "game-route":
    verifyGameRoute();
    break;
  case "secondary-routes":
    verifySecondaryRoutes();
    break;
  case "project-verify":
    verifyProject();
    break;
  case "all":
  default:
    verifyQueryConfig();
    verifySkeletonComponents();
    verifyHomeRoute();
    verifyGameRoute();
    verifySecondaryRoutes();
    verifyProject();
    break;
}
