import React, { useState, useEffect, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./ui/chart";
import {
  type PriceHistoryRange,
  type PriceHistoryResult,
  DEFAULT_PRICE_RANGE,
  formatPriceCents,
  formatPriceUtc,
  getPriceRangeCutoffDate,
} from "../lib/prices";

const priceChartConfig = {
  price: {
    label: "Price",
    color: "#22c55e",
  },
} satisfies ChartConfig;
export interface PriceHistoryChartProps {
  appid: number;
  initialRange?: PriceHistoryRange;
  initialData?: PriceHistoryResult;
  customFetch?: typeof fetch;
}

/**
 * Accessible, gap-preserving price history component with a visual step chart.
 * Supports ranges: 30d, 6m, 1y, All (default All, starting from first observation).
 * Preserves step changes and explicitly models unavailable/unpriced states without converting them to free or zero.
 */
export function PriceHistoryChart({
  appid,
  initialRange = DEFAULT_PRICE_RANGE,
  initialData,
  customFetch,
}: PriceHistoryChartProps) {
  const [range, setRange] = useState<PriceHistoryRange>(initialRange);
  const [data, setData] = useState<PriceHistoryResult | null>(initialData ?? null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    initialData ? "success" : "idle"
  );
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const fetchFn = customFetch ?? fetch;

    if (data?.appid === appid && data.range === range) {
      return () => {
        cancelled = true;
      };
    }

    async function revalidate() {
      if (!data) {
        setStatus("loading");
      }
      try {
        const res = await fetchFn(
          `/api/prices/history?appid=${appid}&range=${range}`
        );
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as {
          status?: string;
          data?: PriceHistoryResult;
        };
        if (cancelled) return;
        if (json.status === "data" || json.status === "empty") {
          setData(json.data ?? null);
          setStatus("success");
        } else {
          setStatus("error");
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    }

    revalidate();

    return () => {
      cancelled = true;
    };
  }, [appid, range, customFetch]);
  const historyEntries = data?.history ?? [];
  const currentPrice = data?.current_price ?? null;

  // Derive metrics across recorded observations
  const stats = useMemo(() => {
    if (historyEntries.length === 0 && !currentPrice) return null;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let hasPricedEntry = false;

    const allRecords: {
      final_price: number | null;
      is_free: boolean;
      is_available: boolean;
    }[] = [...historyEntries];

    if (currentPrice) {
      allRecords.push(currentPrice);
    }

    for (const r of allRecords) {
      if (!r.is_available) continue;
      if (r.is_free) {
        minPrice = 0;
        hasPricedEntry = true;
      } else if (r.final_price !== null) {
        hasPricedEntry = true;
        if (r.final_price < minPrice) minPrice = r.final_price;
        if (r.final_price > maxPrice) maxPrice = r.final_price;
      }
    }

    if (!hasPricedEntry) return null;

    return {
      min: minPrice === Infinity ? null : minPrice,
      max: maxPrice === -Infinity ? null : maxPrice,
      currency: currentPrice?.currency || "USD",
      current: currentPrice,
    };
  }, [historyEntries, currentPrice]);

  const chartPoints = useMemo(() => {
    const entries = [...historyEntries];
    if (
      currentPrice &&
      !entries.some((entry) => entry.observed_at === currentPrice.observed_at)
    ) {
      entries.push({
        id: undefined,
        appid: currentPrice.appid,
        currency: currentPrice.currency,
        initial_price: currentPrice.initial_price,
        final_price: currentPrice.final_price,
        discount_percent: currentPrice.discount_percent,
        is_free: currentPrice.is_free,
        is_available: currentPrice.is_available,
        formatted_price: currentPrice.formatted_final,
        observed_at: currentPrice.observed_at,
      });
    }

    return entries
      .map((entry) => {
        const d = new Date(entry.observed_at);
        const timestamp = d.getTime();
        if (!Number.isFinite(timestamp)) return null;
        const formattedDate = d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const fullDate = d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
        const priceDollars =
          !entry.is_available
            ? null
            : entry.is_free
            ? 0
            : entry.final_price !== null
            ? entry.final_price / 100
            : null;
        return {
          observed_at: entry.observed_at,
          timestamp,
          formattedDate,
          fullDate,
          price: priceDollars,
          finalPriceCents: entry.final_price,
          initialPriceCents: entry.initial_price,
          discountPercent: entry.discount_percent,
          isFree: entry.is_free,
          isAvailable: entry.is_available,
          currency: entry.currency,
        };
      })
      .filter((point): point is NonNullable<typeof point> => point !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [historyEntries, currentPrice]);

  const chartDomain = useMemo<[number, number]>(() => {
    if (chartPoints.length === 0) return [0, 1];

    const latestActual = chartPoints[chartPoints.length - 1].timestamp;
    const anchorTimestamp = data?.anchor_timestamp
      ? new Date(data.anchor_timestamp).getTime()
      : latestActual;
    const anchor = Number.isFinite(anchorTimestamp) ? anchorTimestamp : latestActual;
    const end = range === "all" ? latestActual : anchor;
    const anchorTime = new Date(end);
    const earliest = data?.earliest_observation
      ? new Date(data.earliest_observation).getTime()
      : chartPoints[0].timestamp;
    const start =
      range === "all"
        ? Number.isFinite(earliest)
          ? Math.min(earliest, chartPoints[0].timestamp)
          : chartPoints[0].timestamp
        : getPriceRangeCutoffDate(range, anchorTime, data?.earliest_observation)?.getTime() ??
          chartPoints[0].timestamp;

    return [start, end];
  }, [chartPoints, data?.anchor_timestamp, data?.earliest_observation, range]);

  const visibleChartPoints = useMemo(
    () =>
      range === "all"
        ? chartPoints
        : chartPoints.filter(
            (point) => point.timestamp >= chartDomain[0] && point.timestamp <= chartDomain[1]
          ),
    [chartDomain, chartPoints, range]
  );
  const rechartsPriceData = visibleChartPoints;
  const chartWidth = 800;
  const chartHeight = 220;
  const chartPadLeft = 60;
  const chartPadRight = 20;
  const chartPadTop = 20;
  const chartPadBottom = 40;
  const chartPlotWidth = chartWidth - chartPadLeft - chartPadRight;
  const chartPlotHeight = chartHeight - chartPadTop - chartPadBottom;
  const chartSegments = useMemo(() => {
    const timeSpan = chartDomain[1] - chartDomain[0] || 1;
    const minPrice = stats?.min ?? 0;
    const maxPrice = stats?.max ?? minPrice + 100;
    const valueSpan = maxPrice - minPrice || 1;
    const segments: Array<Array<{ x: number; y: number }>> = [];
    let segment: Array<{ x: number; y: number }> = [];

    for (const point of visibleChartPoints) {
      if (point.price === null) {
        if (segment.length > 0) segments.push(segment);
        segment = [];
        continue;
      }
      segment.push({
        x: chartPadLeft + ((point.timestamp - chartDomain[0]) / timeSpan) * chartPlotWidth,
        y: chartPadTop + chartPlotHeight - ((point.price * 100 - minPrice) / valueSpan) * chartPlotHeight,
      });
    }
    if (segment.length > 0) segments.push(segment);
    return segments;
  }, [chartDomain, chartPlotHeight, chartPlotWidth, stats, visibleChartPoints]);
  return (
    <div
      className="border border-zinc-800 bg-zinc-950 p-5 space-y-4 w-full"
      data-testid="price-history-card"
    >
      {/* Header and range switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-emerald-500 inline-block"></span>
          <h2 className="text-xs font-mono font-semibold text-zinc-200 uppercase tracking-wider">
            Price History (US / USD)
          </h2>
        </div>

        {/* Range control buttons: 30d, 6m, 1y, All (default All) */}
        <div
          className="flex items-center space-x-1"
          role="group"
          aria-label="Price history time ranges"
        >
          {(["30d", "6m", "1y", "all"] as const).map((r) => {
            const active = range === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                aria-pressed={active}
                className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors rounded-none ${
                  active
                    ? "bg-emerald-600 text-white font-semibold"
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
            <span className="text-zinc-500 text-[10px] uppercase block">Current Price</span>
            <span className="text-zinc-100 font-bold tabular-nums">
              {stats.current
                ? stats.current.is_free
                  ? "Free"
                  : stats.current.is_available && stats.current.final_price !== null
                  ? formatPriceCents(stats.current.final_price, stats.currency)
                  : "Unavailable"
                : "No data yet"}
            </span>
          </div>

          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Lowest Observed</span>
            <span className="text-emerald-400 font-bold tabular-nums">
              {stats.min !== null
                ? stats.min === 0
                  ? "Free"
                  : formatPriceCents(stats.min, stats.currency)
                : "Unavailable"}
            </span>
          </div>

          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Base Price</span>
            <span className="text-zinc-300 tabular-nums">
              {stats.current?.initial_price !== null && stats.current?.initial_price !== undefined
                ? formatPriceCents(stats.current.initial_price, stats.currency)
                : stats.max !== null
                ? formatPriceCents(stats.max, stats.currency)
                : "Unavailable"}
            </span>
          </div>

          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Current Discount</span>
            <span className="text-orange-400 font-bold tabular-nums">
              {stats.current && stats.current.discount_percent > 0
                ? `-${stats.current.discount_percent}%`
                : "None"}
            </span>
          </div>
        </div>
      )}

      {/* Visual Chart / Step representation */}
      <div className="relative w-full">
        {status === "loading" && (
          <div className="h-48 flex items-center justify-center font-mono text-xs text-zinc-500">
            Loading price history...
          </div>
        )}

        {status === "error" && (
          <div className="h-48 flex items-center justify-center font-mono text-xs text-amber-500/80">
            Live price data unavailable
          </div>
        )}

        {status === "success" && historyEntries.length === 0 && !currentPrice && (
          <div
            className="h-48 flex items-center justify-center font-mono text-xs text-zinc-500 border border-dashed border-zinc-900"
            data-testid="price-history-empty"
          >
            No data yet
          </div>
        )}

        {status === "success" && (historyEntries.length > 0 || currentPrice) && (
          <div className="space-y-4">
            {isMounted ? (
              <div className="space-y-2">
                <div className="flex flex-wrap justify-between items-center text-[10px] font-mono text-zinc-500 px-1 gap-1">
                  <span>
                    {data?.earliest_observation
                      ? `First observed: ${formatPriceUtc(data.earliest_observation)}`
                      : "Observation start"}
                  </span>
                  <span>Range: {range.toUpperCase()}</span>
                  <span>Latest: {formatPriceUtc(data?.source_timestamp)}</span>
                </div>
                <ChartContainer
                  config={priceChartConfig}
                  className="w-full h-[200px] aspect-auto bg-zinc-900/20 border border-zinc-900 p-2"
                >
                  <LineChart
                    data={rechartsPriceData}
                    margin={{ top: 15, right: 20, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis
                      type="number"
                      dataKey="timestamp"
                      domain={chartDomain}
                      allowDataOverflow
                      stroke="#71717a"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={30}
                      tickFormatter={(value: number) => new Date(value).toISOString().slice(0, 10)}
                    />
                    <YAxis
                      stroke="#71717a"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                      domain={["auto", "auto"]}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_, payload) => {
                            const item = payload?.[0]?.payload;
                            return item?.fullDate ?? "";
                          }}
                          formatter={(value, name, item) => {
                            const p = item.payload;
                            if (p.isFree) return ["Free", "Price"];
                            if (!p.isAvailable) return ["Unavailable", "Price"];
                            return [
                              `$${Number(value).toFixed(2)}${
                                p.discountPercent > 0 ? ` (-${p.discountPercent}%)` : ""
                              }`,
                              "Price",
                            ];
                          }}
                        />
                      }
                    />
                    <Line
                      type="stepAfter"
                      dataKey="price"
                      stroke="#22c55e"
                      strokeWidth={2}
                      dot={{ fill: "#22c55e", r: 3, stroke: "#18181b", strokeWidth: 1 }}
                      activeDot={{ r: 5, fill: "#22c55e", stroke: "#18181b", strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ChartContainer>
              </div>
            ) : (
              <div
                className="w-full bg-zinc-900/20 border border-zinc-900 p-4"
                role="img"
                aria-label="Price history chart showing recorded price changes over time"
              >
                <div className="flex flex-wrap justify-between items-center text-[10px] font-mono text-zinc-500 mb-2 border-b border-zinc-900 pb-1 gap-1">
                  <span>
                    {data?.earliest_observation
                      ? ("First observed: " + formatPriceUtc(data.earliest_observation))
                      : "Observation start"}
                  </span>
                  <span>Range: {range.toUpperCase()}</span>
                  <span>Latest: {formatPriceUtc(data?.source_timestamp)}</span>
                </div>
                <svg
                  viewBox={"0 0 " + chartWidth + " " + chartHeight}
                  className="w-full h-auto block select-none"
                  role="img"
                  aria-label="Price history chart"
                  data-testid="price-history-ssr"
                  data-x-domain-start={chartDomain[0]}
                  data-x-domain-end={chartDomain[1]}
                >
                  <title>{"Price history for AppID " + appid}</title>
                  <desc>Unavailable observations remain gaps rather than zero-valued prices.</desc>
                  <line
                    x1={chartPadLeft}
                    y1={chartPadTop}
                    x2={chartWidth - chartPadRight}
                    y2={chartPadTop}
                    stroke="#27272a"
                    strokeDasharray="3 3"
                  />
                  <line
                    x1={chartPadLeft}
                    y1={chartHeight - chartPadBottom}
                    x2={chartWidth - chartPadRight}
                    y2={chartHeight - chartPadBottom}
                    stroke="#3f3f46"
                  />
                  <text
                    x={chartPadLeft}
                    y={chartHeight - 12}
                    fill="#71717a"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="start"
                  >
                    {new Date(chartDomain[0]).toISOString().slice(0, 10)}
                  </text>
                  <text
                    x={chartWidth - chartPadRight}
                    y={chartHeight - 12}
                    fill="#71717a"
                    fontSize="10"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    {new Date(chartDomain[1]).toISOString().slice(0, 10)}
                  </text>
                  {chartSegments.map((segment, index) => {
                    if (segment.length === 1) {
                      return (
                        <circle
                          key={"price-dot-" + index}
                          cx={segment[0].x}
                          cy={segment[0].y}
                          r={3}
                          fill="#22c55e"
                          data-testid="price-chart-point"
                        />
                      );
                    }
                    return (
                      <path
                        key={"price-segment-" + index}
                        d={segment
                          .map((point, pointIndex) =>
                            pointIndex === 0
                              ? "M " + point.x.toFixed(1) + " " + point.y.toFixed(1)
                              : "H " + point.x.toFixed(1) + " V " + point.y.toFixed(1)
                          )
                          .join(" ")}
                        fill="none"
                        stroke="#22c55e"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    );
                  })}
                </svg>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default PriceHistoryChart;
