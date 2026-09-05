import { createFileRoute } from "@tanstack/react-router";
import { GamePageView } from "../components/game-page";
import type { GameDetail } from "../lib/catalog";
import type { PlayerHistoryResult } from "../lib/player-history";
import type { PriceHistoryResult, PriceState } from "../lib/prices";
import type { GroupedRelatedApps } from "../lib/related";

type VariantKey = "a" | "b" | "c";
type StateKey = "released" | "early-access" | "graduated" | "multi-date";
type EventKind = "release" | "ea" | "one-dot-zero" | "patch";

interface LifecycleEvent {
  kind: EventKind;
  label: string;
  date: string;
  dateTime: string;
  detail?: string;
  primary?: boolean;
}

interface LifecycleState {
  label: string;
  status: string;
  note?: string;
  events: LifecycleEvent[];
}

const variants: Array<{ key: VariantKey; label: string }> = [
  { key: "a", label: "Compact facts" },
  { key: "b", label: "Milestone rail" },
  { key: "c", label: "Release ledger" },
];

const states: Record<StateKey, LifecycleState> = {
  released: {
    label: "Direct release",
    status: "Released",
    events: [
      { kind: "release", label: "Released", date: "Aug 21, 2012", dateTime: "2012-08-21", primary: true },
      { kind: "patch", label: "Latest patch", date: "Jul 16, 2025", dateTime: "2025-07-16", detail: "Gameplay update" },
    ],
  },
  "early-access": {
    label: "Active Early Access",
    status: "In Early Access",
    note: "A 1.0 date has not been announced.",
    events: [
      { kind: "ea", label: "Early Access", date: "Feb 2, 2021", dateTime: "2021-02-02", primary: true },
      { kind: "patch", label: "Latest patch", date: "Aug 26, 2025", dateTime: "2025-08-26", detail: "Call to Arms" },
    ],
  },
  graduated: {
    label: "Graduated to 1.0",
    status: "Version 1.0",
    events: [
      { kind: "ea", label: "Early Access", date: "Oct 6, 2020", dateTime: "2020-10-06" },
      { kind: "one-dot-zero", label: "Version 1.0", date: "Aug 3, 2023", dateTime: "2023-08-03", primary: true },
      { kind: "patch", label: "Latest patch", date: "Sep 1, 2026", dateTime: "2026-09-01", detail: "Patch 7.1" },
    ],
  },
  "multi-date": {
    label: "Original + Steam",
    status: "Released",
    events: [
      { kind: "release", label: "Original release", date: "Jun 30, 2018", dateTime: "2018-06-30", primary: true },
      { kind: "release", label: "Steam release", date: "Aug 31, 2026", dateTime: "2026-08-31", detail: "Platform date" },
      { kind: "patch", label: "Latest patch", date: "Feb 24, 2024", dateTime: "2024-02-24", detail: "Content update" },
    ],
  },
};

