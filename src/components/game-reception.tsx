import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";
import { useQuery } from "@tanstack/react-query";
import type {
  GameScoreHistory,
  GameScoreSummary,
  HistoryMetric,
  ScoreCriticAlignment,
  ScoreCriticRecord,
  ScoreMilestone,
  RecordedScore,
  ReconstructedScore,
  ScorePopulationReference,
} from "../lib/score";
import type { HistoryRange } from "../lib/player-history";
import { formatLocalDateTime, formatNumber } from "../lib/format";
import { wilson95 } from "../lib/recent-reception";
import { gameScoreHistoryQueryOptions, gameScoreSummaryQueryOptions } from "../lib/score-query";
import { SCORE_MILESTONE_LABEL_GAP, SCORE_MILESTONE_LABEL_WIDTH, selectScoreMilestones } from "../lib/score-milestone-density";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart";
import { ScoreEventReader } from "./score-event-reader";
import { isEventWithinHistoryRange } from "../lib/game-params";
import "./game-reception.css";

const SCORE_RANGES: readonly HistoryRange[] = ["24h", "7d", "30d", "90d", "all"];
const SCORE_COLOR = "#a78bfa";
const SCORE_CHART_Y_AXIS_WIDTH = 34;
const SCORE_CHART_MARGIN_RIGHT = 18;

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


export function GameScoreHero({ appid }: { appid: number }) {
  const summaryQuery = useQuery(gameScoreSummaryQueryOptions(appid));
  const summary = summaryQuery.data;
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
          {reviews === null ? "Current scoring-window evidence unavailable" : `${formatNumber(reviews)} reviews in current scoring window`}
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

type ChartPoint = {
  timestamp: number;
  score: number;
  reviews: number;
  provenance: "recorded" | "reconstructed";
  details: RecordedScore | ReconstructedScore;
};

function displayHistoryPoints(history: GameScoreHistory | null | undefined): ChartPoint[] {
  if (!history) return [];
  const rangeStart = history.range_start ? Date.parse(history.range_start) : NaN;
  const rangeEnd = history.range_end ? Date.parse(history.range_end) : NaN;
  const byTimestamp = new Map<number, ChartPoint>();
  for (const entry of history.reconstructed_scores) {
    const timestamp = Date.parse(entry.score_at);
    if (!Number.isFinite(timestamp) || !Number.isFinite(entry.value)
      || (Number.isFinite(rangeStart) && timestamp < rangeStart)
      || (Number.isFinite(rangeEnd) && timestamp > rangeEnd)
      || byTimestamp.has(timestamp)) continue;
    byTimestamp.set(timestamp, { timestamp, score: entry.value, reviews: entry.current_reviews, provenance: "reconstructed", details: entry });
  }
  for (const entry of history.recorded_scores) {
    const timestamp = Date.parse(entry.observed_at);
    if (!Number.isFinite(timestamp)) continue;
    byTimestamp.set(timestamp, { timestamp, score: entry.value, reviews: entry.current_reviews, provenance: "recorded", details: entry });
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function chartPayloadValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
  selected,
  alignLeft,
  onPointerActivate,
  onFocusActivate,
  onDeactivate,
  onSelect,
}: {
  viewBox?: { x?: number; y?: number };
  milestone: ScoreMilestone;
  active: boolean;
  selected: boolean;
  alignLeft: boolean;
  onPointerActivate: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onFocusActivate: (event: React.FocusEvent<HTMLButtonElement>) => void;
  onDeactivate: (kind: "pointer" | "focus" | "all") => void;
  onSelect?: () => void;
}) {
  const x = (viewBox?.x ?? 0) + (alignLeft ? -(SCORE_MILESTONE_LABEL_WIDTH + SCORE_MILESTONE_LABEL_GAP) : SCORE_MILESTONE_LABEL_GAP);
  const y = (viewBox?.y ?? 0) + 3;
  return (
    <foreignObject x={x} y={y} width={SCORE_MILESTONE_LABEL_WIDTH} height={25}>
      <button
        type="button"
        className={`score-event-label block h-6 max-w-[62px] truncate border px-1 text-left font-mono text-[10px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${
          selected
            ? "border-violet-300 bg-violet-500/40 text-white ring-1 ring-violet-300"
            : "border-violet-400/50 bg-zinc-950 text-violet-200 hover:bg-violet-500/20"
        } ${alignLeft ? "ml-auto" : ""}`}
        aria-label={`${milestone.display_label} · ${formatDateOnly(milestone.event_time)}`}
        aria-describedby={active ? `score-milestone-${milestone.event_id}` : undefined}
        onMouseEnter={onPointerActivate}
        onMouseMove={onPointerActivate}
        onFocus={onFocusActivate}
        onClick={(event) => {
          onPointerActivate(event);
          onSelect?.();
        }}
        onBlur={() => onDeactivate("focus")}
        onMouseLeave={() => onDeactivate("pointer")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDeactivate("all");
          }
        }}
      >
        {milestone.display_label}
      </button>
    </foreignObject>
  );
}


