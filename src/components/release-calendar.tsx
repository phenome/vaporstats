import React from "react";
import type { WeeklyReleasesResult, ReleaseEntity } from "../lib/releases";

export interface ReleaseCalendarProps {
  data: WeeklyReleasesResult;
  title?: string;
  description?: string;
  showNavigation?: boolean;
  isHomeSection?: boolean;
}

/**
 * Weekly release discovery calendar.
 * Groups eligible playable games and consumer DLC/expansions across the 7 ISO days (Monday–Sunday).
 * Marks days on or before current date as Released and future dates as Upcoming.
 * Handles responsive horizontal strip overflow on desktop and mobile stacks.
 */
export function ReleaseCalendar({
  data,
  title,
  description,
  showNavigation = true,
  isHomeSection = false,
}: ReleaseCalendarProps) {
  const headingTitle = title || `Releases: Week ${data.weekNumber} (${data.week})`;
  const headingDesc =
    description || `Monday ${data.startDate} through Sunday ${data.endDate}`;

  return (
    <div
      className="border border-zinc-800 bg-zinc-950 p-6 space-y-6 w-full max-w-full overflow-hidden"
      data-testid="release-calendar"
      data-week={data.week}
    >
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-900 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 bg-orange-500 inline-block"></span>
            <span className="text-xs font-mono uppercase tracking-wider text-orange-400">
              Release Discovery
            </span>
          </div>
          <h2 className="text-xl sm:text-2xl font-mono font-bold text-zinc-100 tracking-tight">
            {headingTitle}
          </h2>
          <p className="text-xs font-mono text-zinc-400 mt-0.5">{headingDesc}</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-1.5">
            TOTAL: <span className="text-orange-400 font-bold tabular-nums">{data.totalCount}</span>
          </div>

          {showNavigation && (
            <nav
              aria-label="Release week navigation"
              className="flex items-center space-x-1.5"
              data-testid="week-navigation"
            >
              <a
                href={`/releases/${data.prevWeek}`}
                aria-label={`Previous week (${data.prevWeek})`}
                data-testid="prev-week-link"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-xs font-mono border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition-colors"
              >
                &larr; {data.prevWeek}
              </a>
              <a
                href="/releases"
                aria-label="Current week"
                data-testid="current-week-link"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-xs font-mono border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition-colors"
              >
                Today
              </a>
              <a
                href={`/releases/${data.nextWeek}`}
                aria-label={`Next week (${data.nextWeek})`}
                data-testid="next-week-link"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-xs font-mono border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition-colors"
              >
                {data.nextWeek} &rarr;
              </a>
            </nav>
          )}

          {isHomeSection && (
            <a
              href="/releases"
              data-testid="view-full-calendar-link"
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors px-2 ml-2"
            >
              <span>Calendar</span>
              <span>&rarr;</span>
            </a>
          )}

        </div>
      </div>

      {/* 7-day strip with horizontal overflow container */}
      <div className="overflow-x-auto max-w-full pb-2 -mx-2 px-2 scrollbar-thin">
        <div
          className="grid grid-cols-7 gap-3 min-w-[980px]"
          data-testid="calendar-days-grid"
        >
          {data.days.map((dayGroup) => (
            <DayColumn key={dayGroup.date} dayGroup={dayGroup} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface DayColumnProps {
  dayGroup: WeeklyReleasesResult["days"][number];
}

function DayColumn({ dayGroup }: DayColumnProps) {
  const isReleased = dayGroup.status === "released";

  return (
    <div
      className="border border-zinc-800/80 bg-zinc-900/40 p-3 flex flex-col space-y-3 min-h-[220px]"
      data-testid="calendar-day-column"
      data-date={dayGroup.date}
      data-status={dayGroup.status}
    >
      {/* Day header */}
      <div className="border-b border-zinc-800/60 pb-2">
        <div className="flex items-center justify-between gap-1">
          <span className="text-xs font-mono font-bold text-zinc-200">
            {dayGroup.dayOfWeek.slice(0, 3)}
          </span>
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 uppercase tracking-wider font-semibold ${
              isReleased
                ? "bg-zinc-800 text-zinc-300 border border-zinc-700"
                : "bg-orange-950/60 text-orange-400 border border-orange-800/50"
            }`}
            data-testid="day-status-badge"
          >
            {isReleased ? "Released" : "Upcoming"}
          </span>
        </div>
        <div className="text-[11px] font-mono text-zinc-400 mt-0.5">
          {dayGroup.date}
        </div>
      </div>

      {/* Entity list */}
      <div className="flex-1 space-y-2">
        {dayGroup.entities.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px] font-mono text-zinc-600 py-6 text-center">
            No releases
          </div>
        ) : (
          dayGroup.entities.map((entity) => (
            <ReleaseCard key={entity.appid} entity={entity} />
          ))
        )}
      </div>
    </div>
  );
}

interface ReleaseCardProps {
  entity: ReleaseEntity;
}

export function ReleaseCard({ entity }: ReleaseCardProps) {
  const isDlcOrExpansion = entity.type === "dlc" || entity.type === "expansion";

  return (
    <a
      href={entity.canonical_path}
      data-testid="release-card"
      data-appid={entity.appid}
      data-type={entity.type}
      aria-label={`${entity.name} (${entity.type})`}
      className="block min-h-[44px] p-2 bg-zinc-950 border border-zinc-800/90 hover:border-orange-500/60 transition-colors group space-y-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
    >
      {entity.header_image && (
        <div className="aspect-[460/215] w-full overflow-hidden bg-zinc-900">
          <img
            src={entity.header_image}
            alt={entity.name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
          />
        </div>
      )}

      <div>
        <div className="flex items-center gap-1.5 mb-0.5">
          {isDlcOrExpansion ? (
            <span className="text-[9px] font-mono uppercase tracking-wider px-1 py-0.2 border border-purple-800 bg-purple-950/60 text-purple-300">
              {entity.type === "expansion" ? "Expansion" : "DLC"}
            </span>
          ) : (
            <span className="text-[9px] font-mono uppercase tracking-wider px-1 py-0.2 border border-zinc-800 bg-zinc-900 text-zinc-400">
              Game
            </span>
          )}
        </div>

        <div className="text-xs font-mono font-medium text-zinc-200 group-hover:text-orange-400 transition-colors line-clamp-2">
          {entity.name}
        </div>

        {entity.parent_name && (
          <div className="text-[10px] font-mono text-zinc-500 truncate mt-0.5">
            for {entity.parent_name}
          </div>
        )}
      </div>
    </a>
  );
}

/**
 * Reusable Home Section for Current Week Releases.
 */
export function HomeReleaseCalendarSection({
  data,
}: {
  data: WeeklyReleasesResult;
}) {
  return (
    <ReleaseCalendar
      data={data}
      title="This Week's Releases"
      description={`Current week ${data.week} (${data.startDate} – ${data.endDate})`}
      showNavigation={false}
      isHomeSection={true}
    />
  );
}

export default ReleaseCalendar;