const eventClasses: Record<EventKind, string> = {
  release: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  ea: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "one-dot-zero": "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  patch: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

const game: GameDetail = {
  appid: 730,
  name: "Counter-Strike 2",
  slug: "counter-strike-2",
  type: "game",
  is_eligible: true,
  is_playable: true,
  parent_appid: null,
  release_date: "Aug 21, 2012",
  steam_release_date: "2012-08-21",
  original_release_date: "2012-08-21",
  original_steam_release_date: "2012-08-21",
  release_from_early_access_date: null,
  release_date_source: "original_release_date",
  is_early_access: false,
  release_status: "released",
  description: "For over two decades, Counter-Strike has offered an elite competitive experience, one shaped by millions of players from across the globe. And now the next chapter in the CS story is about to begin. This is Counter-Strike 2.",
  header_image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/730/162664aa5da85f418105350c5d67ca565f6c3713/header.jpg?t=1784564069",
  developer: "Valve",
  publisher: "Valve",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-05T12:20:12.000Z",
  latest_players: 1_095_650,
  peak_players: 1_095_650,
  last_observed_at: "2026-09-05T12:20:12.000Z",
};

const price: PriceState = {
  appid: 730,
  currency: "USD",
  initial_price: 0,
  final_price: 0,
  discount_percent: 0,
  is_free: true,
  is_available: true,
  formatted_initial: "Free",
  formatted_final: "Free",
  observed_at: "2026-09-04T21:00:04.000Z",
};

const playerHistory: PlayerHistoryResult = {
  appid: 730,
  range: "30d",
  earliest_observation: "2026-08-07T12:00:00.000Z",
  source_timestamp: "2026-09-05T12:20:12.000Z",
  points: Array.from({ length: 30 }, (_, day) => ({
    timestamp: new Date(Date.UTC(2026, 7, 7 + day, 12)).toISOString(),
    players: 540_000 + day * 12_000 + Math.round(Math.sin(day / 2) * 72_000),
  })),
};

const priceHistory: PriceHistoryResult = {
  appid: 730,
  range: "all",
  earliest_observation: "2026-09-01T12:00:00.000Z",
  current_price: price,
  source_timestamp: "2026-09-04T21:00:04.000Z",
  history: [
    {
      appid: 730,
      currency: "USD",
      initial_price: 0,
      final_price: 0,
      discount_percent: 0,
      is_free: true,
      is_available: true,
      formatted_price: "Free",
      observed_at: "2026-09-01T12:00:00.000Z",
    },
    {
      appid: 730,
      currency: "USD",
      initial_price: 0,
      final_price: 0,
      discount_percent: 0,
      is_free: true,
      is_available: true,
      formatted_price: "Free",
      observed_at: "2026-09-04T21:00:04.000Z",
    },
  ],
};

const related: GroupedRelatedApps = {
  parent_appid: 730,
  expansions: [],
  dlc: [],
  soundtracks: [],
  servers: [
    {
      appid: 740,
      name: "Counter-Strike Dedicated Server",
      slug: "counter-strike-dedicated-server",
      type: "server",
      raw_type: "server",
      is_eligible: true,
      is_playable: false,
      parent_appid: 730,
      release_date: "2004-03-07",
      release_status: "released",
      description: "Dedicated server tooling.",
      header_image: "",
      developer: "Valve",
      publisher: "Valve",
      prominence: 0,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    },
  ],
  tools: [],
  demos: [],
  tests: [],
  other: [],
  total_count: 1,
};

export const Route = createFileRoute("/prototype/game-detail-lifecycle")({
  validateSearch: (search: Record<string, unknown>) => ({
    variant: search.variant === "b" || search.variant === "c" ? search.variant : "a" as VariantKey,
    state:
      search.state === "early-access" || search.state === "graduated" || search.state === "multi-date"
        ? search.state
        : "released" as StateKey,
  }),
  component: GameDetailLifecyclePrototype,
});

function GameDetailLifecyclePrototype() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const lifecycle = states[search.state];
  const mainEvent = lifecycle.events.find((event) => event.primary) ?? lifecycle.events[0];

  return (
    <div className="pb-48">
      <GamePageView
        game={game}
        price={price}
        playerHistory={playerHistory}
        priceHistory={priceHistory}
        related={related}
        releaseSummary={search.variant === "a" ? <EventSummary event={mainEvent} /> : undefined}
        releasePresentation={<ReleasePresentation variant={search.variant} lifecycle={lifecycle} />}
        releasePresentationPlacement={search.variant === "a" ? "hero-float" : "body"}
      />

      <nav
        aria-label="Prototype controls"
        className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-4xl border border-zinc-600 bg-zinc-100 p-2 font-mono text-zinc-950 shadow-2xl"
      >
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16 px-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Layout</span>
          {variants.map((variant) => (
            <button
              key={variant.key}
              type="button"
              aria-pressed={variant.key === search.variant}
              onClick={() => void navigate({ search: (current) => ({ ...current, variant: variant.key }), replace: true })}
              className={`min-h-9 px-3 text-xs ${variant.key === search.variant ? "bg-zinc-950 text-white" : "hover:bg-zinc-300"}`}
            >
              {variant.key.toUpperCase()} · {variant.label}
            </button>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-zinc-300 pt-1">
          <span className="w-16 px-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">State</span>
          {(Object.entries(states) as Array<[StateKey, LifecycleState]>).map(([key, state]) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === search.state}
              onClick={() => void navigate({ search: (current) => ({ ...current, state: key }), replace: true })}
              className={`min-h-9 px-3 text-xs ${key === search.state ? "bg-zinc-950 text-white" : "hover:bg-zinc-300"}`}
            >
              {state.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

function ReleasePresentation({ variant, lifecycle }: { variant: VariantKey; lifecycle: LifecycleState }) {
  if (variant === "a") {
    return (
      <section aria-label="Release lifecycle" className="w-fit max-w-full py-1 font-mono md:float-right md:mb-2 md:ml-6">
        <table className="border-collapse text-xs">
          <tbody>
            {lifecycle.events.filter((event) => !event.primary).sort((a, b) => b.dateTime.localeCompare(a.dateTime)).map((event) => (
              <tr key={event.label + event.date}>
                <td className="py-0.5 text-left text-zinc-400">{event.date}</td>
                <td className="py-0.5 pl-4 text-right"><EventBadge event={event} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  }

  if (variant === "b") {
    return (
      <section aria-label="Release lifecycle" className="border border-zinc-800 bg-zinc-900/20 px-3 py-3 font-mono">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <strong className="text-xs text-zinc-200">{lifecycle.status}</strong>
        </div>
        <ol className="relative mt-3 grid gap-2 sm:grid-cols-3">
          {lifecycle.events.map((event, index) => (
            <li key={`${event.label}-${event.date}`} className="relative border-l-2 border-zinc-700 bg-zinc-950/70 px-3 py-2">
              <span className="text-[9px] text-zinc-600">0{index + 1}</span>
              <div className="mt-1 flex items-center gap-2"><EventBadge event={event} /></div>
              <time dateTime={event.dateTime} className={`mt-2 block text-xs ${event.primary ? "font-bold text-zinc-100" : "text-zinc-400"}`}>{event.date}</time>
              {event.detail && <p className="mt-1 text-[10px] text-zinc-600">{event.detail}</p>}
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section aria-label="Release lifecycle" className="border border-zinc-800 bg-zinc-900/20 font-mono">
      <header className="flex flex-wrap items-center justify-end gap-2 border-b border-zinc-800 px-3 py-2">
        <strong className="text-xs text-zinc-200">{lifecycle.status}</strong>
      </header>
      <div className="grid sm:grid-cols-[minmax(0,1fr)_220px]">
        <ol className="divide-y divide-zinc-800">
          {lifecycle.events.map((event) => (
            <li key={`${event.label}-${event.date}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-2 text-xs">
              <div className="flex items-center gap-2"><EventBadge event={event} />{event.detail && <span className="text-[10px] text-zinc-600">{event.detail}</span>}</div>
              <time dateTime={event.dateTime} className={event.primary ? "font-bold text-zinc-100" : "text-zinc-400"}>{event.date}</time>
            </li>
          ))}
        </ol>
        <div className="border-t border-zinc-800 px-3 py-2 text-[10px] text-zinc-500 sm:border-l sm:border-t-0">
          <p className="uppercase tracking-wider">Current state</p>
          <p className="mt-1 text-xs font-bold text-zinc-200">{lifecycle.status}</p>
          {lifecycle.note && <p className="mt-2 leading-4 text-zinc-500">{lifecycle.note}</p>}
        </div>
      </div>
    </section>
  );
}

function EventSummary({ event }: { event: LifecycleEvent }) {
  return (
    <div className="inline-flex items-center gap-2 text-xs font-mono">
      <EventBadge event={event} large />
      <time dateTime={event.dateTime} className="text-zinc-200">{event.date}</time>
    </div>
  );
}

function EventBadge({ event, large = false }: { event: LifecycleEvent; large?: boolean }) {
  return <span className={`border py-0.5 font-bold uppercase ${large ? "px-2 text-[10px] font-mono leading-[15px] tracking-widest" : "px-1.5 text-[9px] tracking-wider"} ${eventClasses[event.kind]}`}>{event.label}</span>;
}