function ScoreChart({
  history,
  appid,
  isUpdating,
  activeEventId,
  onSelectEvent,
}: {
  history: GameScoreHistory | null | undefined;
  appid: number;
  isUpdating: boolean;
  activeEventId?: string | null;
  onSelectEvent?: (eventId: string | null) => void;
}) {
  const chartData = useMemo(() => displayHistoryPoints(history), [history]);
  const milestones = useMemo(() => historyMilestones(history), [history]);
  const domain = useMemo(() => historyDomain(history, chartData), [history, chartData]);
  const domainMidpoint = (domain[0] + domain[1]) / 2;
  const visibleMilestones = useMemo(
    () => milestones.filter((milestone) => {
      const timestamp = Date.parse(milestone.event_time);
      return timestamp >= domain[0] && timestamp <= domain[1];
    }),
    [domain, milestones],
  );
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  useLayoutEffect(() => {
    const element = chartContainerRef.current;
    if (!element) return;
    const updateWidth = () => {
      const measuredWidth = Math.round(element.clientWidth);
      if (measuredWidth > 0) setChartWidth((previousWidth) => previousWidth === measuredWidth ? previousWidth : measuredWidth);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const selectedMilestones = useMemo(
    () => selectScoreMilestones(visibleMilestones, domain, Math.max(0, chartWidth - SCORE_CHART_Y_AXIS_WIDTH - SCORE_CHART_MARGIN_RIGHT)),
    [chartWidth, domain, visibleMilestones],
  );
  const hasScoreObservations = chartData.some((point) => Number.isFinite(point.score));
  const [hoveredValue, setHoveredValue] = useState<number | null>(null);
  const [activeTimestamp, setActiveTimestamp] = useState<number | null>(null);
  const [milestoneTooltip, setMilestoneTooltip] = useState<{
    id: string;
    modality: "pointer" | "touch" | "focus";
    anchor: { x: number; y: number };
  } | null>(null);
  const focusedTooltipRef = useRef<{ id: string; anchor: { x: number; y: number } } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  const activeMilestone = milestoneTooltip?.id ?? null;
  const active = selectedMilestones.find((milestone) => milestone.event_id === activeMilestone) ?? null;
  const tooltipAnchor = milestoneTooltip?.anchor ?? null;
  type MilestonePointerEvent = { currentTarget?: EventTarget | null; clientX?: number; clientY?: number; nativeEvent?: Event };
  const tooltipPositionFor = (event: MilestonePointerEvent | undefined, focus = false) => {
    const target = event?.currentTarget;
    if (!(target instanceof Element)) return null;
    const wrapper = target.closest<HTMLElement>("[data-score-range]");
    if (!wrapper) return null;
    const wrapperBox = wrapper.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    return {
      x: (focus ? targetBox.right : event?.clientX ?? targetBox.right) - wrapperBox.left,
      y: (focus ? targetBox.top : event?.clientY ?? targetBox.top) - wrapperBox.top,
    };
  };
  const activateMilestonePointer = (eventMilestoneId: string, event: MilestonePointerEvent | undefined) => {
    const anchor = tooltipPositionFor(event);
    if (!anchor) return;
    const touch = event?.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === "touch";
    if (touch) focusedTooltipRef.current = null;
    setMilestoneTooltip({ id: eventMilestoneId, modality: touch ? "touch" : "pointer", anchor });
  };
  const activateMilestoneFocus = (eventMilestoneId: string, event: React.FocusEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.matches(":focus-visible")) return;
    const anchor = tooltipPositionFor(event, true);
    if (!anchor) return;
    focusedTooltipRef.current = { id: eventMilestoneId, anchor };
    setMilestoneTooltip({ id: eventMilestoneId, modality: "focus", anchor });
  };
  const deactivateMilestone = (eventMilestoneId: string, kind: "pointer" | "focus" | "all") => {
    if (kind === "focus" && focusedTooltipRef.current?.id === eventMilestoneId) focusedTooltipRef.current = null;
    if (kind === "all") focusedTooltipRef.current = null;
    setMilestoneTooltip((current) => {
      if (kind === "all" || (current?.id === eventMilestoneId && current.modality === kind)) {
        if (kind === "pointer") {
          const focused = focusedTooltipRef.current;
          return focused ? { ...focused, modality: "focus" } : null;
        }
        return null;
      }
      return current;
    });
  };
  useLayoutEffect(() => {
    if (!active) {
      focusedTooltipRef.current = null;
      setMilestoneTooltip(null);
    }
    const tooltip = tooltipRef.current;
    const wrapper = tooltip?.closest<HTMLElement>("[data-score-range]");
    if (!tooltip || !wrapper || !tooltipAnchor) {
      setTooltipPosition(null);
      return;
    }
    const wrapperBox = wrapper.getBoundingClientRect();
    const tooltipBox = tooltip.getBoundingClientRect();
    const flipX = tooltipAnchor.x + 12 + tooltipBox.width > wrapperBox.width;
    const flipY = tooltipAnchor.y + 12 + tooltipBox.height > wrapperBox.height;
    const preferredX = tooltipAnchor.x + (flipX ? -12 - tooltipBox.width : 12);
    const preferredY = tooltipAnchor.y + (flipY ? -12 - tooltipBox.height : 12);
    const x = Math.max(0, Math.min(Math.max(0, wrapperBox.width - tooltipBox.width), preferredX));
    const y = Math.max(0, Math.min(Math.max(0, wrapperBox.height - tooltipBox.height), preferredY));
    setTooltipPosition((current) => current?.x === x && current.y === y ? current : { x, y });
  }, [active, tooltipAnchor]);
  useLayoutEffect(() => {
    if (milestoneTooltip?.modality !== "touch") return;
    const dismissTouch = () => {
      focusedTooltipRef.current = null;
      setMilestoneTooltip(null);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      const wrapper = tooltipRef.current?.closest<HTMLElement>("[data-score-range]");
      if (!(target instanceof Node) || !wrapper || !wrapper.contains(target)) dismissTouch();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissTouch();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [milestoneTooltip]);
  const chartConfig = useMemo<ChartConfig>(() => ({ score: { label: "Player score", color: SCORE_COLOR } }), []);
  return (
    <div className={`relative transition-opacity duration-200 ${isUpdating ? "opacity-50" : "opacity-100"}`} data-score-range={history?.range ?? "none"}>
      <ChartContainer ref={chartContainerRef} config={chartConfig} className="h-[240px] w-full aspect-auto">
        <ComposedChart
          data={chartData}
          accessibilityLayer
          margin={{ top: 12, right: SCORE_CHART_MARGIN_RIGHT, left: 0, bottom: 0 }}
          onMouseMove={(state) => {
            const activeLabel = Number(state.activeLabel);
            const activeRow = Number.isFinite(activeLabel) ? chartData.find((row) => row.timestamp === activeLabel) : undefined;
            setActiveTimestamp(Number.isFinite(activeLabel) ? activeLabel : null);
            setHoveredValue(chartPayloadValue(activeRow?.score));
          }}
          onMouseLeave={() => {
            setHoveredValue(null);
            setActiveTimestamp(null);
            setMilestoneTooltip((current) => {
              if (current?.modality !== "pointer") return current;
              const focused = focusedTooltipRef.current;
              return focused ? { ...focused, modality: "focus" } : null;
            });
          }}
        >
          <defs>
            <linearGradient id={`score-area-${appid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SCORE_COLOR} stopOpacity={0.4} />
              <stop offset="95%" stopColor={SCORE_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis dataKey="timestamp" type="number" domain={domain} allowDataOverflow tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} minTickGap={40} tickFormatter={(value) => formatDateOnly(new Date(Number(value)).toISOString())} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={SCORE_CHART_Y_AXIS_WIDTH} tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} />
          {selectedMilestones.map((milestone) => {
            const timestamp = Date.parse(milestone.event_time);
            const isSelected = activeEventId === milestone.event_id;
            return (
              <ReferenceLine
                key={milestone.event_id}
                x={timestamp}
                stroke={isSelected ? "#c4b5fd" : SCORE_COLOR}
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray={isSelected ? undefined : "3 3"}
                onMouseEnter={(event) => activateMilestonePointer(milestone.event_id, event)}
                onMouseMove={(event) => activateMilestonePointer(milestone.event_id, event)}
                onClick={(event) => {
                  activateMilestonePointer(milestone.event_id, event);
                  onSelectEvent?.(milestone.event_id);
                }}
                onMouseLeave={() => deactivateMilestone(milestone.event_id, "pointer")}
                label={
                  <MilestoneLabel
                    milestone={milestone}
                    alignLeft={timestamp >= domainMidpoint}
                    active={activeMilestone === milestone.event_id}
                    selected={isSelected}
                    onPointerActivate={(event) => activateMilestonePointer(milestone.event_id, event)}
                    onFocusActivate={(event) => activateMilestoneFocus(milestone.event_id, event)}
                    onDeactivate={(kind) => deactivateMilestone(milestone.event_id, kind)}
                    onSelect={() => onSelectEvent?.(milestone.event_id)}
                  />
                }
              />
            );
          })}
          {hoveredValue !== null && activeTimestamp !== null && active === null && <ReferenceDot x={activeTimestamp} y={hoveredValue} r={3} fill={SCORE_COLOR} stroke="#09090b" strokeWidth={1} />}
          {hoveredValue !== null && active === null && <ReferenceLine y={hoveredValue} stroke={SCORE_COLOR} strokeDasharray="3 3" />}
          <ChartTooltip active={active ? false : undefined}
            content={
              <ChartTooltipContent
                className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100 max-w-[min(28rem,calc(100vw-2rem))]"
                labelFormatter={(_, payload) => {
                  const row = payload?.[0]?.payload as ChartPoint | undefined;
                  return row ? formatLocalDateTime(new Date(row.timestamp)) : "";
                }}
                formatter={(value, _name, item) => {
                  const row = item?.payload as ChartPoint | undefined;
                  return (
                    <div className="grid w-full gap-1 text-[11px] wrap-anywhere">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono font-medium text-violet-200">Player score</span>
                        <span className="font-mono font-medium text-violet-200">{formatNumber(Number(value), { maximumFractionDigits: 1 })}</span>
                      </div>
                      <p className="text-zinc-400">{row ? "Current scoring-window evidence: " + formatNumber(row.reviews) + " reviews" : "Current scoring-window evidence unavailable"}</p>
                    </div>
                  );
                }}
              />
            }
          />
          <Area data={chartData} dataKey="score" name="Player score" type="monotone" stroke="var(--color-score)" strokeWidth={1.8} fill={"url(#score-area-" + appid + ")"} dot={chartData.length === 1 ? { r: 3 } : false} activeDot={false} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ChartContainer>
      {active && (
        <div
          ref={tooltipRef}
          id={"score-milestone-" + active.event_id}
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-[min(22rem,calc(100%-1rem))] border border-violet-400/50 bg-zinc-950 p-2 text-xs text-zinc-200 shadow-xl"
          style={{
            left: tooltipPosition?.x ?? tooltipAnchor?.x ?? 0,
            top: tooltipPosition?.y ?? tooltipAnchor?.y ?? 0,
          }}
        >
          <p className="font-semibold text-violet-200">{active.title ?? active.display_label}</p>
          <p className="mt-1 text-zinc-400">{milestoneKindLabel(active.kind)} · {formatDateOnly(active.event_time)}</p>
        </div>
      )}
      {!hasScoreObservations && <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-xs text-zinc-500">No score observations in this range.</p>}
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
        <p>Current Player Score is a player-evidence estimate. The chart combines recorded and reconstructed history for display; recorded observations take precedence at matching timestamps. Historical observations remain separate from monthly approval buckets and do not imply that a milestone caused a change.</p>
        {score && <>
          <p>Observed at: <span className="text-zinc-300">{formatLocalDateTime(score.observed_at)}</span>; formula version: <span className="text-zinc-300">{score.formula_version}</span></p>
          <p>Current scoring-window evidence: <span className="text-zinc-300">{formatNumber(score.current_reviews)} reviews</span>; historical support: <span className="text-zinc-300">{formatNumber(score.historical_support.actual_reviews)} actual / {formatNumber(score.historical_support.effective_reviews)} effective</span></p>
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

function ScoreHistoryCard({
  appid,
  range,
  setRange,
  history,
  summary,
  isUpdating,
  activeEventId,
  onSelectEvent,
}: {
  appid: number;
  range: HistoryRange;
  setRange: (range: HistoryRange) => void;
  history: GameScoreHistory | null | undefined;
  summary: GameScoreSummary | null | undefined;
  isUpdating: boolean;
  activeEventId?: string | null;
  onSelectEvent?: (eventId: string | null) => void;
}) {
  const milestones = historyMilestones(history);
  return (
    <section id="score-history" className="min-w-0 border border-zinc-800 bg-zinc-950 p-4 sm:p-5" aria-labelledby="score-history-title">
      <header className="flex flex-col justify-between gap-3 border-b border-zinc-900 pb-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 bg-violet-400" aria-hidden="true" />
          <div><h2 id="score-history-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Score History</h2><p className="mt-1 font-mono text-[11px] text-zinc-500">Player score history</p></div>
        </div>
        {isUpdating && <span className="font-mono text-[10px] text-violet-300" role="status">Updating…</span>}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Score history time ranges">
          {SCORE_RANGES.map((item) => <button key={item} type="button" onClick={() => setRange(item)} aria-pressed={range === item} className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${range === item ? "border-violet-500 bg-violet-600 text-white" : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-violet-500/15 hover:text-violet-200"}`}>{item === "all" ? "All" : item}</button>)}
        </div>
      </header>
      <ScoreMetrics history={history} />
      <div className="mt-4 overflow-hidden" data-testid="score-history-chart">
        <ScoreChart
          appid={appid}
          history={history}
          isUpdating={isUpdating}
          activeEventId={activeEventId}
          onSelectEvent={onSelectEvent}
        />
      </div>
      <details className="mt-3 border-t border-zinc-900 pt-3 text-xs text-zinc-400">
        <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Milestones</summary>
        <ol className="mt-3 space-y-2">
          {milestones.length === 0 ? (
            <li>No sourced milestones in this range.</li>
          ) : (
            milestones.map((milestone) => (
              <li key={milestone.event_id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <time dateTime={milestone.event_time} className="font-mono text-zinc-500">
                  {formatDateOnly(milestone.event_time)}
                </time>
                <button
                  type="button"
                  onClick={() => onSelectEvent?.(milestone.event_id)}
                  className={`cursor-pointer text-left underline-offset-2 hover:underline ${
                    activeEventId === milestone.event_id
                      ? "font-semibold text-violet-200 underline"
                      : "text-zinc-300 hover:text-violet-300"
                  }`}
                >
                  {milestone.title ?? milestone.display_label}
                </button>
                {milestone.kind && <span className="text-zinc-500">({milestoneKindLabel(milestone.kind)})</span>}
                {milestone.source_url && (
                  <a href={milestone.source_url} target="_blank" rel="noreferrer" className="text-violet-300 underline underline-offset-2">
                    Source ↗
                  </a>
                )}
              </li>
            ))
          )}
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


function comparisonClass(alignment: ScoreCriticAlignment | null, current: boolean): string {
  const comparison = current ? alignment?.current_contrast : alignment;
  if (comparison?.alignment === "broadly_aligned") return "text-emerald-300/80";
  if (comparison?.alignment === "clearly_divergent") return "text-rose-300/80";
  return "text-zinc-300";
}

function CriticRecord({ critic }: { critic: ScoreCriticRecord }) {
  return (
    <article className="border-b border-zinc-900 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">{critic.source_url ? <a href={critic.source_url} target="_blank" rel="noreferrer" className="text-sm text-zinc-200 hover:text-violet-200 hover:underline">{criticName(critic)} ↗</a> : <p className="text-sm text-zinc-200">{criticName(critic)}</p>}<p className="mt-1 font-mono text-[10px] uppercase text-zinc-500">{critic.platform_scope} · {critic.edition || "Unknown edition"}</p></div>
        <p className="font-mono text-2xl font-bold tabular-nums text-zinc-100">{criticNativeValue(critic)}</p>
      </div>
      <p className="mt-1 font-mono text-xs text-zinc-500">{critic.review_count === null ? "Review count unavailable" : formatNumber(critic.review_count) + " critic reviews"}</p>
      <p className="mt-1 text-[11px] text-zinc-500">{critic.review_period_start || critic.review_period_end ? "Review dates: " + formatDateOnly(critic.review_period_start) + "–" + formatDateOnly(critic.review_period_end) : "Review dates unavailable"}</p>
      <p className="mt-1 text-[11px] text-zinc-500">Source observed: {formatLocalDateTime(critic.observed_at)} · native scale: {critic.score_scale === null ? "Unknown" : formatNumber(critic.score_scale)}</p>
    </article>
  );
}

function directAlignment(playerScore: number | null | undefined, critic: ScoreCriticRecord): ScoreCriticAlignment["alignment"] | null {
  if (typeof playerScore !== "number" || !Number.isFinite(playerScore)) return null;
  const playerDir = playerScore < 40 ? "unfavorable" : (playerScore < 70 ? "mixed" : "favorable");
  let criticDir: "unfavorable" | "mixed" | "favorable" | null = null;
  if (critic.native_tier === "Weak") criticDir = "unfavorable";
  else if (critic.native_tier === "Fair") criticDir = "mixed";
  else if (critic.native_tier === "Strong" || critic.native_tier === "Mighty") criticDir = "favorable";
  else if (typeof critic.native_score === "number" && Number.isFinite(critic.native_score)) {
    criticDir = critic.native_score < 50 ? "unfavorable" : (critic.native_score < 75 ? "mixed" : "favorable");
  }
  if (!criticDir) return null;
  if (playerDir === criticDir) return "broadly_aligned";
  const rank = (d: string) => d === "unfavorable" ? 0 : d === "mixed" ? 1 : 2;
  if (Math.abs(rank(playerDir) - rank(criticDir)) === 2) return "clearly_divergent";
  return rank(playerDir) > rank(criticDir) ? "players_more_favorable" : "critics_more_favorable";
}

function PlayersCriticsComparison({ critics, alignments, playerScore }: { critics: readonly ScoreCriticRecord[]; alignments: readonly ScoreCriticAlignment[]; playerScore?: number | null }) {
  if (critics.length === 0) return null;
  const classifiedDirections = new Set<string>();
  for (const alignment of alignments) {
    const comparison = alignment.current_contrast.state === "classified" ? alignment.current_contrast : alignment;
    if (comparison.state === "classified" && comparison.critic_direction) classifiedDirections.add(comparison.critic_direction);
  }
  return (
    <section className="mt-3 border-t border-zinc-800 pt-3" aria-labelledby="players-critics-title">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="players-critics-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Players vs critics</h3>
      </div>
      {classifiedDirections.size > 1 && <p className="mt-2 text-xs text-zinc-400">Critic sources differ.</p>}
      <div className="mt-2 divide-y divide-zinc-900">
        {critics.map((critic) => {
          const alignment = alignmentFor(alignments, critic);
          const comparison = alignment?.current_contrast.state === "classified" ? alignment.current_contrast : alignment;
          const resolvedAlignment = (comparison?.state === "classified" && comparison.alignment)
            ? comparison.alignment
            : (comparison?.alignment ?? directAlignment(playerScore, critic));
          const label = resolvedAlignment ? alignmentValueLabel(resolvedAlignment) : "Unavailable";
          const resolvedClass = resolvedAlignment === "broadly_aligned"
            ? "text-emerald-300/80"
            : (resolvedAlignment === "clearly_divergent" ? "text-rose-300/80" : "text-zinc-300");
          return (
            <article key={`${critic.source}-${critic.source_id}-comparison`} className="py-2 first:pt-1 last:pb-1">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-xs font-semibold text-zinc-300">{criticName(critic)}</p>
                <p className={`text-right text-xs font-semibold ${resolvedClass}`}>{label}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}


function ReceptionCard({
  appid,
  summary,
  activeEventId,
  onCloseReader,
}: {
  appid: number;
  summary: GameScoreSummary | null | undefined;
  activeEventId?: string | null;
  onCloseReader?: () => void;
}) {
  if (activeEventId) {
    return (
      <aside
        id="critic-reception"
        className="score-reception-card min-w-0 border border-zinc-800 bg-zinc-950 p-4 sm:p-5 xl:flex xl:flex-col xl:self-stretch"
        aria-label="Event article reader"
      >
        <ScoreEventReader
          appid={appid}
          eventId={activeEventId}
          onClose={() => onCloseReader?.()}
        />
      </aside>
    );
  }

  const score = summary?.score?.value ?? null;
  const reviews = summary?.score?.current_reviews ?? null;
  const lifetime = summary?.lifetime_approval ?? null;
  return (
    <aside id="critic-reception" className="score-reception-card min-w-0 border border-zinc-800 bg-zinc-950 p-4 sm:p-5 xl:flex xl:flex-col xl:self-stretch" aria-labelledby="critic-reception-title">
      <h2 id="critic-reception-title" className="border-b border-zinc-900 pb-3 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Reception</h2>
      <div className="border-b border-zinc-800 py-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm text-zinc-200">Current Player Score</p><p className="mt-1 font-mono text-[10px] uppercase text-zinc-500">Player evidence</p></div><p className="font-mono text-3xl font-bold tabular-nums text-violet-200">{score === null ? "—" : formatNumber(score, { maximumFractionDigits: 1 })}</p></div><p className="mt-1 font-mono text-xs text-zinc-500">{reviews === null ? "Current scoring-window evidence unavailable" : `${formatNumber(reviews)} reviews in current scoring window`}</p></div>{lifetime && <div className="grid grid-cols-2 gap-2 border-b border-zinc-800 py-3 font-mono text-xs" aria-label="Lifetime player approval"><div><span className="text-zinc-500">Reviews:</span> <span className="text-zinc-200">{formatNumber(lifetime.total_reviews)}</span></div><div><span className="text-zinc-500">Approval:</span> <span className="text-violet-200">{formatPercent(lifetime.value)}</span></div></div>}
      <div className="xl:flex-1">{summary?.critics.length ? summary.critics.map((critic) => <CriticRecord key={`${critic.source}-${critic.source_id}`} critic={critic} />) : <p className="mt-4 text-sm text-zinc-500">No critic coverage yet.</p>}{summary?.critics.length ? <PlayersCriticsComparison critics={summary.critics} alignments={summary.alignment} playerScore={score} /> : null}</div>
    </aside>
  );
}

export interface GameReceptionProps {
  appid: number;
  range?: HistoryRange;
  onRangeChange?: (range: HistoryRange) => void;
  activeEventId?: string | null;
  onSelectEvent?: (eventId: string | null) => void;
}

export function GameReception({
  appid,
  range: rangeProp,
  onRangeChange,
  activeEventId,
  onSelectEvent,
}: GameReceptionProps) {
  const [localRange, setLocalRange] = useState<HistoryRange>("30d");
  const range = rangeProp ?? localRange;
  const summaryQuery = useQuery(gameScoreSummaryQueryOptions(appid));
  const historyQuery = useQuery(gameScoreHistoryQueryOptions(appid, range));
  const history = historyQuery.data;
  const isUpdating = historyQuery.isFetching && historyQuery.isPlaceholderData === true;
  const triggeringButtonRef = useRef<HTMLElement | null>(null);

  const handleSelectEvent = (eventId: string | null) => {
    if (eventId && typeof document !== "undefined") {
      triggeringButtonRef.current = document.activeElement as HTMLElement | null;
    }
    onSelectEvent?.(eventId);
  };

  const handleCloseReader = () => {
    onSelectEvent?.(null);
    if (triggeringButtonRef.current) {
      triggeringButtonRef.current.focus({ preventScroll: true });
    }
  };

  const handleSetRange = (nextRange: HistoryRange) => {
    if (activeEventId && history?.milestones) {
      const activeItem = history.milestones.find((m) => m.event_id === activeEventId);
      if (activeItem) {
        const within = isEventWithinHistoryRange(activeItem.event_time, nextRange, null, null);
        if (!within) {
          onSelectEvent?.(null);
        }
      }
    }
    if (onRangeChange) {
      onRangeChange(nextRange);
    } else {
      setLocalRange(nextRange);
    }
  };

  // Mobile scroll-into-view when an event reader is opened
  useEffect(() => {
    if (activeEventId && typeof window !== "undefined") {
      const isMobileStacked = window.innerWidth < 1280;
      if (isMobileStacked) {
        const card = document.getElementById("critic-reception");
        if (card) {
          const targetY = window.scrollY + card.getBoundingClientRect().top - 80;
          try {
            window.scrollTo({ top: targetY, behavior: "smooth" });
          } catch {
            window.scrollTo(0, targetY);
          }
        }
      }
    }
  }, [activeEventId]);

  return (
    <section id="game-reception" className="space-y-4" aria-label="Game reception">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)] xl:items-stretch">
        <ScoreHistoryCard
          appid={appid}
          range={range}
          setRange={handleSetRange}
          history={history}
          summary={summaryQuery.data}
          isUpdating={isUpdating}
          activeEventId={activeEventId}
          onSelectEvent={handleSelectEvent}
        />
        <ReceptionCard
          appid={appid}
          summary={summaryQuery.data}
          activeEventId={activeEventId}
          onCloseReader={handleCloseReader}
        />
      </div>
      {summaryQuery.isError && <p className="font-mono text-xs text-zinc-500" role="status">Reception data unavailable.</p>}
    </section>
  );
}
