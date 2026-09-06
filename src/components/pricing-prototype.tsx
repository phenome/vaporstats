import { useEffect, useMemo } from "react";
import type { GameDetail } from "../lib/catalog";
import type { GroupedRelatedApps } from "../lib/related";
import type { PlayerHistoryResult } from "../lib/player-history";
import type { PriceHistoryResult, PriceState } from "../lib/prices";

/** Four price/header compositions on /games/$game, switchable with ?variant=. */
export const PRICE_PROTOTYPE_NOW = "2026-09-05T12:00:00Z";

export interface PrototypeGameFallback {
  game: GameDetail;
  related: GroupedRelatedApps;
  playerHistory: PlayerHistoryResult;
  price: PriceState | null;
  priceHistory: PriceHistoryResult | null;
}

/** Local-only identity fallback; the route still attempts its real detail query first. */
export const PROTOTYPE_GAME_FALLBACK = {
  game: {
    appid: 730,
    name: "Counter-Strike 2",
    slug: "counter-strike-2",
    type: "game",
    is_eligible: true,
    is_playable: true,
    parent_appid: null,
    release_date: "2012-08-21",
    steam_release_date: "2012-08-21",
    original_release_date: "2012-08-21",
    original_steam_release_date: "2012-08-21",
    release_from_early_access_date: null,
    release_date_source: "steam_release_date",
    is_early_access: false,
    has_left_early_access: true,
    release_status: "released",
    description: "For over two decades, Counter-Strike has offered an elite competitive experience.",
    header_image: "https://cdn.akamai.steamstatic.com/steam/apps/730/header.jpg",
    developer: "Valve",
    publisher: "Valve",
    created_at: PRICE_PROTOTYPE_NOW,
    updated_at: PRICE_PROTOTYPE_NOW,
    latest_players: 612345,
    peak_players: 1818773,
    last_observed_at: "2026-09-05T11:55:00Z",
    release_events: [{ event_type: "full_release", event_date: "2012-08-21", source: "steam_release_date" }],
  },
  related: { parent_appid: 730, expansions: [], dlc: [], soundtracks: [], servers: [], tools: [], demos: [], tests: [], other: [], total_count: 0 },
  playerHistory: {
    appid: 730,
    range: "30d",
    earliest_observation: "2026-08-06T12:00:00Z",
    range_start: "2026-08-06T12:00:00Z",
    range_end: PRICE_PROTOTYPE_NOW,
    points: [
      { timestamp: "2026-08-06T12:00:00Z", players: 490000 },
      { timestamp: "2026-08-20T12:00:00Z", players: 550000 },
      { timestamp: "2026-09-05T11:55:00Z", players: 612345 },
    ],
    source_timestamp: PRICE_PROTOTYPE_NOW,
  },
  price: null,
  priceHistory: null,
} satisfies PrototypeGameFallback;

type ScenarioId =
  | "active-discount"
  | "past-sales"
  | "one-observation"
  | "few-equal"
  | "few-changes"
  | "always-free"
  | "paid-to-free"
  | "temporary-free"
  | "unavailable-gap"
  | "no-data";
type CardLayout = "compact" | "offer-first" | "ledger" | "unified";
type HeaderLayout = "inline" | "hero" | "sidebar" | "panel";
type Range = "30d" | "6m" | "1y" | "all";
type CarryMode = "solid" | "dashed" | "off";
type AreaMode = "bands" | "savings" | "line";
type FreePresentation = "compact" | "retained";
type Variant = "A" | "B" | "C" | "D";

export interface PrototypeSearchState {
  variant?: string;
  scenario?: string;
  card?: string;
  header?: string;
  range?: string;
  carry?: string;
  area?: string;
  free?: string;
}

export interface PricingPrototypeProps {
  search: PrototypeSearchState;
  onChange: (patch: Partial<PrototypeSearchState>) => void;
}

