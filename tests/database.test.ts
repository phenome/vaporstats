import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, createDailySnapshot, getDb } from "../src/lib/db";

const originalDatabasePath = process.env.DATABASE_PATH;

describe("Bun SQLite persistence", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    await closeDb();
    temporaryDirectory = mkdtempSync(join(tmpdir(), "vaporstats-db-test-"));
    process.env.DATABASE_PATH = join(temporaryDirectory, "nested", "vaporstats.sqlite");
  });

  afterEach(async () => {
    await closeDb();
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  test("opens an empty file with every migration applied once", async () => {
    const db = await getDb();
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>();
    const migrations = await db.prepare("SELECT name FROM schema_migrations ORDER BY name").all<{ name: string }>();

    expect(tables.results.map((row) => row.name)).toEqual([
      "app_prices",
      "app_relationships",
      "app_release_events",
      "apps",
      "checkpoints",
      "observations",
      "player_daily_requests",
      "player_rollups",
      "price_history",
      "release_facts",
      "schema_migrations",
      "tracked_games",
    ]);
    expect(migrations.results).toHaveLength(7);
  });

  test("persists rows after reopening the same file", async () => {
    const db = await getDb();
    await db
      .prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
      .bind(10, "Persistence Test", "persistence-test")
      .run();
    await closeDb();

    const reopened = await getDb();
    const row = await reopened.prepare("SELECT name FROM apps WHERE appid = ?").bind(10).first<{ name: string }>();
    expect(row).toEqual({ name: "Persistence Test" });
  });

  test("sets the required SQLite pragmas", async () => {
    const db = await getDb();
    const journalMode = await db.prepare("PRAGMA journal_mode").first<{ journal_mode: string }>();
    const synchronous = await db.prepare("PRAGMA synchronous").first<{ synchronous: number }>();
    const foreignKeys = await db.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
    const busyTimeout = await db.prepare("PRAGMA busy_timeout").first<{ timeout: number }>();

    expect(journalMode?.journal_mode.toLowerCase()).toBe("wal");
    expect(synchronous?.synchronous).toBe(1);
    expect(foreignKeys?.foreign_keys).toBe(1);
    expect(busyTimeout?.timeout).toBe(5000);
  });

  test("writes a readable consistent daily snapshot", async () => {
    const db = await getDb();
    await db
      .prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
      .bind(20, "Snapshot Test", "snapshot-test")
      .run();
    const snapshotPath = join(temporaryDirectory, "snapshots", "snapshot.sqlite");
    const writtenPath = await createDailySnapshot(db, snapshotPath, "2026-09-05");
    const snapshot = new Database(writtenPath, { readonly: true });
    const row = snapshot.prepare("SELECT name FROM apps WHERE appid = ?").get(20) as { name: string } | null;

    expect(row).toEqual({ name: "Snapshot Test" });
    snapshot.close(true);
  });
});
