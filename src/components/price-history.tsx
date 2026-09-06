import React, { useState, useEffect, useRef, useMemo } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import {
  useQuery,
  useQueryClient,
  QueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  type PriceHistoryRange,
  type PriceHistoryResult,
  type PriceState,
  DEFAULT_PRICE_RANGE,
  formatPriceCents,
} from "../lib/prices";
import { formatLocalDateTime } from "../lib/format";
import { formatCurrentPrice, isPriceDiscounted } from "../lib/price-presentation";
import { PriceSummary } from "./price-summary";
import {
  buildPriceChartGeometry,
  buildPriceChartPoints,
  getPriceChartDomain,
  type PriceChartPoint,
} from "../lib/price-chart";

export interface PriceHistoryChartProps {
  appid: number;
  initialRange?: PriceHistoryRange;
  initialData?: PriceHistoryResult;
  customFetch?: typeof fetch;
}

type LoadStatus = "idle" | "loading" | "success" | "error";

const RANGES: readonly PriceHistoryRange[] = ["30d", "6m", "1y", "all"];

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

export async function fetchPriceHistory(
  appid: number,
  range: PriceHistoryRange,
  customFetch?: typeof fetch
): Promise<PriceHistoryResult> {
  const fetchFn = customFetch ?? fetch;
  const res = await fetchFn(`/api/prices/history?appid=${appid}&range=${range}`);
  if (!res.ok) {
    throw new Error(`Failed to load price history: ${res.status}`);
  }
  const payload = (await res.json()) as { status?: string; data?: PriceHistoryResult };
  if (!payload.data) {
    throw new Error("Empty price history data");
  }
  return payload.data;
}

export function priceHistoryQueryOptions(
  appid: number,
  range: PriceHistoryRange,
  options?: { initialData?: PriceHistoryResult; customFetch?: typeof fetch }
) {
  const hasInitial =
    options?.initialData &&
    options.initialData.appid === appid &&
    options.initialData.range === range;
  return {
    queryKey: ["price-history", appid, range],
    queryFn: () => fetchPriceHistory(appid, range, options?.customFetch),
    initialData: hasInitial ? options?.initialData : undefined,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
  };
}

function pointAsHistoryEntry(point: PriceChartPoint) {
  return {
    appid: 0,
    currency: point.currency,
    initial_price: point.initialPriceCents,
    final_price: point.finalPriceCents,
    discount_percent: point.discountPercent,
    is_free: point.isFree,
    is_available: point.isAvailable,
    formatted_price: null,
    observed_at: point.observedAt,
  };
}

function formatPointPrice(point: PriceChartPoint) {
  return formatCurrentPrice(pointAsHistoryEntry(point));
}

/** Renders a chart domain edge instant in the visitor's locale/time zone. */
function formatAxisDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function pointDescription(point: PriceChartPoint) {
  if (point.inferred) {
    return `Last observed ${formatLocalDateTime(point.sourceTimestamp)}; dashed continuation is not a new observation.`;
  }
  return `Observed ${formatLocalDateTime(point.observedAt)}.`;
}

function statusForSummary(status: LoadStatus): "loading" | "error" | "success" {
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "loading";
}

