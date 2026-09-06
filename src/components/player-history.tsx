import { formatLocalDateTime, formatNumber } from "../lib/format";
import React, { useState, useEffect, useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { CircleNotch } from "@phosphor-icons/react";
import {
  useQuery,
  useQueryClient,
  QueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./ui/chart";
import {
  type HistoryRange,
  type PlayerHistoryResult,
  type PlayerHistoryPoint,
  DEFAULT_HISTORY_RANGE,
} from "../lib/player-history";

export interface PlayerHistoryChartProps {
  appid: number;
  initialRange?: HistoryRange;
  initialData?: PlayerHistoryResult;
  customFetch?: typeof fetch;
}

const playerChartConfig = {
  players: {
    label: "Players",
    color: "#f97316",
  },
} satisfies ChartConfig;

function useSafeQueryClient() {
  try {
    return useQueryClient();
  } catch {
    return new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5 * 60 * 1000,
        },
      },
    });
  }
}

export async function fetchPlayerHistory(
  appid: number,
  range: HistoryRange,
  customFetch?: typeof fetch
): Promise<PlayerHistoryResult> {
  const fetchFn = customFetch ?? fetch;
  const res = await fetchFn(`/api/players/history?appid=${appid}&range=${range}`);
  if (!res.ok) {
    throw new Error(`Failed to load player history: ${res.status}`);
  }
  const json = (await res.json()) as { status?: string; data?: PlayerHistoryResult };
  if (json.status !== "data" || !json.data) {
    throw new Error("Empty player history data");
  }
  return json.data;
}

export function playerHistoryQueryOptions(
  appid: number,
  range: HistoryRange,
  options?: { initialData?: PlayerHistoryResult; customFetch?: typeof fetch }
) {
  const hasInitial =
    options?.initialData &&
    options.initialData.appid === appid &&
    options.initialData.range === range;
  return {
    queryKey: ["player-history", appid, range],
    queryFn: () => fetchPlayerHistory(appid, range, options?.customFetch),
    initialData: hasInitial ? options?.initialData : undefined,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
  };
}

/**
 * Accessible, gap-preserving player history chart.
 * Enforces:
 * - Missing samples remain gaps/null/absent, never interpolated or converted to zero.
 * - Visible labels, min/max metrics, and observation timestamps.
 * - Zero-radius Lyra design with responsive container.
 */
