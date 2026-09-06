import React from "react";
import type { CatalogEntity } from "../lib/catalog";
import type { RelatedAppEntity } from "../lib/related";
import type { PriceState, PriceHistoryResult } from "../lib/prices";
import { PriceHistoryChart } from "./price-history";
import { PriceSummary } from "./price-summary";
import { getCanonicalGamePath, getCanonicalPublisherPath } from "../lib/slug";
import { AppLink } from "./app-link";

export interface ChildAppPageViewProps {
  parent: CatalogEntity;
  child: RelatedAppEntity;
  price?: PriceState | null;
  priceHistory?: PriceHistoryResult | null;
}

export function ChildAppPageView({
  parent,
  child,
  price,
  priceHistory,
}: ChildAppPageViewProps) {
  const parentUrl = getCanonicalGamePath(parent.appid, parent.name);
  const isExpansion = child.type === "expansion" || child.prominence > 0;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6 font-mono">
      {/* Breadcrumb Hierarchy */}
      <nav aria-label="Breadcrumb" className="text-xs text-zinc-500 flex items-center gap-2">
        <AppLink href="/" className="hover:text-zinc-300 transition-colors">
          HOME
        </AppLink>
        <span>/</span>
        <AppLink href="/games" className="hover:text-zinc-300 transition-colors">
          GAMES
        </AppLink>
        <span>/</span>
        <AppLink href={parentUrl} className="hover:text-orange-400 text-zinc-400 transition-colors truncate max-w-xs">
          {parent.name}
        </AppLink>
        <span>/</span>
        <span className="text-zinc-200 uppercase truncate max-w-xs">{child.name}</span>
      </nav>

      {/* Subordinate Notice Banner */}
      <div className="border border-zinc-800 bg-zinc-950 p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-zinc-600 inline-block"></span>
          <span className="text-zinc-400 uppercase font-bold">Subordinate Related Entity</span>
          <span className="text-zinc-600">—</span>
          <span className="text-zinc-500">Parent playable game:</span>
          <AppLink href={parentUrl} className="text-orange-400 hover:underline">
            {parent.name} (#{parent.appid})
          </AppLink>
        </div>
        <div className="text-zinc-500">
          TYPE: <span className="text-zinc-300 uppercase font-bold">{child.type}</span>
        </div>
      </div>

      {/* Main Child Card */}
      <div className={`border ${isExpansion ? "border-orange-500/60" : "border-zinc-800"} bg-zinc-950 p-6 space-y-6`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 pb-3">
          <div className="flex items-center gap-3">
            <span
              className={`px-2 py-0.5 text-xs uppercase font-bold border ${
                isExpansion
                  ? "bg-orange-500/20 text-orange-400 border-orange-500/40"
                  : "bg-zinc-800 text-zinc-300 border-zinc-700"
              }`}
            >
              {isExpansion ? "Major Expansion" : child.type}
            </span>
            <span className="text-xs text-zinc-500 tabular-nums">{`AppID #${child.appid}`}</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            {child.release_date && (
              <div className="text-zinc-400">
                RELEASED: <span className="text-zinc-200">{child.release_date}</span>
              </div>
            )}
            <a
              href={`https://store.steampowered.com/app/${child.appid}/`}
              target="_blank"
              rel="noreferrer"
              className="text-orange-400 hover:text-orange-300 hover:underline inline-flex items-center gap-1"
            >
              Steam Store ↗
            </a>
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-6 items-start">
          {child.header_image ? (
            <img
              src={child.header_image}
              alt=""
              className="w-full md:w-80 h-36 object-cover border border-zinc-800 shrink-0"
            />
          ) : (
            <div className="w-full md:w-80 h-36 bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600 text-xs">
              NO IMAGE AVAILABLE
            </div>
          )}

          <div className="flex-1 space-y-3">
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">{child.name}</h1>

            <p className="text-xs text-zinc-400 leading-relaxed">
              {child.description || "No official description provided."}
            </p>

            <div className="pt-3 border-t border-zinc-900 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div>
                <div className="text-zinc-600 text-[10px] uppercase">Parent Game</div>
                <AppLink href={parentUrl} className="text-zinc-200 hover:text-orange-400 truncate block">
                  {parent.name}
                </AppLink>
              </div>
              <div>
                <div className="text-zinc-600 text-[10px] uppercase">Developer</div>
                <div className="text-zinc-200 truncate">
                  {child.developer ? (
                    <AppLink
                      href={getCanonicalPublisherPath(child.developer)}
                      className="hover:text-orange-400 hover:underline transition-colors"
                    >
                      {child.developer}
                    </AppLink>
                  ) : (
                    "Unknown"
                  )}
                </div>
              </div>
              <div>
                <div className="text-zinc-600 text-[10px] uppercase">Publisher</div>
                <div className="text-zinc-200 truncate">
                  {child.publisher ? (
                    <AppLink
                      href={getCanonicalPublisherPath(child.publisher)}
                      className="hover:text-orange-400 hover:underline transition-colors"
                    >
                      {child.publisher}
                    </AppLink>
                  ) : (
                    "Unknown"
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {child.is_eligible && (
        <PriceSummary price={price ?? null} variant="card" />
      )}
      {/* Child Price History Chart */}
      <PriceHistoryChart
        key={`price-${child.appid}`}
        appid={child.appid}
        initialRange="all"
        initialData={priceHistory ?? undefined}
      />


      {/* Return Navigation */}
      <div className="pt-2 flex flex-wrap items-center gap-3">
        <AppLink
          href={parentUrl}
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-orange-500 text-zinc-300 hover:text-white text-xs transition-colors"
        >
          <span>&larr;</span> Return to Parent Game: {parent.name}
        </AppLink>
        <a
          href={`https://store.steampowered.com/app/${child.appid}/`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-orange-500 text-orange-400 hover:text-orange-300 text-xs transition-colors"
        >
          <span>Steam Store ↗</span>
        </a>
      </div>
    </div>
  );
}
