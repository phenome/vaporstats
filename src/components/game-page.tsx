import React, { useRef, useState, useEffect } from "react";
import type { GameDetail } from "../lib/catalog";
import type { GroupedRelatedApps } from "../lib/related";
import type { PlayerHistoryResult } from "../lib/player-history";
import {
  type PriceState,
  type PriceHistoryResult,
} from "../lib/prices";
import { getCanonicalPublisherPath } from "../lib/slug";
import { getCommunityIconUrl } from "../lib/lqip";
import { PlayerPanel } from "./player-panel";
import { PlayerHistoryChart } from "./player-history";
import { PriceHistoryChart } from "./price-history";
import { RelatedApps } from "./related-apps";
import { AppLink } from "./app-link";
import { LifecycleHistorySection } from "./lifecycle-history";

function useHeroScrollProgress(heroRef: React.RefObject<HTMLElement | null>) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let rafId = 0;
    const updateProgress = () => {
      rafId = requestAnimationFrame(() => {
        const el = heroRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // Natural top begins sticking when rect.top touches 56px (SiteHeader bottom)
        const topDiff = 56 - rect.top;
        // Collapses over 160px of scroll
        const p = Math.min(Math.max(topDiff / 160, 0), 1);
        setProgress(p);
      });
    };

    window.addEventListener("scroll", updateProgress, { passive: true });
    updateProgress();
    return () => {
      window.removeEventListener("scroll", updateProgress);
      cancelAnimationFrame(rafId);
    };
  }, [heroRef]);

  return progress;
}
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
  const overviewEvents = getLifecycleOverviewEvents(game);
  const mainReleaseDate = getMainReleaseDate(game);
  const releaseStatusLabel =
    game.release_status === "upcoming"
      ? "Upcoming"
      : game.release_status === "unannounced"
        ? "Unannounced"
        : "Released";
  const isUnreleased = game.release_status === "upcoming" || game.release_status === "unannounced";
  const heroRef = useRef<HTMLElement>(null);
  const scrollProgress = useHeroScrollProgress(heroRef);

  // Overlapping 2-phase progression:
  // Phase 1 (0%..60%): Secondary details fade out and collapse height
  // Phase 2 (40%..100%): Card padding compresses, image crossfades, single-line aligns
  const p1 = Math.min(Math.max(scrollProgress / 0.6, 0), 1);
  const p2 = Math.min(Math.max((scrollProgress - 0.4) / 0.6, 0), 1);

  const communityIconUrl = game.icon_hash
    ? getCommunityIconUrl(game.appid, game.icon_hash)
    : null;

  return (
    <div className="game-page-container max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Morphing Sticky Game Header */}
      <header
        ref={heroRef}
        className="morphing-game-hero border border-zinc-800 bg-zinc-950/95 backdrop-blur-md transition-shadow"
        style={{
          padding: `${Math.round(24 - p2 * 16)}px 24px`,
          boxShadow: p2 > 0.1 ? "0 4px 20px -2px rgba(0, 0, 0, 0.5)" : undefined,
        }}
      >
        {/* Compact Single-Line Header (Active when stuck) */}
        <div
          className="flex items-center justify-between gap-3 w-full font-mono text-xs overflow-hidden"
          style={{
            opacity: p2,
            maxHeight: `${Math.round(p2 * 48)}px`,
            pointerEvents: p2 > 0.5 ? "auto" : "none",
            display: p2 > 0 ? "flex" : "none",
          }}
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {/* Square Art (Community icon or resized LQIP) */}
            <div className="w-8 h-8 shrink-0 relative bg-zinc-900 border border-zinc-800 overflow-hidden flex items-center justify-center">
              {communityIconUrl ? (
                <img
                  src={communityIconUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  style={
                    game.icon_lqip
                      ? { backgroundImage: `url(${game.icon_lqip})`, backgroundSize: "cover" }
                      : undefined
                  }
                />
              ) : game.icon_lqip ? (
                <img src={game.icon_lqip} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-600 font-mono">
                  VS
                </div>
              )}
            </div>

            {/* Title (Truncated) */}
            <span className="font-bold text-zinc-100 truncate text-sm md:text-base">
              {game.name}
            </span>

            {/* Status & Main Release Date (Hidden on mobile <640px) */}
            <div className="hidden sm:inline-flex items-center gap-1.5 shrink-0 text-[11px]">
              <span className="border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-bold uppercase tracking-wider text-zinc-300">
                {releaseStatusLabel}
              </span>
              {mainReleaseDate && (
                <span className="text-zinc-300 font-mono">
                  {formatReleaseDate(mainReleaseDate)}
                </span>
              )}
            </div>
          </div>

          {/* Steam Store Link (Hidden on mobile <640px) */}
          <div className="hidden sm:flex items-center gap-2 shrink-0">
            <a
              href={`https://store.steampowered.com/app/${game.appid}/`}
              target="_blank"
              rel="noreferrer"
              className="text-orange-400 hover:text-orange-300 hover:underline inline-flex items-center gap-1 font-mono text-xs"
            >
              Steam Store ↗
            </a>
          </div>
        </div>

        {/* Expanded Header Body */}
        <div
          className="space-y-4"
          style={{
            opacity: 1 - p2,
            display: p2 >= 1 ? "none" : "block",
            pointerEvents: p2 > 0.5 ? "none" : "auto",
          }}
        >
          {/* Top Row: Type, Status, Date, Steam Link */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 pb-3">
            <div className="flex items-center gap-3">
              <span className="px-2 py-0.5 bg-orange-500/10 text-orange-400 border border-orange-500/30 text-[10px] font-mono uppercase tracking-widest">
                {game.type.toUpperCase()}
              </span>
              <div className="inline-flex items-center gap-2 text-xs font-mono">
                <span className="border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-bold uppercase tracking-wider text-zinc-300">
                  {releaseStatusLabel}
                </span>
                {mainReleaseDate ? (
                  isPreciseReleaseDate(mainReleaseDate) ? (
                     <time dateTime={mainReleaseDate} className="text-zinc-200">
                       {formatReleaseDate(mainReleaseDate)}
                     </time>
                   ) : (
                     <span className="text-zinc-200">{formatReleaseDate(mainReleaseDate)}</span>
                   )
                 ) : isUnreleased ? (
                   <span className="text-zinc-400">TBA</span>
                 ) : (
                   <span className="text-zinc-500">—</span>
                 )}
               </div>
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
 
           {/* Hero Content: Image & Details */}
           <div className="flex flex-col md:flex-row gap-6 items-start">
             {game.header_image ? (
               <div className="w-full md:w-80 border border-zinc-800 aspect-[460/215] overflow-hidden bg-zinc-900 relative shrink-0">
                 <img
                   src={game.header_image}
                   alt={game.name}
                   className="w-full h-full object-cover"
                   style={
                     game.header_lqip
                       ? { backgroundImage: `url(${game.header_lqip})`, backgroundSize: "cover" }
                       : undefined
                   }
                 />
               </div>
             ) : (
               <div className="w-full md:w-80 h-36 bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600 font-mono text-xs shrink-0">
                 NO IMAGE AVAILABLE
               </div>
             )}
 
             <div className="flex-1 min-w-0">
               <div className="flow-root space-y-3">
                 {/* Secondary: Lifecycle Table (Collapses in Phase 1) */}
                 {overviewEvents.length > 0 && (
                   <div
                     style={{
                       opacity: 1 - p1,
                       maxHeight: `${Math.round((1 - p1) * 120)}px`,
                       overflow: "hidden",
                     }}
                   >
                     <LifecycleTable events={overviewEvents} />
                   </div>
                 )}
 
                 <h1 className="text-2xl md:text-3xl font-mono font-bold text-zinc-100 tracking-tight">
                   {game.name}
                 </h1>
 
                 {/* Secondary: Description (Collapses in Phase 1) */}
                 {game.description && (
                   <div
                     style={{
                       opacity: 1 - p1,
                       maxHeight: `${Math.round((1 - p1) * 160)}px`,
                       overflow: "hidden",
                     }}
                   >
                     <p className="text-sm text-zinc-400 leading-relaxed font-sans">
                       {game.description}
                     </p>
                   </div>
                 )}
               </div>
 
               {/* Secondary: Developer & Publisher Grid (Collapses in Phase 1) */}
               <div
                 className="grid grid-cols-2 gap-3 pt-2 text-xs font-mono"
                 style={{
                   opacity: 1 - p1,
                   maxHeight: `${Math.round((1 - p1) * 80)}px`,
                   overflow: "hidden",
                 }}
               >
                 <div className="border border-zinc-900 bg-zinc-900/40 p-2.5">
                   <div className="text-zinc-500 text-[10px] uppercase">Developer</div>
                   <div className="text-zinc-200 font-medium truncate">
                     {game.developer ? (
                       <AppLink
                         href={getCanonicalPublisherPath(game.developer)}
                         className="hover:text-orange-400 hover:underline transition-colors"
                       >
                         {game.developer}
                       </AppLink>
                     ) : (
                       "Unknown"
                     )}
                   </div>
                 </div>
                 <div className="border border-zinc-900 bg-zinc-900/40 p-2.5">
                   <div className="text-zinc-500 text-[10px] uppercase">Publisher</div>
                   <div className="text-zinc-200 font-medium truncate">
                     {game.publisher ? (
                       <AppLink
                         href={getCanonicalPublisherPath(game.publisher)}
                         className="hover:text-orange-400 hover:underline transition-colors"
                       >
                         {game.publisher}
                       </AppLink>
                     ) : (
                       "Unknown"
                     )}
                   </div>
                 </div>
               </div>
             </div>
           </div>
         </div>
       </header>

      <LifecycleHistorySection appid={game.appid} />
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

type LifecycleEventKind = "expected" | "steam-availability" | "left-ea" | "one-dot-zero" | "patch";

interface LifecycleDisplayEvent {
  kind: LifecycleEventKind;
  label: string;
  date: string | null;
  dateTime: string | null;
}

const lifecycleEventClasses: Record<LifecycleEventKind, string> = {
  expected: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  "steam-availability": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "left-ea": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "one-dot-zero": "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  patch: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

function getLifecycleOverviewEvents(game: GameDetail): LifecycleDisplayEvent[] {
  const events: LifecycleDisplayEvent[] = [];
  const seen = new Set<string>();
  const storedEvents = game.release_events ?? [];

  const addEvent = (kind: LifecycleEventKind, label: string, dateTime: string | null) => {
    const key = kind + ":" + (dateTime ?? "undated");
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ kind, label, date: dateTime ? formatReleaseDate(dateTime) : null, dateTime });
  };

  if (game.release_status === "upcoming" && game.release_date) {
    addEvent("expected", "Expected release", game.release_date);
  }

  if (game.release_status === "released") {
    addEvent("steam-availability", "Available on Steam", game.original_steam_release_date ?? game.steam_release_date);
  }

  if (
    game.is_early_access !== true &&
    (Boolean(game.release_from_early_access_date) || game.has_left_early_access === true)
  ) {
    addEvent("left-ea", "Left Early Access", game.release_from_early_access_date);
  }

  const versionOneEvent = storedEvents.find((event) => (event.event_type as string) === "version_1_0");
  if (versionOneEvent) {
    addEvent("one-dot-zero", "Version 1.0", versionOneEvent.event_date);
  }

  const latestPatch = storedEvents
    .filter((event) => event.event_type === "patch" && event.event_date)
    .sort((left, right) => releaseDateValue(right.event_date) - releaseDateValue(left.event_date))[0];
  if (latestPatch) {
    addEvent("patch", "Latest patch", latestPatch.event_date);
  }

  return events.sort((left, right) => releaseDateValue(right.dateTime) - releaseDateValue(left.dateTime));
}

function getMainReleaseDate(game: GameDetail): string | null {
  if (game.release_status === "upcoming") {
    return game.release_date ?? game.original_release_date ?? game.steam_release_date;
  }
  if (game.release_status === "unannounced") {
    return game.release_date ?? null;
  }
  return game.original_release_date ?? game.steam_release_date ?? game.release_date;
}

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidDateOnly(value: string): boolean {
  if (!dateOnlyPattern.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value + "T");
}

function isPreciseReleaseDate(value: string | null): boolean {
  if (!value) return false;
  if (isValidDateOnly(value)) return true;
  return timestampPattern.test(value) && isValidDateOnly(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));
}

function formatReleaseDate(value: string): string {
  const isDateOnly = isValidDateOnly(value);
  if (!isPreciseReleaseDate(value)) return value;
  const date = new Date(isDateOnly ? value + "T00:00:00Z" : value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: isDateOnly ? "UTC" : "America/Los_Angeles",
  }).format(date);
}

