import React, { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { useQuery } from "@tanstack/react-query";
import type {
  GameScoreHistory,
  GameScoreSummary,
  HistoryMetric,
  RecentReceptionPayload,
  RecentReceptionPeriodPayload,
  ScoreCriticAlignment,
  ScoreCriticRecord,
  ScoreMilestone,
  ScorePopulationReference,
} from "../lib/score";
import type { HistoryRange } from "../lib/player-history";
import type { ReviewInterval } from "../lib/review-evidence";
import { formatLocalDateTime, formatNumber } from "../lib/format";
import { wilson95 } from "../lib/recent-reception";
import { gameScoreHistoryQueryOptions, gameScoreSummaryQueryOptions } from "../lib/score-query";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart";
import "./game-reception.css";

const SCORE_RANGES: readonly HistoryRange[] = ["24h", "7d", "30d", "90d", "all"];
const SCORE_COLOR = "#a78bfa";
const WILSON_RULE =
  "More positive or Less positive requires at least a 5 percentage-point difference and non-overlapping two-sided 95% Wilson intervals. Otherwise supported comparisons are No clear shift.";

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${formatNumber(value, { maximumFractionDigits: 1 })}%`;
}

function formatBoundary(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDateOnly(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function displayState(value: RecentReceptionPayload["state"]): string {
  switch (value) {
    case "more_positive": return "More positive";
    case "less_positive": return "Less positive";
    case "no_clear_shift": return "No clear shift";
    case "insufficient_evidence": return "Not enough evidence";
  }
}

function stateClass(value: RecentReceptionPayload["state"]): string {
  if (value === "more_positive") return "text-emerald-300";
  if (value === "less_positive") return "text-rose-300";
  return "text-zinc-400";
}

function ScoreHero({ summary }: { summary: GameScoreSummary | null | undefined }) {
  const score = summary?.score?.value ?? null;
  const reviews = summary?.score?.current_reviews ?? null;
  return (
    <section id="player-score" className="score-hero border border-violet-500/30 bg-zinc-950 p-4 sm:p-5" aria-labelledby="player-score-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="player-score-title" className="font-mono text-[11px] uppercase tracking-wider text-zinc-300">Current Player Score</h2>
        <span className="h-2 w-2 bg-violet-400" aria-hidden="true" />
      </div>
      <div className="pt-3 text-right">
        {score === null ? (
          <p className="font-mono text-xl text-zinc-500">No data yet</p>
        ) : (
          <p className="font-mono text-3xl font-bold tabular-nums text-violet-200" aria-label={`Current Player Score ${formatPercent(score)}`}>
            {formatNumber(score, { maximumFractionDigits: 1 })}
          </p>
        )}
        <p className="mt-1 font-mono text-[11px] text-zinc-500">
          {reviews === null ? "Qualifying reviews unavailable" : `${formatNumber(reviews)} qualifying reviews`}
        </p>
      </div>
    </section>
  );
}

function metricValue(metric: HistoryMetric | null): number | null {
  if (!metric || typeof metric.value !== "number" || !Number.isFinite(metric.value)) return null;
  return metric.value;
}

function ScoreMetrics({ history }: { history: GameScoreHistory | null | undefined }) {
  const latestApproval = metricValue(history?.metrics.latest_approval ?? null);
  const reviewsInPeriod = metricValue(history?.metrics.reviews_in_period ?? null);
  return (
    <div className="grid grid-cols-2 gap-2 pt-3 font-mono text-xs" aria-label="Score history metrics">
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">Latest approval</span>
        <span className="font-bold tabular-nums text-violet-300">{formatPercent(latestApproval)}</span>
      </div>
      <div className="border border-zinc-900 bg-zinc-900/40 p-2">
        <span className="block text-[10px] uppercase text-zinc-500">Reviews in period</span>
        <span className="tabular-nums text-zinc-300">{reviewsInPeriod === null ? "—" : formatNumber(reviewsInPeriod)}</span>
      </div>
    </div>
  );
}

type ChartPoint = { timestamp: number; score: number; reviews: number };

function historyPoints(history: GameScoreHistory | null | undefined): ChartPoint[] {
  if (!history) return [];
  return history.recorded_scores.flatMap((entry) => {
    const timestamp = Date.parse(entry.observed_at);
    if (!Number.isFinite(timestamp)) return [];
    return [{ timestamp, score: entry.value, reviews: entry.current_reviews }];
  });
}

function historyMilestones(history: GameScoreHistory | null | undefined): ScoreMilestone[] {
  return history?.milestones.filter((milestone) => Number.isFinite(Date.parse(milestone.event_time))) ?? [];
}

function historyDomain(history: GameScoreHistory | null | undefined, points: readonly ChartPoint[]): [number, number] {
  const start = history?.range_start ? Date.parse(history.range_start) : NaN;
  const end = history?.range_end ? Date.parse(history.range_end) : NaN;
  const first = points[0]?.timestamp ?? 0;
  const last = points.at(-1)?.timestamp ?? first;
  const from = Number.isFinite(start) ? start : first;
  const to = Number.isFinite(end) ? end : last;
  return [from, Math.max(from + 1, to)];
}

function milestoneKindLabel(kind: string | null): string {
  if (!kind) return "Milestone";
  return kind.replaceAll("_", " ");
}

function MilestoneLabel({
  viewBox,
  milestone,
  active,
  alignLeft,
  onActivate,
  onDeactivate,
}: {
  viewBox?: { x?: number; y?: number };
  milestone: ScoreMilestone;
  active: boolean;
  alignLeft: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}) {
  const x = (viewBox?.x ?? 0) + (alignLeft ? -65 : 3);
  const y = (viewBox?.y ?? 0) + 3;
  return (
    <foreignObject x={x} y={y} width={62} height={25}>
      <button
        type="button"
        className={`score-event-label block h-6 max-w-[62px] truncate border border-violet-400/50 bg-zinc-950 px-1 text-left font-mono text-[10px] font-semibold text-violet-200 hover:bg-violet-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${alignLeft ? "ml-auto" : ""}`}
        aria-label={`${milestone.display_label} · ${formatDateOnly(milestone.event_time)}`}
        aria-describedby={active ? `score-milestone-${milestone.event_id}` : undefined}
        onMouseEnter={onActivate}
        onFocus={onActivate}
        onClick={onActivate}
        onBlur={onDeactivate}
        onMouseLeave={(event) => {
          if (document.activeElement !== event.currentTarget) onDeactivate();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDeactivate();
          }
        }}
      >
        {milestone.display_label}
      </button>
    </foreignObject>
  );
}

function ScoreChart({ history, appid, isUpdating }: { history: GameScoreHistory | null | undefined; appid: number; isUpdating: boolean }) {
  const points = useMemo(() => historyPoints(history), [history]);
  const milestones = useMemo(() => historyMilestones(history), [history]);
  const domain = useMemo(() => historyDomain(history, points), [history, points]);
  const domainMidpoint = (domain[0] + domain[1]) / 2;
  const visibleMilestones = milestones.filter((milestone) => {
    const timestamp = Date.parse(milestone.event_time);
    return timestamp >= domain[0] && timestamp <= domain[1];
  });
  const [hoveredValue, setHoveredValue] = useState<number | null>(null);
  const [activeMilestone, setActiveMilestone] = useState<string | null>(null);
  const active = visibleMilestones.find((milestone) => milestone.event_id === activeMilestone) ?? null;
  const chartConfig = { score: { label: "Current Player Score", color: SCORE_COLOR } } satisfies ChartConfig;
  return (
    <div className={`relative transition-opacity duration-200 ${isUpdating ? "opacity-50" : "opacity-100"}`} data-score-range={history?.range ?? "none"}>
      <ChartContainer config={chartConfig} className="h-[240px] w-full aspect-auto">
        <AreaChart
          data={points}
          accessibilityLayer
          margin={{ top: 12, right: 18, left: 0, bottom: 0 }}
          onMouseMove={(state) => {
            const value = Number(state.activePayload?.[0]?.value);
            setHoveredValue(Number.isFinite(value) ? value : null);
          }}
          onMouseLeave={() => {
            setHoveredValue(null);
            if (!document.activeElement?.classList.contains("score-event-label")) setActiveMilestone(null);
          }}
        >
          <defs>
            <linearGradient id={`score-area-${appid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SCORE_COLOR} stopOpacity={0.3} />
              <stop offset="95%" stopColor={SCORE_COLOR} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis dataKey="timestamp" type="number" domain={domain} allowDataOverflow tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} minTickGap={40} tickFormatter={(value) => formatDateOnly(new Date(Number(value)).toISOString())} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={34} tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} />
          {visibleMilestones.map((milestone) => {
            const timestamp = Date.parse(milestone.event_time);
            return (
              <ReferenceLine
                key={milestone.event_id}
                x={timestamp}
                stroke={SCORE_COLOR}
                strokeDasharray="3 3"
                onMouseEnter={() => setActiveMilestone(milestone.event_id)}
                onClick={() => setActiveMilestone(milestone.event_id)}
                onMouseLeave={() => {
                  if (!document.activeElement?.classList.contains("score-event-label")) setActiveMilestone(null);
                }}
                label={<MilestoneLabel milestone={milestone} alignLeft={timestamp >= domainMidpoint} active={activeMilestone === milestone.event_id} onActivate={() => setActiveMilestone(milestone.event_id)} onDeactivate={() => setActiveMilestone(null)} />}
              />
            );
          })}
          {hoveredValue !== null && active === null && <ReferenceLine y={hoveredValue} stroke={SCORE_COLOR} strokeDasharray="3 3" />}
          <ChartTooltip
            content={
              <ChartTooltipContent
                className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100"
                labelFormatter={(_, payload) => {
                  const timestamp = payload?.[0]?.payload?.timestamp;
                  return typeof timestamp === "number" ? formatLocalDateTime(new Date(timestamp)) : "";
                }}
                formatter={(value, _name, item) => (
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="font-mono font-medium text-violet-200">{formatNumber(Number(value), { maximumFractionDigits: 1 })}</span>
                    <span className="text-zinc-400">{formatNumber(item?.payload?.reviews)} reviews</span>
                  </div>
                )}
              />
            }
          />
          <Area dataKey="score" type="monotone" stroke="var(--color-score)" strokeWidth={1.8} fill={`url(#score-area-${appid})`} dot={points.length === 1 ? { r: 3 } : false} activeDot={{ r: 3 }} isAnimationActive={false} connectNulls={false} />
        </AreaChart>
      </ChartContainer>
      {active && (
        <div id={`score-milestone-${active.event_id}`} role="tooltip" className="pointer-events-auto absolute left-2 top-1 z-10 max-w-[min(22rem,calc(100%-1rem))] border border-violet-400/50 bg-zinc-950 p-2 text-xs text-zinc-200 shadow-xl">
          <p className="font-semibold text-violet-200">{active.title ?? active.display_label}</p>
          <p className="mt-1 text-zinc-400">{milestoneKindLabel(active.kind)} · {formatDateOnly(active.event_time)}</p>
          {active.source_url && <a href={active.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-violet-300 underline underline-offset-2">Source ↗</a>}
        </div>
      )}
      {points.length === 0 && <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-xs text-zinc-500">No score observations in this range.</p>}
    </div>
  );
}

function displayPopulationValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  if (typeof value === "object") return JSON.stringify(value) ?? "Unknown";
  return String(value);
}

