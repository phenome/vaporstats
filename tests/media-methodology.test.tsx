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
      "results-change",
      "media-matches",
      "media-discovery-tags",
    ]);
  });

  test("covers synthesis, revision, both match dimensions and original articles", () => {
    const text = methodologyText();
    // Automatic synthesis from attributed outlet coverage.
    expect(text).toContain("written automatically");
    for (const outlet of ["IGN", "Eurogamer", "GameSpot", "PC Gamer", "Kotaku", "GamesRadar+"]) {
      expect(text).toContain(outlet);
    }
    // Revisable results.
    expect(text).toContain("Results change as coverage changes");
    // Similarity by dimension.
    expect(text).toContain("Gameplay & systems");
    expect(text).toContain("Story & world");
    // Every finding links to its original articles.
    expect(text).toContain("original article");
  });

  test("explains that gameplay compares Steam community tags, story and world compares coverage, and only similar enough games appear", () => {
    const html = renderToString(React.createElement(MediaMethodologyView));
    const section = html.slice(html.indexOf('id="media-matches"'), html.indexOf('id="media-discovery-tags"'));
    const text = section.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    expect(text).toContain("Gameplay & systems compares the Steam community tags");
    expect(text).toMatch(/genre, viewpoint, and mechanics/);
    expect(text).toContain("rarer tags");
    expect(text).toContain("listed only when the overlap is strong enough");
    expect(text).toContain("shows the tags the two games share");
    expect(text).toContain("Story & world compares what the coverage describes");
    expect(text).toContain("Quality judgments, popularity, and technical problems are left out");
    expect(text).toContain("No outlet made the comparison");
    expect(text).toContain("Only games with processed coverage can appear");
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