export function PlayerHistoryChart({
  appid,
  initialRange = DEFAULT_HISTORY_RANGE,
  initialData,
  customFetch,
}: PlayerHistoryChartProps) {
  const [range, setRange] = useState<HistoryRange>(initialRange);
  const [hoveredPoint, setHoveredPoint] = useState<{
    players: number | null;
    fullDate: string;
    hasRange?: boolean;
    min?: number;
    max?: number;
    avg?: number;
  } | null>(null);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const queryClient = useSafeQueryClient();
  const queryOptions = useMemo(
    () => playerHistoryQueryOptions(appid, range, { initialData, customFetch }),
    [appid, range, initialData, customFetch]
  );
  const { data, isFetching, isPlaceholderData, status: queryStatus } = useQuery(
    queryOptions,
    queryClient
  );

  const status = queryStatus === "pending" ? "loading" : queryStatus;
  const isUpdating = isFetching && isPlaceholderData;

  const points = data?.points ?? [];
  const validPoints = useMemo(
    () => points.filter((p) => p.players !== null && p.players !== undefined && !p.is_gap),
    [points]
  );

  // Derive metrics from bucket metadata when available. Raw points count once;
  // rollups contribute their recorded sample_count.
  const stats = useMemo(() => {
    if (validPoints.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    let weightedSum = 0;
    let totalWeight = 0;
    for (const p of validPoints) {
      const val = p.players!;
      const pointMin = typeof p.min === "number" ? p.min : val;
      const pointMax = typeof p.max === "number" ? p.max : val;
      if (pointMin < min) min = pointMin;
      if (pointMax > max) max = pointMax;

      const pointAverage = typeof p.avg === "number" ? p.avg : val;
      const pointWeight =
        typeof p.sample_count === "number" &&
        Number.isFinite(p.sample_count) &&
        p.sample_count > 0
          ? p.sample_count
          : 1;
      weightedSum += pointAverage * pointWeight;
      totalWeight += pointWeight;
    }
    const avg = Math.round(weightedSum / totalWeight);
    const latestPoint = validPoints[validPoints.length - 1];
    const latest = latestPoint?.close ?? latestPoint?.players ?? null;
    return { min, max, avg, latest };
  }, [validPoints]);

  // Chart coordinate mapping
  const width = 800;
  const height = 220;
  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 40;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const chartDomain = useMemo(() => {
    const recordedTimes = points
      .filter((point) => point.players !== null && !point.is_gap)
      .map((point) => new Date(point.timestamp).getTime())
      .filter((timestamp) => Number.isFinite(timestamp));
    const firstRecordedTime = recordedTimes[0] ?? 0;
    const lastRecordedTime = recordedTimes[recordedTimes.length - 1] ?? firstRecordedTime;
    const metadataStart = data?.range_start ? new Date(data.range_start).getTime() : NaN;
    const metadataEnd = data?.range_end ? new Date(data.range_end).getTime() : NaN;
    const startTime = Number.isFinite(metadataStart) ? metadataStart : firstRecordedTime;
    const endTime = Number.isFinite(metadataEnd) ? metadataEnd : lastRecordedTime;

    return {
      startTime,
      endTime,
      timeSpan: Math.max(endTime - startTime, 1),
    };
  }, [data, points]);

  const chartSegments = useMemo(() => {
    if (points.length === 0 || !stats) {
      return [];
    }

    const isConstantValue = stats.max === stats.min;
    const valueSpan = isConstantValue ? 1 : stats.max - stats.min;

    const segments: Array<Array<{ x: number; y: number; point: PlayerHistoryPoint }>> = [];
    let currentSegment: Array<{ x: number; y: number; point: PlayerHistoryPoint }> = [];

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (pt.players === null || pt.is_gap) {
        // Gap encountered: break segment to prevent interpolation
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }
        continue;
      }

      const t = new Date(pt.timestamp).getTime();
      if (!Number.isFinite(t)) {
        continue;
      }
      const x =
        chartDomain.timeSpan === 1 && chartDomain.startTime === chartDomain.endTime
          ? padLeft + plotWidth / 2
          : padLeft + ((t - chartDomain.startTime) / chartDomain.timeSpan) * plotWidth;
      const ptVal = typeof pt.avg === "number" ? Math.round(pt.avg) : pt.players;
      const y = isConstantValue
        ? padTop + plotHeight / 2
        : padTop + plotHeight - ((ptVal - stats.min) / valueSpan) * plotHeight;

      currentSegment.push({ x, y, point: pt });
    }

    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    return segments;
  }, [points, stats, chartDomain, plotWidth, plotHeight, padLeft, padTop]);

  const rechartsData = useMemo(() => {
    return points.map((p) => {
      const d = new Date(p.timestamp);
      const fullDate = isNaN(d.getTime())
        ? ""
        : formatLocalDateTime(d);
      const hasRange = !p.is_gap && typeof p.min === "number" && typeof p.max === "number";
      const min = typeof p.min === "number" ? p.min : p.players;
      const max = typeof p.max === "number" ? p.max : p.players;
      const avg = typeof p.avg === "number" ? Math.round(p.avg) : p.players;
      return {
        timestamp: p.timestamp,
        timestampMs: d.getTime(),
        fullDate,
        players: p.is_gap ? null : (hasRange && typeof avg === "number" ? avg : p.players),
        rangeBand: p.is_gap || !hasRange || min === null || max === null ? null : [min, max],
        min: min ?? undefined,
        max: max ?? undefined,
        avg: avg ?? undefined,
        hasRange,
      };
    });
  }, [points]);

  const formatAxisLabel = (timestamp: number) => {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "";
    return range === "24h"
      ? new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(date)
      : new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(date);
  };

  return (
    <div
      className="border border-zinc-800 bg-zinc-950 p-5 space-y-4 w-full"
      data-testid="player-history-card"
    >
      {/* Header and range switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-orange-500 inline-block"></span>
          <h2 className="text-xs font-mono font-semibold text-zinc-200 uppercase tracking-wider">
            Player Count History
          </h2>
          {isUpdating && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-orange-400">
              <CircleNotch className="h-3 w-3 animate-spin" />
              <span>Updating...</span>
            </span>
          )}
        </div>
        {/* Range control buttons */}
        <div
          className="flex items-center space-x-1"
          role="group"
          aria-label="Player history time ranges"
        >
          {(["24h", "7d", "30d", "90d", "all"] as const).map((r) => {
            const active = range === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => {
                  if (r === range) return;
                  setRange(r);
                }}
                aria-pressed={active}
                className={`min-h-[44px] min-w-[44px] px-2.5 py-1 inline-flex items-center justify-center text-[11px] font-mono uppercase tracking-wider transition-colors rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                  active
                    ? "bg-orange-600 text-white font-semibold"
                    : "bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border border-zinc-800"
                }`}
              >
                {r === "all" ? "All" : r}
              </button>
            );
          })}
        </div>
      </div>

      {/* Metric summary bar */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs font-mono">
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Current</span>
            <span className="text-zinc-100 font-bold tabular-nums">
              {formatNumber(stats.latest)}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">
              {range === "all" ? "All-Time Low" : `${range.toUpperCase()} Low`}
            </span>
            <span className="text-zinc-300 tabular-nums">
              {formatNumber(stats.min)}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">
              {range === "all" ? "All-Time Avg" : `${range.toUpperCase()} Peak`}
            </span>
            <span className="text-orange-400 font-bold tabular-nums">
              {formatNumber(range === "all" ? stats.avg : stats.max)}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">All-Time Peak</span>
            <span className="text-orange-400 font-bold tabular-nums">
              {formatNumber(data?.all_time_peak ?? stats.max)}
            </span>
          </div>
        </div>
      )}

      {/* Chart visualization */}
      <div className={`relative w-full transition-opacity duration-200 ${isUpdating ? "opacity-50" : "opacity-100"}`}>
        {status === "loading" && (
          <div className="h-56 flex items-center justify-center font-mono text-xs text-zinc-500">
            Loading player history...
          </div>
        )}

        {status === "error" && (
          <div className="h-56 flex items-center justify-center font-mono text-xs text-amber-500/80">
            Live data unavailable
          </div>
        )}

        {status === "success" && points.length === 0 && (
          <div
            className="h-56 flex flex-col items-center justify-center font-mono text-xs text-zinc-500 space-y-1"
            data-testid="no-history-state"
          >
            <span className="text-zinc-300 font-semibold">No data yet</span>
            <span>Awaiting first scheduled observation probe.</span>
          </div>
        )}

        {status === "success" && points.length > 0 && stats && (
          <div className="w-full overflow-hidden" data-testid="chart-viewport">
            {isMounted ? (
              <ChartContainer
                config={playerChartConfig}
                className="w-full h-[220px] aspect-auto"
              >
                <AreaChart
                  data={rechartsData}
                  margin={{ top: 10, right: 15, left: 10, bottom: 0 }}
                  onMouseMove={(state) => {
                    const activePt = state?.activePayload?.[0]?.payload;
                    if (activePt && activePt.players !== null && activePt.players !== undefined) {
                      setHoveredPoint(activePt);
                    } else {
                      setHoveredPoint(null);
                    }
                  }}
                  onMouseLeave={() => {
                    setHoveredPoint(null);
                  }}
                >
                  <defs>
                    <linearGradient id="playerGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f97316" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#f97316" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis
                    dataKey="timestampMs"
                    type="number"
                    domain={[chartDomain.startTime, chartDomain.endTime]}
                    tickFormatter={formatAxisLabel}
                    stroke="#71717a"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={25}
                    allowDataOverflow
                  />
                  <YAxis
                    stroke="#71717a"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) =>
                      v >= 1000000
                        ? `${(v / 1000000).toFixed(1)}M`
                        : v >= 1000
                        ? `${(v / 1000).toFixed(0)}k`
                        : `${v}`
                    }
                    domain={["auto", "auto"]}
                  />
                  {hoveredPoint && typeof hoveredPoint.players === "number" && (
                    <ReferenceLine
                      y={hoveredPoint.players}
                      stroke="#ea580c"
                      strokeDasharray="3 3"
                      strokeWidth={1}
                      label={{
                        value: hoveredPoint.players >= 1000000
                          ? `${(hoveredPoint.players / 1000000).toFixed(1)}M`
                          : hoveredPoint.players >= 1000
                          ? `${(hoveredPoint.players / 1000).toFixed(0)}k`
                          : `${hoveredPoint.players}`,
                        position: "left",
                        fill: "#ea580c",
                        fontSize: 10,
                        fontFamily: "monospace",
                      }}
                    />
                  )}
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100"
                        labelFormatter={(_, payload) => {
                          const item = payload?.[0]?.payload;
                          return item?.fullDate ?? "";
                        }}
                        formatter={(value, name, item) => {
                          if (item?.dataKey === "rangeBand") return null;
                          const payload = item?.payload;
                          if (payload?.hasRange && typeof payload.min === "number" && typeof payload.max === "number") {
                            return [
                              <span key="rollup-tooltip" className="flex flex-col gap-0.5">
                                <span className="font-bold">
                                  {typeof payload.avg === "number"
                                    ? formatNumber(Math.round(payload.avg))
                                    : typeof value === "number"
                                    ? formatNumber(value)
                                    : "No data"}{" "}
                                  (Avg)
                                </span>
                                <span className="text-[10px] text-zinc-400">
                                  Min: {formatNumber(payload.min)} | Max: {formatNumber(payload.max)}
                                </span>
                              </span>,
                            ];
                          }
                          return [
                            typeof value === "number"
                              ? formatNumber(value)
                              : "No data",
                            "Players",
                          ];
                        }}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="rangeBand"
                    stroke="#f97316"
                    strokeWidth={1}
                    strokeOpacity={0.4}
                    fill="#f97316"
                    fillOpacity={0.3}
                    isAnimationActive={false}
                    connectNulls={false}
                    tooltipType="none"
                  />
                  <Area
                    type="monotone"
                    dataKey="players"
                    stroke="#f97316"
                    strokeWidth={2}
                    fill="url(#playerGradient)"
                    dot={(dotProps) => {
                      const point = rechartsData[dotProps.index];
                      if (!point || point.players === null) return <></>;

                      const previous = rechartsData[dotProps.index - 1]?.players;
                      const next = rechartsData[dotProps.index + 1]?.players;
                      if (previous !== null && previous !== undefined) return <></>;
                      if (next !== null && next !== undefined) return <></>;

                      return (
                        <circle
                          cx={dotProps.cx}
                          cy={dotProps.cy}
                          r={3}
                          fill="#ea580c"
                          stroke="#18181b"
                          strokeWidth={1}
                        />
                      );
                    }}
                    activeDot={{ r: 5, fill: "#ea580c", stroke: "#18181b", strokeWidth: 2 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ChartContainer>
            ) : (
              <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-auto block select-none"
              role="img"
              aria-label={`Player count chart for AppID ${appid} over ${range}`}
            >
              <title>{`Player activity chart for AppID ${appid}`}</title>
              <desc>
                {`Shows player count between ${stats.min} and ${stats.max}. Observation gaps remain un-interpolated.`}
              </desc>

              {/* Background grid */}
              <line
                x1={padLeft}
                y1={padTop}
                x2={width - padRight}
                y2={padTop}
                stroke="#27272a"
                strokeDasharray="3 3"
              />
              <line
                x1={padLeft}
                y1={padTop + plotHeight / 2}
                x2={width - padRight}
                y2={padTop + plotHeight / 2}
                stroke="#27272a"
                strokeDasharray="3 3"
              />
              <line
                x1={padLeft}
                y1={height - padBottom}
                x2={width - padRight}
                y2={height - padBottom}
                stroke="#3f3f46"
              />

              {/* Y-axis Labels */}
              {stats.max === stats.min ? (
                <text
                  x={padLeft - 8}
                  y={padTop + plotHeight / 2 + 4}
                  fill="#a1a1aa"
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor="end"
                >
                  {formatNumber(stats.max)}
                </text>
              ) : (
                <>
                  <text
                    x={padLeft - 8}
                    y={padTop + 4}
                    fill="#a1a1aa"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    {formatNumber(stats.max)}
                  </text>
                  <text
                    x={padLeft - 8}
                    y={padTop + plotHeight / 2 + 4}
                    fill="#71717a"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    {formatNumber(Math.round((stats.max + stats.min) / 2))}
                  </text>
                  <text
                    x={padLeft - 8}
                    y={height - padBottom + 4}
                    fill="#71717a"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    {formatNumber(stats.min)}
                  </text>
                </>
              )}
              {/* X-axis start and end labels */}
              <text
                x={padLeft}
                y={height - 12}
                fill="#71717a"
                fontSize="10"
                fontFamily="monospace"
                textAnchor="start"
              >
                {formatAxisLabel(chartDomain.startTime)}
              </text>
              <text
                x={width - padRight}
                y={height - 12}
                fill="#71717a"
                fontSize="10"
                fontFamily="monospace"
                textAnchor="end"
              >
                {formatAxisLabel(chartDomain.endTime)}
              </text>

              {/* Gap-preserving Polyline Segments */}
              {chartSegments.map((segment, segIdx) => {
                const pathD = segment
                  .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                  .join(" ");

                return (
                  <React.Fragment key={`seg-${segIdx}`}>
                    {segment.length > 1 && (
                      <path
                        d={pathD}
                        fill="none"
                        stroke="#ea580c"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                    {segment.length === 1 && (
                      <circle
                        key={`dot-${segIdx}`}
                        cx={segment[0].x}
                        cy={segment[0].y}
                        r={3}
                        fill="#ea580c"
                        stroke="#18181b"
                        strokeWidth={1}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </svg>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

export default PlayerHistoryChart;
