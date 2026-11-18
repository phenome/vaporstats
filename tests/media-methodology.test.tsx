import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { MediaMethodologyView } from "../src/components/media-methodology";
import { MediaOverviewSection } from "../src/components/media-overview";
import { MediaMatchesSection } from "../src/components/media-matches";
import type { MediaSource } from "../src/lib/media-discovery";

const METHODOLOGY_PATH = "/methodology";

function methodologyText(): string {
  return renderToString(React.createElement(MediaMethodologyView))
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

const source: MediaSource = {
  appid: 10,
  originalUrl: "https://www.ign.com/articles/test-review",
  discoveryUrl: null,
  title: "Test Review",
  outlet: "IGN",
  author: null,
  publishedAt: null,
  updatedAt: null,
  retrievedAt: "2026-09-10T00:00:00.000Z",
  type: "review",
  handsOn: null,
  affiliation: null,
  platform: null,
  buildContext: null,
};

describe("media methodology page", () => {
  test("answers each question a player needs to judge the media sections", () => {
    const html = renderToString(React.createElement(MediaMethodologyView));
    const questions = [...html.matchAll(/<h2[^>]*id="([^"]+)"/g)].map((match) => match[1]);
    expect(questions).toEqual([
      "how-overviews-are-written",
      "where-statements-come-from",
      "evidence-limits",
      "results-change",
      "media-matches",
      "media-discovery-tags",
    ]);
  });

  test("covers synthesis, evidence limits, revision, both match dimensions and original articles", () => {
    const text = methodologyText();
    // Automatic synthesis from attributed outlet coverage.
    expect(text).toContain("written automatically");
    for (const outlet of ["IGN", "Eurogamer", "GameSpot", "PC Gamer", "Kotaku", "GamesRadar+"]) {
      expect(text).toContain(outlet);
    }
    // Evidence limits.
    expect(text).toContain("Few sources");
    expect(text).toContain("single article");
    expect(text).toContain("Previews and announcements");
    expect(text).toContain("Outlets that refuse access");
    // Revisable results.
    expect(text).toContain("Results change as coverage changes");
    // Similarity by dimension.
    expect(text).toContain("Gameplay & systems");
    expect(text).toContain("Story & world");
    // Every finding links to its original articles.
    expect(text).toContain("original article");
  });

  test("names the approach without model names, versions or accuracy promises", () => {
    const text = methodologyText();
    expect(text).toContain("language model");
    expect(text).not.toMatch(/gemini|haiku|claude|openrouter|gpt|sonnet|opus/i);
    expect(text).not.toMatch(/\bv\d+(\.\d+)*\b|version \d/i);
    expect(text).not.toMatch(/guarantee|always accurate|fully accurate|100%/i);
  });

  test("is a registered route", () => {
    const tree = readFileSync(new URL("../src/routeTree.gen.ts", import.meta.url), "utf8");
    expect(tree).toContain(`path: '${METHODOLOGY_PATH}'`);
  });
});

describe("media sections link to the methodology", () => {
  test("the Overview links to the methodology once, outside its statements", () => {
    const html = renderToString(React.createElement(MediaOverviewSection, {
      overview: {
        appid: 10,
        statements: [{ text: "Combat rewards flexible builds.", sourceUrls: [source.originalUrl] }],
        categories: [],
        prosCons: null,
        tags: [],
      },
      sources: [source],
    }));
    expect(html.match(/href="\/methodology"/g)).toHaveLength(1);
  });

  test("media matches link to the methodology once", () => {
    const html = renderToString(React.createElement(MediaMatchesSection, {
      matches: [{ dimension: "gameplay", similarity: 0.9, matchedGame: { appid: 20, name: "Other", slug: "other" } }],
    }));
    expect(html.match(/href="\/methodology"/g)).toHaveLength(1);
  });

  test("an absent matches section renders no methodology link", () => {
    expect(renderToString(React.createElement(MediaMatchesSection, { matches: [] }))).toBe("");
  });
});
