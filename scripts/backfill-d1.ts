import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface BackfillOptions {
  d1SqlPath?: string;
  targetDbPath?: string;
  force?: boolean;
}

export interface BackfillStats {
  appsInserted: number;
  appsSkipped: number;
  observationsInserted: number;
  observationsSkipped: number;
  rollupsInserted: number;
  rollupsSkipped: number;
  priceHistoryInserted: number;
  priceHistorySkipped: number;
  appPricesInserted: number;
  appPricesSkipped: number;
  relationshipsInserted: number;
  relationshipsSkipped: number;
}
interface D1AppRow {
  appid: number;
  name: string;
  slug: string;
  type: string;
  is_eligible: number;
  is_playable: number;
  parent_appid: number | null;
  release_date: string | null;
  release_status: string;
  description: string | null;
  header_image: string | null;
  developer: string | null;
  publisher: string | null;
  created_at: string;
  updated_at: string;
}
interface D1AppPriceRow {
  appid: number;
  currency: string;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number | null;
  is_free: number;
  is_available: number;
  formatted_initial: string | null;
  formatted_final: string | null;
  observed_at: string;
  created_at: string;
  updated_at: string;
}

interface D1ObservationRow {
  id: number;
  appid: number;
  current_players: number;
  observed_at: string;
  created_at: string;
}

interface D1PlayerRollupRow {
  appid: number;
  date: string;
  min_players: number;
  max_players: number;
  avg_players: number;
  close_players: number;
  sample_count: number;
  created_at: string;
}

interface D1PriceHistoryRow {
  id: number;
  appid: number;
  currency: string;
  initial_price: number | null;
  final_price: number | null;
  discount_percent: number | null;
  is_free: number;
  is_available: number;
  formatted_price: string | null;
  observed_at: string;
  created_at: string;
}

interface D1RelationshipRow {
  parent_appid: number;
  child_appid: number;
  relationship_type: string;
  prominence: number;
  created_at: string;
  updated_at: string;
}

export const BACKFILL_CHECKPOINT_KEY = "d1_history_backfill_completed";

