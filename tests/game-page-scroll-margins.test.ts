import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The selectors of every rule that sets a scroll margin clearing both sticky headers. */
function clearingSelectors(): string[][] {
  return [...css.matchAll(/([^{}]+)\{\s*scroll-margin-top:\s*calc\(\d+px \+ var\(--hero-compact-height/g)]
    .map((match) => match[1]!.split(",").map((selector) => selector.trim()));
}

describe("game page anchor targets clear the sticky headers", () => {
  test("every section-navigation and citation target is listed at desktop and mobile widths", () => {
    const rules = clearingSelectors();
    expect(rules).toHaveLength(2);
    for (const selectors of rules) {
      for (const target of [
        "#media-overview",
        "#media-sources",
        "#media-matches",
        '[id^="media-source-"]',
        "#game-reception",
        "#player-history",
        "#price-history",
        "#related-content",
      ]) {
        expect(selectors).toContain(target);
      }
    }
  });
});
