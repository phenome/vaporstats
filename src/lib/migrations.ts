import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { Database } from "bun:sqlite";

export const MIGRATION_TABLE = "schema_migrations";
export const DRIZZLE_MIGRATION_TABLE = "__drizzle_migrations";

const migrationsDirectory = resolve(process.cwd(), "migrations");

interface JournalEntry {
  tag: string;
  when: number;
}

interface MigrationJournal {
  entries: JournalEntry[];
}

function readJournal(directory: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(directory, "meta", "_journal.json"), "utf8")) as MigrationJournal;
  if (
    !Array.isArray(journal.entries) ||
    journal.entries.some(
      (entry) =>
        typeof entry?.tag !== "string" ||
        !Number.isFinite(entry.when) ||
        !Number.isInteger(entry.when)
    )
  ) {
    throw new Error("Invalid Drizzle migration journal");
  }
  return journal.entries;
}

function adoptLegacyMigrations(
  db: Database,
  entries: JournalEntry[],
  migrations: MigrationMeta[]
): void {
  if (migrations.length !== entries.length) {
    throw new Error("Drizzle migration journal and SQL files are out of sync");
  }
  if (migrations.some((migration, index) => migration.folderMillis !== entries[index]?.when)) {
    throw new Error("Drizzle migration journal timestamps are out of sync");
  }

  const legacyTable = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(MIGRATION_TABLE);
  if (!legacyTable) return;

  db.transaction(() => {
    const legacyRows = db
      .query<{ name: string }, []>("SELECT name FROM " + MIGRATION_TABLE + " ORDER BY rowid")
      .all();
    const knownNames = entries.map((entry) => entry.tag + ".sql");
    if (
      legacyRows.length > knownNames.length ||
      legacyRows.some((row, index) => row.name !== knownNames[index])
    ) {
      throw new Error("Cannot adopt schema_migrations: unknown or gapped migration ledger");
    }

    const journalTable = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(DRIZZLE_MIGRATION_TABLE);
    const existingJournal = journalTable
      ? db
          .query<{ hash: string; created_at: number }, []>(
            "SELECT hash, created_at FROM " + DRIZZLE_MIGRATION_TABLE + " ORDER BY created_at"
          )
          .all()
      : [];
    if (existingJournal.length > 0) {
      throw new Error("Cannot adopt schema_migrations alongside an existing Drizzle journal");
    }

    db.exec(
      "CREATE TABLE IF NOT EXISTS " +
        DRIZZLE_MIGRATION_TABLE +
        " (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)"
    );
    const recordMigration = db.query(
      "INSERT INTO " + DRIZZLE_MIGRATION_TABLE + " (hash, created_at) VALUES (?, ?)"
    );
    const migrationsToAdopt = migrations.slice(0, legacyRows.length);
    for (const [index, migration] of migrationsToAdopt.entries()) {
      recordMigration.run(migration.hash, entries[index].when);
    }
    db.exec("DROP TABLE " + MIGRATION_TABLE);
  }).immediate();
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

function assertNoForeignKeyViolations(db: Database): void {
  const violations = db
    .query<ForeignKeyViolation, []>("PRAGMA foreign_key_check")
    .all();
  if (violations.length === 0) return;
  const summary = violations
    .slice(0, 10)
    .map((violation) => violation.table + "(rowid " + violation.rowid + ") -> " + violation.parent)
    .join(", ");
  throw new Error(
    "Migrations left " + violations.length + " foreign key violations: " + summary
  );
}

function appliedMigrationCount(db: Database): number {
  const table = db
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(DRIZZLE_MIGRATION_TABLE);
  if (!table) return 0;
  return db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM " + DRIZZLE_MIGRATION_TABLE)
    .get()!.count;
}

/**
 * The single migration procedure for every entry point (app startup,
 * `db:migrate`, migration checks and test fixtures). drizzle's migrator
 * applies pending migrations in one transaction, and SQLite ignores
 * `PRAGMA foreign_keys` inside a transaction, so foreign keys are disabled
 * here, before the migrator starts. That keeps table rebuilds from
 * cascading deletes or failing on referenced parents. When migrations were
 * applied, `foreign_key_check` must then be empty; a violation fails the
 * migration step, and deployment restores its pre-migration snapshot. The
 * caller's foreign-key setting is restored afterwards.
 */
export function applyMigrations(db: Database, directory = migrationsDirectory): void {
  if (db.inTransaction) {
    throw new Error("Migrations cannot run inside an open transaction");
  }
  const entries = readJournal(directory);
  const migrations = readMigrationFiles({ migrationsFolder: directory });
  const foreignKeys = db
    .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get()?.foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    adoptLegacyMigrations(db, entries, migrations);
    const before = appliedMigrationCount(db);
    migrate(drizzle(db), {
      migrationsFolder: directory,
      migrationsTable: DRIZZLE_MIGRATION_TABLE,
    });
    if (appliedMigrationCount(db) > before) assertNoForeignKeyViolations(db);
  } finally {
    db.exec("PRAGMA foreign_keys = " + (foreignKeys === 1 ? "ON" : "OFF"));
  }
}
