import type { WeeklyReleasesResult } from "../lib/releases";
import { ReleaseCalendar } from "./release-calendar";
import { AppLink } from "./app-link";

export interface ReleasesWeekPageViewProps {
  data: WeeklyReleasesResult;
}

export function ReleasesWeekPageView({ data }: ReleasesWeekPageViewProps) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      <ReleaseCalendar
        data={data}
        showNavigation={true}
        title={`Release Calendar: Week ${data.weekNumber}`}
        description={`${data.startDate} through ${data.endDate} (UTC)`}
      />
    </div>
  );
}

export function ReleaseWeekNotFoundView({ week }: { week: string }) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4 font-mono">
      <div className="text-2xl font-bold text-zinc-100">Invalid Release Week</div>
      <p className="text-sm text-zinc-400 max-w-md mx-auto">
        The requested week <span className="text-orange-400 font-bold">"{week}"</span> is not a valid ISO-8601 calendar week format (expected YYYY-Www).
      </p>
      <div className="pt-4">
        <AppLink
          href="/releases"
          className="px-4 py-2 text-xs uppercase tracking-wider font-semibold border border-orange-500 text-orange-400 bg-orange-950/40 hover:bg-orange-900/40 transition-colors inline-block"
        >
          Go to Current Week
        </AppLink>
      </div>
    </div>
  );
}

