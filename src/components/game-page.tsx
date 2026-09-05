import type { GameDetail, GameReleaseEvent } from "../lib/catalog";
import type { GroupedRelatedApps } from "../lib/related";
import type { PlayerHistoryResult } from "../lib/player-history";
import {
  type PriceState,
  type PriceHistoryResult,
  formatPriceCents,
  formatPriceUtc,
} from "../lib/prices";
import { getCanonicalPublisherPath } from "../lib/slug";
import { PlayerPanel } from "./player-panel";
import { PlayerHistoryChart } from "./player-history";
import { PriceHistoryChart } from "./price-history";
import { RelatedApps } from "./related-apps";

export interface GamePageProps {
  game: GameDetail;
  related?: GroupedRelatedApps;
  playerHistory?: PlayerHistoryResult;
  price?: PriceState | null;
  priceHistory?: PriceHistoryResult | null;
}

export function GamePageView({
  game,
  related,
  playerHistory,
  price,
  priceHistory,
}: GamePageProps) {
  const lifecycleEvents = getLifecycleEvents(game);
  const primaryEvent = lifecycleEvents.find((event) => event.primary);
  const secondaryEvents = lifecycleEvents.filter((event) => !event.primary);
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Top Banner / Breadcrumb & Header */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 pb-3">
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 bg-orange-500/10 text-orange-400 border border-orange-500/30 text-[10px] font-mono uppercase tracking-widest">
              {game.type}
            </span>
            {primaryEvent && <LifecycleSummary event={primaryEvent} />}
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <a
              href={`https://store.steampowered.com/app/${game.appid}/`}
              target="_blank"
              rel="noreferrer"
              className="text-orange-400 hover:text-orange-300 hover:underline inline-flex items-center gap-1"
            >
              Steam Store ↗
            </a>
          </div>
        </div>


        <div className="flex flex-col md:flex-row gap-6 items-start">
          {game.header_image ? (
            <img
              src={game.header_image}
              alt={game.name}
              className="w-full md:w-80 border border-zinc-800 object-cover aspect-[460/215]"
            />
          ) : (
            <div className="w-full md:w-80 h-36 bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600 font-mono text-xs">
              NO IMAGE AVAILABLE
            </div>
          )}

          <div className="flex-1">
            <div className="flow-root space-y-3">
              {secondaryEvents.length > 0 && <LifecycleTable events={secondaryEvents} />}
              <h1 className="text-2xl md:text-3xl font-mono font-bold text-zinc-100 tracking-tight">
                {game.name}
              </h1>
              {game.description && (
                <p className="text-sm text-zinc-400 leading-relaxed font-sans">
                  {game.description}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2 text-xs font-mono">
              <div className="border border-zinc-900 bg-zinc-900/40 p-2.5">
                <div className="text-zinc-500 text-[10px] uppercase">Developer</div>
                <div className="text-zinc-200 font-medium truncate">
                  {game.developer ? (
                    <a
                      href={getCanonicalPublisherPath(game.developer)}
                      className="hover:text-orange-400 hover:underline transition-colors"
                    >
                      {game.developer}
                    </a>
                  ) : (
                    "Unknown"
                  )}
                </div>
              </div>
              <div className="border border-zinc-900 bg-zinc-900/40 p-2.5">
                <div className="text-zinc-500 text-[10px] uppercase">Publisher</div>
                <div className="text-zinc-200 font-medium truncate">
                  {game.publisher ? (
                    <a
                      href={getCanonicalPublisherPath(game.publisher)}
                      className="hover:text-orange-400 hover:underline transition-colors"
                    >
                      {game.publisher}
                    </a>
                  ) : (
                    "Unknown"
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <nav
        aria-label="Game page sections"
        className="flex min-h-[44px] items-center overflow-x-auto border border-zinc-800 bg-zinc-950 px-1 font-mono"
      >
        <a href="#activity" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Activity
        </a>
        <a href="#player-history" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Player History
        </a>
        <a href="#price-history" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Price History
        </a>
        {related && (
          <a href="#related-content" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
            Related Content
          </a>
        )}
      </nav>

      {/* Metrics Deck: Activity */}
      <div id="activity" className="grid scroll-mt-28 grid-cols-1 gap-4 md:grid-cols-3">
        {/* Current Players Metric Panel */}
        <PlayerPanel
          key={game.appid}
          appid={game.appid}
          initialData={{
            appid: game.appid,
            latest_players: game.latest_players,
            observed_at: game.last_observed_at,
            current_price: price ?? null,
          }}
        />
      </div>

      <section id="player-history" className="scroll-mt-28">
      {/* Player History Chart Deck (Default 30d) */}
      <PlayerHistoryChart
        key={game.appid}
        appid={game.appid}
        initialRange="30d"
        initialData={playerHistory}
      />
      </section>

      <section id="price-history" className="scroll-mt-28">
      {/* Price History Chart Deck (Default All) */}
      <PriceHistoryChart
        key={`price-${game.appid}`}
        appid={game.appid}
        initialRange="all"
        initialData={priceHistory ?? undefined}
      />
      </section>
      {/* Related Content Deck */}
      {related && (
        <section id="related-content" className="scroll-mt-28">
          <RelatedApps parent={game} grouped={related} />
        </section>
      )}
    </div>
  );
}

type LifecycleEventKind = "release" | "ea" | "one-dot-zero" | "patch";

interface LifecycleDisplayEvent {
  kind: LifecycleEventKind;
  label: string;
  date: string;
  dateTime: string;
  primary?: boolean;
}

const lifecycleEventClasses: Record<LifecycleEventKind, string> = {
  release: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  ea: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "one-dot-zero": "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  patch: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

function getLifecycleEvents(game: GameDetail): LifecycleDisplayEvent[] {
  const events: LifecycleDisplayEvent[] = [];
  const seen = new Set<string>();
  const storedEvents = game.release_events ?? [];
  const hasEarlyAccess = storedEvents.some((event) => event.event_type === "early_access") || Boolean(game.original_steam_release_date);

  const addEvent = (kind: LifecycleEventKind, label: string, dateTime: string | null) => {
    if (!dateTime) return;
    const key = kind + ":" + dateTime;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ kind, label, date: formatReleaseDate(dateTime), dateTime });
  };

  for (const event of storedEvents) {
    if (event.event_type === "early_access") {
      addEvent("ea", "Early Access", event.event_date);
    } else if (event.event_type === "full_release") {
      addEvent(
        hasEarlyAccess ? "one-dot-zero" : "release",
        hasEarlyAccess ? "Version 1.0" : "Released",
        event.event_date,
      );
    } else {
      addEvent("patch", "Latest patch", event.event_date);
    }
  }

  if (game.original_steam_release_date && !events.some((event) => event.kind === "ea")) {
    addEvent("ea", "Early Access", game.original_steam_release_date);
  }
  if (game.release_from_early_access_date && !events.some((event) => event.kind === "one-dot-zero")) {
    addEvent("one-dot-zero", "Version 1.0", game.release_from_early_access_date);
  }
  if (!events.some((event) => event.kind === "ea" || event.kind === "one-dot-zero" || event.kind === "release")) {
    addEvent("release", "Released", game.original_release_date ?? game.release_date);
  }

  if (game.is_early_access && !events.some((event) => event.kind === "ea")) {
    addEvent("ea", "Early Access", game.release_date);
  }

  if (!events.some((event) => event.kind === "release" || event.kind === "one-dot-zero")) {
    addEvent("release", "Released", game.release_date);
  }

  if (
    game.steam_release_date &&
    !events.some((event) => event.dateTime === game.steam_release_date)
  ) {
    addEvent("release", "Steam release", game.steam_release_date);
  }

  const hasOneDotZero = events.some((event) => event.kind === "one-dot-zero");
  const primary = game.is_early_access
    ? events.find((event) => event.kind === "ea")
    : hasOneDotZero
      ? events.find((event) => event.kind === "one-dot-zero")
      : events.find((event) => event.kind === "release" && event.dateTime === game.release_date) ??
        events.find((event) => event.kind === "release") ??
        events.find((event) => event.kind === "ea");

  return events
    .map((event) => (event === primary ? { ...event, primary: true } : event))
    .sort((left, right) => releaseDateValue(right.dateTime) - releaseDateValue(left.dateTime));
}

function formatReleaseDate(value: string): string {
  const date = new Date(toUtcDate(value));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function toUtcDate(value: string): string {
  return value.includes("T") ? value : value + "T00:00:00Z";
}

function releaseDateValue(value: string): number {
  return Date.parse(toUtcDate(value));
}

function LifecycleSummary({ event }: { event: LifecycleDisplayEvent }) {
  return (
    <div className="inline-flex items-center gap-2 text-xs font-mono">
      <LifecycleBadge event={event} prominent />
      <time dateTime={event.dateTime} className="text-zinc-200">
        {event.date}
      </time>
    </div>
  );
}

function LifecycleBadge({
  event,
  prominent = false,
}: {
  event: LifecycleDisplayEvent;
  prominent?: boolean;
}) {
  return (
    <span
      className={
        prominent
          ? "border py-0.5 font-bold uppercase px-2 text-[10px] font-mono leading-[15px] tracking-widest " + lifecycleEventClasses[event.kind]
          : "border py-0.5 font-bold uppercase px-1.5 text-[9px] tracking-wider " + lifecycleEventClasses[event.kind]
      }
    >
      {event.label}
    </span>
  );
}

function LifecycleTable({ events }: { events: LifecycleDisplayEvent[] }) {
  return (
    <section
      aria-label="Release lifecycle"
      className="w-fit max-w-full py-1 font-mono md:float-right md:mb-2 md:ml-6"
    >
      <table className="border-collapse text-xs">
        <tbody>
          {events.map((event) => (
            <tr key={event.kind + "-" + event.dateTime}>
              <td className="py-0.5 text-left text-zinc-400">
                <time dateTime={event.dateTime}>{event.date}</time>
              </td>
              <td className="py-0.5 pl-4 text-right">
                <LifecycleBadge event={event} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
export default GamePageView;