export function PriceHistoryChart({
  appid,
  initialRange = DEFAULT_PRICE_RANGE,
  initialData,
  customFetch,
}: PriceHistoryChartProps) {
  const [range, setRange] = useState<PriceHistoryRange>(initialRange);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(900);

  const queryClient = useSafeQueryClient();
  const queryOptions = useMemo(
    () => priceHistoryQueryOptions(appid, range, { initialData, customFetch }),
    [appid, range, initialData, customFetch]
  );
  const { data, isFetching, isPlaceholderData, status: queryStatus } = useQuery(
    queryOptions,
    queryClient
  );

  const status = queryStatus === "pending" ? "loading" : queryStatus;
  const isUpdating = isFetching && isPlaceholderData;

  useEffect(() => {
    const element = chartContainerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateWidth = () => {
      const measuredWidth = Math.round(element.clientWidth);
      if (measuredWidth > 0) {
        setChartWidth((previousWidth) => previousWidth === measuredWidth ? previousWidth : measuredWidth);
      }
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const currentPrice: PriceState | null = data?.current_price ?? null;
  const historyEntries = data?.history ?? [];
  const points = useMemo(
    () => buildPriceChartPoints(historyEntries, currentPrice, data?.anchor_timestamp),
    [currentPrice, data?.anchor_timestamp, historyEntries]
  );
  const domain = useMemo(
    () => getPriceChartDomain(points, range, data?.anchor_timestamp),
    [data?.anchor_timestamp, points, range]
  );
  const geometry = useMemo(
    () => buildPriceChartGeometry(points, domain, { width: chartWidth, height: 260 }),
    [chartWidth, domain, points]
  );
  const compactFree = Boolean(
    data?.is_always_free && currentPrice?.is_available && currentPrice.is_free
  );
  const periodLowCents = useMemo(() => {
    const validPrices = points
      .map((p) => p.finalPriceCents)
      .filter((v): v is number => typeof v === "number" && !isNaN(v));
    if (validPrices.length === 0) {
      return currentPrice?.final_price ?? null;
    }
    return Math.min(...validPrices);
  }, [points, currentPrice]);
  const basePriceCents = currentPrice?.initial_price ?? currentPrice?.final_price ?? null;
  const allTimeLow = data?.all_time_low;
  const summaryStatus = statusForSummary(status);
  const currentIsOffer = isPriceDiscounted(currentPrice);
  const hoveredPoint = hoveredIndex === null ? null : points[hoveredIndex] ?? null;
  const hasData = points.length > 0 || currentPrice !== null;
  return (
    <div
      className="w-full space-y-4 border border-zinc-800 bg-zinc-950 p-4 sm:p-5"
      data-testid="price-history-card"
    >
      <PriceSummary price={currentPrice} variant="hero" status={summaryStatus} />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-orange-500 inline-block"></span>
          <h2 className="text-xs font-mono font-semibold text-zinc-200 uppercase tracking-wider">
            Price History
          </h2>
          {isUpdating && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-orange-400">
              <CircleNotch className="h-3 w-3 animate-spin" />
              <span>Updating...</span>
            </span>
          )}
        </div>
        <div className="flex items-center space-x-1" role="group" aria-label="Price history time ranges">
          {RANGES.map((item) => {
            const active = range === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => {
                  if (item === range) return;
                  setRange(item);
                }}
                aria-pressed={active}
                className={`min-h-[44px] min-w-[44px] px-2.5 py-1 inline-flex items-center justify-center text-[11px] font-mono uppercase tracking-wider transition-colors rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                  active
                    ? "bg-orange-600 text-white font-semibold"
                    : "bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border border-zinc-800"
                }`}
              >
                {item === "all" ? "All" : item}
              </button>
            );
          })}
        </div>
      </div>

      {/* 4-slot price summary bar */}
      {!compactFree && hasData && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs font-mono">
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Current Price</span>
            <span className="text-zinc-100 font-bold tabular-nums">
              {currentPrice ? formatCurrentPrice(currentPrice) : "No data"}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">
              {range === "all" ? "All-Time Low" : `${range.toUpperCase()} Low`}
            </span>
            <span className="text-zinc-300 tabular-nums">
              {periodLowCents !== null ? formatPriceCents(periodLowCents, currentPrice?.currency ?? "USD") : "No data"}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">Base Price</span>
            <span className="text-zinc-300 tabular-nums">
              {basePriceCents !== null ? formatPriceCents(basePriceCents, currentPrice?.currency ?? "USD") : "No data"}
            </span>
          </div>
          <div className="border border-zinc-900 bg-zinc-900/40 p-2">
            <span className="text-zinc-500 text-[10px] uppercase block">All-Time Low</span>
            <span className="text-orange-400 font-bold tabular-nums">
              {allTimeLow
                ? `${formatPriceCents(allTimeLow.price_cents, allTimeLow.currency)}${allTimeLow.discount_percent > 0 ? ` (-${allTimeLow.discount_percent}%)` : ""}`
                : (periodLowCents !== null ? formatPriceCents(periodLowCents, currentPrice?.currency ?? "USD") : "No data")}
            </span>
          </div>
        </div>
      )}

      {status === "loading" && (
        <div className="flex h-48 items-center justify-center text-xs text-zinc-500">Loading price history...</div>
      )}
      {status === "error" && (
        <div className="flex h-48 items-center justify-center text-xs text-amber-400/80">Live price data unavailable</div>
      )}
      {status === "success" && !hasData && (
        <div
          className="flex h-48 items-center justify-center border border-dashed border-zinc-900 text-xs text-zinc-500"
          data-testid="price-history-empty"
        >
          No data yet
        </div>
      )}

      {status === "success" && hasData && (
        compactFree ? (
            <div
              className="border border-zinc-800 bg-zinc-900/30 p-4"
              data-testid="price-history-always-free"
              aria-label="Free since first retained observation"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Free since first observation</p>
                  <p className="mt-1 text-xs text-zinc-400">Free at every recorded price check.</p>
                </div>
                <p className="font-mono text-lg tabular-nums text-zinc-100">Free</p>
              </div>
            </div>
          ) : (
            <div className={`space-y-3 transition-opacity duration-200 ${isUpdating ? "opacity-50" : "opacity-100"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-zinc-500">
                <span>{formatAxisDate(domain.start)}</span>
                <span>Selected range: {range.toUpperCase()}</span>
                <span>{formatAxisDate(domain.end)}</span>
              </div>
              <div ref={chartContainerRef} className="relative overflow-hidden border border-zinc-900 bg-zinc-900/20 p-2" data-testid="price-history-chart">
                <svg
                  viewBox={`0 0 ${geometry.width} ${geometry.height}`}
                  className="block h-auto w-full"
                  role="img"
                  aria-label="Price history chart with stepped observations and savings areas"
                  data-testid="price-history-svg"
                  data-x-domain-start={domain.start}
                  data-x-domain-end={domain.end}
                >
                  <title>{`Price history for AppID ${appid}`}</title>
                  <desc>Unavailable observations and currency changes remain gaps. Dashed lines are carried-forward state, not new observations.</desc>
                  <line x1={geometry.padLeft} y1={geometry.padTop} x2={geometry.width - geometry.padRight} y2={geometry.padTop} stroke="#27272a" strokeDasharray="3 3" />
                  <line x1={geometry.padLeft} y1={geometry.height - geometry.padBottom} x2={geometry.width - geometry.padRight} y2={geometry.height - geometry.padBottom} stroke="#3f3f46" />
                  <text x={geometry.padLeft - 6} y={geometry.padTop + 4} textAnchor="end" fill="#71717a" fontSize="10" fontFamily="monospace">{formatPriceCents(geometry.maxPriceCents, currentPrice?.currency ?? "USD")}</text>
                  <text x={geometry.padLeft - 6} y={geometry.height - geometry.padBottom + 4} textAnchor="end" fill="#71717a" fontSize="10" fontFamily="monospace">{formatPriceCents(0, currentPrice?.currency ?? "USD")}</text>
                  <text x={geometry.padLeft} y={geometry.height - 10} textAnchor="start" fill="#71717a" fontSize="10" fontFamily="monospace">{formatAxisDate(domain.start)}</text>
                  <text x={geometry.width - geometry.padRight} y={geometry.height - 10} textAnchor="end" fill="#71717a" fontSize="10" fontFamily="monospace">{formatAxisDate(domain.end)}</text>
                  {geometry.savingsAreas.map((area, index) => (
                    <path key={`savings-${index}`} d={area.d} fill="#fb923c" opacity="0.2" data-testid="price-savings-area" aria-label={`Savings area ${formatPriceCents(area.savingsCents, area.from.currency)}`} />
                  ))}
                  {geometry.paths.map((path, index) => (
                    <path
                      key={`line-${index}`}
                      d={path.d}
                      fill="none"
                      stroke={path.inferred ? "#a1a1aa" : "#fb923c"}
                      strokeWidth="2"
                      strokeDasharray={path.inferred ? "6 5" : undefined}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      data-testid={path.inferred ? "price-history-inferred" : "price-history-observed"}
                      aria-label={path.inferred ? "Carried-forward price, not observed" : "Observed price change"}
                    />
                  ))}
                  {geometry.coordinates.map((coordinate, index) => {
                    if (coordinate.y === null) return null;
                    const isolated = geometry.isolatedPoints.some(({ point }) => point === coordinate.point);
                    const focused = hoveredIndex === index;
                    return (
                      <circle
                        key={`point-${index}`}
                        cx={coordinate.x}
                        cy={coordinate.y}
                        r={focused || isolated ? 4 : 7}
                        fill={focused || isolated ? "#fb923c" : "transparent"}
                        stroke={focused ? "#fff7ed" : isolated ? "#18181b" : "transparent"}
                        strokeWidth="2"
                        tabIndex={0}
                        role="button"
                        aria-label={`${formatPointPrice(coordinate.point)} at ${formatLocalDateTime(coordinate.point.observedAt)}${coordinate.point.inferred ? ", carried forward, not observed" : ""}`}
                        onMouseEnter={() => setHoveredIndex(index)}
                        onFocus={() => setHoveredIndex(index)}
                        onMouseLeave={() => setHoveredIndex(null)}
                        onBlur={() => setHoveredIndex(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setHoveredIndex(null);
                        }}
                      />
                    );
                  })}
                  {hoveredIndex !== null &&
                    geometry.coordinates[hoveredIndex] &&
                    geometry.coordinates[hoveredIndex].y !== null && (
                      <g data-testid="price-hover-guide">
                        <line
                          x1={geometry.padLeft}
                          y1={geometry.coordinates[hoveredIndex].y!}
                          x2={geometry.coordinates[hoveredIndex].x}
                          y2={geometry.coordinates[hoveredIndex].y!}
                          stroke="#ea580c"
                          strokeDasharray="3 3"
                          strokeWidth="1"
                        />
                        <rect
                          x={geometry.padLeft - 50}
                          y={geometry.coordinates[hoveredIndex].y! - 7}
                          width={44}
                          height={14}
                          fill="#ea580c"
                          rx={2}
                        />
                        <text
                          x={geometry.padLeft - 28}
                          y={geometry.coordinates[hoveredIndex].y! + 4}
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="9"
                          fontFamily="monospace"
                          fontWeight="bold"
                        >
                          {formatPointPrice(geometry.coordinates[hoveredIndex].point)}
                        </text>
                      </g>
                    )}
                </svg>
                {hoveredPoint && (
                  <div
                    role="tooltip"
                    className="pointer-events-none absolute left-2 top-2 max-w-[260px] border border-zinc-700 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-200 shadow-2xl"
                  >
                    <p className="font-mono tabular-nums">{formatPointPrice(hoveredPoint)}</p>
                    <p className="mt-1 text-zinc-400">{pointDescription(hoveredPoint)}</p>
                    {hoveredPoint.isDiscounted && hoveredPoint.savingsCents !== null && (
                      <p className="mt-1 text-orange-300">Save {formatPriceCents(hoveredPoint.savingsCents, hoveredPoint.currency)}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500" aria-label="Price history legend">
                <span><i className="mr-1 inline-block h-2 w-2 bg-orange-400" />Observed</span>
                <span><i className="mr-1 inline-block h-2 w-2 border border-zinc-500" />Carried forward; not a new observation</span>
                {geometry.savingsAreas.length > 0 && <span><i className="mr-1 inline-block h-2 w-2 bg-orange-300/40" />Savings</span>}
                {currentIsOffer && <span className="text-orange-300">Current offer savings shown above</span>}
              </div>
            </div>
          )
      )}
    </div>
  );
}

export default PriceHistoryChart;
