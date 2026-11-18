import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { openSqliteAppDatabase, type AppDatabase } from "../../src/lib/db";
import { applyMigrations } from "../../src/lib/migrations";
import { testTemporaryRoot } from "./tmpdir";

export interface TestDatabaseHandle {
  native: Database;
  db: AppDatabase;
}

export interface TestDatabase extends TestDatabaseHandle {
  /** File path of the database; reopening keeps its contents. */
  databasePath: string;
  directory: string;
  /** Closes the current handle and opens the same file again, as a restart does. */
  reopen(): TestDatabaseHandle;
  /** Closes every handle this fixture opened and removes its directory. */
  cleanup(): void;
}

/**
 * A temporary file database opened through the production path: the
 * application's adapter, pragmas (foreign keys on) and migration procedure.
 */
export function openTestDatabase(prefix = "vaporstats-test-"): TestDatabase {
  const directory = mkdtempSync(join(testTemporaryRoot(), prefix));
  return openTestDatabaseIn(directory);
}

/**
 * A temporary file database that held the schema before migration `tag`,
 * was seeded there by `seed`, and was then opened through the production
 * path, which applies `tag` and every later migration as an upgrade does.
 */
export function openUpgradedTestDatabase(tag: string, seed: (native: Database) => void, prefix = "vaporstats-upgrade-"): TestDatabase {
  const directory = mkdtempSync(join(testTemporaryRoot(), prefix));
  const migrations = resolve(import.meta.dir, "../../migrations");
  const journal = JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 1) throw new Error(`Migration ${tag} is missing`);
  const baseline = join(directory, "baseline");
  mkdirSync(join(baseline, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, index);
  for (const entry of entries) copyFileSync(join(migrations, `${entry.tag}.sql`), join(baseline, `${entry.tag}.sql`));
  writeFileSync(join(baseline, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  const native = new Database(join(directory, "test.sqlite"));
  try {
    native.exec("PRAGMA foreign_keys = ON");
    applyMigrations(native, baseline);
    seed(native);
  } finally {
    native.close();
  }
  return openTestDatabaseIn(directory);
}

function openTestDatabaseIn(directory: string): TestDatabase {
  const databasePath = join(directory, "test.sqlite");
  const handles = [openSqliteAppDatabase(databasePath)];
  const current = () => handles[handles.length - 1]!;
  return {
    /** Always the open handle, including after reopen(). */
    get native() { return current().native; },
    get db() { return current(); },
    databasePath,
    directory,
    reopen() {
      current().close();
      handles.push(openSqliteAppDatabase(databasePath));
      return { native: current().native, db: current() };
    },
    cleanup() {
      for (const handle of handles) handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** An in-memory database opened through the production adapter and migration procedure. */
export function openMemoryDatabase(): TestDatabaseHandle & { close(): void } {
  const database = openSqliteAppDatabase(":memory:");
  return { native: database.native, db: database, close: () => database.close() };
}
