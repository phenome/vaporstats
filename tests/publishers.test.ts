import { describe, test, expect, beforeAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { renderToString } from "react-dom/server";
import React from "react";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import { upsertApp } from "../src/lib/catalog";
import {
  toPublisherSlug,
  parsePublisherSlug,
  getCanonicalPublisherPath,
} from "../src/lib/slug";
import {
  getPublisherGames,
  listPublishers,
} from "../src/lib/publishers";
import { handlePublisherHttpRequest } from "../src/routes/publisher.$publisher";
import { GamePageView } from "../src/components/game-page";

function createSqliteAppAdapter(db: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let boundValues: unknown[] = [];

      const statement = {
        bind(...values: unknown[]): AppPreparedStatement {
          boundValues = values;
          return statement;
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          const stmt = db.prepare(query);
          const row = stmt.get(...(boundValues as SQLQueryBindings[])) as Record<string, unknown> | null;
          if (!row) return null;
          if (colName) {
            return (row[colName] as T) ?? null;
          }
          return row as T;
        },
        async run() {
          const stmt = db.prepare(query);
          const info = stmt.run(...(boundValues as SQLQueryBindings[]));
          return {
            success: true,
            meta: {
              changes: info.changes,
              duration: 0,
            },
          };
        },
        async all<T = unknown>() {
          const stmt = db.prepare(query);
          const results = stmt.all(...(boundValues as SQLQueryBindings[])) as T[];
          return {
            success: true,
            results,
            meta: {
              changes: 0,
              duration: 0,
            },
          };
        },
        async raw<T = unknown>() {
          const stmt = db.prepare(query);
          const results = stmt.values(...(boundValues as SQLQueryBindings[])) as T[];
          return results;
        },
      };

      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]) {
      const results: { success: boolean; results?: T[] }[] = [];
      db.run("BEGIN TRANSACTION;");
      try {
        for (const s of statements) {
          const res = await s.all<T>();
          results.push({ success: res.success, results: res.results });
        }
        db.run("COMMIT;");
      } catch (err) {
        db.run("ROLLBACK;");
        throw err;
      }
      return results;
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

describe("publisher slug and canonical path", () => {
  test("generates and parses publisher slugs accurately", () => {
    expect(toPublisherSlug("Valve")).toBe("valve");
    expect(toPublisherSlug("CD PROJEKT RED")).toBe("cd-projekt-red");
    expect(toPublisherSlug("Warner Bros. Games")).toBe("warner-bros-games");
    expect(toPublisherSlug("")).toBe("publisher");

    expect(parsePublisherSlug("valve")).toEqual({ slug: "valve" });
    expect(parsePublisherSlug("1-valve")).toEqual({ id: 1, slug: "valve" });
    expect(parsePublisherSlug("123-cd-projekt-red")).toEqual({ id: 123, slug: "cd-projekt-red" });
    expect(parsePublisherSlug("")).toBeNull();

    expect(getCanonicalPublisherPath("Valve")).toBe("/publisher/valve");
    expect(getCanonicalPublisherPath("Valve", 1)).toBe("/publisher/1-valve");
    expect(getCanonicalPublisherPath("CD PROJEKT RED")).toBe("/publisher/cd-projekt-red");
  });
});

describe("catalog publisher queries", () => {
  let db: AppDatabase;

  beforeAll(async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    db = createSqliteAppAdapter(sqlite);

    // Seed test games
    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      developer: "Valve",
      publisher: "Valve",
      is_eligible: true,
      is_playable: true,
    });
    await upsertApp(db, {
      appid: 570,
      name: "Dota 2",
      developer: "Valve",
      publisher: "Valve",
      is_eligible: true,
      is_playable: true,
    });
    await upsertApp(db, {
      appid: 1091500,
      name: "Cyberpunk 2077",
      developer: "CD PROJEKT RED",
      publisher: "CD PROJEKT RED",
      is_eligible: true,
      is_playable: true,
    });
    await upsertApp(db, {
      appid: 1245620,
      name: "ELDEN RING",
      developer: "FromSoftware Inc.",
      publisher: "Bandai Namco Entertainment",
      is_eligible: true,
      is_playable: true,
    });
  });

  test("retrieves games by publisher or developer correctly", async () => {
    const valve = await getPublisherGames(db, "valve");
    expect(valve).not.toBeNull();
    expect(valve?.name).toBe("Valve");
    expect(valve?.isPublisher).toBe(true);
    expect(valve?.isDeveloper).toBe(true);
    expect(valve?.totalGames).toBe(2);
    expect(valve?.games.map((g) => g.appid).sort()).toEqual([570, 730]);

    const fromSoft = await getPublisherGames(db, "fromsoftware-inc");
    expect(fromSoft).not.toBeNull();
    expect(fromSoft?.name).toBe("FromSoftware Inc.");
    expect(fromSoft?.isDeveloper).toBe(true);
    expect(fromSoft?.isPublisher).toBe(false);
    expect(fromSoft?.totalGames).toBe(1);

    const bandai = await getPublisherGames(db, "bandai-namco-entertainment");
    expect(bandai).not.toBeNull();
    expect(bandai?.name).toBe("Bandai Namco Entertainment");
    expect(bandai?.isDeveloper).toBe(false);
    expect(bandai?.isPublisher).toBe(true);
    expect(bandai?.totalGames).toBe(1);

    const unknown = await getPublisherGames(db, "nonexistent-studio");
    expect(unknown).toBeNull();

    const all = await listPublishers(db);
    expect(all.length).toBe(4);
    expect(all[0].name).toBe("Valve");
    expect(all[0].gameCount).toBe(2);
  });
});

