import React from "react";
import { SearchForm } from "./search-form";

export function SiteHeader() {
  return (
    <header className="w-full bg-zinc-950 border-b border-zinc-800 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
        {/* Brand identity */}
        <div className="flex items-center gap-6">
          <a
            href="/"
            className="min-h-[44px] min-w-[44px] inline-flex items-center gap-2 font-mono font-bold text-lg tracking-wider text-zinc-100 hover:text-orange-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <span className="w-3 h-3 bg-orange-500 inline-block"></span>
            VAPORSTATS
          </a>

          {/* Navigation Links */}
          <nav aria-label="Primary navigation" className="hidden md:flex items-center space-x-1">
            <a
              href="/games"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Games
            </a>
            <a
              href="/rankings"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Rankings
            </a>
            <a
              href="/deals"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Deals
            </a>
            <a
              href="/releases"
              className="min-h-[44px] px-3 py-1.5 inline-flex items-center text-xs font-mono uppercase tracking-wider text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              Releases
            </a>
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
        <a href="/games" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Games
        </a>
        <a href="/rankings" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Rankings
        </a>
        <a href="/deals" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Deals
        </a>
        <a href="/releases" className="inline-flex min-h-[44px] shrink-0 items-center px-3 text-xs font-mono uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Releases
        </a>
      </nav>
    </header>
  );
}
