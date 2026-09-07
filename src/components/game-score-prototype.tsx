import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import cyberpunkHistory from "./cyberpunk-history.prototype.json";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

export const scorePrototypeEnabled = import.meta.env.DEV || import.meta.env.VITE_PROTOTYPE === "true";

type ScoreRange = "24h" | "7d" | "30d" | "90d" | "all";
type ScoreObservation = {
  timestamp: number;
  score: number;
  reviews: number;
  partial?: boolean;
};
type HistoryEventKind = "majorPatch" | "expansion" | "edition";
type HistoryEvent = {
  date: string;
  kind: HistoryEventKind;
  label: string;
  sourceUrl: string;
};

// Fixed to the fixture's reference date so prototype ranges do not drift with the wall clock.
const REFERENCE_TIME = Date.parse("2026-09-07T00:00:00Z");
const CYBERPUNK_APPID = 1091500;
const CURRENT_SCORE = 84;
const CURRENT_REVIEW_COUNT = 2841;
const observations: readonly ScoreObservation[] = [
  { timestamp: Date.parse("2025-11-21T18:00:00Z"), score: 78, reviews: 1984 },
  { timestamp: Date.parse("2026-01-18T18:00:00Z"), score: 81, reviews: 2116 },
  { timestamp: Date.parse("2026-03-22T18:00:00Z"), score: 75, reviews: 322 },
  { timestamp: Date.parse("2026-05-30T18:00:00Z"), score: 83, reviews: 817 },
  { timestamp: Date.parse("2026-07-14T18:00:00Z"), score: 86, reviews: 1426 },
  { timestamp: Date.parse("2026-09-06T14:05:00Z"), score: CURRENT_SCORE, reviews: CURRENT_REVIEW_COUNT },
];
const cyberpunkObservations: readonly ScoreObservation[] = cyberpunkHistory.data.map((point, index, all) => ({
  timestamp: Date.parse(point.date + "T00:00:00Z"),
  score: 100 * point.positive / point.total,
  reviews: point.total,
  partial: index === all.length - 1,
}));
const cyberpunkEvents: readonly HistoryEvent[] = [
  { date: "2022-02-15", kind: "majorPatch", label: "Patch 1.5", sourceUrl: "https://www.cyberpunk.net/en/news/41435/patch-1-5-next-generation-update-list-of-changes" },
  { date: "2022-09-06", kind: "majorPatch", label: "Edgerunners · 1.6", sourceUrl: "https://www.cyberpunk.net/en/news/45280/edgerunners-update-patch-1-6-list-of-changes" },
  { date: "2023-09-21", kind: "majorPatch", label: "Update 2.0", sourceUrl: "https://www.cyberpunk.net/en/news/49060/update-2-0" },
  { date: "2023-09-25", kind: "expansion", label: "Phantom Liberty · PC", sourceUrl: "https://www.cyberpunk.net/en/news/49150/cyberpunk-2077-phantom-liberty-out-now" },
  { date: "2023-12-05", kind: "edition", label: "Ultimate Edition", sourceUrl: "https://www.cyberpunk.net/en/news/49696/cyberpunk-2077-ultimate-edition-is-out-now" },
  { date: "2023-12-05", kind: "majorPatch", label: "Update 2.1", sourceUrl: "https://www.cyberpunk.net/en/news/49597/update-2-1-patch-notes" },
];
const scoreRanges: readonly ScoreRange[] = ["24h", "7d", "30d", "90d", "all"];
const rangeSpans: Record<Exclude<ScoreRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};
const EVENT_KIND_LABELS: Record<HistoryEventKind, string> = {
  majorPatch: "Major patch",
  expansion: "Expansion",
  edition: "Edition",
};
const SHORT_EVENT_LABELS: Record<string, string> = {
  "Patch 1.5": "1.5",
  "Edgerunners · 1.6": "1.6",
  "Update 2.0": "2.0",
  "Phantom Liberty · PC": "PL",
  "Ultimate Edition": "UE",
  "Update 2.1": "2.1",
};