function toUtcDate(value: string): string | null {
  if (isValidDateOnly(value)) return value + "T00:00:00Z";
  return isPreciseReleaseDate(value) ? value : null;
}

function releaseDateValue(value: string | null): number {
  const timestamp = value ? toUtcDate(value) : null;
  return timestamp ? Date.parse(timestamp) : Number.NEGATIVE_INFINITY;
}

function LifecycleBadge({ event }: { event: LifecycleDisplayEvent }) {
  return (
    <span className={"border py-0.5 font-bold uppercase px-1.5 text-[9px] tracking-wider " + lifecycleEventClasses[event.kind]}>
      {event.label}
    </span>
  );
}

function LifecycleTable({ events }: { events: LifecycleDisplayEvent[] }) {
  return (
    <section
      aria-label="Release lifecycle overview"
      className="w-fit max-w-full py-1 font-mono md:float-right md:mb-2 md:ml-6"
    >
      <table className="border-collapse text-xs">
        <tbody>
          {events.map((event) => (
            <tr key={event.kind + "-" + (event.dateTime ?? "undated")} className="align-middle">
              <td className="py-0.5 text-left text-zinc-400 align-middle">
                {event.date && isPreciseReleaseDate(event.dateTime) ? (
                  <time dateTime={event.dateTime ?? undefined}>{event.date}</time>
                ) : (
                  event.date && <span>{event.date}</span>
                )}
              </td>
              <td className="py-0.5 pl-4 text-right align-middle">
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
