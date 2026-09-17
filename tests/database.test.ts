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
      "media_article_extractions",
      "media_discovery_attempts",
      "media_discovery_progress",
      "media_discovery_runs",
      "media_game_embeddings",
      "media_game_overviews",
      "media_processing_authorizations",
      "media_processing_jobs",
      "media_sources",
      "media_tag_memberships",
      "observations",
      "player_daily_requests",
      "player_rollups",
      "player_score_history",
      "player_score_state",
      "price_history",
      "reception_collection_failures",
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
    const authorizationColumns = await db
      .prepare("PRAGMA table_info(media_processing_authorizations)")
      .all<{ name: string; type: string; notnull: number }>();
    const billingConfirmationColumn = authorizationColumns.results.find(
      (column) => column.name === "billing_confirmation"
    );
    expect(billingConfirmationColumn).toBeDefined();
    expect(billingConfirmationColumn?.type.toLowerCase()).toBe("text");
    const embeddingColumns = await db.prepare("PRAGMA table_info(media_game_embeddings)").all<{ name: string }>();
    expect(embeddingColumns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "appid",
      "dimension",
      "input_identity",
      "overview_input_identity",
      "model",
      "dimensions",
      "config_version",
      "vector",
      "active",
    ]));
    const obsoleteTables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .bind("media_article_embeddings", "media_game_matches")
      .all<{ name: string }>();
    expect(obsoleteTables.results).toEqual([]);
    expect(billingConfirmationColumn?.notnull).toBe(0);
    expect(migrations.results).toHaveLength(migrationNames.length);
  });
  test("enforces game embedding identity, vector, and foreign-key constraints", async () => {
    const db = await getDb();
    await db
      .prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
      .bind(30, "Embedding Test", "embedding-test")
      .run();
    const vector = new Uint8Array(3072 * Float32Array.BYTES_PER_ELEMENT);
    const insert = db
      .prepare(
        "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(30, "gameplay", "input-a", "overview-a", "gemini-embedding-2", 3072, "config-a", vector, 1);

    await insert.run();
    await expect(
      db
        .prepare(
          "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(
          30,
          "story_world",
          "input-text-vector",
          "overview-a",
          "gemini-embedding-2",
          3072,
          "config-a",
          "x".repeat(12288),
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(30, "gameplay", "input-b", "overview-a", "gemini-embedding-2", 3072, "config-a", vector)
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .bind(30, "gameplay", "input-a", "overview-a", "old-model", 3072, "old-config", vector)
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(30, "invalid", "input-c", "overview-a", "gemini-embedding-2", 3072, "config-a", vector)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(30, "story_world", "input-d", "overview-a", "gemini-embedding-2", 1536, "config-a", vector)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(30, "story_world", "input-e", "overview-a", "gemini-embedding-2", 3072, "config-a", new Uint8Array(4))
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(999, "story_world", "input-f", "overview-a", "gemini-embedding-2", 3072, "config-a", vector)
        .run(),
    ).rejects.toThrow();
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
    await db
      .prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'running')")
      .bind("initial:reopen", "[10]")
      .run();
    const mediaRun = await db
      .prepare("SELECT id FROM media_discovery_runs WHERE identity_key = ?")
      .bind("initial:reopen")
      .first<{ id: number }>();
    if (!mediaRun) throw new Error("media run was not persisted");
    await db
      .prepare("INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, status) VALUES (?, ?, 'initial', 'IGN', 'completed')")
      .bind(mediaRun.id, 10)
      .run();
    await db
      .prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review')")
      .bind(10, "https://ign.com/articles/persistence", "Persistence Review", "2026-09-05T00:00:00.000Z")
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
    const mediaSource = await reopened
      .prepare("SELECT appid, original_url, title, outlet, type FROM media_sources WHERE appid = ?")
      .bind(10)
      .first<{ appid: number; original_url: string; title: string; outlet: string; type: string }>();
    const migrations = await reopened
      .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at")
      .all<{ hash: string }>();
    expect(row).toEqual({ name: "Persistence Test" });
    expect(releasePlan).toEqual({
      appid: 10,
      expected_date: "2026-10-01",
      observed_at: "2026-09-05T00:00:00.000Z",
    });
    expect(mediaSource).toEqual({
      appid: 10,
      original_url: "https://ign.com/articles/persistence",
      title: "Persistence Review",
      outlet: "IGN",
      type: "review",
    });
    expect(migrations.results).toHaveLength(migrationNames.length);
  });

  test("adopts the legacy ledger without replaying applied SQL or losing rows", async () => {
    const cleanupMigrationIndex = migrationJournal.entries.findIndex(
      (entry) => entry.tag === "0014_stiff_longshot"
    );
    if (cleanupMigrationIndex < 1) throw new Error("Migration cleanup baseline is missing");
    const legacy = createLegacyDatabase(cleanupMigrationIndex);
    legacy
      .query("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)")
      .run(11, "Adopted Row", "adopted-row");
    legacy
      .query(
        "INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'IGN', ?, 'review')"
      )
      .run(11, "https://ign.com/articles/adopted", "Adopted Review", "2026-09-05T00:00:00.000Z");
    legacy
      .query(
        "INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')"
      )
      .run("adopted-media-run", "[11]");
    const source = legacy
      .query<{ id: number }, [number]>("SELECT id FROM media_sources WHERE appid = ?")
      .get(11);
    const run = legacy
      .query<{ id: number }, [string]>("SELECT id FROM media_discovery_runs WHERE identity_key = ?")
      .get("adopted-media-run");
    if (!source || !run) throw new Error("legacy media fixture was not created");
    legacy
      .query(
        "INSERT INTO media_processing_jobs (run_id, stage, appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, output_json) VALUES (?, 'explanation', ?, 'story_world', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'succeeded', ?)",
      )
      .run(
        run.id,
        11,
        source.id,
        "adopted-processing-job",
        "adopted-input",
        "gemini-3.1-flash-lite",
        "adopted-config",
        10,
        20,
        500,
        450,
        JSON.stringify({ trait: "legacy pair trait", explanation: "legacy generated pair prose" }),
      );
    const migrationJobs = legacy.query(
      "INSERT INTO media_processing_jobs (run_id, stage, appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, error, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const job of [
      ["embedding", 11, "gameplay", source.id, "legacy-embedding-reservation", "legacy-embedding-input", "legacy-embedding-model", "media-embedding-legacy", 600, null, 1, "reserved", null, null],
      ["explanation", 11, "story_world", source.id, "legacy-explanation-reservation", "legacy-explanation-input", "gemini-3.1-flash-lite", "media-explanation-legacy", 700, null, 1, "reserved", null, null],
      ["synthesis", 11, "story_world", null, "legacy-synthesis-v4-reservation", "legacy-synthesis-input", "gemini-3.1-flash-lite", "media-synthesis-2026-09-13-v4", 800, 123, 1, "reserved", null, null],
      ["embedding", 11, "gameplay", null, "embedding:11:gameplay:current-overview-input:current-embedding-input", "current-embedding-input", "gemini-embedding-2", "media-embedding-2026-09-13-v1", 900, null, 1, "reserved", null, null],
      ["embedding", 11, null, null, "invalid-current-aggregate-embedding-reservation", "invalid-current-embedding-input", "gemini-embedding-2", "media-embedding-2026-09-13-v1", 950, null, 1, "reserved", null, null],
      ["extraction", 11, null, source.id, "current-extraction-reservation", "current-extraction-input", "gemini-3.1-flash-lite", "media-extraction-2026-09-13-v3", 1000, null, 1, "reserved", null, null],
      ["synthesis", 11, "story_world", null, "current-synthesis-reservation", "current-synthesis-input", "gemini-3.1-flash-lite", "media-synthesis-2026-09-13-v5", 1100, null, 1, "reserved", null, null],
      ["embedding", 11, "gameplay", source.id, "submitted-legacy-embedding", "submitted-embedding-input", "legacy-embedding-model", "media-embedding-legacy", 1200, null, 1, "submitted", null, null],
    ] as const) {
      migrationJobs.run(
        run.id,
        job[0],
        job[1],
        job[2],
        job[3],
        job[4],
        job[5],
        job[6],
        job[7],
        10,
        20,
        job[8],
        job[9],
        job[10],
        job[11],
        job[12],
        job[13],
      );
    }
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
    const mediaSource = await db
      .prepare(
        "SELECT title, normalized_content_hash, cleanup_version, processing_content, processing_input_identity FROM media_sources WHERE appid = ?"
      )
      .bind(11)
      .first<{
        title: string;
        normalized_content_hash: string | null;
        cleanup_version: string | null;
        processing_content: string | null;
        processing_input_identity: string | null;
      }>();
    expect(mediaSource).toEqual({
      title: "Adopted Review",
      normalized_content_hash: null,
      cleanup_version: null,
      processing_content: null,
      processing_input_identity: null,
    });
    const mediaRun = await db
      .prepare("SELECT id FROM media_discovery_runs WHERE identity_key = ?")
      .bind("adopted-media-run")
      .first<{ id: number }>();
    if (!mediaRun) throw new Error("adopted media discovery run was not preserved");
    await db
      .prepare("INSERT INTO media_processing_authorizations (run_id, status) VALUES (?, 'queued')")
      .bind(mediaRun.id)
      .run();
    const authorization = await db
      .prepare("SELECT billing_confirmation FROM media_processing_authorizations WHERE run_id = ?")
      .bind(mediaRun.id)
      .first<{ billing_confirmation: string | null }>();
    expect(authorization).toEqual({ billing_confirmation: null });
    const processingJob = await db
      .prepare(
        "SELECT stage, reserved_microusd, charged_microusd, reservation_active, status, output_json FROM media_processing_jobs WHERE request_key = ?",
      )
      .bind("adopted-processing-job")
      .first<{
        stage: string;
        reserved_microusd: number;
        charged_microusd: number;
        reservation_active: number;
        status: string;
        output_json: string | null;
      }>();
    expect(processingJob).toEqual({
      stage: "explanation",
      reserved_microusd: 500,
      charged_microusd: 450,
      reservation_active: 0,
      status: "succeeded",
      output_json: null,
    });
    const retiredJobs = await db
      .prepare(
        "SELECT request_key, stage, config_version, reserved_microusd, charged_microusd, reservation_active, status, error, completed_at FROM media_processing_jobs WHERE request_key IN (?, ?, ?) ORDER BY request_key",
      )
      .bind(
        "legacy-embedding-reservation",
        "legacy-explanation-reservation",
        "legacy-synthesis-v4-reservation",
      )
      .all<{
        request_key: string;
        stage: string;
        config_version: string;
        reserved_microusd: number;
        charged_microusd: number | null;
        reservation_active: number;
        status: string;
        error: string | null;
        completed_at: string | null;
      }>();
    expect(retiredJobs.results).toHaveLength(3);
    expect(retiredJobs.results).toEqual([
      {
        request_key: "legacy-embedding-reservation",
        stage: "embedding",
        config_version: "media-embedding-legacy",
        reserved_microusd: 600,
        charged_microusd: null,
        reservation_active: 0,
        status: "stale",
        error: "obsolete reservation retired by migration",
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      },
      {
        request_key: "legacy-explanation-reservation",
        stage: "explanation",
        config_version: "media-explanation-legacy",
        reserved_microusd: 700,
        charged_microusd: null,
        reservation_active: 0,
        status: "stale",
        error: "obsolete reservation retired by migration",
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      },
      {
        request_key: "legacy-synthesis-v4-reservation",
        stage: "synthesis",
        config_version: "media-synthesis-2026-09-13-v4",
        reserved_microusd: 800,
        charged_microusd: 123,
        reservation_active: 0,
        status: "stale",
        error: "obsolete reservation retired by migration",
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      },
    ]);
    const invalidAggregateReservation = await db
      .prepare("SELECT status, reservation_active, error FROM media_processing_jobs WHERE request_key = ?")
      .bind("invalid-current-aggregate-embedding-reservation")
      .first<{ status: string; reservation_active: number; error: string | null }>();
    expect(invalidAggregateReservation).toEqual({
      status: "stale",
      reservation_active: 0,
      error: "obsolete reservation retired by migration",
    });
    const unaffectedJobs = await db
      .prepare(
        "SELECT request_key, stage, model, config_version, reserved_microusd, charged_microusd, reservation_active, status, error, completed_at FROM media_processing_jobs WHERE request_key IN (?, ?, ?, ?) ORDER BY request_key",
      )
      .bind(
        "embedding:11:gameplay:current-overview-input:current-embedding-input",
        "current-extraction-reservation",
        "current-synthesis-reservation",
        "submitted-legacy-embedding",
      )
      .all<{
        request_key: string;
        stage: string;
        model: string;
        config_version: string;
        reserved_microusd: number;
        charged_microusd: number | null;
        reservation_active: number;
        status: string;
        error: string | null;
        completed_at: string | null;
      }>();
    expect(unaffectedJobs.results).toEqual([
      {
        request_key: "current-extraction-reservation",
        stage: "extraction",
        model: "gemini-3.1-flash-lite",
        config_version: "media-extraction-2026-09-13-v3",
        reserved_microusd: 1000,
        charged_microusd: null,
        reservation_active: 1,
        status: "reserved",
        error: null,
        completed_at: null,
      },
      {
        request_key: "current-synthesis-reservation",
        stage: "synthesis",
        model: "gemini-3.1-flash-lite",
        config_version: "media-synthesis-2026-09-13-v5",
        reserved_microusd: 1100,
        charged_microusd: null,
        reservation_active: 1,
        status: "reserved",
        error: null,
        completed_at: null,
      },
      {
        request_key: "embedding:11:gameplay:current-overview-input:current-embedding-input",
        stage: "embedding",
        model: "gemini-embedding-2",
        config_version: "media-embedding-2026-09-13-v1",
        reserved_microusd: 900,
        charged_microusd: null,
        reservation_active: 1,
        status: "reserved",
        error: null,
        completed_at: null,
      },
      {
        request_key: "submitted-legacy-embedding",
        stage: "embedding",
        model: "legacy-embedding-model",
        config_version: "media-embedding-legacy",
        reserved_microusd: 1200,
        charged_microusd: null,
        reservation_active: 1,
        status: "submitted",
        error: null,
        completed_at: null,
      },
    ]);
    const budgetState = await db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE 0 END), 0) AS outstanding, COALESCE(SUM(CASE WHEN reservation_active = 0 THEN COALESCE(charged_microusd, 0) ELSE 0 END), 0) AS charged, COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE COALESCE(charged_microusd, 0) END), 0) AS total, COALESCE(SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END), 0) AS pending FROM media_processing_jobs",
      )
      .first<{ outstanding: number; charged: number; total: number; pending: number }>();
    expect(budgetState).toEqual({ outstanding: 4200, charged: 573, total: 4773, pending: 3 });
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
