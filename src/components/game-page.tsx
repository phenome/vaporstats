import React from "react";
import type { GameDetail } from "../lib/catalog";
import type { GroupedRelatedApps } from "../lib/related";
import type { PlayerHistoryResult } from "../lib/player-history";
import {
  type PriceState,
  type PriceHistoryResult,
  formatPriceCents,
  formatPriceUtc,
} from "../lib/prices";
import { getCanonicalPublisherPath } from "../lib/slug";
import { PlayerPanel } from "./player-panel";
import { PlayerHistoryChart } from "./player-history";
import { PriceHistoryChart } from "./price-history";
import { RelatedApps } from "./related-apps";

export interface GamePageProps {
  game: GameDetail;
  related?: GroupedRelatedApps;
  playerHistory?: PlayerHistoryResult;
  price?: PriceState | null;
  priceHistory?: PriceHistoryResult | null;
  releasePresentation?: React.ReactNode;
  releaseSummary?: React.ReactNode;
  releasePresentationPlacement?: "body" | "hero-float";
}

export function GamePageView({
  game,
  related,
  playerHistory,
  price,
  priceHistory,
  releasePresentation,
  releaseSummary,
  releasePresentationPlacement = "body",
}: GamePageProps) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Top Banner / Breadcrumb & Header */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 pb-3">
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 bg-orange-500/10 text-orange-400 border border-orange-500/30 text-[10px] font-mono uppercase tracking-widest">
              {game.type}
            </span>
            {releaseSummary}
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <a
              href={`https://store.steampowered.com/app/${game.appid}/`}
              target="_blank"
              rel="noreferrer"
              className="text-orange-400 hover:text-orange-300 hover:underline inline-flex items-center gap-1"
            >
              Steam Store ↗
            </a>
          </div>
        </div>

        {releasePresentationPlacement === "body" && releasePresentation}

        <div className="flex flex-col md:flex-row gap-6 items-start">
          {game.header_image ? (
            <img
              src={game.header_image}
              alt={game.name}
              className="w-full md:w-80 border border-zinc-800 object-cover aspect-[460/215]"
            />
          ) : (
            <div className="w-full md:w-80 h-36 bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600 font-mono text-xs">
              NO IMAGE AVAILABLE
            </div>
          )}

          <div className="flex-1">
            <div className="flow-root space-y-3">
              {releasePresentationPlacement === "hero-float" && releasePresentation}
              <h1 className="text-2xl md:text-3xl font-mono font-bold text-zinc-100 tracking-tight">
                {game.name}
              </h1>
              {game.description && (
                <p className="text-sm text-zinc-400 leading-relaxed font-sans">
                  {game.description}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2 text-xs font-mono">
              <div className="border border-zinc-900 bg-zinc-900/40 p-2.5">
                <div className="text-zinc-500 text-[10px] uppercase">Developer</div>
                <div className="text-zinc-200 font-medium truncate">
                  {game.developer ? (
                    <a
                      href={getCanonicalPublisherPath(game.developer)}
                      className="hover:text-orange-400 hover:underline transition-colors"
                    >
                      {game.developer}
                    </a>
                  ) : (
                    "Unknown"
                  )}
                </div>
              </div>
              <div className="border border-zinc-900 bg-zinc-900/40 p-2.5">
                <div className="text-zinc-500 text-[10px] uppercase">Publisher</div>
                <div className="text-zinc-200 font-medium truncate">
                  {game.publisher ? (
                    <a
                      href={getCanonicalPublisherPath(game.publisher)}
                      className="hover:text-orange-400 hover:underline transition-colors"
                    >
                      {game.publisher}
                    </a>
                  ) : (
                    "Unknown"
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <nav
        aria-label="Game page sections"
        className="flex min-h-[44px] items-center overflow-x-auto border border-zinc-800 bg-zinc-950 px-1 font-mono"
      >
        <a href="#activity" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Activity
        </a>
        <a href="#player-history" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Player History
        </a>
        <a href="#price-history" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Price History
        </a>
        {related && (
          <a href="#related-content" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
            Related Content
          </a>
        )}
      </nav>

      {/* Metrics Deck: Activity */}
      <div id="activity" className="grid scroll-mt-28 grid-cols-1 gap-4 md:grid-cols-3">
        {/* Current Players Metric Panel */}
        <PlayerPanel
          key={game.appid}
          appid={game.appid}
          initialData={{
            appid: game.appid,
            latest_players: game.latest_players,
            observed_at: game.last_observed_at,
            current_price: price ?? null,
          }}
        />
      </div>

      <section id="player-history" className="scroll-mt-28">
      {/* Player History Chart Deck (Default 30d) */}
      <PlayerHistoryChart
        key={game.appid}
        appid={game.appid}
        initialRange="30d"
        initialData={playerHistory}
      />
      </section>

      <section id="price-history" className="scroll-mt-28">
      {/* Price History Chart Deck (Default All) */}
      <PriceHistoryChart
        key={`price-${game.appid}`}
        appid={game.appid}
        initialRange="all"
        initialData={priceHistory ?? undefined}
      />
      </section>
      {/* Related Content Deck */}
      {related && (
        <section id="related-content" className="scroll-mt-28">
          <RelatedApps parent={game} grouped={related} />
        </section>
      )}
    </div>
  );
}

export default GamePageView;
