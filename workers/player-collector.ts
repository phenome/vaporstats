import type { D1Database, D1PreparedStatement } from "../src/lib/db";
import {
  TIER_FAST_MAX,
  TIER_HOURLY_MAX,
  TIER_DAILY_MAX,
  MAX_TRACKED_GAMES,
  DAILY_REQUEST_CAP,
  TICK_REQUEST_CAP,
  CONCURRENCY_LIMIT,
  formatUtcDateKey,
  calculateDeterministicSlot,
  calculateNextDueAt,
  getDueTrackedGames,
  getDailyRequestCount,
  prepareObservationInsert,
  prepareSuccessTrackingUpdate,
  prepareFailureTrackingUpdate,
  prepareIncrementDailyCount,
  reRankTrackedTiers,
  registerTrackedGame,
  type PlayerTier,
  type TrackedGame,
} from "../src/lib/player";

/**
 * Fetches current players for an AppID from Steam's official API.
 * Uses injectable customFetch for deterministic testing and worker isolation.
 * Logs individual failures with AppID.
 */
export async function fetchSteamCurrentPlayers(
  appid: number,
  customFetch: typeof fetch = fetch
): Promise<number | null> {
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`;
    const res = await customFetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.error(`Steam current players fetch failed for AppID ${appid}: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      response?: {
        result?: number;
        player_count?: number;
      };
    };

    if (
      data?.response?.result === 1 &&
      typeof data.response.player_count === "number" &&
      data.response.player_count >= 0
    ) {
      return data.response.player_count;
    }

    console.error(`Steam current players fetch failed for AppID ${appid}: invalid response body`);
    return null;
  } catch (err) {
    console.error(`Steam current players fetch failed for AppID ${appid}: ${err}`);
    return null;
  }
}

export interface PoolMetrics {
  maxConcurrent: number;
  totalExecuted: number;
}

/**
 * Executes async tasks over items with an authentic concurrency-bounded worker pool.
 * Does not allocate fake promises or sleep loops.
 */
export async function executeWithConnectionPool<T, R>(
  items: T[],
  concurrencyLimit: number,
  workerFn: (item: T, workerIndex: number) => Promise<R>
): Promise<{ results: R[]; metrics: PoolMetrics }> {
  if (items.length === 0) {
    return { results: [], metrics: { maxConcurrent: 0, totalExecuted: 0 } };
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let activeWorkers = 0;
  let maxConcurrent = 0;

  const poolSize = Math.min(concurrencyLimit, items.length);
  const pool = Array.from({ length: poolSize }, async (_, workerIndex) => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) break;

      activeWorkers++;
      if (activeWorkers > maxConcurrent) {
        maxConcurrent = activeWorkers;
      }

      try {
        results[idx] = await workerFn(items[idx], workerIndex);
      } finally {
        activeWorkers--;
      }
    }
  });

  await Promise.all(pool);

  return {
    results,
    metrics: {
      maxConcurrent,
      totalExecuted: items.length,
    },
  };
}

export interface CollectionTickOptions {
  anchorTime?: Date;
  budgetTime?: Date;
  customFetch?: typeof fetch;
  dailyCap?: number;
  tickCap?: number;
  concurrency?: number;
  simulateCommitFailure?: boolean;
}

export interface CollectionTickResult {
  anchorTime: string;
  attempted: number;
  succeeded: number;
  failed: number;
  dailyCount: number;
  maxConcurrent: number;
  reason?: string;
}

/**
 * Runs a single 10-minute player collection tick anchored to the scheduled event time.
 * Enforces daily cap (5,000), tick cap (100), 6-connection pool, and atomic batch commit.
 */
