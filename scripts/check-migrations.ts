import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations, DRIZZLE_MIGRATION_TABLE, MIGRATION_TABLE } from "../src/lib/migrations";

const expectedTables = [
  "apps",
  "checkpoints",
  "observations",
  "tracked_games",
  "player_daily_requests",
  "player_rollups",
  "app_relationships",
  "app_prices",
  "price_history",
  "release_facts",
  "app_release_events",
  "app_release_plans",
  "steam_events",
  "review_sources",
  "review_buckets",
  "review_summary_snapshots",
  "app_facets",
  "app_facet_memberships",
  "player_score_history",
  "player_score_state",
  "critic_records",
];

const temporaryDirectory = mkdtempSync(join(tmpdir(), "vaporstats-sqlite-check-"));
const databasePath = join(temporaryDirectory, "check.sqlite");
const legacyDatabasePath = join(temporaryDirectory, "legacy.sqlite");
const migrationDirectory = resolve(process.cwd(), "migrations");
const journal = JSON.parse(
  readFileSync(join(migrationDirectory, "meta", "_journal.json"), "utf8")
) as { entries: { tag: string; when: number }[] };
const migrationFiles = readMigrationFiles({ migrationsFolder: migrationDirectory });

function verifyMigrationMetadata(): void {
  if (
    migrationFiles.length !== journal.entries.length ||
    migrationFiles.some(
      (migration, index) => migration.folderMillis !== journal.entries[index]?.when
    )
  ) {
    throw new Error("Migration journal and SQL files are out of sync");
  }
}

