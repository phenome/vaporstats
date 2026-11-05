import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";

const directory = resolve(import.meta.dir, "../migrations");
const journal = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const publicationTables = [
  "reception_publication_builds", "reception_publication_current", "reception_publication_months",
  "reception_publication_revisions", "reception_publication_state",
];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close(true);
});

function database(beforePublication = false): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  if (!beforePublication) {
    applyMigrations(db, directory);
    return db;
  }
  const index = journal.entries.findIndex((entry) => entry.tag === "0018_reception_publication");
  if (index < 1) throw new Error("Publication migration baseline missing");
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const entry of journal.entries.slice(0, index)) {
    db.exec(readFileSync(join(directory, entry.tag + ".sql"), "utf8"));
    db.query("INSERT INTO schema_migrations (name) VALUES (?)").run(entry.tag + ".sql");
  }
  return db;
}

function seed(db: Database): void {
  db.exec(`
    INSERT INTO apps (appid, name, slug, release_status, is_early_access) VALUES
      (10, 'Recorded game', 'recorded-game', 'released', 0),
      (20, 'Other game', 'other-game', 'released', 0);
    INSERT INTO review_sources
      (id, endpoint, request_filter, population, population_flags, interpretation_version, identity_key)
      VALUES ('histogram', 'appreviewhistogram', 'none', 'filtered_reviews', '{"retained":true}', 'steam-review-source-v1', 'histogram');
    INSERT INTO review_sources
      (id, endpoint, request_filter, language, purchase_type, filter_offtopic_activity, population, interpretation_version, identity_key)
      VALUES ('summary', 'appreviews', 'filter=all', 'all', 'all', 1, 'filtered_reviews', 'steam-review-source-v1', 'summary');
    INSERT INTO review_buckets
      (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
      VALUES (10, 'histogram', 'weekly', '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z', 280, 20, '2026-10-09T12:00:00.000Z', '{"retained":"bucket"}');
    INSERT INTO review_summary_snapshots
      (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count)
      VALUES (10, 'summary', '2026-10-09T12:00:00.000Z', 900, 1000);
    INSERT INTO player_score_history
      (appid, observed_at, score, formula_version, current_positive_count, current_total_count,
       historical_positive_count, historical_total_count, current_window_start, current_window_end,
       historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals,
       current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at,
       anchor_event_id, anchor_at, provenance, created_at)
      VALUES (10, '2026-10-09T12:05:00.000Z', 93.33333333333333, 'steam-player-v2', 280, 300,
       70, 100, '2026-07-11T12:00:00.000Z', '2026-10-09T12:00:00.000Z',
       '2026-04-12T12:00:00.000Z', '2026-07-11T12:00:00.000Z',
       '[{"start":"2026-10-01T00:00:00.000Z","end":"2026-10-08T00:00:00.000Z","granularity":"week"}]', '[]',
       'histogram', 'histogram', '2026-10-09T12:00:00.000Z', '2026-07-11T12:00:00.000Z',
       'event-10', '2026-07-11T12:00:00.000Z', '{"retained":"score"}', '2026-10-09T12:05:01.000Z');
    INSERT INTO player_score_state
      (appid, latest_score_history_id, historical_positive_count, historical_total_count, historical_source_id,
       historical_window_start, historical_window_end, historical_baseline_observed_at,
       eligibility_review_count, eligibility_source_id, eligibility_window_start, eligibility_window_end,
       eligibility_evidence_start, eligibility_evidence_end, eligibility_evidence_intervals,
       eligibility_observed_at, eligibility_provenance)
      SELECT appid, id, 70, 100, 'histogram', '2026-04-12T12:00:00.000Z', '2026-07-11T12:00:00.000Z',
       '2026-07-11T12:00:00.000Z', 300, 'histogram', '2026-07-11T12:00:00.000Z', '2026-10-09T12:00:00.000Z',
       '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z',
       '[{"start":"2026-10-01T00:00:00.000Z","end":"2026-10-08T00:00:00.000Z","granularity":"week"}]',
       '2026-10-09T12:00:00.000Z', '{"retained":"eligibility"}' FROM player_score_history WHERE appid = 10;
    INSERT INTO steam_events (event_id, appid, category, title, start_at, observed_at)
      VALUES ('event-10', 10, 'major_update', 'Major update', '2026-07-11T12:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO app_release_events (appid, event_type, source, event_date)
      VALUES (10, 'patch', 'original_release_date', '2026-07-11');
    INSERT INTO app_facets (facet_group, source_id, name) VALUES ('genre', '1', 'Action');
    INSERT INTO app_facet_memberships (appid, facet_group, source_id, source_order)
      VALUES (10, 'genre', '1', 0), (20, 'genre', '1', 0);
  `);
}

