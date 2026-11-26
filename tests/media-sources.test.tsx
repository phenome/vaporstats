import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { parseHTML } from "linkedom";
import React from "react";
import { renderToString } from "react-dom/server";
import type { AppDatabase } from "../src/lib/db";
import { upsertApp } from "../src/lib/catalog";
import { getMediaSources, type MediaSource } from "../src/lib/media-discovery";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { MediaSources } from "../src/components/media-sources";
import { MediaOverviewSection } from "../src/components/media-overview";
import type { MediaOverview } from "../src/lib/media-overview";
import { openMemoryDatabase } from "./support/db";

const source: MediaSource = {
  appid: 1091500,
  originalUrl: "https://www.ign.com/articles/cyberpunk-2077-review",
  discoveryUrl: "https://www.tavily.com/search?q=cyberpunk",
  title: "Cyberpunk 2077 Review",
  outlet: "IGN",
  author: "Reviewer Name",
  publishedAt: "2024-01-02T00:00:00.000Z",
  updatedAt: "2024-01-03T00:00:00.000Z",
  retrievedAt: "2026-09-10T00:00:00.000Z",
  type: "review",
  handsOn: true,
  affiliation: "Independent",
  platform: "PC",
  buildContext: "1.63",
};

function createFixture() {
  return openMemoryDatabase();
}

