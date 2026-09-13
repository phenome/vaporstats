import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MediaMatchesSection } from "../src/components/media-matches";
import type { MediaGameMatch } from "../src/lib/media-similarity";

const citation = (overrides: Partial<MediaGameMatch["currentSources"][number]> = {}) => ({
  originalUrl: "https://example.com/current-review",
  title: "Current Game Preview",
  outlet: "Example Outlet",
  type: "preview" as const,
  handsOn: true,
  platform: "PC",
  buildContext: "Early access build 0.9",
  ...overrides,
});

const matches: MediaGameMatch[] = [
  {
    dimension: "gameplay",
    trait: "Flexible tactical systems",
    explanation: "Both games reward deliberate planning and experimentation.",
    similarity: 0.91,
    matchedGame: { appid: 20, name: "Matched Systems", slug: "matched-systems" },
    currentSources: [citation()],
    matchedSources: [citation({
      originalUrl: "https://example.com/matched-review",
      title: "Matched Game Review",
      outlet: "Second Outlet",
      type: "review",
      handsOn: false,
      platform: "Console",
      buildContext: "Version 1.2",
    })],
  },
  {
    dimension: "story_world",
    trait: "Layered science-fiction worlds",
    explanation: "Their stories build a coherent setting through exploration.",
    similarity: 0.87,
    matchedGame: { appid: 30, name: "Matched Worlds", slug: "matched-worlds" },
    currentSources: [citation({
      originalUrl: "https://example.com/current-worlds",
      title: "Current Worlds Preview",
      outlet: "World Outlet",
      platform: null,
      buildContext: null,
    })],
    matchedSources: [citation({
      originalUrl: "https://example.com/matched-worlds",
      title: "Matched Worlds Review",
      outlet: "World Review",
      handsOn: null,
      platform: null,
      buildContext: null,
    })],
  },
];

describe("media matches section", () => {
  test("renders independent dimensions, canonical game links, and both citation sides", () => {
    const html = renderToString(React.createElement(MediaMatchesSection, { matches }));

    expect(html).toContain("Gameplay &amp; systems");
    expect(html).toContain("Story &amp; world");
    expect(html).toContain("Flexible tactical systems");
    expect(html).toContain("Layered science-fiction worlds");
    expect(html).toContain('href="/games/20-matched-systems"');
    expect(html).toContain('href="/games/30-matched-worlds"');
    expect(html).toContain('href="https://example.com/current-review"');
    expect(html).toContain('href="https://example.com/matched-review"');
    expect(html).toContain("Example Outlet");
    expect(html).toContain("Matched Game Review");
    expect(html).toContain("Read ↗");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Read Current Game Preview on Example Outlet (opens in a new tab)"');
    expect(html).toContain('aria-label="Read Matched Game Review on Second Outlet (opens in a new tab)"');
    expect(html).toContain("Type: preview");
    expect(html).toContain("Build context: Early access build 0.9");
    expect(html).toContain("Platform: Console");
    expect(html).not.toContain("Platform: null");
    expect(html).not.toContain("Build context: null");

  });
  test("omits the section when no persisted matches exist", () => {
    expect(renderToString(React.createElement(MediaMatchesSection, { matches: [] }))).toBe("");
  });
});
