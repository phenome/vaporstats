import React from "react";
import type { DealItem } from "../lib/prices";
import { DealsList } from "./deals";

export interface DealsPageViewProps {
  deals?: DealItem[];
  total?: number;
  currentType?: "all" | "game" | "dlc" | "expansion";
  currentSort?: "discount" | "price" | "recent";
}

/**
 * Public deals page presenting discounted playable games, consumer DLC, and expansions.
 * Accessories are excluded from top-level discovery.
 */
export function DealsPageView({
  deals = [],
  total,
  currentType = "all",
  currentSort = "discount",
}: DealsPageViewProps) {
  const count = total ?? deals.length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Top Banner */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-900 pb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 bg-emerald-500 inline-block"></span>
              <span className="text-xs font-mono uppercase tracking-wider text-emerald-400">
                Steam Store Discounts
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-mono font-bold text-zinc-100 tracking-tight">
              Steam Deals & Price Cuts
            </h1>
            <p className="text-xs text-zinc-400 mt-1 font-mono">
              Live discount tracker for playable games, official expansions, and consumer DLC.
            </p>
          </div>

          <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2">
            ACTIVE DEALS: <span className="text-emerald-400 font-bold tabular-nums">{count}</span>
          </div>
        </div>
      </div>

      {/* Deals Listing */}
      <DealsList
        deals={deals}
        total={count}
        currentType={currentType}
        currentSort={currentSort}
      />
    </div>
  );
}
