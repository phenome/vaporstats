import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

export const MIGRATION_TABLE = "schema_migrations";

export interface Migration {
  name: string;
  sql: string;
}

const migrationsDirectory = resolve(process.cwd(), "migrations");

export function readMigrations(directory = migrationsDirectory): Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => ({ name, sql: readFileSync(join(directory, name), "utf8") }));
}

export function applyMigrations(db: Database, directory = migrationsDirectory): void {
  const migrations = readMigrations(directory);
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS " +
        MIGRATION_TABLE +
        " (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    );
    const hasMigration = db.query<{ name: string }, [string]>("SELECT name FROM " + MIGRATION_TABLE + " WHERE name = ?");
    const recordMigration = db.query("INSERT INTO " + MIGRATION_TABLE + " (name) VALUES (?)");
    for (const migration of migrations) {
      if (hasMigration.get(migration.name)) continue;
      db.exec(migration.sql);
      recordMigration.run(migration.name);
    }
  }).immediate();
}