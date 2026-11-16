import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";

const directories: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close(true);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function migrationDirectory(migrations: string[][]): string {
  const directory = mkdtempSync(join(tmpdir(), "vaporstats-fk-migrations-"));
  directories.push(directory);
  mkdirSync(join(directory, "meta"));
  const entries = migrations.map((_, index) => ({
    idx: index,
    version: "6",
    when: 1_800_000_000_000 + index,
    tag: String(index + 1).padStart(4, "0") + "_fixture",
    breakpoints: true,
  }));
  writeFileSync(
    join(directory, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }),
  );
  for (const [index, statements] of migrations.entries()) {
    writeFileSync(join(directory, entries[index].tag + ".sql"), statements.join("\n--> statement-breakpoint\n"));
  }
  return directory;
}

function database(foreignKeys: "ON" | "OFF"): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = " + foreignKeys);
  return db;
}

const baseline = [
  "CREATE TABLE parents (id INTEGER PRIMARY KEY, label TEXT NOT NULL CHECK (label IN ('a')))",
  "CREATE TABLE cascading_children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE)",
];

// Mirrors the table-rebuild shape drizzle-kit generates for SQLite constraint changes.
const parentRebuild = [
  "PRAGMA foreign_keys=OFF;",
  "CREATE TABLE `__new_parents` (id INTEGER PRIMARY KEY, label TEXT NOT NULL CHECK (label IN ('a', 'b')));",
  "INSERT INTO `__new_parents` (id, label) SELECT id, label FROM `parents`;",
  "DROP TABLE `parents`;",
  "ALTER TABLE `__new_parents` RENAME TO `parents`;",
  "PRAGMA foreign_keys=ON;",
];

function seed(db: Database): void {
  db.exec(`
    INSERT INTO parents (id, label) VALUES (1, 'a'), (2, 'a');
    INSERT INTO cascading_children (id, parent_id) VALUES (10, 1), (11, 2);
  `);
}

function foreignKeysEnabled(db: Database): number {
  return db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys;
}

describe("migration foreign-key procedure", () => {
  test.each(["ON", "OFF"] as const)(
    "rebuilding a referenced table keeps child rows and restores foreign_keys=%s",
    (foreignKeys) => {
      const db = database(foreignKeys);
      applyMigrations(db, migrationDirectory([baseline]));
      seed(db);

      applyMigrations(db, migrationDirectory([baseline, parentRebuild]));

      expect(db.query("SELECT id, parent_id FROM cascading_children ORDER BY id").all()).toEqual([
        { id: 10, parent_id: 1 },
        { id: 11, parent_id: 2 },
      ]);
      expect(db.query("SELECT id, label FROM parents ORDER BY id").all()).toEqual([
        { id: 1, label: "a" },
        { id: 2, label: "a" },
      ]);
      expect(foreignKeysEnabled(db)).toBe(foreignKeys === "ON" ? 1 : 0);
    },
  );

  test("rejects and rolls back a migration that leaves dangling references", () => {
    const db = database("ON");
    applyMigrations(db, migrationDirectory([baseline]));
    seed(db);
    const ledger = db.query("SELECT hash, created_at FROM __drizzle_migrations").all();

    const dropsParent = ["DELETE FROM parents WHERE id = 2;", "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);"];
    expect(() => applyMigrations(db, migrationDirectory([baseline, dropsParent]))).toThrow(
      /foreign key violations.*cascading_children/,
    );

    expect(db.query("SELECT id FROM parents ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'migration_probe'").get()).toBeNull();
    expect(db.query("SELECT hash, created_at FROM __drizzle_migrations").all()).toEqual(ledger);
    expect(foreignKeysEnabled(db)).toBe(1);
  });

  test("refuses to run inside an open transaction", () => {
    const db = database("ON");
    db.exec("BEGIN");
    expect(() => applyMigrations(db, migrationDirectory([baseline]))).toThrow(/open transaction/);
    db.exec("ROLLBACK");
  });
});
