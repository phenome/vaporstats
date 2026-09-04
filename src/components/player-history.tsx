import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  type HistoryRange,
  type PlayerHistoryResult,
  type PlayerHistoryPoint,
  VALID_HISTORY_RANGES,
  DEFAULT_HISTORY_RANGE,
  formatExactUtc,
} from "../lib/player-history";

export interface PlayerHistoryChartProps {
  appid: number;
  initialRange?: HistoryRange;
  initialData?: PlayerHistoryResult;
  customFetch?: typeof fetch;
}

/**
 * Accessible, gap-preserving player history chart and tabular equivalent.
 * Enforces:
 * - Missing samples remain gaps/null/absent, never interpolated or converted to zero.
 * - Visible labels, min/max metrics, and observation timestamps.
 * - Tabular / text representation for screen readers and comprehensive review.
 * - Zero-radius Lyra design with responsive container.
 */
export function PlayerHistoryChart({
  appid,
  initialRange = DEFAULT_HISTORY_RANGE,
  initialData,
  customFetch,
}: PlayerHistoryChartProps) {
  const [range, setRange] = useState<HistoryRange>(initialRange);
  const [data, setData] = useState<PlayerHistoryResult | null>(
    initialData && initialData.appid === appid ? initialData : null
  );
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    initialData && initialData.appid === appid ? "success" : "loading"
  );
  const [showTable, setShowTable] = useState(false);

  // Keep initial display synced if initialData / appid changes
  useEffect(() => {
    if (initialData && initialData.appid === appid) {
      setData(initialData);
      setStatus("success");
    }
  }, [appid, initialData]);

  // Exactly one fetch per mount / appid / range change.
  // Never depends on data, avoiding infinite re-triggering upon success.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const fetchFn = customFetch ?? fetch;
      try {
        const res = await fetchFn(`/api/players/history?appid=${appid}&range=${range}`);
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as { status?: string; data?: PlayerHistoryResult };
        if (cancelled) return;
        if (json.status === "data" && json.data) {
          setData(json.data);
          setStatus("success");
        } else {
          setData(null);
          setStatus("success");
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [appid, range, customFetch]);

  const points = data?.points ?? [];
  const validPoints = useMemo(
    () => points.filter((p) => p.players !== null && p.players !== undefined),
    [points]
  );

  // Derive metrics across valid points without zero-falsification
  const stats = useMemo(() => {
    if (validPoints.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const p of validPoints) {
      const val = p.players!;
      if (val < min) min = val;
      if (val > max) max = val;
      sum += val;
    }
    const avg = Math.round(sum / validPoints.length);
    const latest = validPoints[validPoints.length - 1]?.players ?? null;
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

  const chartSegments = useMemo(() => {
    if (points.length === 0 || !stats) {
      return [];
    }

    const startTime = new Date(points[0].timestamp).getTime();
    const endTime = new Date(points[points.length - 1].timestamp).getTime();
    const timeSpan = endTime - startTime || 1;
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
      const x =
        points.length === 1 || timeSpan === 0
          ? padLeft + plotWidth / 2
          : padLeft + ((t - startTime) / timeSpan) * plotWidth;
      const y = isConstantValue
        ? padTop + plotHeight / 2
        : padTop + plotHeight - ((pt.players - stats.min) / valueSpan) * plotHeight;

      currentSegment.push({ x, y, point: pt });
    }

    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    return segments;
  }, [points, stats, plotWidth, plotHeight, padLeft, padTop]);

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
                onClick={() => setRange(r)}
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
              {stats.latest !== null ? stats.latest.toLocaleString("en-US") : "No data"}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Minimum</span>
            <span className="text-zinc-300 tabular-nums">
              {stats.min.toLocaleString("en-US")}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Maximum</span>
            <span className="text-orange-400 font-bold tabular-nums">
              {stats.max.toLocaleString("en-US")}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Average</span>
            <span className="text-zinc-300 tabular-nums">
              {stats.avg.toLocaleString("en-US")}
            </span>
          </div>
        </div>
      )}

      {/* Chart visualization */}
      <div className="relative w-full">
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
                  {stats.max.toLocaleString("en-US")}
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
                    {stats.max.toLocaleString("en-US")}
                  </text>
                  <text
                    x={padLeft - 8}
                    y={padTop + plotHeight / 2 + 4}
                    fill="#71717a"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    {Math.round((stats.max + stats.min) / 2).toLocaleString("en-US")}
                  </text>
                  <text
                    x={padLeft - 8}
                    y={height - padBottom + 4}
                    fill="#71717a"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    {stats.min.toLocaleString("en-US")}
                  </text>
                </>
              )}
              {/* X-axis start and end date labels */}
              <text
                x={padLeft}
                y={height - 12}
                fill="#71717a"
                fontSize="10"
                fontFamily="monospace"
                textAnchor="start"
              >
                {points[0].timestamp.substring(0, 10)}
              </text>
              <text
                x={width - padRight}
                y={height - 12}
                fill="#71717a"
                fontSize="10"
                fontFamily="monospace"
                textAnchor="end"
              >
                {points[points.length - 1].timestamp.substring(0, 10)}
              </text>

              {/* Gap-preserving Polyline Segments */}
              {chartSegments.map((segment, segIdx) => {
                if (segment.length === 1) {
                  // Single point: render as dot
                  return (
                    <circle
                      key={`dot-${segIdx}`}
                      cx={segment[0].x}
                      cy={segment[0].y}
                      r={3}
                      fill="#ea580c"
                    />
                  );
                }
                const pathD = segment
                  .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                  .join(" ");

                return (
                  <path
                    key={`seg-${segIdx}`}
                    d={pathD}
                    fill="none"
                    stroke="#ea580c"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })}

              {/* Endpoint marker */}
              {chartSegments.length > 0 && (
                <circle
                  cx={chartSegments[chartSegments.length - 1].slice(-1)[0]?.x}
                  cy={chartSegments[chartSegments.length - 1].slice(-1)[0]?.y}
                  r={4}
                  fill="#f97316"
                  stroke="#18181b"
                  strokeWidth={2}
                />
              )}
            </svg>
          </div>
        )}
      </div>

      {/* Accessible Table / Text Equivalent Toggle */}
      <div className="pt-2 border-t border-zinc-900">
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => setShowTable((prev) => !prev)}
            className="min-h-[44px] inline-flex items-center text-[11px] font-mono text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            aria-expanded={showTable}
          >
            {showTable ? "Hide data table equivalent" : "Show accessible data table equivalent"}
          </button>
          <span className="text-[10px] font-mono text-zinc-500">
            {points.length} recorded points • gaps preserved
          </span>
        </div>

        {showTable && (
          <div className="border border-zinc-800 bg-zinc-900/60 overflow-x-auto max-h-64 mt-2">
            <table
              className="w-full text-left text-xs font-mono"
              aria-label="Player count observation history"
            >
              <caption className="sr-only">Player history observations</caption>
              <thead className="bg-zinc-900 text-zinc-400 uppercase text-[10px] border-b border-zinc-800">
                <tr>
                  <th scope="col" className="px-3 py-2">Timestamp (UTC)</th>
                  <th scope="col" className="px-3 py-2">Player Count</th>
                  <th scope="col" className="px-3 py-2">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {points.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-center text-zinc-500">
                      No observations recorded for this range.
                    </td>
                  </tr>
                ) : (
                  points.map((pt, idx) => (
                    <tr
                      key={`${pt.timestamp}-${idx}`}
                      className={pt.players === null ? "bg-zinc-950/60 text-zinc-500 italic" : ""}
                    >
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {formatExactUtc(pt.timestamp)}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {pt.players !== null ? (
                          pt.players.toLocaleString("en-US")
                        ) : (
                          <span className="text-zinc-500 not-italic">— (Observation Gap)</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-[10px] uppercase">
                        {pt.players === null
                          ? "Gap"
                          : pt.is_rollup
                            ? "Daily Rollup"
                            : "Raw Observation"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default PlayerHistoryChart;
