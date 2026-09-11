import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import React from "react";
import { renderToString } from "react-dom/server";
import { applyMigrations } from "../src/lib/migrations";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { upsertApp } from "../src/lib/catalog";
import { getMediaSources, type MediaSource } from "../src/lib/media-discovery";
import { handleGameDetailRequest } from "../src/routes/api.games.$appid.detail";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { MediaSources } from "../src/components/media-sources";

function createSqliteAppAdapter(native: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next) {
          values = next;
          return statement;
        },
        async first<T>(colName?: string) {
          const row = native.prepare(query).get(...(values as SQLQueryBindings[])) as Record<string, unknown> | null;
          if (!row) return null;
          return (colName ? row[colName] : row) as T;
        },
        async run() {
          const result = native.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: result.changes, duration: 0 } };
        },
        async all<T>() {
          const results = native.prepare(query).all(...(values as SQLQueryBindings[])) as T[];
          return { success: true, results, meta: { changes: 0, duration: 0 } };
        },
        async raw<T>() {
          return native.prepare(query).values(...(values as SQLQueryBindings[])) as T[];
        },
      };
      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]): Promise<{ success: boolean; results?: T[] }[]> {
      const results: { success: boolean; meta: { changes: number; duration: number } }[] = [];
      native.exec("BEGIN TRANSACTION");
      try {
        for (const statement of statements) results.push(await statement.run());
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query) {
      native.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}

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
  const native = new Database(":memory:");
  applyMigrations(native);
  const db = createSqliteAppAdapter(native);
  return { native, db };
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
    expect(html).toContain("Read ↗");
    expect(html).not.toContain("By:");
    expect(html).not.toContain("Published:");
    expect(html).not.toContain("Updated:");
    expect(html).not.toContain("Hands-on:");
    expect(html).not.toContain("Affiliation:");
    expect(html).not.toContain("Platform:");
    expect(html).not.toContain("Build context:");
  });
});
