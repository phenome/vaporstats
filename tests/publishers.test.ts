import { describe, test, expect, beforeAll } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { renderToString } from "react-dom/server";
import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../src/lib/query-client";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import { upsertApp } from "../src/lib/catalog";
import { getCanonicalPublisherPath } from "../src/lib/slug";
import {
  getPublisherGames,
  listPublishers,
} from "../src/lib/publishers";
import { handlePublisherHttpRequest } from "../src/routes/publisher.$publisher";
import { Route as DeveloperRoute } from "../src/routes/developer.$developer";
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

describe("publisher links", () => {
  test("preserves exact names in unresolved links and uses ID-based Unicode canonical paths", () => {
    expect(getCanonicalPublisherPath("GD Studio")).toBe("/publisher/~GD%20Studio");
    expect(getCanonicalPublisherPath(" 元气弹工作室(GD Studio) ")).toBe(
      `/publisher/~${encodeURIComponent("元气弹工作室(GD Studio)")}`,
    );
    expect(getCanonicalPublisherPath("元气弹工作室(GD Studio)", 23)).toBe(
      `/publisher/23-${encodeURIComponent("元气弹工作室-gd-studio")}`,
    );
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

  test("counts eligible root games once per creator and pages by descending count with stable ties", async () => {
    const valve = await getPublisherGames(db, "Valve");
    expect(valve?.totalGames).toBe(2);
    expect(valve?.games.map((game) => game.appid).sort()).toEqual([570, 730]);
    expect(valve?.games.every((game) => game.isPublisher && game.isDeveloper)).toBe(true);

    const first = await listPublishers(db, 1, 2);
    const second = await listPublishers(db, 2, 2);
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
    expect(first.publishers.map(({ name, gameCount }) => [name, gameCount])).toEqual([
      ["Valve", 2],
      ["Bandai Namco Entertainment", 1],
    ]);
    expect(second.publishers.map(({ name, gameCount }) => [name, gameCount])).toEqual([
      ["CD PROJEKT RED", 1],
      ["FromSoftware Inc.", 1],
    ]);
    expect((await listPublishers(db, 3, 2)).publishers).toEqual([]);
    expect((await listPublishers(db, 1, 2)).publishers).toEqual(first.publishers);
    expect(first.publishers[0]?.path).toBe(`/publisher/${valve?.id}-valve`);
  });

  test("keeps non-Latin and GD creators separate while merging verified CAPCOM aliases", async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const catalog = createSqliteAppAdapter(sqlite);
    const games = [
      { appid: 11, developers: ["CAPCOM Co., Ltd."], publishers: ["CAPCOM Co., Ltd."] },
      { appid: 12, developers: ["GD Studio"], publishers: ["CAPCOM CO., LTD"] },
      { appid: 13, developers: ["CAPCOM CO., LTD."], publishers: ["CAPCOM CO., LTD."] },
      { appid: 14, developers: ["元气弹工作室(GD Studio)"], publishers: ["元气弹工作室(GD Studio)"] },
      { appid: 15, developers: ["光谱工作室"], publishers: ["星火工作室"] },
    ];
    for (const game of games) {
      await upsertApp(catalog, { ...game, name: `Game ${game.appid}`, is_eligible: true, is_playable: true });
    }
    for (const app of [
      { appid: 16, name: "DLC", parent_appid: 11, developers: ["Child Creator"] },
      { appid: 17, name: "Unlisted", is_eligible: false, developers: ["Unlisted Creator"] },
      { appid: 18, name: "Unplayable", is_playable: false, publishers: ["Unplayable Creator"] },
      { appid: 19, name: "No creator", developers: ["   "], publishers: [""] },
    ]) {
      await upsertApp(catalog, app);
    }

    const capcom = await getPublisherGames(catalog, "CAPCOM CO., LTD");
    expect(capcom?.name).toBe("CAPCOM Co., Ltd.");
    expect(capcom?.totalGames).toBe(3);
    expect(capcom?.games.map(({ appid, isDeveloper, isPublisher }) => [appid, isDeveloper, isPublisher])).toEqual([
      [11, true, true],
      [12, false, true],
      [13, true, true],
    ]);
    const gd = await getPublisherGames(catalog, "GD Studio");
    const chineseGd = await getPublisherGames(catalog, "元气弹工作室(GD Studio)");
    expect(gd?.games.map((game) => game.appid)).toEqual([12]);
    expect(chineseGd?.games.map((game) => game.appid)).toEqual([14]);
    expect(gd?.canonicalPath).not.toBe(chineseGd?.canonicalPath);
    expect((await getPublisherGames(catalog, "光谱工作室"))?.games.map((game) => game.appid)).toEqual([15]);
    expect((await getPublisherGames(catalog, "星火工作室"))?.games.map((game) => game.appid)).toEqual([15]);
    expect(await getPublisherGames(catalog, "gd-studio")).toBeNull();
    expect(await getPublisherGames(catalog, "publisher")).toBeNull();
    for (const excluded of ["Child Creator", "Unlisted Creator", "Unplayable Creator"]) {
      expect(await getPublisherGames(catalog, excluded)).toBeNull();
    }

    const first = await listPublishers(catalog, 1, 2);
    const second = await listPublishers(catalog, 2, 2);
    const third = await listPublishers(catalog, 3, 2);
    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect(first.publishers[0]?.name).toBe("CAPCOM Co., Ltd.");
    expect(first.publishers[0]?.gameCount).toBe(3);
    const entries = [...first.publishers, ...second.publishers, ...third.publishers];
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(5);
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      ["CAPCOM Co., Ltd.", "GD Studio", "元气弹工作室(GD Studio)", "光谱工作室", "星火工作室"].sort(),
    );
    const unicode = entries.find((entry) => entry.name === "元气弹工作室(GD Studio)");
    expect(unicode?.path).toBe(`/publisher/${unicode?.id}-${encodeURIComponent("元气弹工作室-gd-studio")}`);
    expect((await listPublishers(catalog, 2, 2)).publishers).toEqual(second.publishers);
  });

  test("includes co-developers and co-publishers beyond the first array entry", async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const catalog = createSqliteAppAdapter(sqlite);
    await upsertApp(catalog, {
      appid: 21,
      name: "Shared project",
      developers: ["Lead Studio", "Collaborator"],
      publishers: ["Lead Label", "Collaborator"],
    });
    await upsertApp(catalog, {
      appid: 22,
      name: "Second project",
      developers: ["Another Studio", "Collaborator"],
      publishers: ["Another Label"],
    });
    const collaborator = await getPublisherGames(catalog, "Collaborator");
    expect(collaborator?.totalGames).toBe(2);
    expect(collaborator?.games.map(({ appid, isDeveloper, isPublisher }) => [appid, isDeveloper, isPublisher])).toEqual([
      [22, true, false],
      [21, true, true],
    ]);
    const directory = await listPublishers(catalog, 1, 10);
    expect(directory.publishers[0]?.name).toBe("Collaborator");
    expect(directory.publishers[0]?.gameCount).toBe(2);
    expect(directory.publishers[0]?.isDeveloper).toBe(true);
    expect(directory.publishers[0]?.isPublisher).toBe(true);
  });

  test("replaces associations on refresh without leaving obsolete creators in the directory", async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const catalog = createSqliteAppAdapter(sqlite);
    await upsertApp(catalog, {
      appid: 31, name: "Before", developers: ["Old Studio"], publishers: ["Old Label"],
    });
    await upsertApp(catalog, {
      appid: 32, name: "Shared", developers: ["Other Studio"], publishers: ["Old Label"],
    });
    await upsertApp(catalog, {
      appid: 31, name: "After", developers: ["New Studio"], publishers: ["New Label"],
    });

    expect((await getPublisherGames(catalog, "Old Label"))?.games.map((game) => game.appid)).toEqual([32]);
    expect(await getPublisherGames(catalog, "Old Studio")).toBeNull();
    expect((await getPublisherGames(catalog, "New Studio"))?.games.map((game) => game.appid)).toEqual([31]);
    expect((await getPublisherGames(catalog, "New Label"))?.games.map((game) => game.appid)).toEqual([31]);
    const directory = await listPublishers(catalog, 1, 20);
    expect(directory.total).toBe(4);
    expect(directory.publishers.map((entry) => entry.name).sort()).toEqual(
      ["New Label", "New Studio", "Old Label", "Other Studio"].sort(),
    );
  });
});

