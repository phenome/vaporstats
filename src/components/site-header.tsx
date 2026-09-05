import React from "react";
import { AppLink } from "./app-link";
import { SearchForm } from "./search-form";

export function SiteHeader() {
  return (
    <header className="w-full bg-zinc-950 border-b border-zinc-800 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
        {/* Brand identity */}
        <div className="flex items-center gap-6">
          <AppLink
            href="/"
            className="min-h-[44px] min-w-[44px] inline-flex items-center gap-2 font-mono font-bold text-lg tracking-wider text-zinc-100 hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            aria-label="VAPORSTATS Home"
          >
            <picture>
              <source srcSet="/logo.webp" type="image/webp" />
              <img
                src="/logo.png"
                alt="VAPORSTATS"
                width={176}
                height={32}
                className="h-8 w-auto object-contain"
              />
            </picture>
          </AppLink>

          {/* Navigation Links */}
          <nav aria-label="Primary navigation" className="hidden md:flex items-center space-x-1">
            <AppLink
              href="/games"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Games
            </AppLink>
            <AppLink
              href="/rankings"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Rankings
            </AppLink>
            <AppLink
              href="/deals"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Deals
            </AppLink>
            <AppLink
              href="/releases"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Releases
            </AppLink>
            <AppLink
              href="/publishers"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Publishers
            </AppLink>
          </nav>
        </div>

        {/* Persistent search bar */}
        <div className="flex items-center min-w-0 max-w-[170px] sm:max-w-xs shrink-1">
          <SearchForm />
        </div>
      </div>
      <nav
        aria-label="Primary navigation"
        className="flex min-h-[44px] items-center overflow-x-auto border-t border-zinc-900 px-4 md:hidden"
      >
        <AppLink href="/games" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Games
        </AppLink>
        <AppLink href="/rankings" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Rankings
        </AppLink>
        <AppLink href="/deals" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Deals
        </AppLink>
        <AppLink href="/releases" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Releases
        </AppLink>
        <AppLink href="/publishers" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Publishers
        </AppLink>
      </nav>
    </header>
  );
}
