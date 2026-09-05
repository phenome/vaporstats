import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/lib/migrations";

const databasePath = process.env.DATABASE_PATH ?? resolve(process.cwd(), "data/vaporstats.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
try {
  applyMigrations(database);
  console.log("SQLite migrations OK");
} finally {
  database.close(true);
}