function revision(db: Database): number {
  return db.query<{ source_revision: number }, []>("SELECT source_revision FROM reception_publication_state WHERE id = 1").get()?.source_revision ?? 0;
}
function appRevision(db: Database, appid: number): number {
  return db.query<{ revision: number }, [number]>("SELECT revision FROM reception_publication_revisions WHERE appid = ?").get(appid)?.revision ?? 0;
}
function changed(db: Database, sql: string, appids = [10]): void {
  const before = revision(db);
  db.exec(sql);
  expect(revision(db)).toBeGreaterThan(before);
  for (const appid of appids) expect(appRevision(db, appid)).toBeGreaterThan(before);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("published reception SQLite migration", () => {
  test("upgrades retained evidence without altering any original row or foreign key and without seeding projections", () => {
    const db = database(true);
    seed(db);
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    ).all().map((row) => row.name);
    const rows = tables.map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const foreignKeys = tables.map((table) => db.query(`PRAGMA foreign_key_list(${table})`).all());
    applyMigrations(db, directory);
    applyMigrations(db, directory);
    for (const [index, table] of tables.entries()) {
      expect(db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(rows[index]);
      expect(db.query(`PRAGMA foreign_key_list(${table})`).all()).toEqual(foreignKeys[index]);
    }
    for (const table of publicationTables) expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(() => db.exec("DELETE FROM review_sources WHERE id = 'histogram'")).toThrow();
    expect(() => db.exec("DELETE FROM apps WHERE appid = 10")).toThrow();
    expect(() => db.exec("UPDATE player_score_state SET latest_score_history_id = 999999 WHERE appid = 10")).toThrow();
  });

  test("empty migration creates every publication table but no publication, invalidation, or source observations", () => {
    const db = database();
    for (const table of [...publicationTables, "review_sources", "review_buckets", "review_summary_snapshots", "player_score_history", "player_score_state"]) {
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
  });

  test("identical upserts and transport bookkeeping do not invalidate; same-time count corrections do", () => {
    const db = database();
    seed(db);
    const before = revision(db);
    const appBefore = appRevision(db, 10);
    db.exec(`
      INSERT INTO review_sources (id, endpoint, request_filter, population, population_flags, interpretation_version, identity_key)
        SELECT id, endpoint, request_filter, population, population_flags, interpretation_version, identity_key FROM review_sources WHERE id = 'histogram'
        ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint, request_filter=excluded.request_filter,
          population=excluded.population, population_flags=excluded.population_flags, interpretation_version=excluded.interpretation_version, identity_key=excluded.identity_key;
      INSERT INTO review_buckets (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
        SELECT appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance FROM review_buckets WHERE appid = 10
        ON CONFLICT DO UPDATE SET positive_count=excluded.positive_count, negative_count=excluded.negative_count, observed_at=excluded.observed_at, provenance=excluded.provenance;
      INSERT INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count)
        SELECT appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count FROM review_summary_snapshots WHERE appid = 10
        ON CONFLICT DO UPDATE SET lifetime_positive_count=excluded.lifetime_positive_count, lifetime_total_count=excluded.lifetime_total_count;
      UPDATE player_score_state SET updated_at = '2026-11-05T00:00:00.000Z';
      UPDATE steam_events SET updated_at = '2026-11-05T00:00:00.000Z';
      UPDATE app_facets SET updated_at = '2026-11-05T00:00:00.000Z';
      UPDATE app_facet_memberships SET updated_at = '2026-11-05T00:00:00.000Z';
    `);
    expect(revision(db)).toBe(before);
    expect(appRevision(db, 10)).toBe(appBefore);
    const score = db.query("SELECT * FROM player_score_history").all();
    changed(db, "UPDATE review_buckets SET positive_count = 279, negative_count = 21 WHERE appid = 10");
    changed(db, "UPDATE review_summary_snapshots SET lifetime_positive_count = 899 WHERE appid = 10");
    expect(db.query("SELECT observed_at FROM review_buckets").get()).toEqual({ observed_at: "2026-10-09T12:00:00.000Z" });
    expect(db.query("SELECT observed_at FROM review_summary_snapshots").get()).toEqual({ observed_at: "2026-10-09T12:00:00.000Z" });
    expect(db.query("SELECT * FROM player_score_history").all()).toEqual(score);
  });

  test("source interpretation invalidates all dependent games, including state-only references", () => {
    const db = database();
    seed(db);
    db.exec("INSERT INTO player_score_state (appid, eligibility_source_id) VALUES (20, 'histogram')");
    changed(db, "UPDATE review_sources SET population_flags = '{\"corrected\":true}' WHERE id = 'histogram'", [10, 20]);
    changed(db, "UPDATE review_sources SET language = 'english' WHERE id = 'summary'");
    changed(db, "UPDATE player_score_state SET eligibility_review_count = 299 WHERE appid = 10");
    changed(db, "DELETE FROM review_buckets WHERE appid = 10");
    changed(db, "DELETE FROM review_summary_snapshots WHERE appid = 10");
  });

  test("facet names and membership changes invalidate affected apps, and lifecycle metadata invalidates the game", () => {
    const db = database();
    seed(db);
    changed(db, "UPDATE app_facets SET name = 'Action games' WHERE source_id = '1'", [10, 20]);
    changed(db, "UPDATE app_facet_memberships SET weight = 50 WHERE appid = 10");
    changed(db, "UPDATE apps SET is_early_access = 1 WHERE appid = 10");
    changed(db, "UPDATE apps SET release_status = 'upcoming' WHERE appid = 10");
    changed(db, "UPDATE apps SET release_date = '2026-12-01' WHERE appid = 10");
    changed(db, "UPDATE steam_events SET category = 'patchnotes' WHERE appid = 10");
    changed(db, "UPDATE app_release_events SET event_date = '2026-07-12' WHERE appid = 10");
    changed(db, "DELETE FROM app_release_events WHERE appid = 10");
    changed(db, "DELETE FROM steam_events WHERE appid = 10");
    changed(db, "DELETE FROM app_facet_memberships WHERE appid = 10");
    changed(db, "DELETE FROM app_facet_memberships WHERE appid = 20", [20]);
    changed(db, "DELETE FROM app_facets WHERE source_id = '1'", []);
  });

  test("score/state mutations and moved evidence invalidate both old and new app identities", () => {
    const db = database();
    seed(db);
    changed(db, "UPDATE review_buckets SET appid = 20 WHERE appid = 10", [10, 20]);
    changed(db, "UPDATE review_summary_snapshots SET appid = 20 WHERE appid = 10", [10, 20]);
    changed(db, "UPDATE player_score_state SET latest_score_history_id = NULL WHERE appid = 10");
    changed(db, "DELETE FROM player_score_state WHERE appid = 10");
    changed(db, "INSERT INTO player_score_state (appid, eligibility_review_count) VALUES (10, 250)");
    changed(db, "UPDATE player_score_history SET appid = 20 WHERE appid = 10", [10, 20]);
    changed(db, "DELETE FROM player_score_history WHERE appid = 20", [20]);
    const before = revision(db);
    db.exec("UPDATE player_score_state SET eligibility_review_count = eligibility_review_count WHERE appid = 10");
    expect(revision(db)).toBe(before);
  });

  test("source deletion restrictions remain atomic and successful source/app deletion retains safe invalidation tombstones", () => {
    const db = database();
    seed(db);
    const before = revision(db);
    expect(() => db.exec("DELETE FROM review_sources WHERE id = 'histogram'")).toThrow();
    expect(revision(db)).toBe(before);
    expect(db.query("SELECT id FROM review_sources WHERE id = 'histogram'").get()).toEqual({ id: "histogram" });
    changed(db, "DELETE FROM app_facet_memberships WHERE appid = 20", [20]);
    changed(db, "DELETE FROM apps WHERE appid = 20", [20]);
    expect(db.query("SELECT appid FROM apps WHERE appid = 20").get()).toBeNull();
    expect(appRevision(db, 20)).toBe(revision(db));
    db.exec("DELETE FROM player_score_state WHERE appid = 10; DELETE FROM player_score_history WHERE appid = 10; DELETE FROM review_buckets WHERE appid = 10");
    changed(db, "DELETE FROM review_sources WHERE id = 'histogram'", []);
    expect(db.query("SELECT id FROM review_sources WHERE id = 'histogram'").get()).toBeNull();
    changed(db, "DELETE FROM apps WHERE appid = 10");
    expect(appRevision(db, 10)).toBe(revision(db));
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("publication constraints protect generation ownership and retain a published pointer until explicitly moved", () => {
    const db = database();
    seed(db);
    db.exec(`
      INSERT INTO reception_publication_builds (id, status, projection_version, history_key, evaluated_at, source_revision, max_appid)
        VALUES (1, 'published', 1, 'history-1', '2026-10-10T00:00:00.000Z', 0, 20),
               (2, 'building', 1, 'history-2', '2026-10-11T00:00:00.000Z', 0, 20);
      UPDATE reception_publication_state SET published_build_id = 1 WHERE id = 1;
      INSERT INTO reception_publication_current (build_id, appid, type, input_revision, history_key, metric_value, qualifying_reviews, score_history_id)
        SELECT 1, 10, 'top_rated_now', 0, 'history-1', 93.33333333333333, 300, id FROM player_score_history WHERE appid = 10;
      INSERT INTO reception_publication_months (history_key, appid, type, cutoff, metric_kind, value, observed_at, provenance, score_history_id)
        SELECT 'history-1', 10, 'top_rated_now', '2026-10-10T00:00:00.000Z', 'current_player_score', score, observed_at, 'recorded', id FROM player_score_history WHERE appid = 10;
    `);
    expect(() => db.exec("DELETE FROM reception_publication_builds WHERE id = 1")).toThrow();
    expect(() => db.exec("UPDATE reception_publication_current SET metric_value = 101")).toThrow();
    expect(() => db.exec("UPDATE reception_publication_months SET provenance = 'invented'")).toThrow();
    expect(() => db.exec("UPDATE reception_publication_builds SET cursor_appid = 21 WHERE id = 2")).toThrow();
    expect(db.query("SELECT published_build_id FROM reception_publication_state").get()).toEqual({ published_build_id: 1 });
    db.exec("DELETE FROM reception_publication_builds WHERE id = 2");
    expect(db.query("SELECT build_id FROM reception_publication_current").all()).toEqual([{ build_id: 1 }]);
    expect(db.query("SELECT history_key FROM reception_publication_months").all()).toEqual([{ history_key: "history-1" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
