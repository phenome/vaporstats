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
  "reception_collection_failures",
  "app_facets",
  "app_facet_memberships",
  "player_score_history",
  "player_score_state",
  "reception_publication_builds",
  "reception_publication_current",
  "reception_publication_months",
  "reception_publication_revisions",
  "reception_publication_state",
  "critic_records",
  "media_game_embeddings",
  "media_article_extractions",
  "media_discovery_attempts",
  "media_discovery_progress",
  "media_discovery_runs",
  "media_game_overviews",
  "media_processing_authorizations",
  "media_processing_jobs",
  "media_sources",
  "media_tag_memberships",
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
    const appliedCount = journal.entries.findIndex(
      (entry) => entry.tag === "0014_stiff_longshot"
    );
    if (appliedCount < 1) throw new Error("Migration preservation baseline is missing");
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
    legacy
      .query("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review')")
      .run(900001, "https://ign.com/articles/migration-preservation", "Preserved review", "2026-09-01T00:00:00.000Z");
    legacy
      .query(
        "INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')"
      )
      .run("migration-preservation-media", "[900001]");
    const preservedSource = legacy
      .query<{ id: number }, [number]>("SELECT id FROM media_sources WHERE appid = ?")
      .get(900001);
    const preservedRun = legacy
      .query<{ id: number }, [string]>("SELECT id FROM media_discovery_runs WHERE identity_key = ?")
      .get("migration-preservation-media");
    if (!preservedSource || !preservedRun) throw new Error("Preservation fixtures were not created");
    legacy
      .query(
        "INSERT INTO media_processing_jobs (run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json) VALUES (?, 'explanation', ?, NULL, 'gameplay', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'succeeded', ?, ?)",
      )
      .run(
        preservedRun.id,
        900001,
        preservedSource.id,
        "migration-preservation-job",
        "preserved-explanation-input",
        "gemini-3.1-flash-lite",
        "preserved-config",
        10,
        20,
        1234,
        777,
        "preserved-provider-batch",
        JSON.stringify({ trait: "legacy pair trait", explanation: "legacy generated pair prose" }),
      );
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
    const mediaSource = upgraded
      .query<
        {
          title: string;
          normalized_content_hash: string | null;
          cleanup_version: string | null;
          processing_content: string | null;
          processing_input_identity: string | null;
        },
        []
      >(
        "SELECT title, normalized_content_hash, cleanup_version, processing_content, processing_input_identity FROM media_sources WHERE appid = 900001"
      )
      .get();
    if (
      !mediaSource ||
      mediaSource.title !== "Preserved review" ||
      mediaSource.normalized_content_hash !== null ||
      mediaSource.cleanup_version !== null ||
      mediaSource.processing_content !== null ||
      mediaSource.processing_input_identity !== null
    ) {
      throw new Error("Existing media source data was not preserved during migration");
    }
    const mediaRun = upgraded
      .query<{ id: number }, []>(
        "SELECT id FROM media_discovery_runs WHERE identity_key = 'migration-preservation-media'"
      )
      .get();
    if (!mediaRun) throw new Error("Preserved media discovery run was not found");
    upgraded
      .query("INSERT INTO media_processing_authorizations (run_id, status) VALUES (?, 'queued')")
      .run(mediaRun.id);
    const authorization = upgraded
      .query<{ billing_confirmation: string | null }, []>(
        "SELECT billing_confirmation FROM media_processing_authorizations WHERE run_id = ?"
      )
      .get(mediaRun.id);
    if (!authorization || authorization.billing_confirmation !== null) {
      throw new Error("New billing confirmation was not NULL after migration");
    }
    const processingJob = upgraded
      .query<
        { stage: string; reserved_microusd: number; charged_microusd: number; reservation_active: number; status: string; output_json: string | null },
        [string]
      >(
        "SELECT stage, reserved_microusd, charged_microusd, reservation_active, status, output_json FROM media_processing_jobs WHERE request_key = ?",
      )
      .get("migration-preservation-job");
    if (
      !processingJob ||
      processingJob.stage !== "explanation" ||
      processingJob.reserved_microusd !== 1234 ||
      processingJob.charged_microusd !== 777 ||
      processingJob.reservation_active !== 0 ||
      processingJob.status !== "succeeded" ||
      processingJob.output_json !== null
    ) {
      throw new Error("Historical processing-job spend data was not preserved during migration");
    }

  } finally {
    upgraded.close(true);
  }
}