describe("publisher route handling", () => {
  let db: AppDatabase;

  beforeAll(async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    db = createSqliteAppAdapter(sqlite);

    await upsertApp(db, {
      appid: 730,
      name: "Counter-Strike 2",
      developer: "Valve",
      publisher: "Valve",
      is_eligible: true,
      is_playable: true,
    });
  });

  test("handles 200, 301 canonical redirects, and 404 responses", async () => {
    const okRes = await handlePublisherHttpRequest(
      new Request("https://vaporstats.com/publisher/valve"),
      db
    );
    expect(okRes.status).toBe(200);
    const html = await okRes.text();
    expect(html).toContain("Valve");
    expect(html).toContain("Counter-Strike 2");
    expect(html).toContain("TRACKED GAMES:");

    const redirectRes = await handlePublisherHttpRequest(
      new Request("https://vaporstats.com/publisher/1-valve"),
      db
    );
    expect(redirectRes.status).toBe(301);
    expect(redirectRes.headers.get("Location")).toBe("/publisher/valve");

    const notFoundRes = await handlePublisherHttpRequest(
      new Request("https://vaporstats.com/publisher/unknown-publisher"),
      db
    );
    expect(notFoundRes.status).toBe(404);
  });
});

describe("mention link integration", () => {
  test("renders developer and publisher links to /publisher/[slug]", () => {
    const html = renderToString(
      React.createElement(GamePageView, {
        game: {
          appid: 1245620,
          name: "ELDEN RING",
          slug: "elden-ring",
          type: "game",
          is_eligible: true,
          is_playable: true,
          parent_appid: null,
          release_date: "2022-02-25",
          steam_release_date: null,
          original_release_date: null,
          original_steam_release_date: null,
          release_from_early_access_date: null,
          release_date_source: null,
          is_early_access: null,
          has_left_early_access: null,
          release_status: "released",
          description: "An action RPG.",
          header_image: "",
          developer: "FromSoftware Inc.",
          publisher: "Bandai Namco Entertainment",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          latest_players: null,
          peak_players: null,
          last_observed_at: null,
        },
      })
    );

    expect(html).toContain('href="/publisher/fromsoftware-inc"');
    expect(html).toContain("FromSoftware Inc.");
    expect(html).toContain('href="/publisher/bandai-namco-entertainment"');
    expect(html).toContain("Bandai Namco Entertainment");
  });
});