const formatNumber = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const formatDate = (timestamp: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
const formatTooltipDate = (timestamp: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp);
const formatEventDate = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(Date.parse(date + "T00:00:00Z"));
const formatRange = (range: ScoreRange) => range === "all" ? "All" : range;

function scoreDomain(range: ScoreRange, allPoints: readonly ScoreObservation[]): [number, number] {
  if (range === "all") {
    return [allPoints[0].timestamp, allPoints[allPoints.length - 1].timestamp];
  }
  return [REFERENCE_TIME - rangeSpans[range], REFERENCE_TIME];
}

export function ScoreHero() {
  if (!scorePrototypeEnabled) return null;
  return (
    <section id="player-score" className="h-full border border-zinc-800 bg-zinc-950 p-5 space-y-3" aria-labelledby="score-hero-title">
      <div className="flex items-center justify-between">
        <h2 id="score-hero-title" className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
          Current Player Score
        </h2>
        <span className="w-2 h-2 rounded-none bg-violet-500 inline-block" aria-hidden="true" />
      </div>
      <div className="pt-2 text-right">
        <div className="font-mono text-3xl font-bold leading-none tabular-nums text-violet-200" aria-label="Current Player Score: 84">
          {CURRENT_SCORE}
        </div>
        <p className="mt-2 text-[11px] font-mono text-zinc-400" title="Qualifying player reviews represented by the current score">
          {formatNumber(CURRENT_REVIEW_COUNT)} reviews
        </p>
      </div>
    </section>
  );
}

function ScoreMetrics({ points, monthly }: { points: readonly ScoreObservation[]; monthly: boolean }) {
  const latest = points.at(-1)?.score;
  return (
    <div className="grid grid-cols-2 gap-2 pt-1 text-xs font-mono">
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">{monthly ? "Latest approval" : "Latest score"}</span>
        <span className="font-bold tabular-nums text-violet-300">{latest === undefined ? "—" : formatNumber(latest) + (monthly ? "%" : "")}</span>
      </div>
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">{monthly ? "Reviews in period" : "Reviews at latest observation"}</span>
        <span className="tabular-nums text-zinc-300" title={monthly ? "Reviews in the displayed monthly buckets; the latest month is incomplete." : undefined}>{formatNumber(monthly ? points.reduce((total, point) => total + point.reviews, 0) : points.at(-1)?.reviews ?? 0)}</span>
      </div>
    </div>
  );
}

function CriticReception({ appid }: { appid: number }) {
  const [comparison, setComparison] = useState("aligned");
  // Presentation fixtures only; production classification requires the evidence gates in the reception-alignment decision.
  const comparisons = {
    aligned: { title: "Broadly aligned", player: "Favorable", critic: "Favorable", note: "Current players and the Metacritic record are both favorable." },
    mixed: { title: "Critics more favorable", player: "Mixed", critic: "Favorable", note: "Current player reception is mixed; the Metacritic record is favorable." },
    divergent: { title: "Clearly divergent", player: "Unfavorable", critic: "Favorable", note: "Current player reception is unfavorable; the Metacritic record is favorable." },
    unavailable: { title: "Not enough evidence", player: "—", critic: "Favorable", note: "More player reviews are needed for a comparison." },
  };
  const selected = comparisons[comparison as keyof typeof comparisons];
  return (
    <aside id="critic-reception" className="min-w-0 self-start border border-zinc-800 bg-zinc-950 p-5" aria-labelledby="critic-reception-title">
      <h2 id="critic-reception-title" className="border-b border-zinc-900 pb-3 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Critic reception</h2>
      {appid === CYBERPUNK_APPID ? <>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div><a href="https://www.metacritic.com/game/cyberpunk-2077/critic-reviews/?platform=pc" target="_blank" rel="noreferrer" className="text-sm text-zinc-200 hover:underline">Metacritic ↗</a><p className="mt-1 font-mono text-[10px] uppercase text-zinc-500">PC · Metascore</p></div>
          <p className="font-mono text-3xl font-bold tabular-nums text-zinc-100">86<span className="text-xs font-normal text-zinc-500"> / 100</span></p>
        </div>
        <p className="mt-1 font-mono text-xs text-zinc-500">106 listed critic reviews</p>
        <section className="mt-3 border-t border-zinc-800 pt-3" aria-labelledby="reception-alignment-title" aria-live="polite">
          <h3 id="reception-alignment-title" className={"text-sm font-semibold " + (comparison === "unavailable" ? "text-zinc-400" : "text-violet-200")}>{selected.title}</h3>
          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex justify-between gap-3"><dt className="text-zinc-500">Current players</dt><dd className="text-zinc-200">{selected.player}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-zinc-500">Metacritic record</dt><dd className="text-zinc-200">{selected.critic}</dd></div>
          </dl>
        </section>
        <details className="mt-3 border-t border-zinc-900 pt-2 text-xs text-zinc-400">
          <summary className="cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Comparison details</summary>
          <div className="mt-2 space-y-2 leading-relaxed">
            <p>{selected.note}</p>
            <p>Review-time comparison unavailable: critic review dates and a matching player snapshot are missing.</p>
            <p className="text-zinc-500">Metacritic checked September 7, 2026.</p>
          </div>
        </details>
        <nav aria-label="Comparison prototype scenarios" className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded border border-zinc-600 bg-zinc-100 px-3 py-2 text-xs text-zinc-950 shadow-xl">
          <label htmlFor="comparison-scenario" className="shrink-0 font-mono">Sample comparison</label>
          <select id="comparison-scenario" value={comparison} onChange={event => setComparison(event.target.value)} className="min-w-0 rounded border border-zinc-400 bg-white p-2 text-zinc-950">
            <option value="aligned">Aligned</option><option value="mixed">Mixed / favorable</option><option value="divergent">Divergent</option><option value="unavailable">Unavailable</option>
          </select>
        </nav>
      </> : <p className="mt-5 text-sm text-zinc-500">No critic coverage yet.</p>}
    </aside>
  );
}

type EventWithLayout = HistoryEvent & { timestamp: number; lane: number };

function HistoryEventLabel({ viewBox, event, edge, active, tooltipId, onActivate, onDeactivate }: {
  viewBox?: { x?: number; y?: number };
  event: EventWithLayout;
  edge: boolean;
  active: boolean;
  tooltipId: string;
  onActivate: (keyboard?: boolean) => void;
  onDeactivate: () => void;
}) {
  const shortLabel = SHORT_EVENT_LABELS[event.label] ?? event.label.slice(0, 4);
  return (
    <foreignObject x={(viewBox?.x ?? 0) + (edge ? -46 : 3)} y={(viewBox?.y ?? 0) + event.lane * 26} width={44} height={26}>
      <button
        type="button"
        className="score-event-label pointer-events-auto block h-6 w-11 truncate border border-violet-400/50 bg-zinc-950 px-1 text-left font-mono text-[10px] font-semibold text-violet-200 hover:bg-violet-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        aria-label={event.label + " · " + formatEventDate(event.date)}
        aria-describedby={active ? tooltipId : undefined}
        onMouseEnter={() => onActivate(false)}
        onFocus={() => onActivate(true)}
        onClick={() => onActivate(false)}
        onBlur={onDeactivate}
        onMouseLeave={target => { if (document.activeElement !== target.currentTarget) onDeactivate(); }}
        onKeyDown={keyboardEvent => { if (keyboardEvent.key === "Escape") { keyboardEvent.preventDefault(); onDeactivate(); } }}
      >
        {shortLabel}
      </button>
    </foreignObject>
  );
}

function ScoreChart({ points, domain, metricLabel, events, appid }: {
  points: ScoreObservation[];
  domain: [number, number];
  metricLabel: string;
  events: readonly HistoryEvent[];
  appid: number;
}) {
  const [activeEvent, setActiveEvent] = useState<number | null>(null);
  const [hoveredValue, setHoveredValue] = useState<number | null>(null);
  const [markerFromKeyboard, setMarkerFromKeyboard] = useState(false);
  const historyStart = points[0]?.timestamp ?? domain[0];
  const historyEnd = points[points.length - 1]?.timestamp ?? domain[1];
  const laneEnds = [-Infinity, -Infinity, -Infinity, -Infinity];
  const laidOutEvents: EventWithLayout[] = events.flatMap(event => {
    const timestamp = Date.parse(event.date + "T00:00:00Z");
    if (!Number.isFinite(timestamp) || timestamp < historyStart || timestamp > historyEnd) return [];
    const fraction = (timestamp - historyStart) / Math.max(1, historyEnd - historyStart);
    const laneIndex = laneEnds.findIndex(previous => fraction - previous > 0.16);
    const lane = laneIndex < 0 ? laneEnds.length - 1 : laneIndex;
    laneEnds[lane] = fraction;
    return [{ ...event, timestamp, lane }];
  });
  const selectedEvent = activeEvent === null ? undefined : laidOutEvents[activeEvent];
  const tooltipId = `score-event-tooltip-${appid}`;
  return (
    <div className="relative" data-x-domain-start={domain[0]} data-x-domain-end={domain[1]}>
      <ChartContainer config={{ score: { label: metricLabel, color: "#a78bfa" } }} className="h-[240px] w-full aspect-auto">
        <AreaChart
          data={points}
          accessibilityLayer
          margin={{ top: 12, right: 18, left: 0, bottom: 0 }}
          onMouseMove={state => setHoveredValue(typeof state?.activePayload?.[0]?.value === "number" ? state.activePayload[0].value : null)}
          onMouseLeave={() => { setHoveredValue(null); if (!document.activeElement?.classList.contains("score-event-label")) setActiveEvent(null); }}
        >
          <defs>
            <linearGradient id={`score-area-${appid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={domain}
            allowDataOverflow
            tickLine={false}
            axisLine={false}
            stroke="#71717a"
            fontSize={10}
            minTickGap={40}
            tickFormatter={value => formatDate(Number(value))}
          />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={34} tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} />
          {laidOutEvents.map((event, index) => (
            <ReferenceLine
              key={event.kind + event.date}
              x={event.timestamp}
              stroke="#a78bfa"
              strokeDasharray="3 3"
              onMouseEnter={() => { setActiveEvent(index); setMarkerFromKeyboard(false); }}
              onClick={() => { setActiveEvent(index); setMarkerFromKeyboard(false); }}
              onMouseLeave={() => { if (!document.activeElement?.classList.contains("score-event-label")) setActiveEvent(null); }}
              label={<HistoryEventLabel
                event={event}
                edge={event.timestamp > historyStart + (historyEnd - historyStart) * 0.88}
                active={activeEvent === index}
                tooltipId={tooltipId}
                onActivate={keyboard => { setActiveEvent(index); setMarkerFromKeyboard(!!keyboard); }}
                onDeactivate={() => setActiveEvent(null)}
              />}
            />
          ))}
          {hoveredValue !== null && !selectedEvent && <ReferenceLine y={hoveredValue} stroke="#a78bfa" strokeDasharray="3 3" />}
          <ChartTooltip
            {...(selectedEvent ? { active: true, ...(markerFromKeyboard ? { position: { x: 42, y: 118 } } : {}), wrapperStyle: { visibility: "visible" as const } } : {})}
            isAnimationActive={false}
            cursor={selectedEvent ? false : { stroke: "#71717a", strokeDasharray: "3 3" }}
            content={props => (
              <div id={selectedEvent ? tooltipId : undefined} role={selectedEvent ? "tooltip" : undefined}>
                <ChartTooltipContent
                  label={selectedEvent ? selectedEvent.label : props.label}
                  active={selectedEvent ? true : props.active}
                  payload={selectedEvent ? [{ dataKey: "score", name: "event", value: selectedEvent.label, color: "#a78bfa", payload: selectedEvent }] : props.payload}
                  className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100"
                  labelFormatter={(_, payload) => selectedEvent
                    ? selectedEvent.label
                    : formatTooltipDate(payload?.[0]?.payload?.timestamp ?? 0)}
                  formatter={(value, _, item) => selectedEvent
                    ? <span>{EVENT_KIND_LABELS[selectedEvent.kind]} · {formatEventDate(selectedEvent.date)}</span>
                    : <span><strong className="text-violet-300">{formatNumber(Number(value))}%</strong> · {formatNumber(Number(item.payload.reviews))} reviews{item.payload.partial ? " · latest month partial" : ""}</span>}
                />
              </div>
            )}
          />
          <Area dataKey="score" type="monotone" stroke="var(--color-score)" strokeWidth={1.8} fill={`url(#score-area-${appid})`} dot={points.length === 1 ? { r: 3 } : false} activeDot={{ r: 3 }} isAnimationActive={false} connectNulls={false} />
        </AreaChart>
      </ChartContainer>
      {points.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-xs text-zinc-500">
          No score observations in this range.
        </p>
      )}
    </div>
  );
}

function MilestonesDetails({ events }: { events: readonly HistoryEvent[] }) {
  if (!events.length) return null;
  return (
    <details className="mt-3 border-t border-zinc-900 pt-3 text-xs text-zinc-400">
      <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
        Milestones
      </summary>
      <ol className="mt-3 space-y-2">
        {events.map(event => (
          <li key={event.kind + event.date} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <time dateTime={event.date} className="font-mono text-zinc-500">{formatEventDate(event.date)}</time>
            <span className="text-zinc-300">{event.label}</span>
            <span className="text-zinc-500">({EVENT_KIND_LABELS[event.kind]})</span>
            <a href={event.sourceUrl} target="_blank" rel="noreferrer" className="text-violet-300 underline decoration-violet-500/50 underline-offset-2 hover:text-violet-200">
              Source ↗
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function ScoreHistory({ appid }: { appid: number }) {
  const history = appid === CYBERPUNK_APPID
    ? { points: cyberpunkObservations, metricLabel: cyberpunkHistory.metric, note: "Observed monthly Steam totals, not historical Current Player Scores. Latest month is incomplete.", source: cyberpunkHistory.source, events: cyberpunkEvents }
    : { points: observations, metricLabel: "Illustrative Current Player Score", note: "Illustrative score observations with a fixed reference time of September 7, 2026 UTC.", source: null, events: [] as readonly HistoryEvent[] };
  const [range, setRange] = useState<ScoreRange>("all");
  const domain = useMemo(() => scoreDomain(range, history.points), [range, history.points]);
  const points = useMemo(
    () => history.points.filter(point => point.timestamp >= domain[0] && point.timestamp <= domain[1]),
    [domain, history.points]
  );
  if (!scorePrototypeEnabled) return null;
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
    <section id="score-history" className="min-w-0 scroll-mt-28 border border-zinc-800 bg-zinc-950 p-5" aria-labelledby="score-history-title">
      <header className="flex flex-col justify-between gap-3 border-b border-zinc-900 pb-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 bg-violet-500" aria-hidden="true" />
          <div>
            <h2 id="score-history-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Score History</h2>
            <p className="mt-1 text-[11px] font-mono text-zinc-500">{history.metricLabel}</p>
          </div>
        </div>
        <div className="flex items-center space-x-1" role="group" aria-label="Score history time ranges">
          {scoreRanges.map(item => {
            const active = range === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => setRange(item)}
                aria-pressed={active}
                className={"min-h-[44px] min-w-[44px] px-2.5 py-1 inline-flex items-center justify-center rounded-none text-[11px] font-mono uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 " + (active ? "bg-violet-600 font-semibold text-white" : "border border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-violet-500/15 hover:text-violet-200")}
              >
                {formatRange(item)}
              </button>
            );
          })}
        </div>
      </header>
      <ScoreMetrics points={points} monthly={appid === CYBERPUNK_APPID} />
      <div className="mt-4 overflow-hidden" data-testid="score-history-chart">
        <ScoreChart points={points} domain={domain} metricLabel={history.metricLabel} events={history.events} appid={appid} />
      </div>
      <MilestonesDetails events={history.events} />
      <details className="mt-3 border-t border-zinc-900 pt-3 text-xs text-zinc-400">
        <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
          Score details
        </summary>
        <div className="mt-3 space-y-2 leading-relaxed">
          <p>{history.note}</p>
          {history.source && (
            <p>Data source: <a href={history.source} target="_blank" rel="noreferrer" className="text-violet-300 underline decoration-violet-500/50 underline-offset-2 hover:text-violet-200">Steam review histogram ↗</a></p>
          )}
        </div>
      </details>
    </section>
      <CriticReception appid={appid} />
    </div>
  );
}
