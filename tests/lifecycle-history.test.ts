import { describe, test, expect } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import React from "react";
import { renderToString } from "react-dom/server";
import { applyMigrations } from "../src/lib/migrations";
import { type AppDatabase, type AppPreparedStatement } from "../src/lib/db";
import { getGameByAppId, upsertApp } from "../src/lib/catalog";
import { GamePageView } from "../src/components/game-page";
import { getLifecycleHistory } from "../src/lib/lifecycle-history";
import { handleGameLifecycleRequest } from "../src/routes/api.games.$appid.lifecycle";
import { CACHE_POLICIES } from "../src/lib/cache";

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
          const row = db.prepare(query).get(...(boundValues as SQLQueryBindings[])) as Record<string, unknown> | null;
          if (!row) return null;
          return (colName ? row[colName] : row) as T;
        },
        async run<T = unknown>() {
          const info = db.prepare(query).run(...(boundValues as SQLQueryBindings[]));
          return {
            success: true as const,
            meta: { changes: info.changes, duration: 0 },
          };
        },
        async all<T = unknown>() {
          const results = db.prepare(query).all(...(boundValues as SQLQueryBindings[])) as T[];
          return {
            success: true as const,
            results,
            meta: { changes: 0, duration: 0 },
          };
        },
        async raw<T = unknown>() {
          return db.prepare(query).values(...(boundValues as SQLQueryBindings[])) as T[];
        },
      };

      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.all<T>());
      return results;
    },
    async exec(query: string) {
      db.run(query);
      return { count: 0, duration: 0 };
    },
  };
}

function initTestDb(): AppDatabase {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON;");
  applyMigrations(sqlite);
  return createSqliteAppAdapter(sqlite);
}