export async function runD1Backfill(options: BackfillOptions = {}): Promise<BackfillStats> {
  const d1SqlPath = resolve(options.d1SqlPath ?? "data/d1-export-vaporstats.sql");
  const targetDbPath = resolve(options.targetDbPath ?? (process.env.DATABASE_PATH || "data/vaporstats.sqlite"));

  if (!existsSync(d1SqlPath)) {
    throw new Error(`D1 export file not found at: ${d1SqlPath}`);
  }
  if (!existsSync(targetDbPath)) {
    throw new Error(`Target SQLite database not found at: ${targetDbPath}`);
  }

  console.log(`[Backfill] Reading D1 SQL from: ${d1SqlPath}`);
  console.log(`[Backfill] Target database: ${targetDbPath}`);

  // Load D1 export into in-memory database
  const d1Db = new Database(":memory:");
  d1Db.exec("PRAGMA foreign_keys = OFF;");
  const sql = readFileSync(d1SqlPath, "utf8");
  d1Db.exec(sql);

  // Open target database
  const targetDb = new Database(targetDbPath);
  targetDb.exec("PRAGMA foreign_keys = OFF;");
  targetDb.exec("PRAGMA busy_timeout = 10000;");

  // Check if checkpoint already exists
  const existingCheckpoint = targetDb
    .prepare("SELECT value FROM checkpoints WHERE key = ?")
    .get(BACKFILL_CHECKPOINT_KEY) as { value: string } | null;

  if (existingCheckpoint && !options.force) {
    console.log(`[Backfill] Checkpoint '${BACKFILL_CHECKPOINT_KEY}' already recorded at ${existingCheckpoint.value}. Use --force to re-run.`);
    return {
      appsInserted: 0,
      appsSkipped: 0,
      observationsInserted: 0,
      observationsSkipped: 0,
      rollupsInserted: 0,
      rollupsSkipped: 0,
      priceHistoryInserted: 0,
      priceHistorySkipped: 0,
      appPricesInserted: 0,
      appPricesSkipped: 0,
      relationshipsInserted: 0,
      relationshipsSkipped: 0,
    };
  }

  const stats: BackfillStats = {
    appsInserted: 0,
    appsSkipped: 0,
    observationsInserted: 0,
    observationsSkipped: 0,
    rollupsInserted: 0,
    rollupsSkipped: 0,
    priceHistoryInserted: 0,
    priceHistorySkipped: 0,
    appPricesInserted: 0,
    appPricesSkipped: 0,
    relationshipsInserted: 0,
    relationshipsSkipped: 0,
  };

  targetDb.transaction(() => {
    // 1. Merge missing apps only (NEVER overwrite existing apps, preserving title info, dates, release facts)
    console.log("[Backfill] Checking apps...");
    const checkApp = targetDb.prepare("SELECT appid FROM apps WHERE appid = ?");
    const insertApp = targetDb.prepare(`
      INSERT INTO apps (
        appid, name, slug, type, is_eligible, is_playable, parent_appid,
        release_date, release_status, description, header_image, developer, publisher,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?
      )
    `);

    const d1Apps = d1Db.prepare("SELECT * FROM apps").all() as D1AppRow[];
    for (const app of d1Apps) {
      if (checkApp.get(app.appid)) {
        stats.appsSkipped++;
      } else {
        insertApp.run(
          app.appid,
          app.name,
          app.slug,
          app.type,
          app.is_eligible,
          app.is_playable,
          app.parent_appid,
          app.release_date,
          app.release_status,
          app.description,
          app.header_image,
          app.developer,
          app.publisher,
          app.created_at,
          app.updated_at
        );
        stats.appsInserted++;
      }
    }


    // 3. Merge app_prices (missing only)
    const checkPrice = targetDb.prepare("SELECT appid FROM app_prices WHERE appid = ?");
    const insertPrice = targetDb.prepare(`
      INSERT INTO app_prices (
        appid, currency, initial_price, final_price, discount_percent,
        is_free, is_available, formatted_initial, formatted_final, observed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )
    `);
    const d1Prices = d1Db.prepare("SELECT * FROM app_prices").all() as D1AppPriceRow[];
    for (const p of d1Prices) {
      if (checkPrice.get(p.appid)) {
        stats.appPricesSkipped++;
      } else {
        insertPrice.run(
          p.appid,
          p.currency,
          p.initial_price,
          p.final_price,
          p.discount_percent,
          p.is_free,
          p.is_available,
          p.formatted_initial,
          p.formatted_final,
          p.observed_at,
          p.created_at,
          p.updated_at
        );
        stats.appPricesInserted++;
      }
    }

    // 4. Merge observations (deduplicated by appid + observed_at)
    console.log("[Backfill] Merging observations...");
    const checkObs = targetDb.prepare("SELECT 1 FROM observations WHERE appid = ? AND observed_at = ?");
    const insertObs = targetDb.prepare(`
      INSERT INTO observations (appid, current_players, observed_at, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const d1Observations = d1Db.prepare("SELECT * FROM observations ORDER BY observed_at ASC").all() as D1ObservationRow[];
    for (const obs of d1Observations) {
      if (checkObs.get(obs.appid, obs.observed_at)) {
        stats.observationsSkipped++;
      } else {
        insertObs.run(obs.appid, obs.current_players, obs.observed_at, obs.created_at);
        stats.observationsInserted++;
      }
    }

    // 5. Merge player_rollups (deduplicated by appid + date)
    console.log("[Backfill] Merging player_rollups...");
    const checkRollup = targetDb.prepare("SELECT 1 FROM player_rollups WHERE appid = ? AND date = ?");
    const insertRollup = targetDb.prepare(`
      INSERT INTO player_rollups (
        appid, date, min_players, max_players, avg_players, close_players, sample_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const d1Rollups = d1Db.prepare("SELECT * FROM player_rollups ORDER BY date ASC").all() as D1PlayerRollupRow[];
    for (const r of d1Rollups) {
      if (checkRollup.get(r.appid, r.date)) {
        stats.rollupsSkipped++;
      } else {
        insertRollup.run(
          r.appid,
          r.date,
          r.min_players,
          r.max_players,
          r.avg_players,
          r.close_players,
          r.sample_count,
          r.created_at
        );
        stats.rollupsInserted++;
      }
    }

    // 6. Merge price_history (deduplicated by appid + observed_at)
    console.log("[Backfill] Merging price_history...");
    const checkPriceHist = targetDb.prepare("SELECT 1 FROM price_history WHERE appid = ? AND observed_at = ?");
    const insertPriceHist = targetDb.prepare(`
      INSERT INTO price_history (
        appid, currency, initial_price, final_price, discount_percent,
        is_free, is_available, formatted_price, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const d1PriceHist = d1Db.prepare("SELECT * FROM price_history ORDER BY observed_at ASC").all() as D1PriceHistoryRow[];
    for (const ph of d1PriceHist) {
      if (checkPriceHist.get(ph.appid, ph.observed_at)) {
        stats.priceHistorySkipped++;
      } else {
        insertPriceHist.run(
          ph.appid,
          ph.currency,
          ph.initial_price,
          ph.final_price,
          ph.discount_percent,
          ph.is_free,
          ph.is_available,
          ph.formatted_price,
          ph.observed_at,
          ph.created_at
        );
        stats.priceHistoryInserted++;
      }
    }

    // 7. Merge app_relationships (missing only)
    try {
      const checkRel = targetDb.prepare("SELECT 1 FROM app_relationships WHERE parent_appid = ? AND child_appid = ?");
      const insertRel = targetDb.prepare(`
        INSERT INTO app_relationships (
          parent_appid, child_appid, relationship_type, prominence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const d1Rels = d1Db.prepare("SELECT * FROM app_relationships").all() as D1RelationshipRow[];
      for (const rel of d1Rels) {
        if (checkRel.get(rel.parent_appid, rel.child_appid)) {
          stats.relationshipsSkipped++;
        } else {
          insertRel.run(
            rel.parent_appid,
            rel.child_appid,
            rel.relationship_type,
            rel.prominence,
            rel.created_at,
            rel.updated_at
          );
          stats.relationshipsInserted++;
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[Backfill] app_relationships notice: ${msg}`);
    }

    // 8. Record checkpoint
    const checkpointValue = JSON.stringify({
      timestamp: new Date().toISOString(),
      stats,
    });
    targetDb
      .prepare(`
        INSERT INTO checkpoints (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `)
      .run(BACKFILL_CHECKPOINT_KEY, checkpointValue);
  })();

  targetDb.close();
  d1Db.close();

  console.log("[Backfill] Completed successfully!");
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const targetIndex = args.indexOf("--target");
  const targetDbPath = targetIndex !== -1 ? args[targetIndex + 1] : undefined;
  const d1Index = args.indexOf("--d1");
  const d1SqlPath = d1Index !== -1 ? args[d1Index + 1] : undefined;

  runD1Backfill({ force, targetDbPath, d1SqlPath })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Backfill] Error:", err);
      process.exit(1);
    });
}
