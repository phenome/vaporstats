import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  type PriceHistoryRange,
  type PriceHistoryResult,
  type PriceHistoryEntry,
  DEFAULT_PRICE_RANGE,
  formatPriceCents,
  formatPriceUtc,
} from "../lib/prices";
export interface PriceHistoryChartProps {
  appid: number;
  initialRange?: PriceHistoryRange;
  initialData?: PriceHistoryResult;
  customFetch?: typeof fetch;
}

/**
 * Accessible, gap-preserving price history component with visual step chart and tabular equivalent.
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
  const [showTable, setShowTable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchFn = customFetch ?? fetch;

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
          if (!data) setStatus("error");
          return;
        }
        const json = (await res.json()) as {
          status?: string;
          data?: PriceHistoryResult;
        };
        if (cancelled) return;
        if ((json.status === "data" || json.status === "empty") && json.data) {
          setData(json.data);
          setStatus("success");
        } else if (!data) {
          setData(null);
          setStatus("success");
        }
      } catch {
        if (!cancelled && !data) {
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
            No price observations recorded yet.
          </div>
        )}

        {status === "success" && (historyEntries.length > 0 || currentPrice) && (
          <div className="space-y-4">
            {/* SVG Visual Step-Chart */}
            <div
              className="w-full bg-zinc-900/20 border border-zinc-900 p-4"
              role="img"
              aria-label="Price history chart showing recorded price changes over time"
            >
              <div className="flex flex-wrap justify-between items-center text-[10px] font-mono text-zinc-500 mb-2 border-b border-zinc-900 pb-1 gap-1">
                <span>
                  {data?.earliest_observation
                    ? `First observed: ${formatPriceUtc(data.earliest_observation)}`
                    : "Observation start"}
                </span>
                <span>Range: {range.toUpperCase()}</span>
                <span>Latest: {formatPriceUtc(data?.source_timestamp)}</span>
              </div>

              {/* Timeline / step events */}
              <div className="space-y-2 py-2">
                {historyEntries.map((entry, idx) => {
                  const dateStr = formatPriceUtc(entry.observed_at);
                  const isDiscounted = entry.discount_percent > 0;
                  return (
                    <div
                      key={entry.id ?? idx}
                      className="flex items-center justify-between text-xs font-mono py-1 px-2 border-l-2 border-emerald-600 bg-zinc-900/30"
                      data-testid="price-step-point"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-400 text-[11px] tabular-nums">{dateStr}</span>
                        {isDiscounted && (
                          <span className="bg-emerald-950 text-emerald-400 border border-emerald-800 px-1.5 py-0.2 text-[10px] font-bold">
                            -{entry.discount_percent}%
                          </span>
                        )}
                        {!entry.is_available && (
                          <span className="bg-zinc-800 text-zinc-400 px-1 text-[10px]">
                            Unavailable
                          </span>
                        )}
                      </div>
                      <div className="text-right tabular-nums">
                        {entry.is_free ? (
                          <span className="text-emerald-400 font-bold">Free</span>
                        ) : entry.is_available && entry.final_price !== null ? (
                          <div className="flex items-center gap-1.5">
                            {isDiscounted && entry.initial_price !== null && (
                              <span className="text-zinc-600 line-through text-[11px]">
                                {formatPriceCents(entry.initial_price, entry.currency)}
                              </span>
                            )}
                            <span className="text-zinc-100 font-bold">
                              {formatPriceCents(entry.final_price, entry.currency)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-zinc-500 italic">Unavailable</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Accessible Table Equivalent Toggle */}
            <div className="pt-2 border-t border-zinc-900">
              <button
                type="button"
                onClick={() => setShowTable(!showTable)}
                aria-expanded={showTable}
                aria-label="Toggle accessible price history data table"
                className="min-h-[44px] text-xs font-mono text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1.5 py-1"
              >
                <span>{showTable ? "[-]" : "[+]"}</span>
                <span>{showTable ? "Hide data table equivalent" : "View accessible price history table"}</span>
              </button>

              {showTable && (
                <div
                  className="mt-3 border border-zinc-800 overflow-x-auto"
                  data-testid="price-history-table"
                >
                  <table
                    className="w-full text-left text-xs font-mono"
                    aria-label="Price history observation table equivalent"
                  >
                    <thead className="bg-zinc-900 text-zinc-400 border-b border-zinc-800">
                      <tr>
                        <th scope="col" className="px-3 py-2">Date (UTC)</th>
                        <th scope="col" className="px-3 py-2">State</th>
                        <th scope="col" className="px-3 py-2 text-right">Initial Price</th>
                        <th scope="col" className="px-3 py-2 text-right">Final Price</th>
                        <th scope="col" className="px-3 py-2 text-right">Discount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900 text-zinc-300">
                      {historyEntries.map((entry, idx) => (
                        <tr key={entry.id ?? idx} className="hover:bg-zinc-900/40">
                          <td className="px-3 py-2 text-zinc-400 tabular-nums">
                            {formatPriceUtc(entry.observed_at)}
                          </td>
                          <td className="px-3 py-2">
                            {entry.is_free
                              ? "Free to Play"
                              : entry.is_available
                              ? entry.discount_percent > 0
                                ? "Discounted"
                                : "Standard Price"
                              : "Unavailable / Delisted"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                            {entry.initial_price !== null
                              ? formatPriceCents(entry.initial_price, entry.currency)
                              : "-"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold text-zinc-100">
                            {entry.is_free
                              ? "Free"
                              : entry.final_price !== null
                              ? formatPriceCents(entry.final_price, entry.currency)
                              : "Unavailable"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-emerald-400 font-semibold">
                            {entry.discount_percent > 0 ? `-${entry.discount_percent}%` : "0%"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default PriceHistoryChart;
