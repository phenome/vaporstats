import React, { useEffect, useMemo, useRef, useState } from "react";
import { PriceSummary } from "./price-summary";
import {
  type PriceHistoryRange,
  type PriceHistoryResult,
  type PriceState,
  DEFAULT_PRICE_RANGE,
  formatPriceCents,
  formatPriceUtc,
} from "../lib/prices";
import { formatCurrentPrice, isPriceDiscounted } from "../lib/price-presentation";
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

function formatBasePrice(point: PriceChartPoint) {
  if (!point.isAvailable || point.initialPriceCents === null) return "Price unavailable";
  if (point.initialPriceCents === 0 && !point.isFree) {
    return point.currency === "USD" ? "$0.00" : `0.00 ${point.currency}`;
  }
  return formatPriceCents(point.initialPriceCents, point.currency, false);
}

function pointDescription(point: PriceChartPoint) {
  if (point.inferred) {
    return `Last observed ${formatPriceUtc(point.sourceTimestamp)}; dashed continuation is not a new observation.`;
  }
  return `Observed ${formatPriceUtc(point.observedAt)}.`;
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
  const [data, setData] = useState<PriceHistoryResult | null>(initialData ?? null);
  const [status, setStatus] = useState<LoadStatus>(initialData ? "success" : "idle");
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(900);

  useEffect(() => {
    let cancelled = false;
    const fetchFn = customFetch ?? fetch;
    if (data?.appid === appid && data.range === range) {
      return () => {
        cancelled = true;
      };
    }

    async function revalidate() {
      if (!data) setStatus("loading");
      try {
        const response = await fetchFn(`/api/prices/history?appid=${appid}&range=${range}`);
        if (cancelled) return;
        if (!response.ok) {
          setStatus("error");
          return;
        }
        const payload = (await response.json()) as {
          status?: string;
          data?: PriceHistoryResult;
        };
        if (cancelled) return;
        if (payload.status === "data" || payload.status === "empty") {
          setData(payload.data ?? null);
          setStatus("success");
        } else {
          setStatus("error");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void revalidate();
    return () => {
      cancelled = true;
    };
  }, [appid, range, customFetch, data]);

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

      <div className="flex flex-col gap-3 border-b border-zinc-900 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">Price history</p>
          <p className="mt-1 text-xs text-zinc-400">
            {currentPrice ? `Current: ${formatCurrentPrice(currentPrice)}` : "No successful observation yet"}
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Price history time ranges">
          {RANGES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setRange(item)}
              aria-pressed={range === item}
              className={`min-h-9 min-w-10 px-2 text-[11px] font-mono uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                range === item
                  ? "bg-orange-500/15 text-orange-200"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              {item === "all" ? "All" : item}
            </button>
          ))}
        </div>
      </div>

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
        <>
          {compactFree ? (
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
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-zinc-500">
                <span>{new Date(domain.start).toISOString().slice(0, 10)}</span>
                <span>Selected range: {range.toUpperCase()}</span>
                <span>{new Date(domain.end).toISOString().slice(0, 10)}</span>
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
                  <text x={geometry.padLeft - 6} y={geometry.height - geometry.padBottom + 4} textAnchor="end" fill="#71717a" fontSize="10" fontFamily="monospace">$0.00</text>
                  <text x={geometry.padLeft} y={geometry.height - 10} textAnchor="start" fill="#71717a" fontSize="10" fontFamily="monospace">{new Date(domain.start).toISOString().slice(0, 10)}</text>
                  <text x={geometry.width - geometry.padRight} y={geometry.height - 10} textAnchor="end" fill="#71717a" fontSize="10" fontFamily="monospace">{new Date(domain.end).toISOString().slice(0, 10)}</text>
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
                        aria-label={`${formatPointPrice(coordinate.point)} at ${formatPriceUtc(coordinate.point.observedAt)}${coordinate.point.inferred ? ", carried forward, not observed" : ""}`}
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
                </svg>
                {hoveredPoint && (
                  <div
                    role="tooltip"
                    className="pointer-events-none absolute left-2 top-2 max-w-[260px] border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-[11px] text-zinc-200 shadow-lg"
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
          )}

          <details className="border border-zinc-900 bg-zinc-900/20" open>
            <summary className="cursor-pointer px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Accessible observations</summary>
            <div className="overflow-x-auto border-t border-zinc-900">
              <table className="w-full min-w-[620px] text-left text-xs">
                <caption className="sr-only">Price observations and carried-forward state</caption>
                <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-normal">Timestamp (UTC)</th>
                    <th className="px-3 py-2 font-normal">Price</th>
                    <th className="px-3 py-2 font-normal">Base</th>
                    <th className="px-3 py-2 font-normal">Currency</th>
                    <th className="px-3 py-2 font-normal">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900 text-zinc-300">
                  {points.map((point, index) => (
                    <tr key={`${point.observedAt}-${index}`}>
                      <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums">{formatPriceUtc(point.observedAt)}</td>
                      <td className="px-3 py-2 font-mono tabular-nums">{formatPointPrice(point)}</td>
                      <td className="px-3 py-2 font-mono tabular-nums">{formatBasePrice(point)}</td>
                      <td className="px-3 py-2">{point.currency}</td>
                      <td className="px-3 py-2 text-zinc-500">{point.inferred ? "Carried forward, not observed" : point.isAvailable ? "Observed" : "Unavailable"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export default PriceHistoryChart;