describe("publisher route handling", () => {
  let db: AppDatabase;

  beforeAll(async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    sqlite.run("INSERT INTO creators (id, display_name) VALUES (720, 'Unrelated Studio')");
    db = createSqliteAppAdapter(sqlite);
    for (const app of [
      { appid: 730, name: "Counter-Strike 2", developers: ["Valve"], publishers: ["Valve"] },
      { appid: 731, name: "Weebles vs Grebals", developers: ["GD Studio"], publishers: ["GD Studio"] },
      { appid: 732, name: "Whisper of the House", developers: ["元气弹工作室(GD Studio)"] },
      { appid: 733, name: "Game A", publishers: ["光谱工作室"] },
      { appid: 734, name: "Game B", publishers: ["星火工作室"] },
      { appid: 735, name: "Literal publisher", publishers: ["publisher"] },
      { appid: 736, name: "Percent project", publishers: ["Studio%2FWorks"] },
      { appid: 737, name: "Slash project", publishers: ["Studio/Works"] },
      { appid: 738, name: "Number project", developers: ["720"] },
      { appid: 739, name: "Unrelated project", publishers: ["Unrelated Studio"] },
    ]) {
      await upsertApp(db, app);
    }
  });

  test("resolves exact name links to ID pages and corrects stale URL suffixes", async () => {
    const valve = await getPublisherGames(db, "Valve");
    expect(valve).not.toBeNull();
    const request = (path: string) => handlePublisherHttpRequest(new Request(`https://vaporstats.com${path}`), db);
    const canonical = await request(valve!.canonicalPath);
    expect(canonical.status).toBe(200);
    const html = await canonical.text();
    expect(html).toContain("Valve");
    expect(html).toContain("Counter-Strike 2");
    expect(html).toContain("TRACKED GAMES:");

    for (const path of ["/publisher/Valve", "/publisher/valve", `/publisher/${valve!.id}-old-name`]) {
      const response = await request(path);
      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe(valve!.canonicalPath);
    }
    expect((await request(`/publisher/${valve!.id + 100000}-valve`)).status).toBe(404);
    expect((await request("/publisher/unknown-publisher")).status).toBe(404);
    expect((await request("/publisher/%E0%A4%A")).status).toBe(404);
  });

  test("redirects encoded Unicode names but refuses ambiguous legacy slug collisions", async () => {
    const chineseGd = await getPublisherGames(db, "元气弹工作室(GD Studio)");
    expect(chineseGd).not.toBeNull();
    const namePath = getCanonicalPublisherPath("元气弹工作室(GD Studio)");
    const exact = await handlePublisherHttpRequest(new Request(`https://vaporstats.com${namePath}`), db);
    expect(exact.status).toBe(301);
    expect(exact.headers.get("Location")).toBe(chineseGd!.canonicalPath);
    const canonical = await handlePublisherHttpRequest(
      new Request(`https://vaporstats.com${chineseGd!.canonicalPath}`), db,
    );
    expect(canonical.status).toBe(200);
    expect(await canonical.text()).toContain("Whisper of the House");
    for (const path of ["/publisher/gd-studio", "/publisher/publisher"]) {
      const response = await handlePublisherHttpRequest(new Request(`https://vaporstats.com${path}`), db);
      expect(response.status).toBe(404);
    }
  });

  test("does not select a literal alias from an ambiguous legacy slug", async () => {
    expect(await getPublisherGames(db, "publisher")).toBeNull();
    const literal = await getPublisherGames(db, getCanonicalPublisherPath("publisher").slice("/publisher/".length));
    expect(literal).not.toBeNull();
    const request = (path: string) => handlePublisherHttpRequest(new Request(`https://vaporstats.com${path}`), db);
    expect((await request("/publisher/publisher")).status).toBe(404);
    const exact = await request(getCanonicalPublisherPath("publisher"));
    expect(exact.status).toBe(301);
    expect(exact.headers.get("Location")).toBe(literal!.canonicalPath);
  });

  test("keeps literal percent sequences distinct from slash names across redirects and pages", async () => {
    for (const [name, game] of [["Studio%2FWorks", "Percent project"], ["Studio/Works", "Slash project"]]) {
      const path = getCanonicalPublisherPath(name);
      const detail = await getPublisherGames(db, path.slice("/publisher/".length));
      expect(detail).not.toBeNull();
      expect(detail!.games.map(({ name }) => name)).toEqual([game]);
      const redirect = await handlePublisherHttpRequest(new Request(`https://vaporstats.com${path}`), db);
      expect(redirect.status).toBe(301);
      expect(redirect.headers.get("Location")).toBe(detail!.canonicalPath);
      const page = await handlePublisherHttpRequest(
        new Request(`https://vaporstats.com${detail!.canonicalPath}`), db,
      );
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(game);
    }
    expect(getCanonicalPublisherPath("Studio%2FWorks")).not.toBe(getCanonicalPublisherPath("Studio/Works"));
  });

  test("developer aliases redirect by exact name, not numeric IDs or decoded percent escapes", async () => {
    const loader = DeveloperRoute.options.loader;
    if (typeof loader !== "function") throw new Error("Developer route needs a loader");
    for (const [name, href, expectedGame] of [
      ["720", "/publisher/~720", "Number project"],
      ["元气弹工作室(GD Studio)", "/publisher/~%E5%85%83%E6%B0%94%E5%BC%B9%E5%B7%A5%E4%BD%9C%E5%AE%A4(GD%20Studio)", "Whisper of the House"],
      ["Studio%2FWorks", "/publisher/~Studio%252FWorks", "Percent project"],
    ]) {
      let result: unknown;
      try {
        const params = { developer: name } satisfies Parameters<typeof loader>[0]["params"];
        await loader({ params } as Parameters<typeof loader>[0]);
      } catch (error) {
        result = error;
      }
      if (!(result instanceof Response)) throw new Error("Developer loader did not throw a redirect Response");
      expect(result.status).toBe(301);
      expect(result.headers.get("Location")).toBe(href);
      const exact = await getPublisherGames(db, href.slice("/publisher/".length));
      if (!exact) throw new Error(`Missing creator for ${name}`);
      expect(exact.games.map(({ name }) => name)).toEqual([expectedGame]);
      const alias = await handlePublisherHttpRequest(new Request(`https://vaporstats.com${href}`), db);
      expect(alias.status).toBe(301);
      expect(alias.headers.get("Location")).toBe(exact.canonicalPath);
      const page = await handlePublisherHttpRequest(
        new Request(`https://vaporstats.com${exact.canonicalPath}`), db,
      );
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(expectedGame);
    }
    const wrongId = await handlePublisherHttpRequest(new Request("https://vaporstats.com/publisher/720"), db);
    const unrelated = await getPublisherGames(db, "720");
    if (!unrelated) throw new Error("Missing unrelated creator with ID 720");
    expect(unrelated.games.map(({ name }) => name)).toEqual(["Unrelated project"]);
    expect(wrongId.status).toBe(301);
    expect(wrongId.headers.get("Location")).toBe(unrelated.canonicalPath);
  });
});

describe("mention link integration", () => {
  test("renders exact-name creator links that can resolve to their identity", () => {
    const html = renderToString(
      React.createElement(
        QueryClientProvider,
        { client: createQueryClient() },
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
        }),
      ),
    );

    expect(html).toContain('href="/publisher/~FromSoftware%20Inc."');
    expect(html).toContain("FromSoftware Inc.");
    expect(html).toContain('href="/publisher/~Bandai%20Namco%20Entertainment"');
    expect(html).toContain("Bandai Namco Entertainment");
  });
});
