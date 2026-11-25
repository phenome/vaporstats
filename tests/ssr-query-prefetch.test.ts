import { describe, expect, spyOn, test } from "bun:test";
import { createQueryClient, DEFAULT_QUERY_STALE_TIME } from "../src/lib/query-client";
import { Route as gameRoute } from "../src/routes/games.$game";
import { Route as publisherRoute } from "../src/routes/publisher.$publisher";

import { Route as childRoute } from "../src/routes/games.$game_.$child";
import { Route as publishersRoute } from "../src/routes/publishers.index";

function runEntityLoaders(queryClient: ReturnType<typeof createQueryClient>) {
  const gameLoader = gameRoute.options.loader;
  const publisherLoader = publisherRoute.options.loader;
  const childLoader = childRoute.options.loader;
  const indexLoader = publishersRoute.options.loader;
  if (typeof childLoader !== "function" || typeof indexLoader !== "function") {
    throw new Error("Expected child and publisher index route loaders");
  }
  childLoader({
    params: { game: "901-fixture-game", child: "902-fixture-child" },
    deps: { pricerange: 1 },
    context: { queryClient },
  } as Parameters<typeof childLoader>[0]);
  indexLoader({ deps: { page: 1 }, context: { queryClient } } as Parameters<typeof indexLoader>[0]);
  if (typeof gameLoader !== "function" || typeof publisherLoader !== "function") {
    throw new Error("Expected entity route loaders");
  }
  gameLoader({
    params: { game: "901-fixture-game" },
    deps: { range: 1 },
    context: { queryClient },
  } as Parameters<typeof gameLoader>[0]);
  publisherLoader({
    params: { publisher: "fixture-studio" },
    context: { queryClient },
  } as Parameters<typeof publisherLoader>[0]);
}

describe("entity route prefetch", () => {
  test("SSR loaders start no browser prefetches", () => {
    const queryClient = createQueryClient();
    const prefetch = spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);
    const ensure = spyOn(queryClient, "ensureQueryData").mockResolvedValue(undefined);
    runEntityLoaders(queryClient);
    expect(prefetch).not.toHaveBeenCalled();
    expect(ensure.mock.calls.map(([options]) => options.queryKey)).toEqual([["game-detail", 901]]);
  });

  test("request-local queries schedule no GC timers", () => {
    const queryClient = createQueryClient();
    const timeout = spyOn(globalThis, "setTimeout");
    try {
      queryClient.setQueryData(["ssr-fixture"], { title: "Fixture" });
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      timeout.mockRestore();
    }
  });

  test("browser loaders still prefetch all entity queries with the existing cache policy", () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    try {
      const queryClient = createQueryClient();
      const prefetch = spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);
      runEntityLoaders(queryClient);
      expect(prefetch.mock.calls.map(([options]) => options.queryKey[0])).toEqual([
        "child-app", "publishers", "game-detail", "game-score", "game-score-history", "publisher",
      ]);
      expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(DEFAULT_QUERY_STALE_TIME);
      expect(queryClient.getDefaultOptions().queries?.gcTime).toBe(300_000);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("browser game loader waits for detail before the router can restore scroll", async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    try {
      const queryClient = createQueryClient();
      const detail = Promise.withResolvers<void>();
      const prefetch = spyOn(queryClient, "prefetchQuery").mockImplementation(({ queryKey }) =>
        queryKey[0] === "game-detail" ? detail.promise : Promise.resolve(),
      );
      const loader = gameRoute.options.loader;
      if (typeof loader !== "function") throw new Error("Expected game route loader");
      let loaded = false;
      const result = Promise.resolve(loader({
        params: { game: "901-fixture-game" },
        deps: { range: 1 },
        context: { queryClient },
      } as Parameters<typeof loader>[0])).then((data) => {
        loaded = true;
        return data;
      });

      await Promise.resolve();
      expect(prefetch).toHaveBeenCalledTimes(3);
      expect(loaded).toBe(false);
      detail.resolve();
      expect(await result).toMatchObject({ appid: 901, slug: "fixture-game" });
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
