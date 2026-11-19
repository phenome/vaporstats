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
import { mergeIntervals } from "../lib/review-evidence";
import { PLAYER_SCORE_FORMULA_VERSION } from "../lib/player-score";
import { gameScoreHistoryQueryOptions, gameScoreSummaryQueryOptions } from "../lib/score-query";
import { SCORE_MILESTONE_LABEL_GAP, SCORE_MILESTONE_LABEL_WIDTH, selectScoreMilestones } from "../lib/score-milestone-density";
import { ChartContainer, ChartTooltip, type ChartConfig } from "./ui/chart";
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


export function GameScoreHero({ appid, className }: { appid: number; className?: string }) {
  const summaryQuery = useQuery(gameScoreSummaryQueryOptions(appid));
  const summary = summaryQuery.data;
  const score = summary?.score?.value ?? null;
  const reviews = summary?.score?.current_reviews ?? null;
  return (
    <section id="player-score" className={`score-hero border border-violet-500/30 bg-zinc-950 p-4 sm:p-5 ${className ?? ""}`} aria-labelledby="player-score-title">
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
  id: string;
  timestamp: number;
  score: number;
  run: number;
} & (
  | { provenance: "recorded"; details: RecordedScore }
  | { provenance: "reconstructed"; details: ReconstructedScore }
);

const DAY_MS = 24 * 60 * 60 * 1000;

type ScorePointDetails = ChartPoint["details"];

function sourceIdentity(source: ScorePopulationReference | null): string | null {
  return source?.source_id ?? null;
}

function evidenceScope(details: ScorePointDetails): string | null {
  if (!details.current_evidence_intervals.length) return null;
  const coverage = (intervals: ScorePointDetails["current_evidence_intervals"]) =>
    mergeIntervals(intervals).map(({ start, end }) => [start, end]);
  return JSON.stringify([
    sourceIdentity(details.population_ref),
    coverage(details.current_evidence_intervals),
    sourceIdentity(details.historical_population_ref),
    coverage(details.historical_evidence_intervals),
  ]);
}

function canConnectScorePoints(previous: ChartPoint, next: ChartPoint): boolean {
  const before = previous.details;
  const after = next.details;
  if (previous.timestamp === next.timestamp
    || before.formula_version !== after.formula_version
    || sourceIdentity(before.population_ref) !== sourceIdentity(after.population_ref)
    || (before.historical_population_ref && after.historical_population_ref
      && sourceIdentity(before.historical_population_ref) !== sourceIdentity(after.historical_population_ref))) return false;

  const previousEnd = before.evidence_end ? Date.parse(before.evidence_end) : previous.timestamp;
  const nextEnd = after.evidence_end ? Date.parse(after.evidence_end) : NaN;
  if (Number.isFinite(nextEnd)) {
    return nextEnd > previousEnd && after.current_evidence_intervals.some((interval) =>
      Date.parse(interval.end) === nextEnd && Date.parse(interval.start) <= previousEnd);
  }

  // Older observations can lack interval metadata. Use collection cadence for those rows.
  return next.provenance === "recorded"
    && Math.floor(next.timestamp / DAY_MS) - Math.floor(previous.timestamp / DAY_MS) <= 1;
}

export function buildScoreHistoryChartData(history: GameScoreHistory | null | undefined): ChartPoint[] {
  if (!history) return [];
  const rangeStart = history.range_start ? Date.parse(history.range_start) : -Infinity;
  const rangeEnd = history.range_end ? Date.parse(history.range_end) : Infinity;
  const visible = (timestamp: number, score: number) =>
    Number.isFinite(timestamp) && Number.isFinite(score) && !(timestamp < rangeStart || timestamp > rangeEnd);

  const recordedScopes = new Set<string>();
  const recorded = new Map<string, Extract<ChartPoint, { provenance: "recorded" }>>();
  for (const entry of history.recorded_scores) {
    const timestamp = Date.parse(entry.observed_at);
    if (!visible(timestamp, entry.value)) continue;
    const scope = evidenceScope(entry);
    // Recalculations keep their later calculation timestamp and cannot stand in for collection.
    if (scope && !entry.recalculation) recordedScopes.add(scope);
    const key = JSON.stringify([timestamp, scope, sourceIdentity(entry.population_ref),
      entry.recalculation?.previous_observation_id ?? null, scope ? null : entry.observation_id]);
    const existing = recorded.get(key)?.details;
    if (existing && existing.observation_id > entry.observation_id) continue;
    recorded.set(key, { id: `recorded-${entry.observation_id}-${timestamp}`, timestamp, score: entry.value, run: 0, provenance: "recorded", details: entry });
  }

  const points: ChartPoint[] = [...recorded.values()];
  const reconstructedScopes = new Set<string>();
  const estimatesPerTimestamp = new Map<number, number>();
  for (const entry of history.reconstructed_scores) {
    const timestamp = Date.parse(entry.score_at);
    if (!visible(timestamp, entry.value)) continue;
    const scope = evidenceScope(entry);
    const key = JSON.stringify([timestamp, scope]);
    if (scope && (recordedScopes.has(scope) || reconstructedScopes.has(key))) continue;
    if (scope) reconstructedScopes.add(key);
    const index = estimatesPerTimestamp.get(timestamp) ?? 0;
    estimatesPerTimestamp.set(timestamp, index + 1);
    points.push({ id: `reconstructed-${timestamp}-${index}`, timestamp, score: entry.value, run: 0, provenance: "reconstructed", details: entry });
  }
  points.sort((a, b) => a.timestamp - b.timestamp);

  let run = 0;
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (previous && !canConnectScorePoints(previous, point)) run++;
    point.run = run;
  }
  return points;
}

