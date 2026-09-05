import React from "react";
import { AppLink } from "./app-link";
import type { ReleaseEntity } from "../lib/releases";

export interface RecentReleasesProps {
  releases: ReleaseEntity[];
  title?: string;
  description?: string;
  limit?: number;
  isHomeSection?: boolean;
}

/**
 * Recent releases discovery section.
 * Lists recently released playable games and consumer expansions/DLC.
 * Handles table overflow gracefully on narrow viewports.
 */
export function RecentReleases({
  releases = [],
  title = "Recent Releases",
  description = "Recently released playable games and consumer expansions",
  limit,
  isHomeSection = false,
}: RecentReleasesProps) {
  const displayed = limit ? releases.slice(0, limit) : releases;

  return (
    <div
      className="border border-zinc-800 bg-zinc-950 p-6 space-y-4 w-full"
      data-testid="recent-releases-block"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 bg-orange-500 inline-block"></span>
          <div>
            <h2 className="text-sm sm:text-base font-mono font-bold uppercase tracking-wider text-zinc-100">
              {title}
            </h2>
            <p className="text-[11px] font-mono text-zinc-400 mt-0.5">{description}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-2.5 py-1">
            COUNT: <span className="text-orange-400 font-bold tabular-nums">{displayed.length}</span>
          </div>

          {isHomeSection && (
            <AppLink
              href="/releases"
              data-testid="recent-view-all-link"
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-2 text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors"
            >
              <span>All Releases</span>
              <span>&rarr;</span>
            </AppLink>
          )}
        </div>
      </div>

      {/* Content */}
      {displayed.length === 0 ? (
        <div
          className="border border-zinc-900 bg-zinc-900/30 p-8 text-center font-mono text-xs text-zinc-500"
          data-testid="no-recent-releases"
        >
          No recent releases recorded yet.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 px-2 scrollbar-thin">
          <table
            className="w-full text-left border-collapse font-mono text-xs min-w-[540px]"
            data-testid="recent-releases-table"
          >
            <thead>
              <tr className="border-b border-zinc-800 text-[11px] text-zinc-400 uppercase tracking-wider">
                <th className="py-2.5 px-3">Date</th>
                <th className="py-2.5 px-3">Title</th>
                <th className="py-2.5 px-3">Type</th>
                <th className="py-2.5 px-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {displayed.map((release) => {
                const isDlcOrExpansion =
                  release.type === "dlc" || release.type === "expansion";

                return (
                  <tr
                    key={release.appid}
                    className="hover:bg-zinc-900/50 transition-colors group"
                    data-testid="recent-release-row"
                    data-appid={release.appid}
                  >
                    <td className="py-2.5 px-3 text-zinc-400 whitespace-nowrap">
                      {release.release_date}
                    </td>

                    <td className="py-2.5 px-3">
                      <AppLink
                        href={release.canonical_path}
                        className="min-h-[44px] inline-flex items-center text-zinc-200 group-hover:text-orange-400 transition-colors font-medium gap-2"
                      >
                        {release.header_image && (
                          <img
                            src={release.header_image}
                            alt=""
                            loading="lazy"
                            className="w-10 h-5 object-cover border border-zinc-800 shrink-0"
                          />
                        )}
                        <span className="line-clamp-1">{release.name}</span>
                      </AppLink>
                      {release.parent_name && (
                        <div className="text-[10px] text-zinc-500 truncate ml-12">
                          for {release.parent_name}
                        </div>
                      )}
                    </td>

                    <td className="py-2.5 px-3 whitespace-nowrap">
                      {isDlcOrExpansion ? (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 border border-purple-800 bg-purple-950/60 text-purple-300">
                          {release.type === "expansion" ? "Expansion" : "DLC"}
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 border border-zinc-800 bg-zinc-900 text-zinc-400">
                          Game
                        </span>
                      )}
                    </td>

                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 border border-zinc-700 bg-zinc-800 text-zinc-300 font-semibold">
                        Released
                      </span>
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

/**
 * Reusable Home Section for Recent Releases.
 */
export function HomeRecentReleasesSection({
  releases,
  limit = 10,
}: {
  releases: ReleaseEntity[];
  limit?: number;
}) {
  return (
    <RecentReleases
      releases={releases}
      limit={limit}
      isHomeSection={true}
      title="Recent Releases"
      description="Latest games and major expansions to hit Steam"
    />
  );
}

export default RecentReleases;