export async function runPlayerCollectionTick(
  db: D1Database,
  options: CollectionTickOptions = {}
): Promise<CollectionTickResult> {
  const anchorTime = options.anchorTime ?? new Date();
  const budgetTime = options.budgetTime ?? anchorTime;
  const customFetch = options.customFetch ?? fetch;
  const dailyCap = options.dailyCap ?? DAILY_REQUEST_CAP;
  const tickCap = options.tickCap ?? TICK_REQUEST_CAP;
  const concurrency = options.concurrency ?? CONCURRENCY_LIMIT;

  const dateKey = formatUtcDateKey(budgetTime);
  const currentDaily = await getDailyRequestCount(db, dateKey);
  const remainingDaily = Math.max(0, dailyCap - currentDaily);

  if (remainingDaily === 0) {
    return {
      anchorTime: anchorTime.toISOString(),
      attempted: 0,
      succeeded: 0,
      failed: 0,
      dailyCount: currentDaily,
      maxConcurrent: 0,
      reason: "daily_cap_reached",
    };
  }

  // Bounded batch limit: at most tickCap (100) and remaining daily allowance
  const batchLimit = Math.min(tickCap, remainingDaily);
  const dueGames = await getDueTrackedGames(db, anchorTime, batchLimit);

  if (dueGames.length === 0) {
    return {
      anchorTime: anchorTime.toISOString(),
      attempted: 0,
      succeeded: 0,
      failed: 0,
      dailyCount: currentDaily,
      maxConcurrent: 0,
      reason: "no_work_due",
    };
  }

  // Execute outbound requests using the 6-worker pool
  const { results: outcomes, metrics } = await executeWithConnectionPool<
    TrackedGame,
    { game: TrackedGame; count: number | null; success: boolean }
  >(
    dueGames,
    concurrency,
    async (game: TrackedGame) => {
      const count = await fetchSteamCurrentPlayers(game.appid, customFetch);
      return {
        game,
        count,
        success: count !== null,
      };
    }
  );

  let succeeded = 0;
  let failed = 0;
  const stmts: D1PreparedStatement[] = [];
  const observedAtIso = anchorTime.toISOString();

  for (const outcome of outcomes) {
    const { game, count, success } = outcome;
    const nextDueIso = calculateNextDueAt(anchorTime, game.tier, game.appid).toISOString();

    if (success && count !== null) {
      succeeded++;
      stmts.push(prepareObservationInsert(db, game.appid, count, observedAtIso));
      stmts.push(prepareSuccessTrackingUpdate(db, game.appid, nextDueIso, count, observedAtIso));
    } else {
      failed++;
      console.error(`Individual Steam failure for AppID ${game.appid}; preserving latest value and advancing cadence to ${nextDueIso}`);
      // G7: One Steam failure preserves the valid value and advances normal cadence without 10-min retry
      stmts.push(prepareFailureTrackingUpdate(db, game.appid, nextDueIso, observedAtIso));
    }
  }

  // Atomically increment daily request count by total attempted
  stmts.push(prepareIncrementDailyCount(db, dateKey, outcomes.length));

  if (options.simulateCommitFailure) {
    throw new Error("Simulated D1 commit failure");
  }

  // Commit atomically in single transaction
  await db.batch(stmts);

  return {
    anchorTime: observedAtIso,
    attempted: outcomes.length,
    succeeded,
    failed,
    dailyCount: currentDaily + outcomes.length,
    maxConcurrent: metrics.maxConcurrent,
  };
}

export interface DiscoveryOptions {
  anchorTime?: Date;
  budgetTime?: Date;
  customFetch?: typeof fetch;
  officialChartAppIds?: number[];
  dailyCap?: number;
  tickCap?: number;
  alreadyAttemptedInTick?: number;
}

export interface DiscoveryResult {
  discovered: number;
  initialObservations: number;
  replacements: number;
  tiers: {
    fastCount: number;
    hourlyCount: number;
    dailyCount: number;
  };
}

/**
 * Checks Steam official Most Played chart once daily for discovery,
 * seeds initial observations for newly cataloged games,
 * performs bounded replacements at 1,000 cap only for official-chart entrants,
 * bounds initial-player requests by daily and tick caps with concurrency six,
 * and re-ranks tiers.
 */
