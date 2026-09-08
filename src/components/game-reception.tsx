import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";
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
  ReconstructedScore,
  ScorePopulationReference,
} from "../lib/score";
import type { HistoryRange } from "../lib/player-history";
import { buildApprovalHistorySeries, type ApprovalHistoryPoint, type ApprovalHistorySeries } from "../lib/approval-history";
import type { ReviewInterval } from "../lib/review-evidence";
import { formatLocalDateTime, formatNumber } from "../lib/format";
import { wilson95 } from "../lib/recent-reception";
import { gameScoreHistoryQueryOptions, gameScoreSummaryQueryOptions } from "../lib/score-query";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart";
import "./game-reception.css";

const SCORE_RANGES: readonly HistoryRange[] = ["24h", "7d", "30d", "90d", "all"];
const SCORE_COLOR = "#a78bfa";
const RECONSTRUCTED_COLOR = "#c084fc";
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

type ChartPoint = { timestamp: number; score: number; reviews: number };
type ReconstructedChartPoint = { timestamp: number; score: number; entry: ReconstructedScore };

type ScoreChartRow = {
  timestamp: number;
  score?: number;
  reviews?: number;
  reconstructed?: number;
  approvalDetails: Record<string, ApprovalHistoryPoint>;
  reconstructedDetails?: ReconstructedScore;
  [key: string]: unknown;
};

type ChartApprovalSeries = ApprovalHistorySeries & { key: string; color: string; data: ScoreChartRow[] };

const APPROVAL_COLORS = ["#67b7c4", "#60a5fa", "#38bdf8"];

function approvalSourceLabel(sourceId: string): string {
  const endpoint = sourceId.split("|", 1)[0];
  const population = sourceId.match(/population=([^|]+)/)?.[1];
  if (endpoint === "histogram" && population) return `Steam histogram · ${population}`;
  return sourceId.length > 24 ? `${sourceId.slice(0, 21)}…` : sourceId;
}

function approvalLegendLabel(sourceId: string, multipleSources: boolean): string {
  return multipleSources ? `Historical Steam approval · ${approvalSourceLabel(sourceId)}` : "Historical Steam approval";
}

function historyPoints(history: GameScoreHistory | null | undefined): ChartPoint[] {
  if (!history) return [];
  return history.recorded_scores.flatMap((entry) => {
    const timestamp = Date.parse(entry.observed_at);
    if (!Number.isFinite(timestamp)) return [];
    return [{ timestamp, score: entry.value, reviews: entry.current_reviews }];
  }).sort((a, b) => a.timestamp - b.timestamp);
}

function reconstructedHistoryPoints(history: GameScoreHistory | null | undefined): ReconstructedChartPoint[] {
  const rangeStart = history?.range_start ? Date.parse(history.range_start) : NaN;
  const rangeEnd = history?.range_end ? Date.parse(history.range_end) : NaN;
  const seen = new Set<number>();
  return (history?.reconstructed_scores ?? []).flatMap((entry) => {
    const timestamp = Date.parse(entry.score_at);
    if (!Number.isFinite(timestamp) || !Number.isFinite(entry.value)
      || (Number.isFinite(rangeStart) && timestamp < rangeStart)
      || (Number.isFinite(rangeEnd) && timestamp > rangeEnd)
      || seen.has(timestamp)) return [];
    seen.add(timestamp);
    return [{ timestamp, score: entry.value, entry }];
  }).sort((a, b) => a.timestamp - b.timestamp);
}

function chartPayloadValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

type ApprovalDotProps = { cx?: number; cy?: number; value?: unknown; index?: number; points?: readonly { value?: unknown }[] };