describe("Lifecycle history", () => {
  test("records A to B to A release-plan revisions without duplicate polls", async () => {
    const db = initTestDb();
    const app = {
      appid: 510001,
      name: "Revised Release Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_status: "upcoming",
      is_early_access: true,
    } as const;

    await upsertApp(db, { ...app, release_date: "2027-01-01" });
    await upsertApp(db, { ...app, release_date: "2027-01-01" });
    await upsertApp(db, { ...app, release_date: "2027-02-15" });
    await upsertApp(db, { ...app, release_date: "2027-02-15" });
    await upsertApp(db, { ...app, release_date: "2027-01-01" });
    const storedPlans = await db
      .prepare("SELECT expected_date FROM app_release_plans WHERE appid = ? ORDER BY id")
      .bind(app.appid)
      .all<{ expected_date: string }>();
    expect(storedPlans.results.map((plan) => plan.expected_date)).toEqual([
      "2027-01-01",
      "2027-02-15",
      "2027-01-01",
    ]);

    const history = await getLifecycleHistory(db, app.appid);
    expect(history.plans.map((plan) => plan.expected_date)).toEqual([
      "2027-01-01",
      "2027-02-15",
      "2027-01-01",
    ]);
    expect(history.plans.every((plan) => plan.observed_at.length > 0)).toBe(true);
  });

  test("keeps a passed source-declared upcoming date as a release plan", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 510002,
      name: "Delayed Release Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2020-01-01",
      release_status: "upcoming",
    });

    const history = await getLifecycleHistory(db, 510002);
    expect(history.plans.map((plan) => plan.expected_date)).toEqual(["2020-01-01"]);
    expect(history.events.some((event) => event.event_type === "release")).toBe(false);
  });

  test("records an undated early-access exit only from confirmed state", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 510003,
      name: "Confirmed Exit Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2020-01-01",
      release_status: "released",
      is_early_access: false,
      has_left_early_access: true,
    });
    await upsertApp(db, {
      appid: 510004,
      name: "State Only Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2020-01-01",
      release_status: "released",
      is_early_access: false,
    });

    const confirmed = await getLifecycleHistory(db, 510003);
    expect(confirmed.events).toContainEqual({
      event_type: "early_access_exit",
      event_date: null,
      source: "has_left_early_access",
    });

    const stateOnly = await getLifecycleHistory(db, 510004);
    expect(stateOnly.events.some((event) => event.event_type === "early_access_exit")).toBe(false);
  });

  test("renders an explicit early-access exit as Left Early Access when the flag is unknown", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 510009,
      name: "Dated Exit Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2024-06-20",
      release_status: "released",
      is_early_access: false,
      has_left_early_access: null,
      release_from_early_access_date: "2024-06-20",
    });

    const game = await getGameByAppId(db, 510009);
    expect(game).not.toBeNull();
    const html = renderToString(React.createElement(GamePageView, { game: game! }));
    expect(html).toContain("Left Early Access");
    expect(html).not.toContain("Version 1.0");
  });

  test("does not render a current early-access exit while early access is active", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 510010,
      name: "Active Early Access Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2024-06-20",
      release_status: "released",
      is_early_access: true,
      has_left_early_access: true,
      release_from_early_access_date: "2024-06-20",
    });

    const game = await getGameByAppId(db, 510010);
    expect(game).not.toBeNull();
    const html = renderToString(React.createElement(GamePageView, { game: game! }));
    expect(html).not.toContain("Left Early Access");
  });

  test("preserves an upcoming month window without fabricating a released date", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 510011,
      name: "September Window Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "September 2026",
      release_status: "upcoming",
    });

    const game = await getGameByAppId(db, 510011);
    expect(game).not.toBeNull();
    const html = renderToString(React.createElement(GamePageView, { game: game! }));
    expect(html).toContain("September 2026");
    expect(html).toContain("Expected release");
    expect(html).toMatch(/>Released<\/span><span[^>]*>—<\/span>/);
    expect(html).not.toContain("Sep 1, 2026");
    expect(html).not.toContain("2026-09-01");
  });

  test("maintains horizontal gap between date and badge in release lifecycle overview", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 2502430,
      name: "Terminal Error",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2024-10-10",
      steam_release_date: "2024-10-10",
      release_status: "released",
    });

    const game = await getGameByAppId(db, 2502430);
    expect(game).not.toBeNull();
    const html = renderToString(React.createElement(GamePageView, { game: game! }));
    expect(html).toContain("Available on Steam");
    expect(html).toContain("Oct 10, 2024");
    expect(html).toMatch(/<td class="[^"]*pl-4[^"]*text-right[^"]*">\s*<span[^>]*>Available on Steam<\/span>\s*<\/td>/);
  });

  test("prefers original and Steam platform dates over the appdetails date", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 510005,
      name: "Original Date Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2020-03-03",
      release_date_source: "appdetails",
      original_release_date: "2020-01-01",
      steam_release_date: "2020-02-02",
      original_steam_release_date: "2019-12-12",
      release_status: "released",
    });
    await upsertApp(db, {
      appid: 510006,
      name: "Steam Date Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2020-03-03",
      release_date_source: "appdetails",
      steam_release_date: "2020-02-02",
      release_status: "released",
    });
    await upsertApp(db, {
      appid: 510007,
      name: "Appdetails Date Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_date: "2020-03-03",
      release_date_source: "appdetails",
      release_status: "released",
    });

    const original = await getLifecycleHistory(db, 510005);
    expect(original.events).toContainEqual({
      event_type: "release",
      event_date: "2020-01-01",
      source: "original_release_date",
    });
    expect(original.events).toContainEqual({
      event_type: "steam_availability",
      event_date: "2019-12-12",
      source: "original_steam_release_date",
    });

    const steam = await getLifecycleHistory(db, 510006);
    expect(steam.events).toContainEqual({
      event_type: "release",
      event_date: "2020-02-02",
      source: "steam_release_date",
    });

    const appdetails = await getLifecycleHistory(db, 510007);
    expect(appdetails.events).toContainEqual({
      event_type: "release",
      event_date: "2020-03-03",
      source: "appdetails",
    });
  });

  test("validates lifecycle endpoint IDs and does not cache errors", async () => {
    const db = initTestDb();
    await upsertApp(db, {
      appid: 510008,
      name: "Lifecycle Endpoint Game",
      type: "game",
      is_playable: true,
      is_eligible: true,
      release_status: "released",
    });

    const success = await handleGameLifecycleRequest(
      new Request("https://vaporstats.com/api/games/510008/lifecycle"),
      db,
    );
    expect(success.status).toBe(200);
    expect(success.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);
    expect(await success.json()).toEqual({ status: "ok", data: { events: [], plans: [] } });

    const invalid = await handleGameLifecycleRequest(
      new Request("https://vaporstats.com/api/games/not-an-app/lifecycle"),
      db,
    );
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);
    expect(await invalid.json()).toMatchObject({
      status: "error",
      error: "Invalid AppID",
    });

    const unsafe = await handleGameLifecycleRequest(
      new Request("https://vaporstats.com/api/games/9007199254740992/lifecycle"),
      db,
    );
    expect(unsafe.status).toBe(400);
    expect(unsafe.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);

    const missing = await handleGameLifecycleRequest(
      new Request("https://vaporstats.com/api/games/510009/lifecycle"),
      db,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe(CACHE_POLICIES.noStore);
    expect(await missing.json()).toMatchObject({
      status: "error",
      error: "Game not found",
    });
  });
});
