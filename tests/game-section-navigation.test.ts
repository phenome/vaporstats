import { describe, expect, test } from "bun:test";
import { getActiveGameSection } from "../src/lib/game-section-navigation";

const cardDestinations = [
  ["game-reception", "media-sources"],
  ["player-history", "game-reception"],
  ["price-history", "player-history"],
] as const;

const stickyStacks = [
  { width: 1280, navBottom: 137, scrollPadding: 106 },
  { width: 390, navBottom: 183, scrollPadding: 152 },
];

describe("game section navigation", () => {
  for (const [destination, preceding] of cardDestinations) {
    for (const { width, navBottom, scrollPadding } of stickyStacks) {
      test(`${destination} wins at its fragment landing at ${width}px`, () => {
        const inset = navBottom + scrollPadding;
        const sections = [
          { id: preceding, top: -250, bottom: inset - 24 },
          { id: destination, top: inset, bottom: inset + 900 },
        ];

        expect(getActiveGameSection(sections, navBottom, {
          sectionId: destination,
          top: inset,
          inset,
          scrollTop: 1_200,
          maxScrollTop: 3_000,
        })).toBe(destination);
      });
    }
  }

  test("a nested citation selects Sources at the fragment landing", () => {
    expect(getActiveGameSection([
      { id: "media-overview", top: -300, bottom: 196 },
      { id: "media-sources", top: 220, bottom: 1_100 },
    ], 137, {
      sectionId: "media-sources",
      top: 243,
      inset: 243,
      scrollTop: 820,
      maxScrollTop: 3_000,
    })).toBe("media-sources");
  });

  test("the last card still selects its section when the page is too short for alignment", () => {
    expect(getActiveGameSection([
      { id: "player-history", top: -350, bottom: 365 },
      { id: "price-history", top: 389, bottom: 775 },
    ], 137, {
      sectionId: "price-history",
      top: 389,
      inset: 243,
      scrollTop: 2_000,
      maxScrollTop: 2_000,
    })).toBe("price-history");
  });

  test("manual scrolling uses the reading line while the previous fragment is still visible", () => {
    expect(getActiveGameSection([
      { id: "media-overview", top: -300, bottom: 236 },
      { id: "media-sources", top: 260, bottom: 1_140 },
    ], 137, {
      sectionId: "media-sources",
      top: 283,
      inset: 243,
      scrollTop: 780,
      maxScrollTop: 3_000,
    })).toBe("media-overview");
  });
});