function populationDetails(label: string, population: ScorePopulationReference | null, sourceId: string | null = null): React.ReactNode {
  return (
    <div className="wrap-anywhere border-l border-zinc-800 pl-2">
      <p className="text-zinc-300">{label}</p>
      <p>Source: {displayPopulationValue(sourceId ?? population?.source_id)}; endpoint: {displayPopulationValue(population?.endpoint)}</p>
      <p>Request filter: {displayPopulationValue(population?.request_filter)}</p>
      <p>Language: {displayPopulationValue(population?.language)}; purchase type: {displayPopulationValue(population?.purchase_type)}; filter off-topic activity: {displayPopulationValue(population?.filter_offtopic_activity)}</p>
      <p>Population: {displayPopulationValue(population?.population)}; flags: {displayPopulationValue(population?.population_flags)}</p>
    </div>
  );
}

function ScoreDetails({ summary, history }: { summary: GameScoreSummary | null | undefined; history: GameScoreHistory | null | undefined }) {
  const score = summary?.score;
  const uncertainty = score ? wilson95(score.current_positive_reviews, score.current_total_reviews) : null;
  return (
    <details className="mt-3 border-t border-zinc-900 pt-3 text-xs text-zinc-400">
      <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Score details</summary>
      <div className="mt-3 space-y-2 leading-relaxed">
        <p>Current Player Score is a player-evidence estimate. Historical observations remain separate from monthly approval buckets and do not imply that a milestone caused a change.</p>
        {score && <>
          <p>Observed at: <span className="text-zinc-300">{formatLocalDateTime(score.observed_at)}</span>; formula version: <span className="text-zinc-300">{score.formula_version}</span></p>
          <p>Current evidence: <span className="text-zinc-300">{formatNumber(score.current_reviews)} reviews</span>; historical support: <span className="text-zinc-300">{formatNumber(score.historical_support.actual_reviews)} actual / {formatNumber(score.historical_support.effective_reviews)} effective</span></p>
          <p>Sampling uncertainty: <span className="text-zinc-300">{uncertainty ? `${formatPercent(uncertainty.lower)}–${formatPercent(uncertainty.upper)}` : "Unavailable"}</span> (95% Wilson interval for current raw approval). This excludes historical support and does not measure selection bias.</p>
          <p>Current reviews have full weight. Historical approval contributes at most 20 effective reviews, capped by its actual sample. Without usable history, one neutral effective review stabilizes small samples. Critic scores do not affect this estimate.</p>
          <p>Evidence window: <span className="text-zinc-300">{formatBoundary(score.evidence_start)}–{formatBoundary(score.evidence_end)}</span>; score window: <span className="text-zinc-300">{formatBoundary(score.score_window.start)}–{formatBoundary(score.score_window.end)}</span></p>
          {populationDetails("Current population", score.population_ref)}
          {populationDetails("Historical population", score.historical_population_ref)}
          <p>Anchor: <span className="text-zinc-300">{score.anchor ? `${score.anchor.event_id ?? "Verified event"} · ${formatBoundary(score.anchor.start)}` : "None recorded"}</span></p>
        </>}
        <p>Selected history: <span className="text-zinc-300">{history?.range ?? "Unknown"} ({formatBoundary(history?.range_start ?? null)}–{formatBoundary(history?.range_end ?? null)})</span></p>
      </div>
    </details>
  );
}