interface MockRow {
  observedAt: string;
  initialPrice: number | null;
  finalPrice: number | null;
  discountPercent: number;
  isFree: boolean;
  isAvailable: boolean;
}
interface Scenario {
  id: ScenarioId;
  label: string;
  summary: string;
  rows: MockRow[];
  lastSuccessfulCheck: string | null;
}

const NOW = new Date(PRICE_PROTOTYPE_NOW).getTime();
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const row = (daysAgo: number, initialPrice: number | null, finalPrice: number | null, discountPercent = 0, isFree = false, isAvailable = true): MockRow => ({
  observedAt: iso(daysAgo), initialPrice, finalPrice, discountPercent, isFree, isAvailable,
});

const SCENARIOS: Scenario[] = [
  { id: "active-discount", label: "Active discount", summary: "A retained sale state with a newer successful check carried forward to today.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(28, 2999, 2999), row(15, 2999, 1499, 50), row(7, 2999, 1499, 50)] },
  { id: "past-sales", label: "Past / repeated sales", summary: "Repeated sale states are retained once per state change; identical polls are not rows.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(170, 3999, 3999), row(145, 3999, 1999, 50), row(132, 3999, 3999), row(94, 3999, 999, 75), row(82, 3999, 3999), row(34, 3999, 1999, 50), row(21, 3999, 3999)] },
  { id: "one-observation", label: "One observation", summary: "One isolated observation keeps its marker; no invented history precedes it.", lastSuccessfulCheck: iso(2), rows: [row(2, 2499, 2499)] },
  { id: "few-equal", label: "Few equal observations", summary: "Several successful checks with one retained state demonstrate carried-forward continuity.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(18, 1999, 1999), row(9, 1999, 1999), row(3, 1999, 1999)] },
  { id: "few-changes", label: "Few price changes", summary: "A short state-change ledger makes step transitions explicit.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(26, 5999, 5999), row(19, 5999, 2999, 50), row(11, 5999, 4499, 25), row(4, 5999, 5999)] },
  { id: "always-free", label: "Always free", summary: "Free history can be compact or retain its zero baseline and observations.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(180, 0, 0, 0, true), row(90, 0, 0, 0, true), row(18, 0, 0, 0, true)] },
  { id: "paid-to-free", label: "Paid to free", summary: "The paid history remains visible after the game becomes free.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(220, 1999, 1999), row(150, 1999, 999, 50), row(94, 1999, 1999), row(45, 1999, 0, 0, true), row(10, 1999, 0, 0, true)] },
  { id: "temporary-free", label: "Temporary 100% off", summary: "A 100% discount is a temporary offer, not permanent free pricing.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(50, 3999, 3999), row(35, 3999, 0, 100, false), row(28, 3999, 3999)] },
  { id: "unavailable-gap", label: "Unavailable gap", summary: "Unavailable periods remain gaps instead of becoming zero or a guessed price.", lastSuccessfulCheck: PRICE_PROTOTYPE_NOW, rows: [row(52, 2999, 2999), row(38, null, null, 0, false, false), row(27, 2999, 1499, 50), row(6, 2999, 1499, 50)] },
  { id: "no-data", label: "No data", summary: "No successful observation exists yet.", lastSuccessfulCheck: null, rows: [] },
];

const DEFAULTS: Record<Variant, { card: CardLayout; header: HeaderLayout }> = {
  A: { card: "compact", header: "inline" },
  B: { card: "offer-first", header: "hero" },
  C: { card: "ledger", header: "sidebar" },
  D: { card: "unified", header: "panel" },
};

function normalize<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}
function getState(search: PrototypeSearchState) {
  const variant = normalize(search.variant, ["A", "B", "C", "D"] as const, "A");
  const defaults = DEFAULTS[variant];
  return {
    variant,
    scenario: normalize(search.scenario, SCENARIOS.map((item) => item.id), "active-discount"),
    card: normalize(search.card, ["compact", "offer-first", "ledger", "unified"] as const, defaults.card),
    header: normalize(search.header, ["inline", "hero", "sidebar", "panel"] as const, defaults.header),
    range: normalize(search.range, ["30d", "6m", "1y", "all"] as const, "30d"),
    carry: normalize(search.carry, ["solid", "dashed", "off"] as const, "dashed"),
    area: normalize(search.area, ["bands", "savings", "line"] as const, "bands"),
    free: normalize(search.free, ["compact", "retained"] as const, "retained"),
  };
}
function money(cents: number | null, free = false) {
  if (free || cents === 0) return "Free";
  if (cents === null) return "Unavailable";
  return `$${(cents / 100).toFixed(2)}`;
}
function dateTime(value: string | null) {
  if (!value) return "No data yet";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + " UTC";
}
function dateShort(value: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(value));
}
function currentState(scenario: Scenario): MockRow | null {
  return scenario.rows[scenario.rows.length - 1] ?? null;
}
function savedAmount(current: MockRow | null) {
  if (!current || current.initialPrice === null || current.finalPrice === null) return null;
  return Math.max(0, current.initialPrice - current.finalPrice);
}

function SelectControl({ label, value, values, onChange }: { label: string; value: string; values: readonly string[]; onChange: (value: string) => void }) {
  return <label className="flex min-w-0 flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
    {label}
    <select value={value} onChange={(event) => onChange(event.target.value)} className="min-h-9 border border-zinc-700 bg-zinc-950 px-2 text-xs font-mono normal-case tracking-normal text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
      {values.map((item) => <option key={item} value={item}>{item.replaceAll("-", " ")}</option>)}
    </select>
  </label>;
}

function PrototypeSwitcher({ variant, onChange }: { variant: Variant; onChange: (variant: Variant) => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = ["A", "B", "C", "D"].indexOf(variant);
      const next = event.key === "ArrowRight" ? (index + 1) % 4 : (index + 3) % 4;
      onChange(["A", "B", "C", "D"][next] as Variant);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onChange, variant]);

  if (!import.meta.env.DEV) return null;
  const move = (delta: number) => {
    const index = ["A", "B", "C", "D"].indexOf(variant);
    onChange(["A", "B", "C", "D"][(index + delta + 4) % 4] as Variant);
  };
  return <div className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-max items-center gap-1 border border-orange-500/60 bg-zinc-950/95 p-1 font-mono shadow-2xl shadow-black/50" aria-label="Prototype variant switcher">
    <button type="button" onClick={() => move(-1)} aria-label="Previous prototype variant" className="min-h-10 min-w-10 text-lg text-orange-300 hover:bg-orange-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">←</button>
    <span aria-live="polite" className="min-w-14 px-2 text-center text-xs font-bold tracking-[0.25em] text-zinc-100">{variant} / 4</span>
    <button type="button" onClick={() => move(1)} aria-label="Next prototype variant" className="min-h-10 min-w-10 text-lg text-orange-300 hover:bg-orange-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">→</button>
  </div>;
}

function HeaderLayout({ layout, current, saved, onJump }: { layout: HeaderLayout; current: MockRow | null; saved: number | null; onJump: () => void }) {
  const summary = current?.isAvailable === false ? "Price unavailable" : current ? (current.discountPercent ? String(current.discountPercent) + "% off" : money(current.finalPrice, current.isFree)) : "No data yet";
  const observed = current ? "Observed " + dateTime(current.observedAt) : "No successful observation yet";
  const base = "Base price " + money(current?.initialPrice ?? null);
  const core = <>
    <div><p className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">Price history</p><h2 className="mt-1 text-xl font-bold tracking-tight text-zinc-100">Price history</h2></div>
    <div className="text-right"><p className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">Now</p><p className="mt-1 text-2xl font-bold tabular-nums text-orange-300">{summary}</p></div>
  </>;
  if (layout === "hero") return <div id="price-prototype-header" className="border border-orange-500/40 bg-orange-500/10 p-5"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-[10px] uppercase tracking-[0.25em] text-orange-300">Current offer</p><h2 className="mt-1 text-3xl font-bold text-zinc-100">{summary}</h2><p className="mt-2 max-w-xl text-xs text-zinc-400">{observed}</p></div><div className="text-right"><p className="text-xs text-zinc-400">Base price</p><p className="text-xl font-mono text-zinc-100">{money(current?.initialPrice ?? null)}</p>{saved !== null && <p className="text-xs text-emerald-300">Save {money(saved)}</p>}</div></div></div>;
  if (layout === "sidebar") return <div id="price-prototype-header" className="grid gap-4 border border-zinc-800 bg-zinc-950 p-4 md:grid-cols-[180px_1fr]"><aside className="border-r border-zinc-800 pr-4"><p className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">Ledger</p><p className="mt-2 text-2xl font-bold text-orange-300">{summary}</p><button type="button" onClick={onJump} className="mt-4 text-left text-[10px] uppercase tracking-wider text-zinc-400 underline decoration-zinc-700 underline-offset-4 hover:text-orange-300">Jump to graph</button></aside><div><h2 className="text-xl font-bold text-zinc-100">Price history</h2><p className="mt-2 text-sm leading-relaxed text-zinc-400">{base} · {observed}</p></div></div>;
  if (layout === "panel") return <div id="price-prototype-header" className="border border-zinc-800 bg-zinc-950 p-5"><div className="flex flex-wrap items-center justify-between gap-3">{core}</div><p className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">{base} · {observed}</p></div>;
  return <div id="price-prototype-header" className="flex flex-wrap items-end justify-between gap-3 border-b border-zinc-800 pb-3">{core}<p className="w-full text-xs text-zinc-500 md:w-auto">{base} · {observed}</p></div>;
}

function PriceCard({ layout, current, scenario }: { layout: CardLayout; current: MockRow | null; scenario: Scenario }) {
  const final = current?.isAvailable === false ? null : current?.finalPrice ?? null;
  const saved = savedAmount(current);
  const discount = current?.discountPercent ?? 0;
  if (layout === "offer-first") return <article id="price-prototype-card" className="border border-orange-500/40 bg-orange-500/10 p-5"><p className="text-[10px] uppercase tracking-[0.2em] text-orange-300">Offer</p><p className="mt-2 text-4xl font-bold tabular-nums text-zinc-100">{current ? money(final, current.isFree) : "No data yet"}</p><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="border border-orange-400/40 px-2 py-1 text-orange-200">{discount ? `${discount}% off` : "List price"}</span>{saved !== null && <span className="border border-emerald-400/30 px-2 py-1 text-emerald-300">Save {money(saved)}</span>}</div><p className="mt-4 text-[11px] text-zinc-400">Checked {dateTime(scenario.lastSuccessfulCheck)}</p></article>;
  if (layout === "ledger") return <article id="price-prototype-card" className="border border-zinc-800 bg-zinc-950 p-4"><div className="mb-3 flex items-center justify-between"><p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Current ledger</p><span className="text-xs text-zinc-400">{discount ? `-${discount}%` : "—"}</span></div><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs"><div><dt className="text-zinc-500">Paid now</dt><dd className="mt-1 font-mono text-lg text-zinc-100">{money(final, current?.isFree)}</dd></div><div><dt className="text-zinc-500">Base</dt><dd className="mt-1 font-mono text-lg text-zinc-300">{money(current?.initialPrice ?? null)}</dd></div><div><dt className="text-zinc-500">State</dt><dd className="mt-1 text-zinc-300">{current?.isAvailable === false ? "Unavailable" : current?.isFree && discount === 0 ? "Free" : discount === 100 ? "100% off" : "Paid"}</dd></div><div><dt className="text-zinc-500">Observed</dt><dd className="mt-1 text-zinc-300">{current ? dateShort(current.observedAt) : "—"}</dd></div></dl></article>;
  if (layout === "unified") return <article id="price-prototype-card" className="border border-zinc-700 bg-zinc-900/60 p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Price surface</p><p className="mt-1 text-3xl font-bold text-zinc-100">{money(final, current?.isFree)}</p></div><div className="text-right text-xs text-zinc-400"><p>{discount ? `${discount}% discount` : "No active discount"}</p><p>{saved !== null ? `${money(saved)} saved` : "No savings recorded"}</p></div></div><div className="mt-4 border-t border-zinc-700 pt-3 text-[11px] text-zinc-400">Last retained change: {current ? dateTime(current.observedAt) : "No data yet"}</div></article>;
  return <article id="price-prototype-card" className="border border-zinc-800 bg-zinc-950 p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Price now</p><p className="mt-1 text-2xl font-bold tabular-nums text-zinc-100">{money(final, current?.isFree)}</p></div><div className="text-right"><p className="text-xs text-orange-300">{discount ? `-${discount}%` : "List"}</p><p className="mt-1 text-[10px] text-zinc-500">{current ? dateShort(current.observedAt) : "No observation"}</p></div></div></article>;
}

interface GraphPoint { at: number; value: number | null; row: MockRow; inferred: boolean; }
function rangeBounds(range: Range, rows: MockRow[]) {
  const end = NOW;
  if (range === "all") return { start: rows[0] ? new Date(rows[0].observedAt).getTime() : end - 30 * DAY, end };
  const days = range === "30d" ? 30 : range === "6m" ? 183 : 365;
  return { start: end - days * DAY, end };
}
function graphRows(scenario: Scenario, range: Range, carry: CarryMode): { points: GraphPoint[]; bounds: { start: number; end: number }; max: number } {
  const bounds = rangeBounds(range, scenario.rows);
  const rows = scenario.rows.filter((item) => new Date(item.observedAt).getTime() <= bounds.end);
  const before = rows.filter((item) => new Date(item.observedAt).getTime() < bounds.start).at(-1);
  const inside = rows.filter((item) => new Date(item.observedAt).getTime() >= bounds.start);
  const points: GraphPoint[] = [];
  if (before) points.push({ at: bounds.start, value: before.isAvailable ? before.finalPrice : null, row: before, inferred: true });
  for (const item of inside) points.push({ at: new Date(item.observedAt).getTime(), value: item.isAvailable ? item.finalPrice : null, row: item, inferred: false });
  const last = points.at(-1);
  if (last && last.at < bounds.end && carry !== "off") points.push({ at: bounds.end, value: last.value, row: last.row, inferred: true });
  const max = Math.max(100, ...rows.flatMap((item) => [item.initialPrice ?? 0, item.finalPrice ?? 0]));
  return { points, bounds, max };
}
function pointY(value: number, max: number, top = 18, height = 176) { return top + height - (value / max) * height; }
function graphX(at: number, bounds: { start: number; end: number }) {
  return 30 + ((at - bounds.start) / Math.max(1, bounds.end - bounds.start)) * 850;
}
function observedPath(points: GraphPoint[], bounds: { start: number; end: number }, max: number) {
  let path = "";
  let previous: GraphPoint | null = null;
  for (const point of points) {
    if (point.inferred) continue;
    if (point.value === null) {
      previous = null;
      continue;
    }
    const px = graphX(point.at, bounds);
    const py = pointY(point.value, max);
    if (!previous || previous.value === null) path += `M ${px} ${py}`;
    else path += ` H ${px} V ${py}`;
    previous = point;
  }
  return path;
}
function inferredPath(points: GraphPoint[], bounds: { start: number; end: number }, max: number) {
  let path = "";
  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point.value === null || next.value === null || (!point.inferred && !next.inferred)) continue;
    path += `M ${graphX(point.at, bounds)} ${pointY(point.value, max)} H ${graphX(next.at, bounds)}`;
  }
  return path;
}
function savingsPaths(points: GraphPoint[], bounds: { start: number; end: number }, max: number) {
  const paths: string[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    const base = point.row.initialPrice;
    if (point.value === null || next.value === null || base === null || point.row.discountPercent <= 0) continue;
    const startX = graphX(point.at, bounds);
    const endX = graphX(next.at, bounds);
    const paidY = pointY(point.value, max);
    const baseY = pointY(base, max);
    paths.push(`M ${startX} ${paidY} H ${endX} V ${baseY} H ${startX} Z`);
  }
  return paths;
}

function PriceGraph({ scenario, range, carry, area, freePresentation }: { scenario: Scenario; range: Range; carry: CarryMode; area: AreaMode; freePresentation: FreePresentation }) {
  const graph = graphRows(scenario, range, carry);
  if (scenario.id === "always-free" && freePresentation === "compact") return <div id="price-prototype-graph" className="border border-zinc-800 bg-zinc-950 p-4"><div className="flex items-center justify-between"><p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Free since first observation</p><p className="font-mono text-lg text-emerald-300">$0.00</p></div><div className="mt-4 h-2 bg-emerald-400/30" aria-label="Compact free history"></div></div>;
  const line = observedPath(graph.points, graph.bounds, graph.max);
  const inferred = carry === "off" ? "" : inferredPath(graph.points, graph.bounds, graph.max);
  const showMarkers = scenario.rows.length === 1 || graph.points.some((point) => point.value === null);
  return <div id="price-prototype-graph" className="border border-zinc-800 bg-zinc-950 p-3 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Price timeline</p><p className="mt-1 text-[11px] text-zinc-500">{dateShort(new Date(graph.bounds.start).toISOString())} → {dateShort(new Date(graph.bounds.end).toISOString())} · full selected range</p></div><div className="flex flex-wrap gap-3 text-[10px] text-zinc-500"><span><i className="mr-1 inline-block h-2 w-2 bg-orange-300"></i>Observed</span><span><i className="mr-1 inline-block h-2 w-2 border border-zinc-500"></i>Carried forward</span><span>— unavailable gap</span></div></div><svg viewBox="0 0 900 220" role="img" aria-label={`Price history from ${dateShort(new Date(graph.bounds.start).toISOString())} to ${dateShort(new Date(graph.bounds.end).toISOString())}`} className="mt-3 h-auto w-full overflow-visible"><line x1="30" y1="194" x2="880" y2="194" stroke="currentColor" className="text-zinc-800" /><line x1="30" y1="18" x2="30" y2="194" stroke="currentColor" className="text-zinc-800" />{[0, graph.max / 2, graph.max].map((value) => { const y = pointY(value, graph.max); return <g key={"y-" + value}><line x1="25" x2="30" y1={y} y2={y} className="stroke-zinc-700" /><text x="22" y={y + 3} textAnchor="end" className="fill-zinc-500 text-[10px]">{money(value)}</text></g>; })}{[graph.bounds.start, (graph.bounds.start + graph.bounds.end) / 2, graph.bounds.end].map((at) => { const x = graphX(at, graph.bounds); return <g key={"x-" + at}><line x1={x} x2={x} y1="194" y2="199" className="stroke-zinc-700" /><text x={x} y="214" textAnchor="middle" className="fill-zinc-500 text-[10px]">{dateShort(new Date(at).toISOString())}</text></g>; })}{area === "bands" && graph.points.slice(0, -1).map((point, index) => { const next = graph.points[index + 1]; if (!next || !point.row.discountPercent) return null; return <rect key={`band-${point.at}`} x={graphX(point.at, graph.bounds)} y="18" width={Math.max(0, graphX(next.at, graph.bounds) - graphX(point.at, graph.bounds))} height="176" className="fill-orange-400/10" />; })}{area === "savings" && savingsPaths(graph.points, graph.bounds, graph.max).map((path, index) => <path key={`savings-${index}`} d={path} className="fill-emerald-400/15" />)}{line && <path d={line} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" className="text-orange-300" />}{inferred && <path d={inferred} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" className={`text-orange-300 ${carry === "dashed" ? "[stroke-dasharray:8_6]" : ""}`} />}{showMarkers && graph.points.filter((point) => point.value !== null).map((point) => <circle key={`point-${point.at}`} cx={graphX(point.at, graph.bounds)} cy={pointY(point.value ?? 0, graph.max)} r={showMarkers ? "4" : "7"} className={showMarkers ? "fill-orange-300" : "fill-transparent hover:fill-orange-300/70"}><title>{`${point.inferred ? "Carried-forward inference" : "Observed"} · ${dateTime(new Date(point.at).toISOString())} · ${money(point.value, point.row.isFree)}`}</title></circle>)}{graph.points.filter((point) => point.value === null).map((point) => <line key={`gap-${point.at}`} x1={graphX(point.at, graph.bounds)} x2={graphX(point.at, graph.bounds)} y1="18" y2="194" className="stroke-zinc-700" strokeDasharray="3 5" />)}</svg>{!graph.points.length && <p className="border-t border-zinc-800 pt-3 text-sm text-zinc-500">No data yet — waiting for the first successful observation.</p>}{scenario.lastSuccessfulCheck && scenario.rows.length > 0 && <p className="mt-2 text-[11px] text-zinc-500">Last successful check: {dateTime(scenario.lastSuccessfulCheck)}. The final segment is inferred, not an additional retained row.</p>}</div>;
}

function MockInspector({ scenario, state }: { scenario: Scenario; state: ReturnType<typeof getState> }) {
  const current = currentState(scenario);
  return <details className="border border-zinc-800 bg-zinc-950"><summary className="cursor-pointer px-4 py-3 text-xs font-mono uppercase tracking-wider text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Mock state inspector</summary><div className="space-y-4 border-t border-zinc-800 p-4 text-xs"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><p className="text-zinc-500">Fixed clock</p><p className="mt-1 font-mono text-zinc-200">{dateTime(PRICE_PROTOTYPE_NOW)}</p></div><div><p className="text-zinc-500">Scenario current</p><p className="mt-1 text-zinc-200">{current ? money(current.finalPrice, current.isFree) : "No data yet"}</p></div><div><p className="text-zinc-500">Last successful check</p><p className="mt-1 font-mono text-zinc-200">{dateTime(scenario.lastSuccessfulCheck)}</p></div><div><p className="text-zinc-500">Last retained change</p><p className="mt-1 font-mono text-zinc-200">{dateTime(current?.observedAt ?? null)}</p></div></div><dl className="grid gap-2 border-t border-zinc-800 pt-3 text-[11px] text-zinc-400 sm:grid-cols-2 lg:grid-cols-4"><div><dt>Variant</dt><dd className="text-zinc-200">{state.variant}</dd></div><div><dt>Card</dt><dd className="text-zinc-200">{state.card}</dd></div><div><dt>Header</dt><dd className="text-zinc-200">{state.header}</dd></div><div><dt>Range / carry / area</dt><dd className="text-zinc-200">{state.range} / {state.carry} / {state.area}</dd></div></dl><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[11px]"><caption className="mb-2 text-left text-zinc-500">Retained state-change rows (Issue #19); repeated identical polls are omitted.</caption><thead className="border-b border-zinc-800 text-zinc-500"><tr><th className="py-2 pr-3">Observed UTC</th><th className="py-2 pr-3">Availability</th><th className="py-2 pr-3">Base</th><th className="py-2 pr-3">Paid</th><th className="py-2 pr-3">Discount</th><th className="py-2">Meaning</th></tr></thead><tbody>{scenario.rows.map((item) => <tr key={item.observedAt} className="border-b border-zinc-900"><td className="py-2 pr-3 font-mono text-zinc-300">{dateTime(item.observedAt)}</td><td className="py-2 pr-3 text-zinc-300">{item.isAvailable ? "Available" : "Unavailable"}</td><td className="py-2 pr-3 font-mono text-zinc-300">{money(item.initialPrice)}</td><td className="py-2 pr-3 font-mono text-zinc-300">{money(item.finalPrice, item.isFree)}</td><td className="py-2 pr-3 text-zinc-300">{item.discountPercent}%</td><td className="py-2 text-zinc-400">Observed state change</td></tr>)}</tbody></table>{!scenario.rows.length && <p className="py-3 text-zinc-500">No retained rows.</p>}</div></div></details>;
}

export function PricingPrototype({ search, onChange }: PricingPrototypeProps) {
  const state = useMemo(() => getState(search), [search]);
  const scenario = SCENARIOS.find((item) => item.id === state.scenario) ?? SCENARIOS[0];
  const current = currentState(scenario);
  const saved = savedAmount(current);
  return <section aria-label="Price prototype" className="space-y-4">
    <nav aria-label="Price prototype surfaces" className="flex flex-wrap gap-1 border border-zinc-800 bg-zinc-950 p-1 text-[10px] font-mono uppercase tracking-wider"><a href="#price-prototype-header" className="min-h-9 px-3 py-2 text-zinc-400 hover:bg-zinc-900 hover:text-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Header</a><a href="#price-prototype-card" className="min-h-9 px-3 py-2 text-zinc-400 hover:bg-zinc-900 hover:text-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Card</a><a href="#price-prototype-graph" className="min-h-9 px-3 py-2 text-zinc-400 hover:bg-zinc-900 hover:text-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Graph</a></nav>
    <div className="grid gap-3 border border-zinc-800 bg-zinc-950 p-3 md:grid-cols-2 lg:grid-cols-4"><SelectControl label="Scenario" value={state.scenario} values={SCENARIOS.map((item) => item.id)} onChange={(value) => onChange({ scenario: value })} /><SelectControl label="Card treatment" value={state.card} values={["compact", "offer-first", "ledger", "unified"]} onChange={(value) => onChange({ card: value })} /><SelectControl label="Header treatment" value={state.header} values={["inline", "hero", "sidebar", "panel"]} onChange={(value) => onChange({ header: value })} /><SelectControl label="Range" value={state.range} values={["30d", "6m", "1y", "all"]} onChange={(value) => onChange({ range: value })} /><SelectControl label="Last observation" value={state.carry} values={["solid", "dashed", "off"]} onChange={(value) => onChange({ carry: value })} /><SelectControl label="Area" value={state.area} values={["bands", "savings", "line"]} onChange={(value) => onChange({ area: value })} /><SelectControl label="Free presentation" value={state.free} values={["compact", "retained"]} onChange={(value) => onChange({ free: value })} /></div>
    <p className="border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs leading-relaxed text-zinc-400"><span className="font-mono uppercase tracking-wider text-zinc-500">Scenario notes</span> · {scenario.summary}</p>
    <div id="price-prototype-surfaces"><HeaderLayout layout={state.header} current={current} saved={saved} onJump={() => document.getElementById("price-prototype-graph")?.scrollIntoView({ behavior: "smooth", block: "start" })} /><div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]"><PriceCard layout={state.card} current={current} scenario={scenario} /><PriceGraph scenario={scenario} range={state.range} carry={state.carry} area={state.area} freePresentation={state.free} /></div></div>
    <MockInspector scenario={scenario} state={state} />
    <PrototypeSwitcher variant={state.variant} onChange={(variant) => onChange({ variant })} />
  </section>;
}

export default PricingPrototype;