function verifyReceptionRowsSurvivePublicationUpgrade(): void {
  const retained = new Database(join(temporaryDirectory, "retained-reception.sqlite"));
  retained.exec("PRAGMA foreign_keys = ON");
  try {
    const publicationIndex = journal.entries.findIndex((entry) => entry.tag === "0018_reception_publication");
    if (publicationIndex < 1) throw new Error("Reception publication baseline is missing");
    retained.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const entry of journal.entries.slice(0, publicationIndex)) {
      retained.exec(readFileSync(join(migrationDirectory, entry.tag + ".sql"), "utf8"));
      retained.query("INSERT INTO schema_migrations (name) VALUES (?)").run(entry.tag + ".sql");
    }
    retained.exec(`
      INSERT INTO apps (appid, name, slug) VALUES (900002, 'Reception preservation', 'reception-preservation');
      INSERT INTO review_sources (id, endpoint, request_filter, population, interpretation_version, identity_key)
        VALUES ('retained-histogram', 'appreviewhistogram', 'none', 'filtered_reviews', 'steam-review-source-v1', 'retained-histogram');
      INSERT INTO review_sources (id, endpoint, request_filter, language, purchase_type, filter_offtopic_activity, population, interpretation_version, identity_key)
        VALUES ('retained-summary', 'appreviews', 'filter=all', 'all', 'all', 1, 'filtered_reviews', 'steam-review-source-v1', 'retained-summary');
      INSERT INTO review_buckets (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
        VALUES (900002, 'retained-histogram', 'weekly', '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z', 280, 20, '2026-10-09T12:00:00.000Z', '{"retained":"bucket"}');
      INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count)
        VALUES (900002, 'retained-summary', '2026-10-09T12:00:00.000Z', 900, 1000);
      INSERT INTO player_score_history
        (appid, observed_at, score, formula_version, current_positive_count, current_total_count,
         historical_positive_count, historical_total_count, current_window_start, current_window_end,
         historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
         current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at, provenance)
        VALUES (900002, '2026-10-09T12:05:00.000Z', 93.33333333333333, 'steam-player-v2', 280, 300,
         0, 0, '2026-07-11T12:00:00.000Z', '2026-10-09T12:00:00.000Z',
         '2026-04-12T12:00:00.000Z', '2026-07-11T12:00:00.000Z',
         '[{"start":"2026-10-01T00:00:00.000Z","end":"2026-10-08T00:00:00.000Z","granularity":"week"}]', '[]',
         'retained-histogram', 'retained-histogram', '2026-10-09T12:00:00.000Z', NULL, '{"retained":"score"}');
      INSERT INTO player_score_state
        (appid, latest_score_history_id, eligibility_review_count, eligibility_source_id, eligibility_observed_at, eligibility_provenance)
        SELECT appid, id, 300, 'retained-histogram', '2026-10-09T12:00:00.000Z', '{"retained":"state"}'
        FROM player_score_history WHERE appid = 900002;
    `);
    const tables = ["apps", "review_sources", "review_buckets", "review_summary_snapshots", "player_score_history", "player_score_state"];
    const before = tables.map((table) => retained.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const foreignKeys = tables.map((table) => retained.query(`PRAGMA foreign_key_list(${table})`).all());
    applyMigrations(retained, migrationDirectory);
    for (const [index, table] of tables.entries()) {
      if (JSON.stringify(retained.query(`SELECT * FROM ${table} ORDER BY rowid`).all()) !== JSON.stringify(before[index])) {
        throw new Error("Reception publication migration changed retained " + table + " rows");
      }
      if (JSON.stringify(retained.query(`PRAGMA foreign_key_list(${table})`).all()) !== JSON.stringify(foreignKeys[index])) {
        throw new Error("Reception publication migration changed " + table + " foreign keys");
      }
    }
    for (const table of expectedTables.filter((name) => name.startsWith("reception_publication_"))) {
      if (retained.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        throw new Error("Reception publication migration seeded " + table);
      }
    }
    if (retained.query("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("Reception publication upgrade broke foreign keys");
    }
  } finally {
    retained.close(true);
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
  const obsoleteTables = ["media_article_embeddings", "media_game_matches"].filter((table) => foundTables.has(table));
  if (obsoleteTables.length > 0) {
    throw new Error("Obsolete SQLite tables remain: " + obsoleteTables.join(", "));
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
  const appPriceColumns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info(app_prices)")
      .all()
      .map((column) => column.name)
  );
  if (!appPriceColumns.has("deal_expires_at")) {
    throw new Error("Missing app_prices.deal_expires_at column");
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
  const mediaSourceColumns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info(media_sources)")
      .all()
      .map((column) => column.name)
  );
  for (const column of [
    "normalized_content_hash",
    "cleanup_version",
    "processing_content",
    "processing_input_identity",
  ]) {
    if (!mediaSourceColumns.has(column)) {
      throw new Error("Missing media_sources." + column + " column");
    }
  }
  const mediaAuthorizationColumns = database
    .query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(media_processing_authorizations)"
    )
    .all();
  const billingConfirmationColumn = mediaAuthorizationColumns.find(
    (column) => column.name === "billing_confirmation"
  );
  if (
    !billingConfirmationColumn ||
    billingConfirmationColumn.type.toLowerCase() !== "text" ||
    billingConfirmationColumn.notnull !== 0
  ) {
    throw new Error("Missing nullable media_processing_authorizations.billing_confirmation column");
  }

  const gameEmbeddingColumns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info(media_game_embeddings)")
      .all()
      .map((column) => column.name),
  );
  for (const column of [
    "id",
    "appid",
    "dimension",
    "input_identity",
    "overview_input_identity",
    "model",
    "dimensions",
    "config_version",
    "vector",
    "active",
    "created_at",
  ]) {
    if (!gameEmbeddingColumns.has(column)) {
      throw new Error("Missing media_game_embeddings." + column + " column");
    }
  }
  database
    .query(
      "INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)"
    )
    .run(900002, "Embedding Constraint Check", "embedding-constraint-check");
  const embeddingInsert = database.query(
    "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  embeddingInsert.run(
    900002,
    "gameplay",
    "valid-input",
    "valid-overview",
    "gemini-embedding-2",
    3072,
    "config",
    new Uint8Array(12288),
    1
  );
  let textVectorAccepted = false;
  try {
    embeddingInsert.run(
      900002,
      "story_world",
      "text-input",
      "text-overview",
      "gemini-embedding-2",
      3072,
      "config",
      "x".repeat(12288),
      0
    );
    textVectorAccepted = true;
  } catch {
    // Expected: the vector must be a BLOB, not merely a value of the right length.
  }
  if (textVectorAccepted) {
    throw new Error("media_game_embeddings accepts a 12,288-character TEXT vector");
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
  verifyReceptionRowsSurvivePublicationUpgrade();
  if (!existsSync(databasePath)) throw new Error("SQLite database file was not created");
  console.log("SQLite migrations OK (" + appliedMigrations.length + " migrations; existing rows preserved)");
} finally {
  database?.close(true);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
