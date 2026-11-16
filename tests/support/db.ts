import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { openSqliteAppDatabase, type AppDatabase } from "../../src/lib/db";

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
  const directory = mkdtempSync(join(tmpdir(), prefix));
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