export function ScoreHistoryTooltip({ point }: { point: Pick<ChartPoint, "timestamp" | "score"> }) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 shadow-2xl">
      <time dateTime={new Date(point.timestamp).toISOString()}>{formatLocalDateTime(new Date(point.timestamp))}</time>
      <p className="mt-1 flex justify-between gap-3 font-mono font-medium text-violet-200">
        <span>Player score</span>
        <span>{formatNumber(point.score, { maximumFractionDigits: 1 })}</span>
      </p>
    </div>
  );
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
    <foreignObject
      x={x}
      y={y}
      width={SCORE_MILESTONE_LABEL_WIDTH}
      height={28}
      className="overflow-visible pointer-events-auto"
      style={{ overflow: "visible", pointerEvents: "auto" }}
    >
      <button
        type="button"
        className={`score-event-label block h-6 max-w-[62px] truncate border px-1 text-left font-mono text-[10px] font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${
          selected
            ? "border-violet-300 bg-violet-500/40 text-white ring-1 ring-violet-300"
            : "border-violet-400/50 bg-zinc-950 text-violet-200 hover:bg-violet-500/20"
        } ${alignLeft ? "ml-auto" : ""}`}
        aria-label={`${milestone.display_label} · ${formatDateOnly(milestone.event_time)}`}
        aria-describedby={active ? `score-milestone-${milestone.event_id}` : undefined}
        onMouseEnter={(event) => {
          event.stopPropagation();
          onPointerActivate(event);
        }}
        onMouseMove={(event) => {
          event.stopPropagation();
          onPointerActivate(event);
        }}
        onFocus={onFocusActivate}
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect?.();
        }}
        onClick={(event) => {
          event.stopPropagation();
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
  chartData,
  history,
  appid,
  isUpdating,
  activeEventId,
  onSelectEvent,
  onSelectPoint,
}: {
  chartData: ChartPoint[];
  history: GameScoreHistory | null | undefined;
  appid: number;
  isUpdating: boolean;
  activeEventId?: string | null;
  onSelectEvent?: (eventId: string | null) => void;
  onSelectPoint: (id: string) => void;
}) {
  const pointsByTimestamp = useMemo(() => {
    const grouped = new Map<number, ChartPoint[]>();
    for (const point of chartData) {
      const points = grouped.get(point.timestamp);
      if (points) points.push(point);
      else grouped.set(point.timestamp, [point]);
    }
    return grouped;
  }, [chartData]);
  const runSizes = useMemo(() => {
    const sizes = new Map<number, number>();
    for (const point of chartData) sizes.set(point.run, (sizes.get(point.run) ?? 0) + 1);
    return sizes;
  }, [chartData]);
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
  const [hoveredPoint, setHoveredPoint] = useState<ChartPoint>();
  const pointAtPointer = (label: string | number | undefined, target: EventTarget) => {
    const points = pointsByTimestamp.get(Number(label));
    if (!points || points.length === 1 || !(target instanceof Element)) return points?.[0];
    const pointId = target.closest("[data-score-point]")?.getAttribute("data-score-point");
    return points.find((point) => point.id === pointId) ?? points[0];
  };
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
    const touch = event?.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === "touch";
    if (touch) focusedTooltipRef.current = null;
    setHoveredPoint(undefined);
    const modality = touch ? "touch" : "pointer";
    const anchor = tooltipPositionFor(event);
    if (!anchor) return;
    setMilestoneTooltip((current) => {
      if (
        current?.id === eventMilestoneId &&
        current.modality === modality &&
        current.anchor.x === anchor.x &&
        current.anchor.y === anchor.y
      ) {
        return current;
      }
      return { id: eventMilestoneId, modality, anchor };
    });
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
          onMouseMove={(state, event) => {
            if (active) return;
            setHoveredPoint(pointAtPointer(state.activeLabel, event.target));
          }}
          onClick={(state, event) => {
            if (active) return;
            const point = pointAtPointer(state.activeLabel, event.target);
            if (point) onSelectPoint(point.id);
          }}
          onMouseLeave={() => {
            setHoveredPoint(undefined);
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
          {[...runSizes].map(([run, size]) => size > 1 && (
            <Area key={run} dataKey={(point: ChartPoint) => point.run === run ? point.score : undefined}
              type="monotone" stroke="var(--color-score)" strokeWidth={1.8}
              fill={"url(#score-area-" + appid + ")"} dot={false} activeDot={false}
              isAnimationActive={false} connectNulls
            />
          ))}
          {/* Keep one shared tooltip timeline and show a marker only for a one-point run. */}
          <Area dataKey="score" name="Player score" stroke="none" fill="none"
            dot={(props) => {
              const point: ChartPoint = props.payload;
              if (runSizes.get(point.run) !== 1) return <g />;
              return <circle key={point.id} data-score-point={point.id} cx={props.cx} cy={props.cy} r={3} fill="var(--color-score)" />;
            }}
            activeDot={false} isAnimationActive={false}
          />
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
                  event.stopPropagation();
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
          {hoveredPoint && !active && <ReferenceDot x={hoveredPoint.timestamp} y={hoveredPoint.score} r={3} fill={SCORE_COLOR} stroke="#09090b" strokeWidth={1} pointerEvents="none" />}
          {hoveredPoint && !active && <ReferenceLine y={hoveredPoint.score} stroke={SCORE_COLOR} strokeDasharray="3 3" pointerEvents="none" />}
          <ChartTooltip active={active ? false : undefined}
            content={({ active: tooltipActive, label }) => {
              const timestamp = Number(label);
              const point = hoveredPoint?.timestamp === timestamp ? hoveredPoint : pointsByTimestamp.get(timestamp)?.[0];
              return tooltipActive && point ? <ScoreHistoryTooltip point={point} /> : null;
            }}
          />
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
      {chartData.length === 0 && <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-xs text-zinc-500">No score observations in this range.</p>}
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

function ScoreDetails({ summary, history, points, selectedPointId, onSelectPoint, detailsRef }: {
  summary: GameScoreSummary | null | undefined;
  history: GameScoreHistory | null | undefined;
  points: readonly ChartPoint[];
  selectedPointId: string | null;
  onSelectPoint: (id: string) => void;
  detailsRef: React.Ref<HTMLDetailsElement>;
}) {
  const point = points.find((item) => item.id === selectedPointId) ?? points.at(-1);
  const recalculation = point?.provenance === "recorded" ? point.details.recalculation : undefined;
  const score = summary?.score;
  const uncertainty = score ? wilson95(score.current_positive_reviews, score.current_total_reviews) : null;
  return (
    <details ref={detailsRef} className="mt-3 border-t border-zinc-900 pt-3 text-xs text-zinc-400">
      <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Score details</summary>
      <div className="mt-3 space-y-2 leading-relaxed">
        <p>Current Player Score is a player-evidence estimate. The timeline uses recorded scores where available for the same review evidence and supported estimates elsewhere. Reconstructions use {PLAYER_SCORE_FORMULA_VERSION}. The line breaks at gaps and changes in formula or review population.</p>
        {point && <>
          <label className="block">
            <span className="block text-zinc-300">Historical score point</span>
            <select
              className="max-w-full border border-zinc-700 bg-zinc-950 p-2 text-zinc-200"
              value={point.id}
              onChange={(event) => onSelectPoint(event.currentTarget.value)}
            >
              {points.map((item) => (
                <option key={item.id} value={item.id}>
                  {formatLocalDateTime(new Date(item.timestamp))} · {formatNumber(item.score, { maximumFractionDigits: 1 })}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-1 border-l border-zinc-800 pl-2" aria-live="polite">
            <p>{point.provenance === "reconstructed" ? "Reconstructed estimate" : recalculation ? "Formula recalculation (not new reviews)" : "Recorded observation"} · {point.details.formula_version}</p>
            <p>Current scoring-window evidence: {formatNumber(point.details.current_reviews)} reviews</p>
            <p>Review evidence observed at: {formatBoundary(point.details.current_evidence_observed_at)}</p>
            {point.details.population_ref && populationDetails("Review population", point.details.population_ref)}
            {recalculation && <p>{recalculation.previous_formula_version} → {point.details.formula_version} · calculated {formatBoundary(recalculation.calculated_at)}</p>}
          </div>
        </>}
        {score && <>
          <p>Score recorded at: <span className="text-zinc-300">{formatLocalDateTime(score.observed_at)}</span>; formula version: <span className="text-zinc-300">{score.formula_version}</span></p>
          {score.recalculation && <p>Formula recalculation (not new reviews): {score.recalculation.previous_formula_version} → {score.formula_version}, calculated {formatLocalDateTime(score.recalculation.calculated_at)} from observation {formatNumber(score.recalculation.previous_observation_id)}. Review evidence is unchanged.</p>}
          <p>Review evidence observed at: <span className="text-zinc-300">{formatBoundary(score.current_evidence_observed_at)}</span>; historical evidence observed at: <span className="text-zinc-300">{formatBoundary(score.historical_evidence_observed_at)}</span></p>
          <p>Current scoring-window evidence: <span className="text-zinc-300">{formatNumber(score.current_reviews)} reviews</span>; historical support: <span className="text-zinc-300">{formatNumber(score.historical_support.actual_reviews)} actual / {formatNumber(score.historical_support.effective_reviews)} effective</span></p>
          <p>Sampling uncertainty: <span className="text-zinc-300">{uncertainty ? `${formatPercent(uncertainty.lower)}–${formatPercent(uncertainty.upper)}` : "Unavailable"}</span> (95% Wilson interval for current raw approval). This excludes historical support and does not measure selection bias or game quality.</p>
          <p>New calculations use {PLAYER_SCORE_FORMULA_VERSION}: current reviews have full weight. Compatible, nonoverlapping historical approval contributes at most 20 effective reviews, capped by its actual sample. Without usable history, the estimate is the positive share of actual current reviews; no synthetic reviews are added. Critic scores do not affect this estimate.</p>
          {score.formula_version !== PLAYER_SCORE_FORMULA_VERSION && <p>This recorded estimate uses {score.formula_version}; it has not been recalculated under {PLAYER_SCORE_FORMULA_VERSION}.</p>}
          <p>Small samples can change sharply with the next review. A 100% estimate means all included reviews are positive, not certainty about all players. When evidence stops, the last supported estimate remains; missing periods are not new reviews.</p>
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
  const chartData = useMemo(() => buildScoreHistoryChartData(history), [history]);
  const [pointSelection, setPointSelection] = useState<{ range: HistoryRange; id: string } | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selectPoint = (id: string) => {
    if (!history) return;
    setPointSelection({ range: history.range, id });
  };
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
          key={history?.range}
          chartData={chartData}
          onSelectPoint={(id) => {
            selectPoint(id);
            if (detailsRef.current) detailsRef.current.open = true;
          }}
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
      <ScoreDetails
        summary={summary}
        history={history}
        points={chartData}
        selectedPointId={pointSelection && pointSelection.range === history?.range ? pointSelection.id : null}
        onSelectPoint={selectPoint}
        detailsRef={detailsRef}
      />
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

  // Native nearest scrolling preserves the reader when it is already visible.
  useEffect(() => {
    if (!activeEventId || typeof window === "undefined") return;
    const card = document.getElementById("critic-reception") || document.getElementById("score-event-reader");
    if (!card) return;
    card.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
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
