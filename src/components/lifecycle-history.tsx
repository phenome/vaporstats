import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LifecycleHistory } from "../lib/lifecycle-history";

interface LifecycleHistoryResponse {
  status?: string;
  data?: LifecycleHistory;
}

export async function fetchLifecycleHistory(appid: number): Promise<LifecycleHistory> {
  const response = await fetch(`/api/games/${appid}/lifecycle`);
  if (!response.ok) {
    throw new Error(`Failed to load release history for ${appid}`);
  }
  const result = (await response.json()) as LifecycleHistoryResponse;
  if (result.status !== "ok" || !result.data) {
    throw new Error(`Failed to load release history for ${appid}`);
  }
  return result.data;
}

export function lifecycleHistoryQueryOptions(appid: number) {
  return {
    queryKey: ["lifecycle-history", appid],
    queryFn: () => fetchLifecycleHistory(appid),
  };
}

export function LifecycleHistorySection({ appid }: { appid: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <details
      className="border border-zinc-800 bg-zinc-950 font-mono"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer px-4 py-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500">
        Release history
      </summary>
      {expanded && <LifecycleHistoryQuery appid={appid} enabled={expanded} />}
    </details>
  );
}

function LifecycleHistoryQuery({ appid, enabled }: { appid: number; enabled: boolean }) {
  const { data, isLoading, isError, refetch } = useQuery({
    ...lifecycleHistoryQueryOptions(appid),
    enabled,
  });

  return (
    <div className="border-t border-zinc-800 px-4 py-4 text-xs">
      {isLoading && (
        <div role="status" aria-live="polite" className="text-zinc-400">
          Loading release history…
        </div>
      )}
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-zinc-400">
          <span>Unable to load release history.</span>
          <button
            type="button"
            className="border border-zinc-700 px-2 py-1 text-zinc-200 hover:border-orange-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            onClick={() => void refetch()}
          >
            Retry
          </button>
        </div>
      )}
      {data && <LifecycleHistoryContent history={data} />}
    </div>
  );
}

function LifecycleHistoryContent({ history }: { history: LifecycleHistory }) {
  return (
    <div className="space-y-5">
      <p className="text-zinc-500">
        Confirmed events are shown separately from retained release-plan observations. Plans describe what was expected at the time, not completed milestones.
      </p>

      <section aria-labelledby="confirmed-lifecycle-events">
        <h3 id="confirmed-lifecycle-events" className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">
          Confirmed events
        </h3>
        {history.events.length > 0 ? (
          <table className="w-full border-collapse text-xs">
            <tbody>
              {history.events.map((event, index) => (
                <tr key={`${event.event_type}-${event.event_date ?? "undated"}-${event.source}-${index}`} className="align-middle">
                  <td className="py-1 text-left align-middle">
                    <span className="inline-block border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-300">
                      {formatEventLabel(event.event_type)}
                    </span>
                  </td>
                  <td className="py-1 text-right align-middle text-zinc-400">
                    {event.event_date ? (
                      isPreciseLifecycleDate(event.event_date) ? (
                        <time dateTime={event.event_date}>{formatLifecycleDate(event.event_date)}</time>
                      ) : (
                        <span>{formatLifecycleDate(event.event_date)}</span>
                      )
                    ) : (
                      <span>
                        {event.event_type === "full_release" || event.event_type === "early_access_exit"
                          ? "Transition date unconfirmed"
                          : "Date unconfirmed"}
                      </span>
                    )}
                    <span className="ml-2 text-zinc-600">Source: {formatEventSource(event.source)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-zinc-500">No confirmed release events recorded.</p>
        )}
      </section>

      <section aria-labelledby="release-plan-observations">
        <h3 id="release-plan-observations" className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">
          Release-plan observations
        </h3>
        {history.plans.length > 0 ? (
          <table className="w-full border-collapse text-xs">
            <tbody>
              {history.plans.map((plan, index) => (
                <tr key={`${plan.expected_date}-${plan.observed_at}-${index}`} className="align-middle">
                  <td className="py-1 text-left align-middle">
                    <span className="inline-block border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-300">
                      Expected release
                    </span>
                  </td>
                  <td className="py-1 text-right align-middle text-zinc-400">
                    {isPreciseLifecycleDate(plan.expected_date) ? (
                      <time dateTime={plan.expected_date}>{formatLifecycleDate(plan.expected_date)}</time>
                    ) : (
                      <span>{formatLifecycleDate(plan.expected_date)}</span>
                    )}
                    <span className="ml-2 text-zinc-600">
                      Observed {observationDateTimeValue(plan.observed_at) ? (
                        <time dateTime={observationDateTimeValue(plan.observed_at)}>{formatObservationTimestamp(plan.observed_at)}</time>
                      ) : (
                        formatObservationTimestamp(plan.observed_at)
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-zinc-500">No release-plan observations recorded.</p>
        )}
      </section>
    </div>
  );
}

function formatEventLabel(eventType: string): string {
  switch (eventType) {
    case "early_access":
      return "Entered Early Access";
    case "full_release":
    case "early_access_exit":
      return "Left Early Access";
    case "steam_availability":
      return "Available on Steam";
    case "version_1_0":
      return "Version 1.0";
    case "patch":
      return "Patch";
    case "release":
      return "Released";
    default:
      return eventType.replaceAll("_", " ");
  }
}

function formatEventSource(source: string): string {
  return source === "has_left_early_access" ? "Steam store description" : "Steam release metadata";
}
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const sqliteTimestampPattern =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function isValidDateOnly(value: string): boolean {
  if (!dateOnlyPattern.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value + "T");
}

function parseLifecycleTimestamp(value: string): Date | null {
  const timestamp = timestampPattern.test(value)
    ? value
    : sqliteTimestampPattern.test(value)
      ? value.replace(" ", "T") + "Z"
      : null;
  if (!timestamp || !isValidDateOnly(value.slice(0, 10))) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLifecycleDate(value: string): { date: Date; dateOnly: boolean } | null {
  if (isValidDateOnly(value)) return { date: new Date(value + "T00:00:00Z"), dateOnly: true };
  const date = parseLifecycleTimestamp(value);
  return date ? { date, dateOnly: false } : null;
}

function isPreciseLifecycleDate(value: string): boolean {
  return parseLifecycleDate(value) !== null;
}

function formatLifecycleDate(value: string): string {
  const parsed = parseLifecycleDate(value);
  if (!parsed) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: parsed.dateOnly ? "UTC" : "America/Los_Angeles",
  }).format(parsed.date);
}

function formatObservationTimestamp(value: string): string {
  const date = parseLifecycleTimestamp(value);
  if (!date) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function observationDateTimeValue(value: string): string | undefined {
  if (timestampPattern.test(value) && parseLifecycleTimestamp(value)) return value;
  if (sqliteTimestampPattern.test(value) && parseLifecycleTimestamp(value)) return value.replace(" ", "T") + "Z";
  return undefined;
}