async function seedGame(db: AppDatabase, native: Database) {
  await upsertApp(db, {
    appid: 1091500,
    name: "Cyberpunk 2077",
    is_eligible: true,
    is_playable: true,
    release_date: "2020-12-10",
    steam_release_date: "2020-12-10",
    release_status: "released",
    header_image: "",
  });
  native.prepare(`
    INSERT INTO media_sources (
      appid, pass, original_url, discovery_url, title, outlet, author, published_at,
      updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.appid,
    "initial",
    source.originalUrl,
    source.discoveryUrl,
    source.title,
    source.outlet,
    source.author,
    source.publishedAt,
    source.updatedAt,
    source.retrievedAt,
    source.type,
    source.handsOn ? 1 : 0,
    source.affiliation,
    source.platform,
    source.buildContext,
  );
}

describe("game media sources", () => {
  test("detail API returns persisted source metadata unchanged", async () => {
    const { db, native } = createFixture();
    try {
      await seedGame(db, native);
      const response = await handleGameDetailRequest(
        new Request("https://vaporstats.test/api/games/1091500/detail"),
        db,
        1091500,
      );
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { sources: MediaSource[] } };
      expect(body.data.sources).toEqual([source]);
      expect(await getMediaSources(db, 1091500)).toEqual([source]);
      const ssrResponse = await handleGameHttpRequest(
        new Request("https://vaporstats.test/games/1091500-cyberpunk-2077"),
        db,
      );
      expect(ssrResponse.status).toBe(200);
      expect(await ssrResponse.text()).toContain("Cyberpunk 2077 Review");
    } finally {
      native.close(true);
    }
  });

  test("serves and renders a persisted cited Overview when publication is enabled", async () => {
    const previous = process.env.MEDIA_OVERVIEW_PUBLIC;
    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    const { db, native } = createFixture();
    try {
      await seedGame(db, native);
      native.prepare(
        "INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json) VALUES (?, ?, ?, ?, ?)",
      ).run(
        source.appid,
        "overview-input",
        "gemini-3.1-flash-lite",
        "media-synthesis-v1",
        JSON.stringify({
          appid: source.appid,
          statements: [{
            text: "Optional quests can influence the ending on PC (reviewed PC version)",
            sourceUrls: [source.originalUrl],
          }],
        }),
      );

      const response = await handleGameDetailRequest(
        new Request("https://vaporstats.test/api/games/1091500/detail"),
        db,
        1091500,
      );
      const body = await response.json() as {
        data: { mediaOverview: { statements: Array<{ text: string; sourceUrls: string[] }> } };
      };
      expect(body.data.mediaOverview.statements[0]).toEqual({
        text: "Optional quests can influence the ending on PC (reviewed PC version)",
        sourceUrls: [source.originalUrl],
      });

      const overviewHtml = renderToString(React.createElement(MediaOverviewSection, {
        overview: {
          appid: source.appid,
          statements: [
            ...body.data.mediaOverview.statements,
            { text: "Night City's open world feels vast and dense at middle to long distances (50GB Day 0 patch, PC)", sourceUrls: [source.originalUrl] },
            { text: "Gunplay feels satisfying and offers creative build variety (50GB Day 0 patch, PC)", sourceUrls: [source.originalUrl] },
          ],
          tags: [{ label: "First-person shooter", slug: "first-person-shooter" }],
          categories: [],
          prosCons: null,
        },
        sources: [source],
      }));
      expect(overviewHtml).toContain("Overview");
      expect(overviewHtml).toContain("Optional quests can influence the ending");
      expect(overviewHtml).not.toContain("reviewed PC version");
      expect(overviewHtml).toContain("Gunplay feels satisfying and offers creative build variety");
      expect(overviewHtml).not.toContain("Day 0 patch");
      expect(overviewHtml).toContain('href="#media-source-1"');
      expect(overviewHtml).toContain('title="IGN: Cyberpunk 2077 Review"');
      expect(overviewHtml).toContain('aria-label="Source 1: Cyberpunk 2077 Review on IGN"');
      expect(overviewHtml).toContain('href="/games/?mediaTag=First-person%20shooter"');
      expect(overviewHtml).toContain('aria-label="Browse games tagged First-person shooter"');

      const ssrResponse = await handleGameHttpRequest(
        new Request("https://vaporstats.test/games/1091500-cyberpunk-2077"),
        db,
      );
      const ssrHtml = await ssrResponse.text();
      expect(ssrHtml).toContain("Optional quests can influence the ending");
      expect(ssrHtml).toContain('id=\"media-source-1\"');
    } finally {
      native.close(true);
      if (previous === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
      else process.env.MEDIA_OVERVIEW_PUBLIC = previous;
    }
  });

  test("renders rich and disputed persisted synthesis while omitting absent categories", async () => {
    const previous = process.env.MEDIA_OVERVIEW_PUBLIC;
    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    const { db, native } = createFixture();
    try {
      await seedGame(db, native);
      const secondUrl = "https://www.eurogamer.net/cyberpunk-2077-review";
      native.prepare(
        "INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on) VALUES (?, 'initial', ?, 'Cyberpunk 2077 review', 'Eurogamer', ?, 'review', 1)",
      ).run(source.appid, secondUrl, "2026-09-10T00:00:00.000Z");
      native.prepare(
        "INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json) VALUES (?, ?, ?, ?, ?)",
      ).run(
        source.appid,
        "rich-overview-input",
        "gemini-3.1-flash-lite",
        "media-synthesis-v2",
        JSON.stringify({
          statements: [{
            text: "Night City supports several approaches to its missions.",
            sourceUrls: [source.originalUrl, secondUrl],
          }],
          categories: [
            {
              name: "Gameplay & systems",
              findings: [{
                text: "Combat can reward specialization or feel restrictive depending on build.",
                sourceUrls: [source.originalUrl, secondUrl],
                contested: true,
              }],
            },
            {
              name: "Visuals & audio",
              findings: [{
                text: "Dense city detail supports the setting.",
                sourceUrls: [source.originalUrl],
              }],
            },
          ],
          prosCons: {
            pros: [{
              text: "Missions allow varied approaches.",
              sourceUrls: [source.originalUrl, secondUrl],
            }],
            cons: [],
          },
        }),
      );

      const response = await handleGameDetailRequest(
        new Request("https://vaporstats.test/api/games/1091500/detail"),
        db,
        source.appid,
      );
      const body = await response.json() as {
        data: { mediaOverview: MediaOverview | null };
      };
      const overview = body.data.mediaOverview;
      expect(overview?.categories.map((category) => category.name)).toEqual([
        "Gameplay & systems",
        "Visuals & audio",
      ]);
      expect(overview?.prosCons?.cons).toEqual([]);
      if (!overview) throw new Error("Expected persisted media overview");

      const html = renderToString(React.createElement(MediaOverviewSection, {
        overview,
        sources: await getMediaSources(db, source.appid),
      }));
      expect(html).toContain("Gameplay &amp; systems");
      expect(html).toContain("Visuals &amp; audio");
      expect(html).toContain("Pros &amp; cons");
      expect(html).toContain("Contested");
      expect(html).toContain("data-contested");
      expect(html).toContain('href="#media-source-1"');
      expect(html).toContain('href="#media-source-2"');
      expect(html).not.toContain("Story &amp; world");
      expect(html).not.toContain(">Cons<");

      const ssrResponse = await handleGameHttpRequest(
        new Request("https://vaporstats.test/games/1091500-cyberpunk-2077"),
        db,
      );
      const ssrHtml = await ssrResponse.text();
      expect(ssrHtml).toContain("Contested");
      expect(ssrHtml).toContain("Missions allow varied approaches.");
    } finally {
      native.close(true);
      if (previous === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
      else process.env.MEDIA_OVERVIEW_PUBLIC = previous;
    }
  });

  test("renders the edition chapters and every article target in the game response", async () => {
    const previous = process.env.MEDIA_OVERVIEW_PUBLIC;
    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    const { db, native } = createFixture();
    try {
      await seedGame(db, native);
      const port = "https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update";
      const eurogamer = "https://www.eurogamer.net/cyberpunk-2077-review";
      const insertSource = native.prepare(
        "INSERT INTO media_sources (appid, pass, original_url, title, outlet, published_at, retrieved_at, type) VALUES (?, 'initial', ?, ?, ?, ?, '2026-09-10', 'review')",
      );
      insertSource.run(source.appid, eurogamer, "PC launch review", "Eurogamer", "2024-01-04");
      insertSource.run(source.appid, port, "Switch 2 review", "IGN", "2025-06-12");
      native.prepare(
        "INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json) VALUES (?, 'editions', 'model', 'config', ?)",
      ).run(source.appid, JSON.stringify({
        statements: [{ text: "The city is densely detailed.", sourceUrls: [source.originalUrl], edition: "PC at launch" }],
        categories: [{
          name: "Visuals & audio",
          findings: [
            { text: "The city is densely detailed!", sourceUrls: [eurogamer], edition: "PC at launch" },
            { text: "Neon colors stand out at night.", sourceUrls: [source.originalUrl], edition: "PC at launch" },
            { text: "The city is densely detailed.", sourceUrls: [port], edition: "Switch 2 port" },
            { text: "The soundscape changes by neighborhood.", sourceUrls: [eurogamer] },
          ],
        }],
      }));

      const response = await handleGameHttpRequest(
        new Request("https://vaporstats.test/games/1091500-cyberpunk-2077"),
        db,
      );
      expect(response.status).toBe(200);
      const { document } = parseHTML(await response.text());
      const overview = document.querySelector("#media-overview")!;
      const chapters = [...overview.querySelectorAll("section")];
      expect(chapters.map((chapter) => chapter.querySelector("h3")?.textContent)).toEqual(["PC at launch", "Switch 2 port"]);
      expect(chapters.map((chapter) => chapter.querySelector("time")?.getAttribute("dateTime"))).toEqual(["2024-01", "2025-06"]);
      expect(chapters[0]?.textContent).toContain("Neon colors stand out at night.");
      expect(chapters[0]?.textContent).not.toContain("The city is densely detailed");
      expect(chapters[1]?.textContent).toContain("The city is densely detailed.");
      expect(overview.textContent).toContain("The soundscape changes by neighborhood.");
      const lead = [...overview.querySelectorAll("p")].find((p) => p.textContent?.startsWith("The city is densely detailed."));
      expect([...lead!.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["#media-source-1", "#media-source-2"]);

      const sources = document.querySelector("#media-sources")!;
      expect(sources.textContent).toContain("3 articles · 2 outlets");
      const group = sources.querySelector("details")!;
      expect(group.hasAttribute("open")).toBe(false);
      expect(group.querySelector("summary strong")?.textContent).toBe("IGN▸");
      expect(group.querySelector("summary")?.textContent).toContain("2 articles");
      expect(group.textContent).toContain("Switch 2 review");
      expect(sources.querySelector("#media-source-2")?.closest("details")).toBeNull();
      expect([...overview.querySelectorAll('a[href^="#media-source-"]')].every((citation) => {
        const target = sources.querySelector(citation.getAttribute("href")!);
        return target?.getAttribute("tabindex") === "-1" && target.querySelector("a") !== null;
      })).toBe(true);
      expect(overview.querySelector('a[href="#media-source-1"] sub')?.textContent).toBe("1");
      expect(overview.querySelector('a[href="#media-source-3"] sub')?.textContent).toBe("2");
      expect(group.querySelector("#media-source-1 sub")?.textContent).toBe("1");
      expect(group.querySelector("#media-source-3 sub")?.textContent).toBe("2");
    } finally {
      native.close(true);
      if (previous === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
      else process.env.MEDIA_OVERVIEW_PUBLIC = previous;
    }
  });

  test("renders a composed lead with its original punctuation and each span's own citations", () => {
    const second = { ...source, originalUrl: "https://www.pcgamer.com/cyberpunk-2077-review/", outlet: "PC Gamer" as const };
    const html = renderToString(React.createElement(MediaOverviewSection, {
      overview: {
        appid: source.appid,
        composedLead: true,
        statements: [
          { text: "You reach the flooded town by ferry", sourceUrls: [source.originalUrl] },
          { text: "and choose which mission to take next.", sourceUrls: [source.originalUrl, second.originalUrl] },
        ],
        categories: [],
        prosCons: null,
        tags: [],
      },
      sources: [source, second],
    }));
    const { document } = parseHTML(html);
    const spans = document.querySelectorAll("#media-overview p > span");
    expect(spans).toHaveLength(2);
    expect(spans[0]?.firstChild?.textContent).toBe("You reach the flooded town by ferry");
    expect(spans[0]?.lastChild?.nodeName).toBe("A");
    expect(spans[1]?.textContent).toContain("and choose which mission to take next.");
    expect([...spans].map((span) => [...span.querySelectorAll("a")].map((link) => link.getAttribute("href"))))
      .toEqual([["#media-source-1"], ["#media-source-1", "#media-source-2"]]);
  });

  test("renders one known edition as topics without an edition chapter", () => {
    const finding = { text: "The city looks distinct at night.", sourceUrls: [source.originalUrl], edition: "PC at launch" };
    const html = renderToString(React.createElement(MediaOverviewSection, {
      overview: {
        appid: source.appid,
        statements: [{ ...finding, text: "The city rewards exploration." }],
        categories: [{ name: "Visuals & audio", findings: [finding] }],
        prosCons: null,
        tags: [],
      },
      sources: [source],
    }));
    const { document } = parseHTML(html);
    expect(document.querySelector("h3")?.textContent).toBe("Visuals & audio");
    expect(document.querySelector("#media-overview section")).toBeNull();
    expect(document.querySelector("#media-overview")?.textContent).toContain(finding.text);
  });

  test("empty persisted coverage is omitted from the rendered page", () => {
    const html = renderToString(React.createElement(MediaSources, { sources: [] }));
    expect(html).toBe("");
    expect(html).not.toContain("Sources");
  });

  test("null optional metadata stays absent while links remain semantic", () => {
    const nullable: MediaSource = {
      ...source,
      author: null,
      publishedAt: null,
      updatedAt: null,
      handsOn: null,
      affiliation: null,
      platform: null,
      buildContext: null,
    };
    const html = renderToString(React.createElement(MediaSources, { sources: [nullable] }));
    expect(html).toContain("Sources");
    expect(html).toContain("Cyberpunk 2077 Review");
    expect(html).toContain('href="https://www.ign.com/articles/cyberpunk-2077-review"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Read Cyberpunk 2077 Review on IGN (opens in a new tab)"');
    expect(html).toContain('aria-hidden="true">↗');
    expect(html).not.toContain("By:");
    expect(html).not.toContain("Published:");
    expect(html).not.toContain("Updated:");
    expect(html).not.toContain("Hands-on:");
    expect(html).not.toContain("Affiliation:");
    expect(html).not.toContain("Platform:");
    expect(html).not.toContain("Build context:");
  });
});
