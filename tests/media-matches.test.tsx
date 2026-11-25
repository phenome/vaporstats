import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../src/lib/query-client";
import type { GameDetail } from "../src/lib/catalog";
import { GamePageView } from "../src/components/game-page";
import { ChildAppPageView } from "../src/components/child-app-page";
import { MediaMatchesSection } from "../src/components/media-matches";
import type { MediaGameMatch } from "../src/lib/media-similarity";

const matches: MediaGameMatch[] = [
  {
    dimension: "gameplay",
    similarity: 0.91,
    matchedGame: { appid: 20, name: "Matched Systems", slug: "matched-systems" },
  },
  {
    dimension: "story_world",
    similarity: 0.87,
    matchedGame: { appid: 30, name: "Matched Worlds", slug: "matched-worlds" },
  },
];

function matchInDimension(match: MediaGameMatch, dimension: MediaGameMatch["dimension"]): MediaGameMatch {
  return { ...match, dimension, similarity: 0.42 };
}

const game: GameDetail = {
  appid: 10,
  name: "Test Game",
  slug: "test-game",
  type: "game",
  is_eligible: true,
  is_playable: true,
  parent_appid: null,
  release_date: "2020-01-01",
  steam_release_date: null,
  original_release_date: null,
  original_steam_release_date: null,
  release_from_early_access_date: null,
  release_date_source: null,
  is_early_access: null,
  has_left_early_access: null,
  release_status: "released",
  description: "",
  header_image: "",
  developer: "",
  publisher: "",
  created_at: "2020-01-01T00:00:00Z",
  updated_at: "2020-01-01T00:00:00Z",
  latest_players: null,
  peak_players: null,
  last_observed_at: null,
};