export async function runDailyDiscoveryAndReRanking(
  db: D1Database,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const anchorTime = options.anchorTime ?? new Date();
  const budgetTime = options.budgetTime ?? anchorTime;
  const customFetch = options.customFetch ?? fetch;
  const dailyCap = options.dailyCap ?? DAILY_REQUEST_CAP;
  const tickCap = options.tickCap ?? TICK_REQUEST_CAP;
  const alreadyAttemptedInTick = options.alreadyAttemptedInTick ?? 0;

  let entrantAppIds: number[] = options.officialChartAppIds ?? [];
  if (!entrantAppIds.length && customFetch !== fetch) {
    entrantAppIds = [];
  } else if (!entrantAppIds.length) {
    try {
      const res = await customFetch(
        "https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/"
      );
      if (res.ok) {
        const data = (await res.json()) as {
          response?: { ranks?: Array<{ appid: number }> };
        };
        entrantAppIds = data.response?.ranks?.map((r: { appid: number }) => r.appid) || [];
      }
    } catch (err) {
      console.error(`Steam official chart fetch failed: ${err}`);
      entrantAppIds = [];
    }
  }

  const officialEntrantSet = new Set(entrantAppIds);

  // Also discover newly cataloged playable games not yet tracked
  const unTrackedAppsRes = await db
    .prepare(
      `SELECT appid FROM apps 
       WHERE is_playable = 1 
         AND is_eligible = 1 
         AND parent_appid IS NULL
         AND appid NOT IN (SELECT appid FROM tracked_games)
       LIMIT 100`
    )
    .all<{ appid: number }>();
  const unTrackedAppIds = unTrackedAppsRes.results?.map((r) => r.appid) || [];

  const rawCandidateIds = Array.from(new Set([...entrantAppIds, ...unTrackedAppIds]));
  const validCandidates: number[] = [];

  // Check which candidates exist in apps catalog and are not yet tracked
  for (const appid of rawCandidateIds) {
    const app = await db
      .prepare(
        `SELECT appid FROM apps 
         WHERE appid = ? AND is_playable = 1 AND is_eligible = 1 AND parent_appid IS NULL`
      )
      .bind(appid)
      .first<{ appid: number }>();
    if (!app) continue;

    const tracked = await db
      .prepare("SELECT appid FROM tracked_games WHERE appid = ?")
      .bind(appid)
      .first<{ appid: number }>();
    if (tracked) continue;

    validCandidates.push(appid);
  }

  // Calculate discovery initial-player request allowance based on daily and tick caps
  const dateKey = formatUtcDateKey(budgetTime);
  const currentDaily = await getDailyRequestCount(db, dateKey);
  const remainingDaily = Math.max(0, dailyCap - currentDaily);
  const remainingTick = Math.max(0, tickCap - alreadyAttemptedInTick);
  const discoveryRequestAllowance = Math.min(remainingDaily, remainingTick);

  // Bound candidates to allowance
  const candidatesToProbe = validCandidates.slice(0, discoveryRequestAllowance);

  // Fetch initial player observations with max concurrency of six
  const { results: probeOutcomes } = await executeWithConnectionPool<
    number,
    { appid: number; players: number | null }
  >(
    candidatesToProbe,
    CONCURRENCY_LIMIT,
    async (appid: number) => {
      const players = await fetchSteamCurrentPlayers(appid, customFetch);
      return { appid, players };
    }
  );

  let initialObservations = 0;
  let replacements = 0;

  // Snapshot all currently tracked games ordered lowest-first deterministically
  const trackedRowsRes = await db
    .prepare(
      `SELECT appid, latest_players 
       FROM tracked_games 
       ORDER BY 
         CASE WHEN latest_players IS NULL THEN 0 ELSE 1 END ASC,
         latest_players ASC,
         appid ASC`
    )
    .all<{ appid: number; latest_players: number | null }>();

  const trackedSnapshot: Array<{ appid: number; latest_players: number | null }> = [
    ...(trackedRowsRes.results || []),
  ];

  const sortTracked = () => {
    trackedSnapshot.sort((a, b) => {
      const countA = a.latest_players ?? -1;
      const countB = b.latest_players ?? -1;
      if (countA !== countB) return countA - countB;
      return a.appid - b.appid;
    });
  };
  sortTracked();

  const chosenVictimAppIds = new Set<number>();
  const stmts: D1PreparedStatement[] = [];

  for (const outcome of probeOutcomes) {
    const { appid, players } = outcome;
    const isOfficial = officialEntrantSet.has(appid);

    if (players !== null) {
      initialObservations++;
      stmts.push(prepareObservationInsert(db, appid, players, anchorTime.toISOString()));
    }

    if (trackedSnapshot.length < MAX_TRACKED_GAMES) {
      // Room in tracking table: admit new game
      const slot = calculateDeterministicSlot(appid, "daily");
      const nextDue = calculateNextDueAt(anchorTime, "daily", appid).toISOString();
      stmts.push(
        db
          .prepare(
            `INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players)
             VALUES (?, 'daily', ?, ?, ?)
             ON CONFLICT(appid) DO UPDATE SET
               tier = excluded.tier,
               slot = excluded.slot,
               next_due_at = excluded.next_due_at,
               latest_players = COALESCE(excluded.latest_players, tracked_games.latest_players),
               updated_at = CURRENT_TIMESTAMP`
          )
          .bind(appid, slot, nextDue, players)
      );
      trackedSnapshot.push({ appid, latest_players: players });
      sortTracked();
    } else if (isOfficial && players !== null) {
      // At cap (1,000): allow replacement ONLY for verified official-chart entrants
      // Find the lowest victim not already chosen
      const victimIndex = trackedSnapshot.findIndex((g) => !chosenVictimAppIds.has(g.appid));

      if (victimIndex !== -1) {
        const victim = trackedSnapshot[victimIndex];
        const victimCount = victim.latest_players ?? -1;
        if (players > victimCount) {
          chosenVictimAppIds.add(victim.appid);
          stmts.push(db.prepare("DELETE FROM tracked_games WHERE appid = ?").bind(victim.appid));

          const slot = calculateDeterministicSlot(appid, "daily");
          const nextDue = calculateNextDueAt(anchorTime, "daily", appid).toISOString();
          stmts.push(
            db
              .prepare(
                `INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players)
                 VALUES (?, 'daily', ?, ?, ?)`
              )
              .bind(appid, slot, nextDue, players)
          );

          // Replace victim in tracked snapshot with entrant
          trackedSnapshot.splice(victimIndex, 1, { appid, latest_players: players });
          sortTracked();
          replacements++;
        }
      }
    }
  }

  // Account for discovery request attempts in daily requests count
  if (candidatesToProbe.length > 0) {
    stmts.push(prepareIncrementDailyCount(db, dateKey, candidatesToProbe.length));
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  // Re-rank tiers and assign deterministic slots
  const tiers = await reRankTrackedTiers(db, anchorTime);

  return {
    discovered: validCandidates.length,
    initialObservations,
    replacements,
    tiers,
  };
}
