import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, createDailySnapshot, getDb } from "../src/lib/db";
import { applyMigrations, DRIZZLE_MIGRATION_TABLE, MIGRATION_TABLE } from "../src/lib/migrations";

const originalDatabasePath = process.env.DATABASE_PATH;
const migrationDirectory = resolve(import.meta.dir, "../migrations");
const migrationJournal = JSON.parse(
  readFileSync(join(migrationDirectory, "meta", "_journal.json"), "utf8")
) as { entries: { tag: string }[] };
const migrationNames = migrationJournal.entries.map((entry) => entry.tag + ".sql");

function createLegacyDatabase(appliedCount: number): Database {
  const databasePath = process.env.DATABASE_PATH;
  if (!databasePath) throw new Error("DATABASE_PATH is required for this test");
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.exec(
    "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );
  for (const migrationName of migrationNames.slice(0, appliedCount)) {
    database.exec(readFileSync(join(migrationDirectory, migrationName), "utf8"));
    database.query("INSERT INTO schema_migrations (name) VALUES (?)").run(migrationName);
  }
  return database;
}

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
    const migrations = await db
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
      .all<{ hash: string; created_at: number }>();

    expect(tables.results.map((row) => row.name)).toEqual([
      DRIZZLE_MIGRATION_TABLE,
      "app_facet_memberships",
      "app_facets",
      "app_prices",
      "app_relationships",
      "app_release_events",
      "app_release_plans",
      "apps",
      "checkpoints",
      "critic_records",
      "observations",
      "player_daily_requests",
      "player_rollups",
      "player_score_history",
      "player_score_state",
      "price_history",
      "release_facts",
      "review_buckets",
      "review_sources",
      "review_summary_snapshots",
      "steam_events",
      "tracked_games",
    ]);
    const appColumns = await db.prepare("PRAGMA table_info(apps)").all<{ name: string }>();
    expect(appColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "has_left_early_access",
        "metacritic_score",
        "metacritic_url",
        "metacritic_observed_at",
      ]),
    );
    const releasePlanColumns = await db
      .prepare("PRAGMA table_info(app_release_plans)")
      .all<{ name: string }>();
    expect(releasePlanColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["id", "appid", "expected_date", "observed_at"]),
    );
    expect(migrations.results).toHaveLength(migrationNames.length);
  });

  test("persists rows after reopening the same file without replaying migrations", async () => {
    const db = await getDb();
    await db
      .prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
      .bind(10, "Persistence Test", "persistence-test")
      .run();
    await db
      .prepare("INSERT INTO app_release_plans (appid, expected_date, observed_at) VALUES (?, ?, ?)")
      .bind(10, "2026-10-01", "2026-09-05T00:00:00.000Z")
      .run();
    await closeDb();

    const reopened = await getDb();
    const row = await reopened
      .prepare("SELECT name FROM apps WHERE appid = ?")
      .bind(10)
      .first<{ name: string }>();
    const releasePlan = await reopened
      .prepare("SELECT appid, expected_date, observed_at FROM app_release_plans WHERE appid = ?")
      .bind(10)
      .first<{ appid: number; expected_date: string; observed_at: string }>();
    const migrations = await reopened
      .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at")
      .all<{ hash: string }>();
    expect(row).toEqual({ name: "Persistence Test" });
    expect(releasePlan).toEqual({
      appid: 10,
      expected_date: "2026-10-01",
      observed_at: "2026-09-05T00:00:00.000Z",
    });
    expect(migrations.results).toHaveLength(migrationNames.length);
  });

  test("adopts the legacy ledger without replaying applied SQL or losing rows", async () => {
    const legacy = createLegacyDatabase(migrationNames.length - 1);
    legacy
      .query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
      .run(11, "Adopted Row", "adopted-row");
    legacy.close(true);

    const db = await getDb();
    const row = await db
      .prepare("SELECT name, has_left_early_access FROM apps WHERE appid = ?")
      .bind(11)
      .first<{ name: string; has_left_early_access: number | null }>();
    const ledger = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(MIGRATION_TABLE)
      .first<{ name: string }>();
    const journal = await db
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
      .all<{ hash: string; created_at: number }>();
    expect(row).toEqual({ name: "Adopted Row", has_left_early_access: null });
    expect(ledger).toBeNull();
    expect(journal.results).toHaveLength(migrationNames.length);
    expect(await db.prepare("SELECT 1 FROM app_release_events LIMIT 1").first()).toBeNull();
  });

  test("rejects a gapped legacy ledger and rolls back adoption", async () => {
    const databasePath = process.env.DATABASE_PATH;
    if (!databasePath) throw new Error("DATABASE_PATH is required for this test");
    mkdirSync(dirname(databasePath), { recursive: true });
    const legacy = new Database(databasePath);
    legacy.exec(
      "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    );
    legacy.exec(readFileSync(join(migrationDirectory, migrationNames[0]), "utf8"));
    legacy.query("INSERT INTO schema_migrations (name) VALUES (?)").run(migrationNames[0]);
    legacy.query("INSERT INTO schema_migrations (name) VALUES (?)").run(migrationNames[2]);
    legacy.query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)").run(12, "Atomic Row", "atomic-row");
    legacy.close(true);

    const invalid = new Database(databasePath);
    try {
      expect(() => applyMigrations(invalid)).toThrow("unknown or gapped migration ledger");
    } finally {
      invalid.close(true);
    }

    const unchanged = new Database(databasePath);
    try {
      const rows = unchanged
        .query<{ name: string }, []>("SELECT name FROM schema_migrations ORDER BY rowid")
        .all();
      const journal = unchanged
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
        )
        .get();
      expect(rows.map((row) => row.name)).toEqual([migrationNames[0], migrationNames[2]]);
      expect(unchanged.query("SELECT name FROM apps WHERE appid = 12").get()).toEqual({ name: "Atomic Row" });
      expect(journal).toBeNull();
    } finally {
      unchanged.close(true);
    }
  });


  test("rolls back an unapplied migration failure atomically", () => {
    const failureMigrationDirectory = join(temporaryDirectory, "failing-migrations");
    const failureMetaDirectory = join(failureMigrationDirectory, "meta");
    mkdirSync(failureMetaDirectory, { recursive: true });
    for (const migrationName of migrationNames) {
      copyFileSync(
        join(migrationDirectory, migrationName),
        join(failureMigrationDirectory, migrationName),
      );
    }

    const journal = JSON.parse(
      readFileSync(join(migrationDirectory, "meta", "_journal.json"), "utf8"),
    ) as {
      version: string;
      dialect: string;
      entries: {
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }[];
    };
    const lastEntry = journal.entries[journal.entries.length - 1];
    if (!lastEntry) throw new Error("Migration journal is empty");
    const failureTag = "0010_atomicity_failure";
    journal.entries.push({
      idx: journal.entries.length,
      version: lastEntry.version,
      when: lastEntry.when + 1,
      tag: failureTag,
      breakpoints: true,
    });
    writeFileSync(
      join(failureMetaDirectory, "_journal.json"),
      JSON.stringify(journal, null, 2),
    );
    writeFileSync(
      join(failureMigrationDirectory, failureTag + ".sql"),
      [
        "CREATE TABLE migration_atomicity_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
        "--> statement-breakpoint",
        "INSERT INTO migration_atomicity_probe (id, value) VALUES (1, 'written');",
        "--> statement-breakpoint",
        "INSERT INTO missing_atomicity_table (id) VALUES (1);",
      ].join("\n"),
    );

    const databasePath = join(temporaryDirectory, "migration-failure.sqlite");
    const database = new Database(databasePath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrations(database, migrationDirectory);
      database
        .query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
        .run(70, "Atomicity Sentinel", "atomicity-sentinel");
      database
        .query("INSERT INTO checkpoints (key, value, cursor) VALUES (?, ?, ?)")
        .run("atomicity-sentinel", "kept", 17);
      const historyBefore = database
        .query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
        .all();

      expect(() => applyMigrations(database, failureMigrationDirectory)).toThrow();

      expect(
        database
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("migration_atomicity_probe"),
      ).toBeNull();
      expect(database.query("SELECT name FROM apps WHERE appid = 70").get()).toEqual({
        name: "Atomicity Sentinel",
      });
      expect(
        database.query("SELECT value, cursor FROM checkpoints WHERE key = ?").get("atomicity-sentinel"),
      ).toEqual({ value: "kept", cursor: 17 });
      expect(
        database
          .query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
          .all(),
      ).toEqual(historyBefore);
    } finally {
      database.close(true);
    }
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
