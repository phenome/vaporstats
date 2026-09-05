import type { D1Database } from "../src/lib/db";
import {
  TICK_REQUEST_CAP,
  DAILY_REQUEST_CAP,
  calculateDeterministicSlot,
  reRankTrackedTiers,
} from "../src/lib/player";
import {
  runPlayerCollectionTick,
  runDailyDiscoveryAndReRanking,
  type CollectionTickResult,
} from "./player-collector";
import { runDailyRollupJob } from "./player-rollups";
import {
  runHourlyPriceFeedTick,
  refreshIndicatedAppPrices,
  type HourlyPriceFeedTickResult,
} from "./price-collector";
import {
  CATALOG_REFRESH_CHECKPOINT_KEY,
  refreshCatalogBatch,
  queueCatalogRefresh,
  runBoundedCatalogImport,
  type SeedResult,
} from "./catalog-seed";
import { syncReleaseFactsFromApps, type SyncReleaseFactsResult } from "./release-facts";

export interface IngestionEnv {
  DB: D1Database;
  STEAM_API_KEY?: string;
  INGESTION_TRIGGER_SECRET?: string;
  FETCH?: typeof fetch;
}

export interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
  type: string;
}

const INGESTION_LEASE_KEY = "ingestion:active-run";
const INGESTION_LEASE_DURATION_MS = 15 * 60 * 1000;

function hasIngestionAuth(request: Request, expectedSecret: string | undefined): boolean {
  return Boolean(expectedSecret) && request.headers.get("Authorization") === `Bearer ${expectedSecret}`;
}

