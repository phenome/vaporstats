import React, { useState, useEffect, useRef, useCallback } from "react";

export interface PlayerOverview {
  appid: number;
  latest_players: number | null;
  observed_at: string | null;
}

export type PlayerPanelStatus = "pending" | "success" | "error";

export interface UsePlayerOverviewOptions {
  initialData?: PlayerOverview | null;
  customFetch?: typeof fetch;
  staleThresholdMs?: number;
}

export const DEFAULT_STALE_THRESHOLD_MS = 300_000; // 5 minutes matching CDN s-maxage

export type RefreshTrigger = "navigation" | "focus";

/**
 * Pure decision helper governing client refresh policy:
 * - Navigation: always triggers a fetch (returns true).
 * - Focus / visibility: triggers a fetch only when elapsed ageMs >= staleThresholdMs.
 */
export function shouldRefreshOverview(
  trigger: RefreshTrigger,
  ageMs: number,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS
): boolean {
  if (trigger === "navigation") {
    return true;
  }
  return ageMs >= staleThresholdMs;
}

/**
 * Client hook enforcing navigation and stale-focus refresh policy without interval polling.
 */
export function usePlayerOverview(
  appid: number,
  options: UsePlayerOverviewOptions = {}
) {
  const customFetch = options.customFetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  const [data, setData] = useState<PlayerOverview | null>(
    options.initialData !== undefined ? options.initialData : null
  );
  const [status, setStatus] = useState<PlayerPanelStatus>(
    options.initialData !== undefined ? "success" : "pending"
  );

  const lastFetchedAtRef = useRef<number>(options.initialData !== undefined ? Date.now() : 0);
  const fetchCountRef = useRef<number>(0);

  const loadOverview = useCallback(
    async (trigger: RefreshTrigger = "navigation") => {
      if (!customFetch) return;

      const age = Date.now() - lastFetchedAtRef.current;
      if (!shouldRefreshOverview(trigger, age, staleThresholdMs)) {
        // Data is still fresh; do not refetch on focus
        return;
      }

      fetchCountRef.current++;
      try {
        const res = await customFetch(`/api/games/${appid}/overview`);
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as PlayerOverview;
        setData(json);
        setStatus("success");
        lastFetchedAtRef.current = Date.now();
      } catch {
        setStatus("error");
      }
    },
    [appid, customFetch, staleThresholdMs]
  );

  // Fetch on navigation (mount or appid change); retain SSR initial display if present
  useEffect(() => {
    if (options.initialData && options.initialData.appid === appid) {
      setData(options.initialData);
      setStatus("success");
    } else {
      setStatus("pending");
      setData(null);
    }
    loadOverview("navigation");
  }, [appid, loadOverview]);

  // Stale-focus policy without interval polling
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleFocus = () => {
      loadOverview("focus");
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadOverview("focus");
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadOverview]);

  return {
    data,
    status,
    refetch: () => loadOverview("navigation"),
    fetchCount: fetchCountRef.current,
  };
}

export interface PlayerPanelProps {
  appid: number;
  initialData?: PlayerOverview | null;
  customFetch?: typeof fetch;
  staleThresholdMs?: number;
}

/**
 * Renders current player activity deck with Lyra zero-radius styling.
 * Displays Loading while pending, No data yet on successful empty,
 * and Live data unavailable on request failure.
 */
export function PlayerPanel({
  appid,
  initialData,
  customFetch,
  staleThresholdMs,
}: PlayerPanelProps) {
  const { data, status } = usePlayerOverview(appid, {
    initialData,
    customFetch,
    staleThresholdMs,
  });

  return (
    <div key={appid} className="border border-zinc-800 bg-zinc-950 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
          Current Players
        </span>
        <span className="w-2 h-2 rounded-none bg-orange-500 inline-block"></span>
      </div>

      <div className="pt-2">
        {status === "pending" && (
          <div className="space-y-1" data-testid="player-panel-loading">
            <div className="text-xl font-mono text-zinc-500 tracking-tight">
              Loading
            </div>
            <p className="text-[11px] text-zinc-600 font-mono">
              Retrieving live player activity.
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-1" data-testid="player-panel-error">
            <div className="text-xl font-mono text-amber-500/80 tracking-tight">
              Live data unavailable
            </div>
            <p className="text-[11px] text-zinc-500 font-mono">
              Unable to retrieve current player count.
            </p>
          </div>
        )}

        {status === "success" && data?.latest_players === null && (
          <div className="space-y-1" data-testid="no-data-state">
            <div className="text-xl font-mono text-zinc-400 tracking-tight">
              No data yet
            </div>
            <p className="text-[11px] text-zinc-500 font-mono">
              Awaiting first scheduled observation probe.
            </p>
          </div>
        )}

        {status === "success" &&
          data?.latest_players !== null &&
          data?.latest_players !== undefined && (
            <div className="space-y-1" data-testid="player-panel-data">
              <div className="text-3xl font-mono font-bold text-zinc-100 tabular-nums">
                {data.latest_players.toLocaleString("en-US")}
              </div>
              {data.observed_at && (
                <p className="text-[11px] text-zinc-500 font-mono">
                  {`Observed: ${data.observed_at} UTC`}
                </p>
              )}
            </div>
          )}
      </div>
    </div>
  );
}