function isolatedApprovalDot({ cx, cy, value, index, points }: ApprovalDotProps, color: string): React.JSX.Element {
  const previous = index === undefined || index <= 0 ? null : points?.[index - 1]?.value;
  const next = index === undefined ? null : points?.[index + 1]?.value;
  if (chartPayloadValue(value) === null || chartPayloadValue(previous) !== null || chartPayloadValue(next) !== null || typeof cx !== "number" || typeof cy !== "number") return <g aria-hidden="true" />;
  return <circle cx={cx} cy={cy} r={3} fill={color} stroke="#09090b" strokeWidth={1} />;
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
  onPointerActivate,
  onFocusActivate,
  onDeactivate,
}: {
  viewBox?: { x?: number; y?: number };
  milestone: ScoreMilestone;
  active: boolean;
  alignLeft: boolean;
  onPointerActivate: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onFocusActivate: (event: React.FocusEvent<HTMLButtonElement>) => void;
  onDeactivate: (kind: "pointer" | "focus" | "all") => void;
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
        onMouseEnter={onPointerActivate}
        onMouseMove={onPointerActivate}
        onFocus={onFocusActivate}
        onClick={(event) => {
          if (event.detail > 0) onPointerActivate(event);
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

type ScoreTooltipContentProps = React.ComponentProps<typeof ChartTooltipContent>;
type ScoreTooltipItem = NonNullable<ScoreTooltipContentProps["payload"]>[number];
type ScoreTooltipProps = ScoreTooltipContentProps & { canonicalRows: readonly ScoreChartRow[]; approvalSeries: readonly ChartApprovalSeries[] };

function canonicalScoreTooltipPayload(row: ScoreChartRow, approvalSeries: readonly ChartApprovalSeries[]): ScoreTooltipItem[] {
  const payload: ScoreTooltipItem[] = [];
  const score = chartPayloadValue(row.score);
  if (score !== null) payload.push({ dataKey: "score", name: "Current Player Score", value: score, payload: row, color: SCORE_COLOR });
  const reconstructed = chartPayloadValue(row.reconstructed);
  if (reconstructed !== null) payload.push({ dataKey: "reconstructed", name: "Reconstructed score", value: reconstructed, payload: row, color: RECONSTRUCTED_COLOR });
  for (const series of approvalSeries) {
    const point = row.approvalDetails[series.key];
    const approval = chartPayloadValue(point?.approval);
    if (!point?.bucket || approval === null) continue;
    payload.push({ dataKey: series.key, name: approvalLegendLabel(series.sourceId, approvalSeries.length > 1), value: approval, payload: row, color: series.color });
  }
  return payload;
}

function ScoreTooltipContent({ canonicalRows, approvalSeries, ...props }: ScoreTooltipProps) {
  const activeTimestamp = Number(props.label);
  const row = Number.isFinite(activeTimestamp) ? canonicalRows.find((entry) => entry.timestamp === activeTimestamp) : undefined;
  const payload = row ? canonicalScoreTooltipPayload(row, approvalSeries) : [];
  return <ChartTooltipContent {...props} payload={payload} />;
}

function ScoreChart({ history, appid, isUpdating }: { history: GameScoreHistory | null | undefined; appid: number; isUpdating: boolean }) {
  const points = useMemo(() => historyPoints(history), [history]);
  const reconstructedPoints = useMemo(() => reconstructedHistoryPoints(history), [history]);
  const reconstructedData = useMemo(
    () => reconstructedPoints.map((point) => ({ timestamp: point.timestamp, reconstructed: point.score, reconstructedDetails: point.entry })),
    [reconstructedPoints],
  );
  const approvalSeries = useMemo<ChartApprovalSeries[]>(
    () => buildApprovalHistorySeries(history?.approval_buckets ?? [], history?.range_start ?? null, history?.range_end ?? null)
      .map((series, index) => {
        const key = `approval-${index}`;
        return {
          ...series,
          key,
          color: APPROVAL_COLORS[index % APPROVAL_COLORS.length],
          data: series.points.map((point) => ({ timestamp: point.timestamp, [key]: point.approval, approvalDetails: { [key]: point } })),
        };
      }),
    [history],
  );
  const chartRows = useMemo<ScoreChartRow[]>(() => {
    const byTimestamp = new Map<number, ScoreChartRow>();
    const rowFor = (timestamp: number) => {
      const existing = byTimestamp.get(timestamp);
      if (existing) return existing;
      const row: ScoreChartRow = { timestamp, approvalDetails: {} };
      byTimestamp.set(timestamp, row);
      return row;
    };
    for (const point of points) {
      const row = rowFor(point.timestamp);
      row.score = point.score;
      row.reviews = point.reviews;
    }
    for (const point of reconstructedPoints) {
      const row = rowFor(point.timestamp);
      row.reconstructed = point.score;
      row.reconstructedDetails = point.entry;
    }
    for (const series of approvalSeries) {
      for (const point of series.points) {
        const row = rowFor(point.timestamp);
        row[series.key] = point.approval;
        row.approvalDetails[series.key] = point;
      }
    }
    return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [approvalSeries, points, reconstructedPoints]);
  const milestones = useMemo(() => historyMilestones(history), [history]);
  const domain = useMemo(() => historyDomain(history, points), [history, points]);
  const domainMidpoint = (domain[0] + domain[1]) / 2;
  const visibleMilestones = milestones.filter((milestone) => {
    const timestamp = Date.parse(milestone.event_time);
    return timestamp >= domain[0] && timestamp <= domain[1];
  });
  const hasRecordedObservations = points.some((point) => Number.isFinite(point.score));
  const hasReconstructedObservations = reconstructedPoints.some((point) => Number.isFinite(point.score));
  const hasApprovalObservations = approvalSeries.some((series) => series.points.some((point) => Number.isFinite(point.approval)));
  const [hoveredValue, setHoveredValue] = useState<number | null>(null);
  const [activeTimestamp, setActiveTimestamp] = useState<number | null>(null);
  const [hoveredSeries, setHoveredSeries] = useState<"score" | "reconstructed" | "approval" | null>(null);
  const [milestoneTooltip, setMilestoneTooltip] = useState<{
    id: string;
    modality: "pointer" | "touch" | "focus";
    anchor: { x: number; y: number };
  } | null>(null);
  const focusedTooltipRef = useRef<{ id: string; anchor: { x: number; y: number } } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  const activeMilestone = milestoneTooltip?.id ?? null;
  const active = visibleMilestones.find((milestone) => milestone.event_id === activeMilestone) ?? null;
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
  const chartConfig = useMemo<ChartConfig>(() => ({
    score: { label: "Current Player Score", color: SCORE_COLOR },
    reconstructed: { label: "Reconstructed score", color: RECONSTRUCTED_COLOR },
    ...Object.fromEntries(approvalSeries.map((series) => [series.key, {
      label: approvalLegendLabel(series.sourceId, approvalSeries.length > 1),
      color: series.color,
    }])),
  }), [approvalSeries]);
  return (
    <div className={`relative transition-opacity duration-200 ${isUpdating ? "opacity-50" : "opacity-100"}`} data-score-range={history?.range ?? "none"}>
      <ChartContainer config={chartConfig} className="h-[240px] w-full aspect-auto">
        <ComposedChart
          data={chartRows}
          accessibilityLayer
          margin={{ top: 12, right: 18, left: 0, bottom: 0 }}
          onMouseMove={(state) => {
            const activeLabel = Number(state.activeLabel);
            setActiveTimestamp(Number.isFinite(activeLabel) ? activeLabel : null);
            const activeRow = Number.isFinite(activeLabel) ? chartRows.find((row) => row.timestamp === activeLabel) : undefined;
            const activePayload = activeRow ? canonicalScoreTooltipPayload(activeRow, approvalSeries) : [];
            const hasValue = (item: ScoreTooltipItem) => chartPayloadValue(item.value) !== null;
            const preferred = hoveredSeries === "approval"
              ? activePayload.find((item) => String(item.dataKey ?? "").startsWith("approval-") && hasValue(item))
              : hoveredSeries
                ? activePayload.find((item) => String(item.dataKey ?? "") === hoveredSeries && hasValue(item))
                : undefined;
            const selected = preferred
              ?? activePayload.find((item) => String(item.dataKey ?? "").startsWith("approval-") && hasValue(item))
              ?? activePayload.find((item) => String(item.dataKey ?? "") === "reconstructed" && hasValue(item))
              ?? activePayload.find((item) => String(item.dataKey ?? "") === "score" && hasValue(item));
            setHoveredValue(chartPayloadValue(selected?.value));
            const selectedDataKey = String(selected?.dataKey ?? "");
            setHoveredSeries(selected ? (selectedDataKey.startsWith("approval-") ? "approval" : selectedDataKey === "reconstructed" ? "reconstructed" : "score") : null);
          }}
          onMouseLeave={() => {
            setHoveredValue(null);
            setActiveTimestamp(null);
            setHoveredSeries(null);
            setMilestoneTooltip((current) => {
              if (current?.modality !== "pointer") return current;
              const focused = focusedTooltipRef.current;
              return focused ? { ...focused, modality: "focus" } : null;
            });
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
                onMouseEnter={(event) => activateMilestonePointer(milestone.event_id, event)}
                onMouseMove={(event) => activateMilestonePointer(milestone.event_id, event)}
                onClick={(event) => activateMilestonePointer(milestone.event_id, event)}
                onMouseLeave={() => deactivateMilestone(milestone.event_id, "pointer")}
                label={<MilestoneLabel milestone={milestone} alignLeft={timestamp >= domainMidpoint} active={activeMilestone === milestone.event_id} onPointerActivate={(event) => activateMilestonePointer(milestone.event_id, event)} onFocusActivate={(event) => activateMilestoneFocus(milestone.event_id, event)} onDeactivate={(kind) => deactivateMilestone(milestone.event_id, kind)} />}
              />
            );
          })}
          {hoveredValue !== null && activeTimestamp !== null && active === null && <ReferenceDot x={activeTimestamp} y={hoveredValue} r={3} fill={hoveredSeries === "approval" ? APPROVAL_COLORS[0] : hoveredSeries === "reconstructed" ? RECONSTRUCTED_COLOR : SCORE_COLOR} stroke="#09090b" strokeWidth={1} />}
          {hoveredValue !== null && active === null && <ReferenceLine y={hoveredValue} stroke={hoveredSeries === "approval" ? APPROVAL_COLORS[0] : hoveredSeries === "reconstructed" ? RECONSTRUCTED_COLOR : SCORE_COLOR} strokeDasharray="3 3" />}
          <ChartTooltip active={active ? false : undefined}
            content={
              <ScoreTooltipContent
                canonicalRows={chartRows}
                approvalSeries={approvalSeries}
                className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100 max-w-[min(28rem,calc(100vw-2rem))]"
                labelFormatter={(_, payload) => {
                  const row = payload?.[0]?.payload as ScoreChartRow | undefined;
                  const activeKeys = new Set(payload?.map((item) => String(item?.dataKey ?? "")));
                  if (activeKeys.has("score")) return row ? `Recorded observation · ${formatLocalDateTime(new Date(row.timestamp))}` : "";
                  if (activeKeys.has("reconstructed")) return row ? `Reconstructed score · ${formatLocalDateTime(new Date(row.timestamp))}` : "";
                  const historical = Object.values(row?.approvalDetails ?? {}).some((point) => point.bucket !== null);
                  if (historical) return "Historical approval period";
                  return row ? `Recorded observation · ${formatLocalDateTime(new Date(row.timestamp))}` : "";
                }}
                formatter={(value, _name, item) => {
                  const dataKey = String(item?.dataKey ?? "");
                  const row = item?.payload as ScoreChartRow | undefined;
                  if (dataKey === "score") {
                    return (
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="font-mono font-medium text-violet-200">Current Player Score</span>
                        <span className="font-mono font-medium text-violet-200">{formatNumber(Number(value), { maximumFractionDigits: 1 })}</span>
                        <span className="text-zinc-400">{row?.reviews === undefined ? "Current scoring-window evidence unavailable" : `Current scoring-window evidence: ${formatNumber(row.reviews)} reviews`}</span>
                      </div>
                    );
                  }
                  if (dataKey === "reconstructed") {
                    const reconstructed = row?.reconstructedDetails;
                    if (!reconstructed) return null;
                    return (
                      <div className="grid w-full gap-1 text-[11px] wrap-anywhere">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-violet-200">Reconstructed score</span>
                          <span className="font-mono font-medium text-violet-200">{formatNumber(Number(value), { maximumFractionDigits: 1 })}</span>
                        </div>
                        <p className="text-zinc-300">Score at: {formatBoundary(reconstructed.score_at)} · evaluated at: {formatBoundary(reconstructed.evaluated_at)}</p>
                        <p className="text-zinc-400">Score window: {formatBoundary(reconstructed.score_window.start)}–{formatBoundary(reconstructed.score_window.end)}</p>
                        <p className="text-zinc-400">Current scoring-window evidence: {formatNumber(reconstructed.current_reviews)} reviews · historical support: {formatNumber(reconstructed.historical_support.actual_reviews)} actual / {formatNumber(reconstructed.historical_support.effective_reviews)} effective</p>
                        <p className="text-zinc-400">Source observation: {formatBoundary(reconstructed.observed_at)}</p>
                      </div>
                    );
                  }
                  const point = row?.approvalDetails[dataKey];
                  const bucket = point?.bucket;
                  const series = approvalSeries.find((entry) => entry.key === dataKey);
                  if (!bucket || !series) return null;
                  return (
                    <div className="grid w-full gap-1 text-[11px] wrap-anywhere">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-cyan-200">{approvalLegendLabel(series.sourceId, approvalSeries.length > 1)}</span>
                        <span className="font-mono font-medium text-cyan-200">{formatPercent(bucket.approval)}</span>
                      </div>
                      <p className="text-zinc-300">Period: {formatDateOnly(bucket.period_start)}–{formatDateOnly(bucket.period_end)} · {bucket.granularity === "daily" ? "Daily" : "Monthly"} bucket</p>
                       <p className="text-zinc-400">{formatNumber(bucket.positive_reviews)} positive + {formatNumber(bucket.negative_reviews)} negative = {formatNumber(bucket.total_reviews)} reviews</p>
                      <p className="text-zinc-400">Source population: {displayPopulationValue(series.populationRef?.population ?? bucket.population_ref?.population)} · {series.sourceId}</p>
                    </div>
                  );
                }}
              />
            }
          />
          <Area data={points} dataKey="score" type="monotone" stroke="var(--color-score)" strokeWidth={1.8} fill={`url(#score-area-${appid})`} dot={points.length === 1 ? { r: 3 } : false} activeDot={false} isAnimationActive={false} connectNulls={false} onMouseEnter={() => setHoveredSeries("score")} />
          <Line
            data={reconstructedData}
            onMouseEnter={() => setHoveredSeries("reconstructed")}
            dataKey="reconstructed"
            name="Reconstructed score"
            type="monotone"
            stroke={RECONSTRUCTED_COLOR}
            strokeWidth={1.8}
            strokeDasharray="2 3"
            dot={reconstructedPoints.length === 1 ? { r: 3 } : false}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          {approvalSeries.map((series) => (
            <Line
              key={series.key}
              data={series.data}
              onMouseEnter={() => setHoveredSeries("approval")}
              dataKey={series.key}
              name={approvalLegendLabel(series.sourceId, approvalSeries.length > 1)}
              type="monotone"
              stroke={series.color}
              strokeWidth={1.7}
              strokeDasharray="5 4"
              dot={(props: ApprovalDotProps) => isolatedApprovalDot(props, series.color)}
              activeDot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
        </ComposedChart>
      </ChartContainer>
      <div className="score-chart-legend" aria-label="Score history legend">
        <span className="score-chart-legend-item"><span className="score-chart-legend-swatch score-chart-legend-swatch--recorded" aria-hidden="true" />Recorded score</span>
        {hasReconstructedObservations && <span className="score-chart-legend-item"><span className="score-chart-legend-swatch score-chart-legend-swatch--reconstructed" aria-hidden="true" />Reconstructed score</span>}
        {approvalSeries.map((series) => <span key={series.key} className="score-chart-legend-item"><span className="score-chart-legend-swatch score-chart-legend-swatch--approval" style={{ borderTopColor: series.color }} aria-hidden="true" />{approvalLegendLabel(series.sourceId, approvalSeries.length > 1)}</span>)}
      </div>
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
      {!hasRecordedObservations && !hasReconstructedObservations && !hasApprovalObservations && <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-xs text-zinc-500">No score observations in this range.</p>}
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

function ScoreHistoryCard({ appid, range, setRange, history, summary, isUpdating }: { appid: number; range: HistoryRange; setRange: (range: HistoryRange) => void; history: GameScoreHistory | null | undefined; summary: GameScoreSummary | null | undefined; isUpdating: boolean }) {
  const milestones = historyMilestones(history);
  return (
    <section id="score-history" className="min-w-0 border border-zinc-800 bg-zinc-950 p-4 sm:p-5" aria-labelledby="score-history-title">
      <header className="flex flex-col justify-between gap-3 border-b border-zinc-900 pb-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 bg-violet-400" aria-hidden="true" />
          <div><h2 id="score-history-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Score History</h2><p className="mt-1 font-mono text-[11px] text-zinc-500">Player scores and historical Steam approval</p></div>
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
  const lifetime = summary?.lifetime_approval ?? null;
  return (
    <aside id="critic-reception" className="score-reception-card min-w-0 border border-zinc-800 bg-zinc-950 p-4 sm:p-5 xl:flex xl:flex-col xl:self-stretch" aria-labelledby="critic-reception-title">
      <h2 id="critic-reception-title" className="border-b border-zinc-900 pb-3 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">Reception</h2>
      <div className="border-b border-zinc-800 py-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm text-zinc-200">Current Player Score</p><p className="mt-1 font-mono text-[10px] uppercase text-zinc-500">Player evidence</p></div><p className="font-mono text-3xl font-bold tabular-nums text-violet-200">{score === null ? "—" : formatNumber(score, { maximumFractionDigits: 1 })}</p></div><p className="mt-1 font-mono text-xs text-zinc-500">{reviews === null ? "Current scoring-window evidence unavailable" : `${formatNumber(reviews)} reviews in current scoring window`}</p></div>{lifetime && <div className="grid grid-cols-2 gap-2 border-b border-zinc-800 py-3 font-mono text-xs" aria-label="Lifetime player approval"><div><span className="block text-[10px] uppercase text-zinc-500">Lifetime approval</span><span className="font-bold tabular-nums text-violet-200">{formatPercent(lifetime.value)}</span></div><div><span className="block text-[10px] uppercase text-zinc-500">Lifetime reviews</span><span className="tabular-nums text-zinc-300">{formatNumber(lifetime.total_reviews)}</span></div></div>}
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
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)] xl:items-stretch">
        <ScoreHistoryCard appid={appid} range={range} setRange={setRange} history={history} summary={summaryQuery.data} isUpdating={isUpdating} />
        <ReceptionCard summary={summaryQuery.data} />
      </div>
      {summaryQuery.isError && <p className="font-mono text-xs text-zinc-500" role="status">Reception data unavailable.</p>}
    </section>
  );
}
