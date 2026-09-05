import React from "react";
import { AppLink } from "./app-link";
import { type DealItem, formatPriceUtc } from "../lib/prices";
import { getCanonicalGamePath } from "../lib/slug";
import { getCanonicalChildPath } from "../lib/related";

export interface DealsListProps {
  deals: DealItem[];
  total?: number;
  currentType?: "all" | "game" | "dlc" | "expansion";
  currentSort?: "discount" | "price" | "recent";
  onTypeChange?: (type: "all" | "game" | "dlc" | "expansion") => void;
  onSortChange?: (sort: "discount" | "price" | "recent") => void;
}

/**
 * Accessible deals listing component for Steam discounts.
 * Presents discounted playable games and consumer DLC/expansions while excluding accessories.
 */
export function DealsList({
  deals = [],
  total,
  currentType = "all",
  currentSort = "discount",
}: DealsListProps) {
  const count = total ?? deals.length;

  return (
    <div className="space-y-4 w-full" data-testid="deals-container">
      {/* Deals Header & Filter / Sort Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 bg-emerald-500 inline-block"></span>
          <span className="text-xs font-mono font-semibold text-zinc-200 uppercase tracking-wider">
            Active Steam Deals ({count})
          </span>
        </div>

        {/* Filter by Entity Type */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <div className="flex items-center space-x-1 border border-zinc-800 p-0.5 bg-zinc-900/60">
            {(
              [
                { id: "all", label: "All Deals" },
                { id: "game", label: "Games" },
                { id: "dlc", label: "DLC" },
                { id: "expansion", label: "Expansions" },
              ] as const
            ).map((t) => {
              const active = currentType === t.id;
              const href = t.id === "all" ? "/deals" : `/deals?type=${t.id}`;
              return (
                <AppLink
                  key={t.id}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-emerald-600 text-white font-semibold"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                  }`}
                >
                  {t.label}
                </AppLink>
              );
            })}
          </div>

          {/* Sort Selector */}
          <div className="flex items-center space-x-1 border border-zinc-800 p-0.5 bg-zinc-900/60">
            {(
              [
                { id: "discount", label: "Highest Discount" },
                { id: "price", label: "Lowest Price" },
                { id: "recent", label: "Recently Updated" },
              ] as const
            ).map((s) => {
              const active = currentSort === s.id;
              const typeParam = currentType !== "all" ? `type=${currentType}&` : "";
              const href = `/deals?${typeParam}sort=${s.id}`;
              return (
                <AppLink
                  key={s.id}
                  href={href}
                  className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-zinc-700 text-zinc-100 font-semibold"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {s.label}
                </AppLink>
              );
            })}
          </div>
        </div>
      </div>

      {/* Deals Table */}
      {deals.length === 0 ? (
        <div
          className="border border-zinc-800 bg-zinc-950 p-12 text-center font-mono text-xs text-zinc-400"
          data-testid="deals-empty"
        >
          No active discounts found for this selection.
        </div>
      ) : (
        <div
          className="border border-zinc-800 bg-zinc-950 overflow-x-auto"
          data-testid="deals-table-container"
        >
          <table
            className="w-full text-left text-xs font-mono"
            aria-label="Active Steam deals on games, DLC, and expansions"
          >
            <thead className="bg-zinc-900/80 text-zinc-400 border-b border-zinc-800 uppercase tracking-wider text-[11px]">
              <tr>
                <th scope="col" className="px-4 py-3">Entity</th>
                <th scope="col" className="px-4 py-3">Type</th>
                <th scope="col" className="px-4 py-3 text-right">Discount</th>
                <th scope="col" className="px-4 py-3 text-right">Initial</th>
                <th scope="col" className="px-4 py-3 text-right">Current Deal</th>
                <th scope="col" className="px-4 py-3 text-right hidden sm:table-cell">Observed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900 text-zinc-300">
              {deals.map((deal) => {
                const isChild = Boolean(deal.parent_appid);
                const canonicalPath =
                  isChild && deal.parent_appid && deal.parent_name
                    ? getCanonicalChildPath(
                        deal.parent_appid,
                        deal.parent_name,
                        deal.appid,
                        deal.name
                      )
                    : getCanonicalGamePath(deal.appid, deal.name);

                const parentCanonicalPath =
                  isChild && deal.parent_appid && deal.parent_name
                    ? getCanonicalGamePath(deal.parent_appid, deal.parent_name)
                    : null;

                const typeLabel =
                  deal.type === "expansion"
                    ? "Expansion"
                    : deal.type === "dlc"
                    ? "DLC"
                    : "Game";

                const typeBadgeClass =
                  deal.type === "expansion"
                    ? "border-purple-800 bg-purple-950/60 text-purple-300"
                    : deal.type === "dlc"
                    ? "border-blue-800 bg-blue-950/60 text-blue-300"
                    : "border-zinc-800 bg-zinc-900 text-zinc-300";

                return (
                  <tr
                    key={deal.appid}
                    className="hover:bg-zinc-900/40 transition-colors"
                    data-testid="deal-row"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {deal.header_image && (
                          <img
                            src={deal.header_image}
                            alt=""
                            className="w-16 h-8 object-cover border border-zinc-800 shrink-0 hidden sm:block"
                            loading="lazy"
                          />
                        )}
                        <div>
                          <AppLink
                            href={canonicalPath}
                            className="font-bold text-zinc-100 hover:text-emerald-400 hover:underline transition-colors inline-flex min-h-[44px] min-w-[44px] items-center"
                          >
                            {deal.name}
                          </AppLink>
                          {isChild && deal.parent_name && parentCanonicalPath && (
                            <span className="text-[10px] text-zinc-500 block">
                              Base:{" "}
                              <AppLink
                                href={parentCanonicalPath}
                                className="hover:text-zinc-300 inline-flex min-h-[44px] min-w-[44px] items-center"
                              >
                                {deal.parent_name}
                              </AppLink>
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`inline-block border px-1.5 py-0.5 text-[10px] uppercase font-bold tracking-wider ${typeBadgeClass}`}
                      >
                        {typeLabel}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <span className="inline-block bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 text-xs font-bold tabular-nums">
                        {`-${deal.discount_percent}%`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-zinc-500 line-through tabular-nums">
                      {deal.formatted_initial}
                    </td>

                    <td className="px-4 py-3 text-right whitespace-nowrap text-emerald-400 font-bold tabular-nums text-sm">
                      {deal.formatted_final}
                    </td>

                    <td className="px-4 py-3 text-right whitespace-nowrap text-zinc-500 tabular-nums text-[11px] hidden sm:table-cell">
                      {formatPriceUtc(deal.observed_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default DealsList;
