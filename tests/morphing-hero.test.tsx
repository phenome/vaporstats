import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GamePageView } from "../src/components/game-page";
import type { GameDetail } from "../src/lib/catalog";
import { generateLqipFromBuffer, generateSquareLqipFromBuffer, ensureAppLqips } from "../src/lib/lqip";
import { getDb } from "../src/lib/db";

const mockGame: GameDetail = {
  appid: 1091500,
  name: "Cyberpunk 2077",
  slug: "cyberpunk-2077",
  type: "game",
  is_eligible: true,
  is_playable: true,
  parent_appid: null,
  release_date: "2020-12-10",
  steam_release_date: "2020-12-10",
  original_release_date: null,
  original_steam_release_date: null,
  release_from_early_access_date: null,
  release_date_source: "steam_release_date",
  is_early_access: false,
  has_left_early_access: false,
  release_status: "released",
  description: "Cyberpunk 2077 is an open-world, action-adventure RPG.",
  header_image: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg",
  header_lqip: "data:image/png;base64,mockHeaderLqip",
  icon_hash: "6897c3848f3e0350d512f59d5bae174a1e3739f9",
  icon_lqip: "data:image/png;base64,mockIconLqip",
  developer: "CD PROJEKT RED",
  publisher: "CD PROJEKT RED",
  latest_players: 25000,
  peak_players: 1054388,
  last_observed_at: "2026-09-06T12:00:00Z",
  created_at: "2020-12-10T00:00:00Z",
  updated_at: "2026-09-06T00:00:00Z",
};

test("keeps header artwork on icon failure and crossfades a working icon after navigation", async () => {
  const { window, document } = parseHTML("<html><body><main></main></body></html>");
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const globals = {
    window,
    document,
    location: { hash: "" },
    scrollY: 0,
    fetch: async () => new Response(null, { status: 404 }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const container = document.querySelector("main")!;
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const renderGame = (game: GameDetail) => act(async () => {
    root.render(<QueryClientProvider client={queryClient}><GamePageView game={game} /></QueryClientProvider>);
  });
  const header = () => container.querySelector<HTMLImageElement>(".hero-art-header")!;
  const compact = () => container.querySelector<HTMLImageElement>(".hero-art-compact")!;
  const warlock = {
    ...mockGame,
    appid: 3714800,
    name: "Warlock",
    header_image: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/3714800/header.jpg",
    icon_lqip: null,
  };

  try {
    await renderGame(warlock);
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
    const hero = container.querySelector<HTMLElement>(".morphing-game-hero")!;
    expect(hero.style.getPropertyValue("--hero-morph-progress")).toBe("1");
    expect(compact().src).toContain("/3714800/");
    act(() => { compact().dispatchEvent(new window.Event("error")); });
    expect(compact().style.visibility).toBe("hidden");
    expect(header().getAttribute("data-hero-crossfade")).toBeNull();
    expect(header().src).toBe(warlock.header_image);

    await renderGame(mockGame);
    expect(compact().src).toContain("/1091500/");
    expect(compact().style.visibility).toBe("hidden");
    act(() => { compact().dispatchEvent(new window.Event("load")); });
    expect(compact().style.visibility).not.toBe("hidden");
    expect(compact().getAttribute("data-hero-crossfade")).toBe("compact");
    expect(header().getAttribute("data-hero-crossfade")).toBe("header");

    await renderGame(warlock);
    expect(compact().style.visibility).toBe("hidden");
    expect(header().src).toBe(warlock.header_image);
    expect(header().getAttribute("data-hero-crossfade")).toBeNull();
  } finally {
    act(() => root.unmount());
    queryClient.clear();
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

describe("dual LQIP", () => {
  test("Bun.Image placeholder generators produce valid data URLs", async () => {
    const img = new Bun.Image("./src/assets/logo.png");
    const bytes = await img.bytes();
    const lqip = await generateLqipFromBuffer(bytes);
    const squareLqip = await generateSquareLqipFromBuffer(bytes);

    expect(lqip.startsWith("data:image/png;base64,")).toBe(true);
    expect(squareLqip.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("ensureAppLqips preserves existing placeholders without re-fetching", async () => {
    const db = await getDb();
    const result = await ensureAppLqips(db, mockGame);
    expect(result.header_lqip).toBe(mockGame.header_lqip!);
    expect(result.icon_lqip).toBe(mockGame.icon_lqip!);
  });
});
