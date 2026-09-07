import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

export const scorePrototypeEnabled = import.meta.env.DEV || import.meta.env.VITE_PROTOTYPE === "true";

type ScoreRange = "24h" | "7d" | "30d" | "90d" | "all";
type ScoreObservation = { timestamp: number; score: number; reviews: number };

// Fixed to the fixture's reference date so prototype ranges do not drift with the wall clock.
const REFERENCE_TIME = Date.parse("2026-09-07T00:00:00Z");
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
const scoreRanges: readonly ScoreRange[] = ["24h", "7d", "30d", "90d", "all"];
const rangeSpans: Record<Exclude<ScoreRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

const formatNumber = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const formatDate = (timestamp: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
const formatTooltipDate = (timestamp: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
const formatRange = (range: ScoreRange) => range === "all" ? "All" : range;

function scoreDomain(range: ScoreRange): [number, number] {
  if (range === "all") {
    return [observations[0].timestamp, observations[observations.length - 1].timestamp];
  }
  return [REFERENCE_TIME - rangeSpans[range], REFERENCE_TIME];
}

function ScoreBadge() {
  return (
    <div className="flex shrink-0 flex-col items-center">
      <div
        className="h-20 w-20 bg-violet-300 p-px"
        style={{ clipPath: "polygon(0 8px, 8px 0, calc(100% - 8px) 0, 100% 8px, 100% calc(100% - 8px), calc(100% - 8px) 100%, 8px 100%, 0 calc(100% - 8px))" }}
      >
        <div
          className="grid h-full w-full place-items-center bg-zinc-950"
          style={{ clipPath: "polygon(0 8px, 8px 0, calc(100% - 8px) 0, 100% 8px, 100% calc(100% - 8px), calc(100% - 8px) 100%, 8px 100%, 0 calc(100% - 8px))" }}
        >
          <strong
            className="font-mono text-3xl font-bold leading-none tabular-nums text-violet-200"
            title="Current Player Score: 84"
            aria-label="Current Player Score: 84"
          >
            {CURRENT_SCORE}
          </strong>
        </div>
      </div>
      <span
        className="mt-2 cursor-help text-center font-mono text-[11px] text-zinc-400"
        title="Qualifying player reviews represented by the current score"
        tabIndex={0}
        aria-label={formatNumber(CURRENT_REVIEW_COUNT) + " qualifying player reviews"}
      >
        {formatNumber(CURRENT_REVIEW_COUNT)} reviews
      </span>
    </div>
  );
}

export function ScoreHero() {
  if (!scorePrototypeEnabled) return null;
  return (
    <section id="player-score" className="h-full scroll-mt-28 border border-zinc-800 bg-zinc-950 p-5" aria-labelledby="score-hero-title">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 bg-violet-500" aria-hidden="true" />
        <h2 id="score-hero-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Current Player Score
        </h2>
      </div>
      <div className="mt-5 flex items-center gap-4">
        <ScoreBadge />
      </div>
    </section>
  );
}

function ScoreMetrics({ range, points }: { range: ScoreRange; points: readonly ScoreObservation[] }) {
  const values = points.map(point => point.score);
  const minimum = values.length ? Math.min(...values) : null;
  const maximum = values.length ? Math.max(...values) : null;
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const allTimePeak = Math.max(...observations.map(point => point.score));
  const metric = (value: number | null) => value === null ? "—" : formatNumber(value);
  const periodName = range.toUpperCase();
  return (
    <div className="grid grid-cols-2 gap-2 pt-1 text-xs font-mono sm:grid-cols-4">
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">Current</span>
        <span className="font-bold tabular-nums text-zinc-100">{formatNumber(CURRENT_SCORE)}</span>
      </div>
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">{range === "all" ? "All-Time Low" : periodName + " Low"}</span>
        <span className="tabular-nums text-zinc-300">{metric(minimum)}</span>
      </div>
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">{range === "all" ? "All-Time Avg" : periodName + " Peak"}</span>
        <span className="font-bold tabular-nums text-violet-300">{metric(range === "all" ? average : maximum)}</span>
      </div>
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">All-Time Peak</span>
        <span className="font-bold tabular-nums text-violet-300">{formatNumber(allTimePeak)}</span>
      </div>
    </div>
  );
}

function ScoreChart({ points, domain }: { points: ScoreObservation[]; domain: [number, number] }) {
  const [hoveredValue, setHoveredValue] = useState<number | null>(null);
  return (
    <div className="relative" data-x-domain-start={domain[0]} data-x-domain-end={domain[1]}>
      <ChartContainer config={{ score: { label: "Current Player Score", color: "#a78bfa" } }} className="h-[240px] w-full aspect-auto">
        <AreaChart
          data={points}
          accessibilityLayer
          margin={{ top: 12, right: 18, left: 0, bottom: 0 }}
          onMouseMove={state => setHoveredValue(typeof state?.activePayload?.[0]?.value === "number" ? state.activePayload[0].value : null)}
          onMouseLeave={() => setHoveredValue(null)}
        >
          <defs>
            <linearGradient id="score-area" x1="0" y1="0" x2="0" y2="1">
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
          {hoveredValue !== null && <ReferenceLine y={hoveredValue} stroke="#a78bfa" strokeDasharray="3 3" />}
          <ChartTooltip
            isAnimationActive={false}
            cursor={{ stroke: "#71717a", strokeDasharray: "3 3" }}
            content={<ChartTooltipContent
              className="!bg-zinc-950 !opacity-100 border-zinc-700 text-zinc-100 shadow-2xl"
              labelFormatter={(_, payload) => {
                const timestamp = payload?.[0]?.payload?.timestamp;
                return typeof timestamp === "number" ? formatTooltipDate(timestamp) : "";
              }}
              formatter={(value, _, item) => (
                <span><strong className="text-violet-300">{formatNumber(Number(value))}</strong> · {formatNumber(Number(item.payload.reviews))} reviews</span>
              )}
            />}
          />
          <Area dataKey="score" type="monotone" stroke="var(--color-score)" strokeWidth={1.8} fill="url(#score-area)" dot={points.length === 1 ? { r: 3 } : false} activeDot={{ r: 3 }} isAnimationActive={false} connectNulls={false} />
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

export function ScoreHistory() {
  const [range, setRange] = useState<ScoreRange>("90d");
  const domain = useMemo(() => scoreDomain(range), [range]);
  const points = useMemo(
    () => observations.filter(point => point.timestamp >= domain[0] && point.timestamp <= domain[1]),
    [domain]
  );
  if (!scorePrototypeEnabled) return null;
  return (
    <section id="score-history" className="scroll-mt-28 border border-zinc-800 bg-zinc-950 p-5" aria-labelledby="score-history-title">
      <header className="flex flex-col justify-between gap-3 border-b border-zinc-900 pb-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 bg-violet-500" aria-hidden="true" />
          <h2 id="score-history-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Score History</h2>
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
      <ScoreMetrics range={range} points={points} />
      <div className="mt-4 overflow-hidden" data-testid="score-history-chart">
        <ScoreChart points={points} domain={domain} />
      </div>
      <details className="mt-3 border-t border-zinc-900 pt-3 text-xs text-zinc-400">
        <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
          Score methodology
        </summary>
        <div className="mt-3 space-y-2 leading-relaxed">
          <p>This prototype uses illustrative score observations with a fixed reference time of September 7, 2026 UTC.</p>
          <p>The score estimates Steam player approval from recent reviews, supported by up to 20 effective historical reviews. Small samples are less certain; each new review contributes to the estimate.</p>
          <p>The shaded area follows the score line. It does not represent uncertainty or missing observations.</p>
        </div>
      </details>
    </section>
  );
}


