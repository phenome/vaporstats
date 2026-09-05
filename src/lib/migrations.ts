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

export function applyMigrations(db: Database, directory = migrationsDirectory): void {
  const entries = readJournal(directory);
  const migrations = readMigrationFiles({ migrationsFolder: directory });
  adoptLegacyMigrations(db, entries, migrations);
  migrate(drizzle(db), {
    migrationsFolder: directory,
    migrationsTable: DRIZZLE_MIGRATION_TABLE,
  });
}
