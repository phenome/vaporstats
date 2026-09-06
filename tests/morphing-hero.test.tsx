import { describe, expect, test } from "bun:test";
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
  test("renders one shared identity set and one fade-only description", () => {
    const html = renderToString(<GamePageView game={mockGame} />);

    expect(html.match(/data-game-identity="title"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="status"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="date"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="store"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="artwork"/g)?.length).toBe(1);

    expect(
      html.match(
        /<h1\b(?=[^>]*data-game-identity="title")[^>]*>[\s\S]*?Cyberpunk 2077[\s\S]*?<\/h1>/g,
      )?.length,
    ).toBe(1);
    expect(
      html.match(
        /<span\b(?=[^>]*data-game-identity="status")[^>]*>[^<]*Released[^<]*<\/span>/g,
      )?.length,
    ).toBe(1);
    expect(
      html.match(
        /<(?:time|span)\b(?=[^>]*data-game-identity="date")[^>]*>[^<]*Dec 10, 2020[^<]*<\/(?:time|span)>/g,
      )?.length,
    ).toBe(1);
    expect(
      html.match(
        /<a\b(?=[^>]*data-game-identity="store")(?=[^>]*href="https:\/\/store\.steampowered\.com\/app\/1091500\/)[^>]*>[\s\S]*?Steam Store ↗[\s\S]*?<\/a>/g,
      )?.length,
    ).toBe(1);
    expect(
      html.match(/<div\b(?=[^>]*data-game-identity="artwork")[^>]*>/g)?.length,
    ).toBe(1);
    expect(html.match(/Cyberpunk 2077 is an open-world, action-adventure RPG\./g)?.length).toBe(1);
  });

  test("uses icon LQIP in the shared artwork shell without the VS fallback", () => {
    const html = renderToString(
      <GamePageView
        game={{ ...mockGame, icon_hash: null, icon_lqip: "data:image/png;base64,mockIconLqip" }}
      />,
    );

    expect(html.match(/data-game-identity="title"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="status"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="date"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="store"/g)?.length).toBe(1);
    expect(html.match(/data-game-identity="artwork"/g)?.length).toBe(1);
    expect(
      html.match(
        /data-game-identity="artwork"[^>]*>[\s\S]*?src="data:image\/png;base64,mockIconLqip"/g,
      )?.length,
    ).toBe(1);
    expect(html.match(/>\s*VS\s*</g)?.length ?? 0).toBe(0);
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
