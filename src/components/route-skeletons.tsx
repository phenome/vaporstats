import { Skeleton } from "./ui/skeleton";

/**
 * Skeleton loading state for the main Home discovery page.
 * Mirrors the structure of HomeComponent: Hero, Trending, Deals, and Releases.
 */
export function HomeSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-12 space-y-10 animate-fade-in" data-testid="home-skeleton">
      {/* Hero section */}
      <div className="border border-zinc-800 bg-zinc-950 p-8 space-y-6">
        <div className="flex items-center gap-2">
          <Skeleton className="w-2.5 h-2.5 bg-orange-500/50" />
          <Skeleton className="h-3.5 w-64" />
        </div>

        <div className="space-y-3 max-w-2xl">
          <Skeleton className="h-9 sm:h-10 w-3/4 max-w-lg" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Skeleton className="h-11 w-44 bg-orange-950/40 border border-orange-500/20" />
          <Skeleton className="h-11 w-36 bg-zinc-900 border border-zinc-800" />
        </div>
      </div>

      {/* Trending Block Skeleton */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
          <div className="flex items-center gap-2">
            <Skeleton className="w-2.5 h-2.5 bg-orange-500/50" />
            <Skeleton className="h-3.5 w-32" />
          </div>
          <Skeleton className="h-4 w-24" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="border border-zinc-800 bg-zinc-950 p-3 space-y-3">
              <Skeleton className="w-full aspect-[460/215] bg-zinc-900" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-5/6" />
                <div className="flex items-center justify-between pt-1">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Featured Steam Deals Section Skeleton */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
          <div className="flex items-center gap-2">
            <Skeleton className="w-2.5 h-2.5 bg-emerald-500/50" />
            <Skeleton className="h-3.5 w-40" />
          </div>
          <Skeleton className="h-4 w-32" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="border border-zinc-800 bg-zinc-950 p-3 space-y-3">
              <Skeleton className="w-full aspect-[460/215] bg-zinc-900" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-4/5" />
                <div className="flex items-center justify-between">
                  <Skeleton className="h-5 w-12 bg-emerald-950/40" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Weekly Releases Skeleton */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Skeleton className="w-2.5 h-2.5 bg-orange-500/50" />
          <Skeleton className="h-3.5 w-44" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 pt-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="border border-zinc-900 bg-zinc-900/40 p-3 space-y-2 min-h-[140px]">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-20" />
              <div className="pt-2 space-y-1.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Skeleton loading state for the Game Detail page (/games/$game).
 * Mirrors the structure of GamePageView: Banner, Player/Price Panels, Charts, Related Apps.
 */
export function GamePageSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6 animate-fade-in" data-testid="game-skeleton">
      {/* Top Banner / Breadcrumb & Header */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 pb-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-14 bg-orange-950/40 border border-orange-500/20" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-4 w-24" />
        </div>

        <div className="flex flex-col md:flex-row gap-6 items-start">
          <Skeleton className="w-full md:w-80 aspect-[460/215] shrink-0 border border-zinc-800 bg-zinc-900" />
          <div className="flex-1 space-y-3 w-full">
            <Skeleton className="h-8 w-3/4 max-w-md" />
            <div className="flex flex-wrap gap-4 pt-1">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="pt-3 space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-5/6" />
              <Skeleton className="h-3.5 w-4/6" />
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-6 w-14" />
            </div>
          </div>
        </div>
      </div>

      {/* 2-column grid: Player Panel + Price Panel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
            <div className="flex items-center gap-2">
              <Skeleton className="w-2.5 h-2.5 bg-orange-500/50" />
              <Skeleton className="h-3.5 w-28" />
            </div>
            <Skeleton className="h-3.5 w-20" />
          </div>
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="space-y-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-28" />
            </div>
            <div className="space-y-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-28" />
            </div>
          </div>
          <div className="pt-2">
            <Skeleton className="h-3.5 w-48" />
          </div>
        </div>

        <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
            <div className="flex items-center gap-2">
              <Skeleton className="w-2.5 h-2.5 bg-emerald-500/50" />
              <Skeleton className="h-3.5 w-28" />
            </div>
            <Skeleton className="h-3.5 w-20" />
          </div>
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="space-y-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-24" />
            </div>
            <div className="space-y-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
          <div className="pt-2">
            <Skeleton className="h-3.5 w-44" />
          </div>
        </div>
      </div>

      {/* 2-column grid: Player History Chart + Price History Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
            <Skeleton className="h-3.5 w-36" />
            <div className="flex gap-2">
              <Skeleton className="h-6 w-12" />
              <Skeleton className="h-6 w-12" />
            </div>
          </div>
          <Skeleton className="h-64 w-full bg-zinc-900/60" />
        </div>

        <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
            <Skeleton className="h-3.5 w-36" />
            <div className="flex gap-2">
              <Skeleton className="h-6 w-12" />
              <Skeleton className="h-6 w-12" />
            </div>
          </div>
          <Skeleton className="h-64 w-full bg-zinc-900/60" />
        </div>
      </div>

      {/* Related apps placeholder */}
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-4">
        <Skeleton className="h-4 w-40" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border border-zinc-900 bg-zinc-900/30 p-3 space-y-2">
              <Skeleton className="w-full aspect-[460/215]" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Skeleton for Games catalog page (/games).
 */
export function CatalogSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6 animate-fade-in" data-testid="catalog-skeleton">
      <div className="border border-zinc-800 bg-zinc-950 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3.5 w-72" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>

      <div className="border border-zinc-800 bg-zinc-950 p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between py-2 border-b border-zinc-900/50">
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-8" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-4 w-44" />
            </div>
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton for Rankings page (/rankings).
 */
export function RankingsSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6 animate-fade-in" data-testid="rankings-skeleton">
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3.5 w-80" />
      </div>

      <div className="border border-zinc-800 bg-zinc-950 p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between py-2 border-b border-zinc-900/50">
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-8" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton for Deals page (/deals).
 */
export function DealsSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6 animate-fade-in" data-testid="deals-skeleton">
      <div className="border border-zinc-800 bg-zinc-950 p-6 space-y-3">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-3.5 w-72" />
        <div className="flex gap-2 pt-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 15 }).map((_, i) => (
          <div key={i} className="border border-zinc-800 bg-zinc-950 p-3 space-y-3">
            <Skeleton className="w-full aspect-[460/215]" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-4/5" />
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-12" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