function verifyExistingRowsSurviveUpgrade(): void {
  if (journal.entries.length === 0) throw new Error("Migration journal is empty");

  const legacy = new Database(legacyDatabasePath);
  legacy.exec("PRAGMA foreign_keys = ON");
  try {
    legacy.exec(
      "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    );
    const appliedCount = Math.max(1, journal.entries.length - 1);
    for (const entry of journal.entries.slice(0, appliedCount)) {
      const migrationName = entry.tag + ".sql";
      legacy.exec(readFileSync(join(migrationDirectory, migrationName), "utf8"));
      legacy.query("INSERT INTO schema_migrations (name) VALUES (?)").run(migrationName);
    }
    legacy
      .query(
        "INSERT INTO apps (appid, name, slug, release_status, description) VALUES (?, ?, ?, ?, ?)"
      )
      .run(900001, "Migration Preservation Test", "migration-preservation-test", "released", "kept");
    legacy
      .query("INSERT INTO checkpoints (key, value, cursor) VALUES (?, ?, ?)")
      .run("migration-preservation", "kept", 7);
    legacy
      .query("INSERT INTO observations (appid, current_players, observed_at) VALUES (?, ?, ?)")
      .run(900001, 321, "2026-09-01T00:00:00.000Z");
    legacy
      .query("INSERT INTO app_prices (appid, final_price, observed_at) VALUES (?, ?, ?)")
      .run(900001, 1999, "2026-09-01T00:00:00.000Z");
    legacy
      .query("INSERT INTO price_history (appid, final_price, observed_at) VALUES (?, ?, ?)")
      .run(900001, 1999, "2026-08-31T00:00:00.000Z");
    legacy
      .query(
        "INSERT INTO release_facts (appid, name, slug, type, release_date, release_year, release_week, release_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(900001, "Migration Preservation Test", "migration-preservation-test", "game", "2026-09-01", 2026, "2026-W36", "released");
    legacy
      .query("INSERT INTO app_release_events (appid, event_type, source, event_date) VALUES (?, ?, ?, ?)")
      .run(900001, "patch", "original_release_date", "2026-09-01");
    legacy
      .query("INSERT INTO app_release_plans (appid, expected_date, observed_at) VALUES (?, ?, ?)")
      .run(900001, "2026-10-01", "2026-09-01T00:00:00.000Z");
  } finally {
    legacy.close(true);
  }

  const upgraded = new Database(legacyDatabasePath);
  upgraded.exec("PRAGMA foreign_keys = ON");
  try {
    applyMigrations(upgraded, migrationDirectory);
    const app = upgraded
      .query<
        { appid: number; name: string; slug: string; release_status: string; description: string; has_left_early_access: number | null },
        []
      >(
        "SELECT appid, name, slug, release_status, description, has_left_early_access FROM apps WHERE appid = 900001"
      )
      .get();
    if (
      !app ||
      app.name !== "Migration Preservation Test" ||
      app.slug !== "migration-preservation-test" ||
      app.release_status !== "released" ||
      app.description !== "kept" ||
      app.has_left_early_access !== null
    ) {
      throw new Error("Existing app data was not preserved during migration");
    }

    const checkpoint = upgraded
      .query<{ key: string; value: string; cursor: number }, []>(
        "SELECT key, value, cursor FROM checkpoints WHERE key = 'migration-preservation'"
      )
      .get();
    if (!checkpoint || checkpoint.value !== "kept" || checkpoint.cursor !== 7) {
      throw new Error("Existing checkpoint data was not preserved during migration");
    }
    const observation = upgraded
      .query<{ appid: number; current_players: number }, []>(
        "SELECT appid, current_players FROM observations WHERE appid = 900001"
      )
      .get();
    if (!observation || observation.current_players !== 321) {
      throw new Error("Existing player observation data was not preserved during migration");
    }

    const appPrice = upgraded
      .query<{ appid: number; final_price: number }, []>(
        "SELECT appid, final_price FROM app_prices WHERE appid = 900001"
      )
      .get();
    const priceHistory = upgraded
      .query<{ appid: number; final_price: number }, []>(
        "SELECT appid, final_price FROM price_history WHERE appid = 900001"
      )
      .get();
    if (!appPrice || appPrice.final_price !== 1999 || !priceHistory || priceHistory.final_price !== 1999) {
      throw new Error("Existing price data was not preserved during migration");
    }

    const release = upgraded
      .query<{ appid: number; release_date: string }, []>(
        "SELECT appid, release_date FROM release_facts WHERE appid = 900001"
      )
      .get();
    const releaseEvent = upgraded
      .query<{ appid: number; event_type: string }, []>(
        "SELECT appid, event_type FROM app_release_events WHERE appid = 900001"
      )
      .get();
    const releasePlan = upgraded
      .query<{ appid: number; expected_date: string }, []>(
        "SELECT appid, expected_date FROM app_release_plans WHERE appid = 900001"
      )
      .get();
    if (
      !release || release.release_date !== "2026-09-01" ||
      !releaseEvent || releaseEvent.event_type !== "patch" ||
      !releasePlan || releasePlan.expected_date !== "2026-10-01"
    ) {
      throw new Error("Existing lifecycle data was not preserved during migration");
    }

  } finally {
    upgraded.close(true);
  }
}

let database: Database | undefined;

try {
  verifyMigrationMetadata();
  database = new Database(databasePath);
  applyMigrations(database, migrationDirectory);
  applyMigrations(database, migrationDirectory);

  const foundTables = new Set(
    database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all()
      .map((row) => row.name)
  );
  const missingTables = expectedTables.filter((table) => !foundTables.has(table));
  if (missingTables.length > 0) {
    throw new Error("Missing SQLite tables: " + missingTables.join(", "));
  }
  if (!foundTables.has(DRIZZLE_MIGRATION_TABLE) || foundTables.has(MIGRATION_TABLE)) {
    throw new Error("Unexpected migration journal tables");
  }

  const appColumns = new Set(
    database.query<{ name: string }, []>("PRAGMA table_info(apps)").all().map((column) => column.name)
  );
  for (const column of ["has_left_early_access", "metacritic_score", "metacritic_url", "metacritic_observed_at"]) {
    if (!appColumns.has(column)) {
      throw new Error("Missing apps." + column + " column");
    }
  }
  const releasePlanColumns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info(app_release_plans)")
      .all()
      .map((column) => column.name)
  );
  for (const column of ["id", "appid", "expected_date", "observed_at"]) {
    if (!releasePlanColumns.has(column)) {
      throw new Error("Missing app_release_plans." + column + " column");
    }
  }

  const appliedMigrations = database
    .query<{ hash: string; created_at: number }, []>(
      "SELECT hash, created_at FROM " + DRIZZLE_MIGRATION_TABLE + " ORDER BY created_at"
    )
    .all();
  if (
    appliedMigrations.length !== migrationFiles.length ||
    appliedMigrations.some(
      (migration, index) =>
        migration.hash !== migrationFiles[index]?.hash ||
        migration.created_at !== journal.entries[index]?.when
    )
  ) {
    throw new Error("Applied migrations do not match the migration journal");
  }

  verifyExistingRowsSurviveUpgrade();
  if (!existsSync(databasePath)) throw new Error("SQLite database file was not created");
  console.log("SQLite migrations OK (" + appliedMigrations.length + " migrations; existing rows preserved)");
} finally {
  database?.close(true);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
