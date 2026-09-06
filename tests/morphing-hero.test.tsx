import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
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

describe("morphing sticky hero and dual LQIP", () => {
  test("renders morphing sticky header with compact bar and expanded body", () => {
    const html = renderToString(<GamePageView game={mockGame} />);
    expect(html).toContain("morphing-game-hero");
    expect(html).toContain("Cyberpunk 2077");
    expect(html).toContain("Steam Store ↗");
    expect(html).toContain("6897c3848f3e0350d512f59d5bae174a1e3739f9.jpg");
    expect(html).toContain("mockHeaderLqip");
    expect(html).toContain("mockIconLqip");
  });

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
