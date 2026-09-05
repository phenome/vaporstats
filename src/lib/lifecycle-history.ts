import type { AppDatabase } from "./db";

export interface LifecycleHistoryEvent {
  event_type: string;
  event_date: string | null;
  source: string;
}

export interface LifecycleHistoryPlan {
  expected_date: string;
  observed_at: string;
}

export interface LifecycleHistory {
  events: LifecycleHistoryEvent[];
  plans: LifecycleHistoryPlan[];
}

interface LifecycleAppRow {
  release_status: string;
  release_date: string | null;
  release_date_source: string | null;
  steam_release_date: string | null;
  original_release_date: string | null;
  original_steam_release_date: string | null;
  release_from_early_access_date: string | null;
  is_early_access: number | boolean | null;
  has_left_early_access: number | boolean | null;
}

interface StoredLifecycleEvent {
  event_type: string;
  event_date: string;
  source: string;
}

interface StoredLifecyclePlan {
  expected_date: string;
  observed_at: string;
}

/**
 * Returns the complete lifecycle history for one catalog app.
 * Dated release facts are projected from the current catalog row and supported
 * event records; release plans remain observations and are never promoted to events.
 */
export async function getLifecycleHistory(
  db: AppDatabase,
  appid: number,
): Promise<LifecycleHistory> {
  const app = await db
    .prepare(
      `SELECT release_status, release_date, release_date_source,
              steam_release_date, original_release_date,
              original_steam_release_date, release_from_early_access_date,
              is_early_access, has_left_early_access
       FROM apps
       WHERE appid = ?`
    )
    .bind(appid)
    .first<LifecycleAppRow>();

  if (!app) return { events: [], plans: [] };

  const events: LifecycleHistoryEvent[] = [];
  const seen = new Set<string>();
  const addEvent = (
    event_type: string,
    event_date: string | null,
    source: string,
  ): void => {
    const key = `${event_type}\u0000${event_date ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ event_type, event_date, source });
  };

  const earlyAccessDate = app.original_steam_release_date;
  const fullReleaseDate = app.release_from_early_access_date;
  const hasEarlyAccessEvidence =
    (app.is_early_access === true || app.is_early_access === 1) ||
    (app.has_left_early_access === true || app.has_left_early_access === 1) ||
    fullReleaseDate !== null;

  const storedEvents = await db
    .prepare(
      `SELECT event_type, event_date, source
       FROM app_release_events
       WHERE appid = ?
       ORDER BY event_date ASC, event_type ASC`
    )
    .bind(appid)
    .all<StoredLifecycleEvent>();

  for (const event of storedEvents.results ?? []) {
    if (
      event.event_type === "full_release" &&
      event.source !== "release_from_early_access_date"
    ) {
      continue;
    }
    if (
      event.event_type === "early_access" &&
      !hasEarlyAccessEvidence
    ) {
      continue;
    }
    addEvent(event.event_type, event.event_date, event.source);
  }

  if (earlyAccessDate && hasEarlyAccessEvidence) {
    addEvent("early_access", earlyAccessDate, "original_steam_release_date");
  }
  if (fullReleaseDate) {
    addEvent(
      "full_release",
      fullReleaseDate,
      "release_from_early_access_date",
    );
  }
  if (
    (app.has_left_early_access === true || app.has_left_early_access === 1) &&
    !fullReleaseDate
  ) {
    addEvent("early_access_exit", null, "has_left_early_access");
  }

  if (app.release_status === "released") {
    const mainReleaseDate =
      app.original_release_date ??
      app.steam_release_date ??
      (app.release_date_source === "appdetails" ? app.release_date : null);
    const mainReleaseSource =
      app.original_release_date
        ? "original_release_date"
        : app.steam_release_date
          ? "steam_release_date"
          : app.release_date_source === "appdetails"
            ? "appdetails"
            : null;
    if (mainReleaseDate && mainReleaseSource) {
      addEvent("release", mainReleaseDate, mainReleaseSource);
    }

    const steamAvailabilityDate =
      app.original_steam_release_date ?? app.steam_release_date;
    if (steamAvailabilityDate) {
      addEvent(
        "steam_availability",
        steamAvailabilityDate,
        app.original_steam_release_date
          ? "original_steam_release_date"
          : "steam_release_date",
      );
    }
  }

  events.sort((left, right) => {
    if (left.event_date === right.event_date) {
      return left.event_type.localeCompare(right.event_type);
    }
    if (left.event_date === null) return 1;
    if (right.event_date === null) return -1;
    return left.event_date.localeCompare(right.event_date);
  });

  const planResult = await db
    .prepare(
      `SELECT expected_date, observed_at
       FROM app_release_plans
       WHERE appid = ?
       ORDER BY observed_at ASC, id ASC`
    )
    .bind(appid)
    .all<StoredLifecyclePlan>();

  return {
    events,
    plans: planResult.results ?? [],
  };
}