function ScoreHistoryCard({ appid, range, setRange, history, summary, isUpdating }: { appid: number; range: HistoryRange; setRange: (range: HistoryRange) => void; history: GameScoreHistory | null | undefined; summary: GameScoreSummary | null | undefined; isUpdating: boolean }) {
  const milestones = historyMilestones(history);
  return (
    <section id="score-history" className="min-w-0 border border-zinc-800 bg-zinc-950 p-4 sm:p-5" aria-labelledby="score-history-title">
      <header className="flex flex-col justify-between gap-3 border-b border-zinc-900 pb-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 bg-violet-400" aria-hidden="true" />
          <div><h2 id="score-history-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Score History</h2><p className="mt-1 font-mono text-[11px] text-zinc-500">Recorded Current Player Score observations</p></div>
        </div>
        {isUpdating && <span className="font-mono text-[10px] text-violet-300" role="status">Updating…</span>}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Score history time ranges">
          {SCORE_RANGES.map((item) => <button key={item} type="button" onClick={() => setRange(item)} aria-pressed={range === item} className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${range === item ? "border-violet-500 bg-violet-600 text-white" : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-violet-500/15 hover:text-violet-200"}`}>{item === "all" ? "All" : item}</button>)}
        </div>
      </header>
      <ScoreMetrics history={history} />
      <div className="mt-4 overflow-hidden" data-testid="score-history-chart"><ScoreChart appid={appid} history={history} isUpdating={isUpdating} /></div>
      <details className="mt-3 border-t border-zinc-900 pt-3 text-xs text-zinc-400">
        <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Milestones</summary>
        <ol className="mt-3 space-y-2">
          {milestones.length === 0 ? <li>No sourced milestones in this range.</li> : milestones.map((milestone) => <li key={milestone.event_id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><time dateTime={milestone.event_time} className="font-mono text-zinc-500">{formatDateOnly(milestone.event_time)}</time><span className="text-zinc-300">{milestone.title ?? milestone.display_label}</span>{milestone.kind && <span className="text-zinc-500">({milestoneKindLabel(milestone.kind)})</span>}{milestone.source_url && <a href={milestone.source_url} target="_blank" rel="noreferrer" className="text-violet-300 underline underline-offset-2">Source ↗</a>}</li>)}
        </ol>
      </details>
      <ScoreDetails summary={summary} history={history} />
    </section>
  );
}

function criticNativeValue(critic: ScoreCriticRecord): string {
  if (critic.native_score !== null) return formatNumber(critic.native_score, { maximumFractionDigits: 1 });
  return critic.native_tier ?? "Unknown";
}

function criticName(critic: ScoreCriticRecord): string {
  return critic.source === "metacritic" ? "Metacritic" : "OpenCritic";
}

function alignmentFor(alignments: readonly ScoreCriticAlignment[], critic: ScoreCriticRecord): ScoreCriticAlignment | null {
  return alignments.find((alignment) => alignment.source === critic.source) ?? null;
}

function alignmentValueLabel(value: ScoreCriticAlignment["alignment"]): string {
  switch (value) {
    case "broadly_aligned": return "Broadly aligned";
    case "players_more_favorable": return "Audience more favorable";
    case "critics_more_favorable": return "Critics more favorable";
    case "clearly_divergent": return "Clearly divergent";
    default: return "Unavailable";
  }
}

function alignmentLabel(alignment: ScoreCriticAlignment | null): string | null {
  return alignment?.alignment ? alignmentValueLabel(alignment.alignment) : null;
}

function CriticRecord({ critic, alignment }: { critic: ScoreCriticRecord; alignment: ScoreCriticAlignment | null }) {
  const label = alignmentLabel(alignment);
  const labelClass = label === "Broadly aligned" ? "text-emerald-300/80" : label === "Clearly divergent" ? "text-rose-300/80" : "text-zinc-300";
  return (
    <article className="border-b border-zinc-900 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">{critic.source_url ? <a href={critic.source_url} target="_blank" rel="noreferrer" className="text-sm text-zinc-200 hover:text-violet-200 hover:underline">{criticName(critic)} ↗</a> : <p className="text-sm text-zinc-200">{criticName(critic)}</p>}<p className="mt-1 font-mono text-[10px] uppercase text-zinc-500">{critic.platform_scope} · {critic.edition || "Unknown edition"}</p></div>
        <p className="font-mono text-2xl font-bold tabular-nums text-zinc-100">{criticNativeValue(critic)}</p>
      </div>
      <p className="mt-1 font-mono text-xs text-zinc-500">{critic.review_count === null ? "Review count unavailable" : formatNumber(critic.review_count) + " critic reviews"}</p>
      <p className="mt-1 text-[11px] text-zinc-500">{critic.review_period_start || critic.review_period_end ? "Review dates: " + formatDateOnly(critic.review_period_start) + "–" + formatDateOnly(critic.review_period_end) : "Review dates unavailable"}</p>
      <p className="mt-1 text-[11px] text-zinc-500">Source observed: {formatLocalDateTime(critic.observed_at)} · native scale: {critic.score_scale === null ? "Unknown" : formatNumber(critic.score_scale)}</p>
      {label && <p className={`mt-2 text-xs font-semibold ${labelClass}`}>{label}</p>}
      {alignment && <p className="mt-1 text-[11px] text-zinc-500">Review-time: {label ?? "Unavailable"}; current contrast: {alignment.current_contrast.state === "classified" && alignment.current_contrast.alignment ? alignmentValueLabel(alignment.current_contrast.alignment) : "Unavailable"}</p>}
    </article>
  );
}

function intervalList(intervals: readonly ReviewInterval[]): string {
  if (intervals.length === 0) return "None recorded";
  return intervals.map((interval) => `${formatDateOnly(interval.start)}–${formatDateOnly(interval.end)} (${interval.granularity})`).join(", ");
}

function periodDetails(label: string, period: RecentReceptionPeriodPayload): React.ReactNode {
  return (
    <div className="border-l border-zinc-800 pl-2">
      <p className="text-zinc-300">{label}: {formatBoundary(period.start)}–{formatBoundary(period.end)}</p>
      <p>{period.positive_reviews === null || period.total_reviews === null ? "Counts unavailable" : `${formatNumber(period.positive_reviews)} positive of ${formatNumber(period.total_reviews)} reviews · ${formatPercent(period.approval)}`}</p>
      <p>Covered intervals: {intervalList(period.covered_intervals)}; gaps: {intervalList(period.gaps)}</p>
      {populationDetails("Population", period.population_ref, period.source_id)}
      <p>Source observations: {period.observation_times.length ? period.observation_times.map(formatBoundary).join(", ") : "Unknown"}</p>
    </div>
  );
}

function RecentReception({ recent }: { recent: RecentReceptionPayload }) {
  return (
    <section className="mt-4 border-t border-zinc-800 pt-3" aria-labelledby="recent-reception-title">
      <div className="flex items-center justify-between gap-3"><h3 id="recent-reception-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Recent reception</h3><span className={`font-mono text-xs font-semibold ${stateClass(recent.state)}`}>{displayState(recent.state)}</span></div>
      <details className="mt-2 text-xs text-zinc-400">
        <summary className="cursor-pointer py-1 text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Comparison details</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>Recent reception compares reviewer approval, not Current Player Score, critic reception, rank, quality, or patch impact. A supported result does not establish causation.</p>
          <p>Evaluated at: <span className="text-zinc-300">{formatBoundary(recent.evaluated_at)}</span>; cutoff: <span className="text-zinc-300">{formatBoundary(recent.cutoff)}</span></p>
          {periodDetails("Recent", recent.recent)}
          {periodDetails("Previous", recent.previous)}
          <p>Approval delta: <span className="text-zinc-300">{formatPercent(recent.delta_pp)} percentage points</span></p>
          {recent.reasons.length > 0 && <p>Evidence notes: <span className="text-zinc-300">{recent.reasons.map((reason) => reason.replaceAll("_", " ")).join(", ")}</span></p>}
          <p>{WILSON_RULE}</p>
          <p>Both periods require complete whole-bucket coverage and at least 50 actual compatible Steam histogram reviews. A supported zero-review interval is covered; missing evidence is not zero.</p>
        </div>
      </details>
    </section>
  );
}

function ReceptionCard({ summary }: { summary: GameScoreSummary | null | undefined }) {
  const score = summary?.score?.value ?? null;
  const reviews = summary?.score?.current_reviews ?? null;
  return (
    <aside id="critic-reception" className="score-reception-card min-w-0 border border-zinc-800 bg-zinc-950 p-4 sm:p-5 xl:flex xl:flex-col xl:self-stretch" aria-labelledby="critic-reception-title">
      <h2 id="critic-reception-title" className="border-b border-zinc-900 pb-3 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Reception</h2>
      <div className="border-b border-zinc-800 py-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm text-zinc-200">Current Player Score</p><p className="mt-1 font-mono text-[10px] uppercase text-zinc-500">Player evidence</p></div><p className="font-mono text-3xl font-bold tabular-nums text-violet-200">{score === null ? "—" : formatNumber(score, { maximumFractionDigits: 1 })}</p></div><p className="mt-1 font-mono text-xs text-zinc-500">{reviews === null ? "Reviews unavailable" : `${formatNumber(reviews)} reviews`}</p></div>
      <div className="xl:flex-1">{summary?.critics.length ? summary.critics.map((critic) => <CriticRecord key={`${critic.source}-${critic.source_id}`} critic={critic} alignment={alignmentFor(summary.alignment, critic)} />) : <p className="mt-4 text-sm text-zinc-500">No critic coverage yet.</p>}{summary?.recent_reception && <RecentReception recent={summary.recent_reception} />}</div>
      <details className="mt-3 border-t border-zinc-900 pt-2 text-xs text-zinc-400 xl:mt-auto"><summary className="cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Source and comparison limits</summary><div className="mt-2 space-y-2 leading-relaxed"><p>Critic records remain source-native. Scores and tiers are not blended with player evidence or subtracted from it.</p><p>Alignment is shown only when source-specific identity, PC/edition scope, player snapshot, review-time evidence, and freshness gates support it. Unknown limits remain unknown.</p></div></details>
    </aside>
  );
}

export function GameReception({ appid }: { appid: number }) {
  const [range, setRange] = useState<HistoryRange>("30d");
  const summaryQuery = useQuery(gameScoreSummaryQueryOptions(appid));
  const historyQuery = useQuery(gameScoreHistoryQueryOptions(appid, range));
  const history = historyQuery.data;
  const isUpdating = historyQuery.isFetching && historyQuery.isPlaceholderData === true;
  return (
    <section id="game-reception" className="space-y-4" aria-label="Game reception">
      <ScoreHero summary={summaryQuery.data} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)] xl:items-stretch">
        <ScoreHistoryCard appid={appid} range={range} setRange={setRange} history={history} summary={summaryQuery.data} isUpdating={isUpdating} />
        <ReceptionCard summary={summaryQuery.data} />
      </div>
      {summaryQuery.isError && <p className="font-mono text-xs text-zinc-500" role="status">Reception data unavailable.</p>}
    </section>
  );
}