async function acquireIngestionLease(db: D1Database): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO checkpoints (key, value, cursor, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         cursor = excluded.cursor,
         updated_at = CURRENT_TIMESTAMP
       WHERE checkpoints.cursor IS NULL OR checkpoints.cursor <= ?`
    )
    .bind(INGESTION_LEASE_KEY, token, now + INGESTION_LEASE_DURATION_MS, now)
    .run();
  return result.meta.changes === 1 ? token : null;
}

async function releaseIngestionLease(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("DELETE FROM checkpoints WHERE key = ? AND value = ?")
    .bind(INGESTION_LEASE_KEY, token)
    .run();
}

/**
 * Cloudflare Worker for scheduled ten-minute player activity ingestion
 * and incremental Steam price catalog feed processing.
 * Owns Steam credentials, shares D1 with public Worker, and anchors slot calculation to scheduled event time.
 * Accepts optional injected fetch in env for tests; production default remains global fetch.
 */
export default {
  async scheduled(
    event: ScheduledEvent,
    env: IngestionEnv,
    ctx?: { waitUntil: (promise: Promise<unknown>) => void }
  ): Promise<void> {
    const anchorTime = new Date(event.scheduledTime);
    const db = env.DB;
    const customFetch = env.FETCH ?? fetch;

    const tickPromise = (async () => {
      const startTime = Date.now();
      const lease = await acquireIngestionLease(db);
      if (!lease) {
        console.log(
          JSON.stringify({
            event: "ingestion_completion",
            cron: event.cron,
            scheduledTime: event.scheduledTime,
            durationMs: Date.now() - startTime,
            reason: "run_in_progress",
          })
        );
        return;
      }

      try {
        const budgetTime = new Date();
        const tickResult = await runPlayerCollectionTick(db, {
          anchorTime,
          budgetTime,
          customFetch,
        });
        await reRankTrackedTiers(db, anchorTime);

        let discoveryResult = null;
        let rollupResult = null;
        if (anchorTime.getUTCHours() === 0 && anchorTime.getUTCMinutes() < 10) {
          discoveryResult = await runDailyDiscoveryAndReRanking(db, {
            anchorTime,
            budgetTime,
            customFetch,
            alreadyAttemptedInTick: tickResult.attempted,
          });
          rollupResult = await runDailyRollupJob(db, { anchorTime });
        }

        let priceResult = null;
        if (env.STEAM_API_KEY) {
          priceResult = await runHourlyPriceFeedTick(db, {
            apiKey: env.STEAM_API_KEY,
            customFetch,
            anchorTime,
          });
        }
        const catalogRefreshResult = await refreshCatalogBatch(db, {
          checkpointKey: CATALOG_REFRESH_CHECKPOINT_KEY,
          fetchFn: customFetch,
        });
        const { records: _catalogRefreshRecords, ...catalogRefresh } = catalogRefreshResult;
        const releaseResult = await syncReleaseFactsFromApps(db, { asOfDate: anchorTime });

        console.log(
          JSON.stringify({
            event: "ingestion_completion",
            cron: event.cron,
            scheduledTime: event.scheduledTime,
            durationMs: Date.now() - startTime,
            tick: tickResult,
            discovery: discoveryResult,
            rollups: rollupResult,
            prices: priceResult,
            catalogRefresh,
            releaseFacts: releaseResult,
          })
        );
      } finally {
        await releaseIngestionLease(db, lease);
      }
    })();

    if (ctx?.waitUntil) {
      ctx.waitUntil(tickPromise);
    } else {
      await tickPromise;
    }
  },

  async fetch(
    request: Request,
    env: IngestionEnv,
    ctx?: { waitUntil: (promise: Promise<unknown>) => void }
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/catalog/refresh") {
      if (!hasIngestionAuth(request, env.INGESTION_TRIGGER_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const lease = await acquireIngestionLease(env.DB);
      if (!lease) {
        return Response.json({ success: false, reason: "run_in_progress" }, { status: 409 });
      }

      try {
        const customFetch = env.FETCH ?? fetch;
        const queue = await queueCatalogRefresh(env.DB, CATALOG_REFRESH_CHECKPOINT_KEY);
        const refresh = await refreshCatalogBatch(env.DB, {
          checkpointKey: CATALOG_REFRESH_CHECKPOINT_KEY,
          fetchFn: customFetch,
        });
        const releases = await syncReleaseFactsFromApps(env.DB, {
          apps: refresh.records.map((record) => ({ ...record, type: record.type ?? "game" })),
        });
        const { records: _records, ...refreshSummary } = refresh;

        return Response.json({
          success: true,
          queue,
          refresh: refreshSummary,
          releases,
        });
      } finally {
        await releaseIngestionLease(env.DB, lease);
      }
    }

    // Authenticated manual catalog seed, precise release facts, and storefront prices
    if (request.method === "POST" && url.pathname === "/api/catalog/seed") {
      if (!hasIngestionAuth(request, env.INGESTION_TRIGGER_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const limitParam = url.searchParams.get("limit");
      const parsedLimit = limitParam ? parseInt(limitParam, 10) : undefined;
      const limit =
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(Math.floor(parsedLimit), 50)
          : undefined;
      const customFetch = env.FETCH ?? fetch;

      // 1. Run bounded catalog seed (hard-clamped to max 50 with curated relations)
      const seedResult = await runBoundedCatalogImport(env.DB, {
        limit,
        fetchFn: customFetch,
      });

      // Seeded playable roots become immediately due without resetting existing schedules.
      const trackedAt = new Date();
      const trackingStatements = seedResult.records
        .filter(
          (record) =>
            record.is_playable === true &&
            record.is_eligible === true &&
            record.parent_appid === null
        )
        .map((record) =>
          env.DB
            .prepare(
              `INSERT INTO tracked_games (appid, tier, slot, next_due_at)
               VALUES (?, 'daily', ?, ?)
               ON CONFLICT(appid) DO NOTHING`
            )
            .bind(
              record.appid,
              calculateDeterministicSlot(record.appid, "daily"),
              trackedAt.toISOString()
            )
        );
      if (trackingStatements.length > 0) {
        await env.DB.batch(trackingStatements);
      }

      // 2. Persist precise release facts for the exact imported records (not a DB-wide 500 scan)
      const releaseResult = await syncReleaseFactsFromApps(env.DB, {
        apps: seedResult.records.map((r) => ({ ...r, type: r.type ?? "game" })),
      });

      // 3. Refresh prices without Steam Web API key using Storefront API for imported eligible apps
      const priceStats = await refreshIndicatedAppPrices(env.DB, seedResult.importedAppIds, {
        customFetch,
      });

      return Response.json({
        success: true,
        seed: seedResult,
        releases: releaseResult,
        tracking: { registered: trackingStatements.length },
        prices: priceStats,
      });
    }

    // Support authenticated manual scheduled invocation for operations and deterministic tests
    if (
      request.method === "POST" &&
      (url.pathname === "/api/ingest/scheduled" ||
        url.pathname === "/scheduled" ||
        url.pathname === "/api/collect/players" ||
        url.pathname === "/api/collect/prices")
    ) {
      // Require INGESTION_TRIGGER_SECRET bearer auth
      if (!hasIngestionAuth(request, env.INGESTION_TRIGGER_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let body: {
        anchorTime?: unknown;
        forceDiscovery?: boolean;
        forceRollups?: boolean;
        forcePriceTick?: boolean;
        tickCap?: number;
        dailyCap?: number;
      } = {};

      try {
        if (request.headers.get("Content-Type")?.includes("application/json")) {
          body = (await request.json()) as typeof body;
        }
      } catch {
        // empty body is valid
      }

      if (body.anchorTime !== undefined) {
        return new Response("anchorTime is controlled by the Worker", { status: 400 });
      }

      const anchorTime = new Date();
      const lease = await acquireIngestionLease(env.DB);
      if (!lease) {
        return Response.json(
          { success: false, reason: "run_in_progress" },
          { status: 409 }
        );
      }

      try {
        const customFetch = env.FETCH ?? fetch;
        if (url.pathname === "/api/collect/prices") {
          const priceResult = await runHourlyPriceFeedTick(env.DB, {
            apiKey: env.STEAM_API_KEY,
            customFetch,
            anchorTime,
          });
          const catalogRefreshResult = await refreshCatalogBatch(env.DB, {
            checkpointKey: CATALOG_REFRESH_CHECKPOINT_KEY,
            fetchFn: customFetch,
          });
          const { records: _catalogRefreshRecords, ...catalogRefresh } = catalogRefreshResult;
          const releaseResult = await syncReleaseFactsFromApps(env.DB, {
            asOfDate: anchorTime,
          });
          return Response.json({
            success: true,
            prices: priceResult,
            catalogRefresh,
            releases: releaseResult,
          });
        }

        const sanitizeCap = (val: unknown, maxCap: number): number => {
          if (typeof val === "number" && Number.isFinite(val) && val > 0) {
            return Math.min(Math.floor(val), maxCap);
          }
          return maxCap;
        };
        const tickCap = sanitizeCap(body.tickCap, TICK_REQUEST_CAP);
        const dailyCap = sanitizeCap(body.dailyCap, DAILY_REQUEST_CAP);

        const tickResult = await runPlayerCollectionTick(env.DB, {
          anchorTime,
          budgetTime: new Date(),
          tickCap,
          dailyCap,
          customFetch,
        });

        let discoveryResult = null;
        if (body.forceDiscovery) {
          discoveryResult = await runDailyDiscoveryAndReRanking(env.DB, {
            anchorTime,
            budgetTime: new Date(),
            tickCap,
            dailyCap,
            customFetch,
            alreadyAttemptedInTick: tickResult.attempted,
          });
        }

        const rollupResult = body.forceRollups
          ? await runDailyRollupJob(env.DB, { anchorTime })
          : null;
        const priceResult = body.forcePriceTick
          ? await runHourlyPriceFeedTick(env.DB, {
              apiKey: env.STEAM_API_KEY,
              customFetch,
              anchorTime,
            })
          : null;
        const catalogRefreshResult = await refreshCatalogBatch(env.DB, {
          checkpointKey: CATALOG_REFRESH_CHECKPOINT_KEY,
          fetchFn: customFetch,
        });
        const { records: _catalogRefreshRecords, ...catalogRefresh } = catalogRefreshResult;
        const releaseResult = await syncReleaseFactsFromApps(env.DB, {
          asOfDate: anchorTime,
        });

        return Response.json({
          success: true,
          tick: tickResult,
          discovery: discoveryResult,
          rollups: rollupResult,
          prices: priceResult,
          catalogRefresh,
          releases: releaseResult,
        });
      } finally {
        await releaseIngestionLease(env.DB, lease);
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", worker: "vaporstats-ingestion" });
    }

    return new Response("Not Found", { status: 404 });
  },
};
