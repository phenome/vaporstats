import React from "react";
import type { RankedGame } from "../lib/player-history";
import type { DealItem } from "../lib/prices";
import { TrendingBlock } from "./trending";
import { DealsList } from "./deals";
import type { WeeklyReleasesResult, ReleaseEntity } from "../lib/releases";
import { HomeReleaseCalendarSection } from "./release-calendar";
import { HomeRecentReleasesSection } from "./recent-releases";
import { AppLink } from "./app-link";

export interface HomeComponentProps {
  initialTrending?: RankedGame[];
  initialDeals?: DealItem[];
  totalDeals?: number;
  currentWeekReleases?: WeeklyReleasesResult | null;
  recentReleases?: ReleaseEntity[];
}

export function HomeComponent({
  initialTrending,
  initialDeals,
  totalDeals,
  currentWeekReleases,
  recentReleases,
}: HomeComponentProps = {}) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-12 space-y-10">
      {/* Hero section with Command Deck styling */}
      <div className="border border-zinc-800 bg-zinc-950 p-8 space-y-6">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 bg-orange-500"></span>
          <span className="text-xs font-mono uppercase tracking-widest text-orange-400">
            Current players, prices, and releases
          </span>
        </div>

        <div className="space-y-3 max-w-2xl">
          <h1 className="text-3xl sm:text-4xl font-mono font-bold tracking-tight text-white">
            Steam Analytics & Player Tracking
          </h1>
          <p className="text-zinc-400 text-sm leading-relaxed">
            Explore current player counts, observed history, Steam prices and discounts, and weekly releases in one place.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <AppLink
            href="/games"
            className="px-4 py-2 min-h-[44px] inline-flex items-center justify-center bg-orange-600 hover:bg-orange-500 text-white font-mono text-xs uppercase tracking-wider font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Browse Playable Games
          </AppLink>
          <AppLink
            href="/rankings"
            className="px-4 py-2 min-h-[44px] inline-flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 font-mono text-xs uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            View Rankings
          </AppLink>
        </div>
      </div>

      {/* Trending Block: Top 10 tracked playable games */}
      <TrendingBlock initialGames={initialTrending} />

      {/* Featured Steam Deals Section */}
      <div className="space-y-4" data-testid="home-deals-section">
        <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 bg-emerald-500 inline-block"></span>
            <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-200">
              Featured Steam Deals
            </h2>
          </div>
          <AppLink
            href="/deals"
            className="min-h-[44px] inline-flex items-center text-xs font-mono text-emerald-400 hover:text-emerald-300 transition-colors uppercase tracking-wider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            Browse All Deals ({totalDeals ?? initialDeals?.length ?? 0}) &rarr;
          </AppLink>
        </div>

        <DealsList deals={initialDeals ?? []} total={totalDeals} />
      </div>

      {/* This Week's Releases Section */}
      {currentWeekReleases ? (
        <div data-testid="home-current-week-releases">
          <HomeReleaseCalendarSection data={currentWeekReleases} />
        </div>
      ) : (
        <section
          className="border border-zinc-800 bg-zinc-950 p-6 font-mono"
          data-testid="home-current-week-releases"
        >
          <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
            This Week&apos;s Releases
          </h2>
          <p className="mt-4 text-xs text-zinc-500">No data yet</p>
        </section>
      )}

      {/* Recent Releases Section */}
      <div data-testid="home-recent-releases">
        <HomeRecentReleasesSection releases={recentReleases ?? []} />
      </div>

    </div>
  );
}
