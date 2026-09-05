import React from "react";
import type { PublisherDetail, PublisherSummary, PublisherGameItem } from "../lib/publishers";
import { getCanonicalGamePath } from "../lib/slug";

export function PublisherPageView({ publisher }: { publisher: PublisherDetail }) {
  const roleBadges = [];
  if (publisher.isDeveloper) roleBadges.push("DEVELOPER");
  if (publisher.isPublisher) roleBadges.push("PUBLISHER");

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      <div className="border border-zinc-800 bg-zinc-950 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 bg-orange-500"></span>
            <div className="flex gap-1.5">
              {roleBadges.map((role) => (
                <span
                  key={role}
                  className="px-2 py-0.5 bg-orange-500/10 text-orange-400 border border-orange-500/30 text-[10px] font-mono uppercase tracking-widest"
                >
                  {role}
                </span>
              ))}
            </div>
          </div>
          <h1 className="text-2xl font-mono font-bold text-white tracking-tight">
            {publisher.name}
          </h1>
          <p className="text-xs text-zinc-400 mt-1 font-mono">
            Catalog listings published or developed by {publisher.name}.
          </p>
        </div>

        <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2 flex items-center gap-2">
          <span>TRACKED GAMES:</span>
          <span className="text-orange-400 font-bold tabular-nums">{publisher.totalGames}</span>
        </div>
      </div>

      {publisher.games.length === 0 ? (
        <div className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-3">
          <div className="text-sm font-mono text-zinc-400">No games recorded yet.</div>
          <p className="text-xs text-zinc-600 font-mono">
            Check back after subsequent catalog discovery runs.
          </p>
        </div>
      ) : (
        <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400">
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider w-24">AppID</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider">Game Title</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider hidden sm:table-cell">Role</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider hidden md:table-cell">Release Date</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {publisher.games.map((game: PublisherGameItem) => {
                const canonicalUrl = getCanonicalGamePath(game.appid, game.name);
                const roles: string[] = [];
                if (game.isDeveloper) roles.push("Dev");
                if (game.isPublisher) roles.push("Pub");
                const roleLabel = roles.join(" / ");

                return (
                  <tr key={game.appid} className="hover:bg-zinc-900/40 transition-colors group">
                    <td className="py-3 px-4 text-zinc-500 tabular-nums">{game.appid}</td>
                    <td className="py-3 px-4 font-medium text-zinc-200 group-hover:text-orange-400 transition-colors">
                      <a href={canonicalUrl} className="hover:underline">
                        {game.name}
                      </a>
                    </td>
                    <td className="py-3 px-4 text-zinc-400 hidden sm:table-cell">
                      <span className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[10px] text-zinc-300">
                        {roleLabel || "Creator"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-500 hidden md:table-cell">
                      {game.release_date || "—"}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <a
                        href={canonicalUrl}
                        className="px-2.5 py-1 text-[11px] bg-zinc-900 hover:bg-orange-500 hover:text-white border border-zinc-800 text-zinc-300 transition-colors"
                      >
                        View Game
                      </a>
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

export function PublishersIndexView({ publishers }: { publishers: PublisherSummary[] }) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      <div className="border border-zinc-800 bg-zinc-950 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 bg-orange-500"></span>
            <span className="text-[11px] font-mono uppercase tracking-widest text-orange-400">
              Creators & Studios
            </span>
          </div>
          <h1 className="text-2xl font-mono font-bold text-white tracking-tight">
            Publishers & Developers
          </h1>
          <p className="text-xs text-zinc-400 mt-1 font-mono">
            Index of game publishers, development studios, and creators tracked in VaporStats.
          </p>
        </div>

        <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2 flex items-center gap-2">
          <span>ENTITIES:</span>
          <span className="text-orange-400 font-bold tabular-nums">{publishers.length}</span>
        </div>
      </div>

      {publishers.length === 0 ? (
        <div className="border border-zinc-800 bg-zinc-950 p-12 text-center space-y-3">
          <div className="text-sm font-mono text-zinc-400">No publishers or developers indexed yet.</div>
          <p className="text-xs text-zinc-600 font-mono">
            Entities populate as catalog games are imported.
          </p>
        </div>
      ) : (
        <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400">
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider">Publisher / Developer</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider hidden sm:table-cell">Roles</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider text-center">Tracked Games</th>
                <th className="py-3 px-4 uppercase text-[10px] tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {publishers.map((pub) => {
                const roles: string[] = [];
                if (pub.isDeveloper) roles.push("Developer");
                if (pub.isPublisher) roles.push("Publisher");

                return (
                  <tr key={pub.slug} className="hover:bg-zinc-900/40 transition-colors group">
                    <td className="py-3 px-4 font-medium text-zinc-200 group-hover:text-orange-400 transition-colors">
                      <a href={pub.path} className="hover:underline">
                        {pub.name}
                      </a>
                    </td>
                    <td className="py-3 px-4 text-zinc-400 hidden sm:table-cell">
                      <div className="flex gap-1.5">
                        {roles.map((r) => (
                          <span
                            key={r}
                            className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[10px] text-zinc-300"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center tabular-nums text-zinc-300">
                      {pub.gameCount}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <a
                        href={pub.path}
                        className="px-2.5 py-1 text-[11px] bg-zinc-900 hover:bg-orange-500 hover:text-white border border-zinc-800 text-zinc-300 transition-colors"
                      >
                        View Games
                      </a>
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