describe("media matches section", () => {
  const paths = {
    20: "/games/10-parent/20-matched-systems",
    30: "/games/30-matched-worlds",
  };

  test("passes a non-default price range to the root price graph", () => {
    const html = renderToString(
      React.createElement(
        QueryClientProvider,
        { client: createQueryClient() },
        React.createElement(GamePageView, {
          game,
          pricerange: 2,
          priceHistory: null,
        }),
      ),
    );

    expect(html).toContain('aria-label="Price history time ranges"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">6m</button>");
    expect(html).not.toMatch(/aria-pressed="true"[^>]*>All<\/button>/);
  });

  test("renders independent dimensions and canonical game links without pair prose", () => {
    const html = renderToString(React.createElement(MediaMatchesSection, { matches, paths }));

    expect(html).toContain("Similar Games");
    expect(html).toContain("Gameplay &amp; systems");
    expect(html).toContain("Story &amp; world");
    expect(html).toContain('href="/methodology"');
    expect(html).toContain('href="/games/10-parent/20-matched-systems"');
    expect(html).toContain('href="/games/30-matched-worlds"');
    expect(html).not.toContain("Shared trait");
    expect(html).not.toContain("Both games");
    expect(html).not.toContain("Sources for");
    expect(html).not.toContain("0.91");
    expect(html).not.toContain("0.87");

    const gameplayOnlyHtml = renderToString(
      React.createElement(MediaMatchesSection, { matches: [matches[0]!], paths }),
    );
    expect(gameplayOnlyHtml).not.toContain("Story &amp; world");

    const missingPathHtml = renderToString(
      React.createElement(MediaMatchesSection, { matches: [matches[0]!], paths: {} }),
    );
    expect(missingPathHtml).toContain("Matched Systems");
    expect(missingPathHtml).not.toContain('href="/games/20-matched-systems"');
  });

  test("combines dimensions when they have the same app IDs in the same order", () => {
    const gameplay = [matches[0]!, matchInDimension(matches[1]!, "gameplay")];
    const story = gameplay.map((match) => matchInDimension(match, "story_world"));
    const { document } = parseHTML(renderToString(
      React.createElement(MediaMatchesSection, { matches: [...story, ...gameplay], paths }),
    ));

    expect(Array.from(document.querySelectorAll("h3"), (heading) => heading.textContent))
      .toEqual(["Gameplay & systems and Story & world"]);
    expect(Array.from(document.querySelectorAll("li a"), (link) => link.getAttribute("href")))
      .toEqual([paths[20], paths[30]]);
  });

  test("renders separate ordered lists when the same apps are ranked differently", () => {
    const gameplay = [matches[0]!, matchInDimension(matches[1]!, "gameplay")];
    const story = [matches[1]!, matchInDimension(matches[0]!, "story_world")];
    const { document } = parseHTML(renderToString(
      React.createElement(MediaMatchesSection, { matches: [...story, ...gameplay], paths }),
    ));

    expect(Array.from(document.querySelectorAll("h3"), (heading) => heading.textContent))
      .toEqual(["Gameplay & systems", "Story & world"]);
    expect(Array.from(document.querySelectorAll("ul"), (list) =>
      Array.from(list.querySelectorAll("a"), (link) => link.getAttribute("href"))))
      .toEqual([[paths[20], paths[30]], [paths[30], paths[20]]]);
  });

  test("keeps separate lists when one dimension has additional results", () => {
    const gameplay = [matches[0]!, matchInDimension(matches[1]!, "gameplay")];
    const story = [matchInDimension(matches[0]!, "story_world")];
    const { document } = parseHTML(renderToString(
      React.createElement(MediaMatchesSection, { matches: [...gameplay, ...story], paths }),
    ));

    expect(Array.from(document.querySelectorAll("ul"), (list) => list.children.length)).toEqual([2, 1]);
  });

  test("renders decorative Steam artwork over a local fallback even without a game link", () => {
    const { document } = parseHTML(renderToString(
      React.createElement(MediaMatchesSection, { matches: [matches[0]!] }),
    ));
    const artwork = document.querySelector("li img");

    expect(artwork?.getAttribute("src")).toBe(
      "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/20/capsule_184x69.jpg",
    );
    expect(artwork?.getAttribute("alt")).toBe("");
    expect(artwork?.parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(artwork?.parentElement?.textContent).toBe("M");
    expect(document.querySelector("li a")).toBeNull();
  });

  test("omits the section when no persisted matches exist", () => {
    expect(renderToString(React.createElement(MediaMatchesSection, { matches: [] }))).toBe("");
  });
  test("renders child evidence and keeps a controlled price range", () => {
    const child = {
      appid: 40,
      name: "Child Expansion",
      slug: "child-expansion",
      type: "expansion" as const,
      raw_type: "expansion",
      is_eligible: true,
      is_playable: false,
      parent_appid: game.appid,
      release_date: "2024-01-01",
      release_status: "released" as const,
      description: "A complete child detail.",
      header_image: "https://example.com/child.jpg",
      developer: "Child Studio",
      publisher: "Child Publisher",
      prominence: 1,
      created_at: game.created_at,
      updated_at: game.updated_at,
    };
    const childGame: GameDetail = {
      ...game,
      appid: child.appid,
      name: child.name,
      slug: child.slug,
      type: child.type,
      is_playable: child.is_playable,
      parent_appid: child.parent_appid,
      release_date: child.release_date,
      description: child.description,
      header_image: child.header_image,
      developer: child.developer,
      publisher: child.publisher,
    };
    const onPriceRangeChange = () => {};
    const html = renderToString(
      React.createElement(ChildAppPageView, {
        parent: game,
        child,
        game: childGame,
        sources: [{
          appid: child.appid,
          originalUrl: "https://ign.com/articles/child-review",
          discoveryUrl: "https://ign.com/search?child",
          title: "Child Review",
          outlet: "IGN",
          author: "Reviewer",
          publishedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: null,
          retrievedAt: "2026-09-01T00:00:00.000Z",
          type: "review",
          handsOn: true,
          affiliation: null,
          platform: "PC",
          buildContext: null,
        }],
        mediaOverview: {
          appid: child.appid,
          statements: [{ text: "Child evidence statement.", sourceUrls: ["https://example.com/child-review"] }],
          categories: [],
          prosCons: null,
          tags: [],
        },
        mediaMatches: matches,
        mediaMatchPaths: paths,
        pricerange: 2,
        onPriceRangeChange,
      }),
    );

    expect(html).toContain("Child evidence statement.");
    expect(html).toContain("Child Review");
    expect(html).toContain("Similar Games");
    expect(html).toMatch(/aria-pressed="true"[^>]*>6m<\/button>/);
    expect(html).not.toMatch(/aria-pressed="true"[^>]*>All<\/button>/);
  });
});
