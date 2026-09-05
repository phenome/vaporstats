import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PrototypeSwitcher, type PrototypeVariant } from "../components/prototype-switcher";
import { ScrollArea } from "../components/ui/scroll-area";

type EventKind = "ea" | "launch" | "full-release" | "patch";
type VariantKey = "A" | "B" | "C";

interface WeeklyEvent {
  title: string;
  kind: EventKind;
  label: string;
  image: string;
}

interface Weekday {
  day: string;
  date: string;
  events: WeeklyEvent[];
}

const variants: PrototypeVariant[] = [
  { key: "A", name: "Calendar grid" },
  { key: "B", name: "Milestone ribbon" },
  { key: "C", name: "Day rows" },
];

const week: Weekday[] = [
  { day: "MON", date: "AUG 31", events: [] },
  {
    day: "TUE",
    date: "SEP 01",
    events: [{ title: "Deep Rock Galactic: Rogue Core", kind: "ea", label: "EA", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2605790/header.jpg" }],
  },
  {
    day: "WED",
    date: "SEP 02",
    events: [
      { title: "Hollow Knight: Silksong", kind: "launch", label: "Launch", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1030300/header.jpg" },
      { title: "No Rest for the Wicked", kind: "patch", label: "Patch", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1371980/header.jpg" },
    ],
  },
  { day: "THU", date: "SEP 03", events: [] },
  {
    day: "FRI",
    date: "SEP 04",
    events: [{ title: "Valheim", kind: "full-release", label: "1.0", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/892970/header.jpg" }],
  },
  {
    day: "SAT",
    date: "SEP 05",
    events: [
      { title: "Baldur's Gate 3", kind: "patch", label: "Patch", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg" },
      { title: "Cyberpunk 2077", kind: "patch", label: "Patch", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg" },
      { title: "Factorio", kind: "full-release", label: "1.0", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/427520/header.jpg" },
      { title: "Hades II", kind: "ea", label: "EA", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145350/header.jpg" },
      { title: "Dead Cells", kind: "patch", label: "Patch", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/588650/header.jpg" },
    ],
  },
  { day: "SUN", date: "SEP 06", events: [] },
];

const badgeStyles: Record<EventKind, string> = {
  ea: "border-sky-300 bg-sky-600 text-white",
  launch: "border-orange-300 bg-orange-600 text-white",
  "full-release": "border-emerald-300 bg-emerald-600 text-white",
  patch: "border-violet-300 bg-violet-600 text-white",
};

const outlinedText: CSSProperties = {
  textShadow: "-1px -1px 0 #09090b, 1px -1px 0 #09090b, -1px 1px 0 #09090b, 1px 1px 0 #09090b, 0 2px 4px #09090b",
};

export const Route = createFileRoute("/prototype/release-lifecycle")({ component: WeeklyLifecyclePrototype });

function WeeklyLifecyclePrototype() {
  const [variant, setVariant] = useState<VariantKey>("A");
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("variant");
    if (requested === "A" || requested === "B" || requested === "C") setVariant(requested);
  }, []);

  const changeVariant = (next: string) => {
    const selected = next as VariantKey;
    setVariant(selected);
    const url = new URL(window.location.href);
    url.searchParams.set("variant", selected);
    window.history.replaceState({}, "", url);
  };

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-8 pb-24">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800 pb-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-orange-400">Prototype · Weekly presentation · Variant {variant}</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-100 md:text-3xl">This week</h1>
          <p className="mt-2 text-sm text-zinc-400">Aug 31 – Sep 6 · lifecycle events</p>
        </div>
      </header>

      {variant === "A" && <CalendarGrid />}
      {variant === "B" && <MilestoneRibbon />}
      {variant === "C" && <DayRows />}

      <p className="mt-3 font-mono text-[10px] text-zinc-600">Layout specimen; titles and dates are illustrative.</p>
      <PrototypeSwitcher variants={variants} current={variant} onChange={changeVariant} />
    </main>
  );
}

function CalendarGrid() {
  return (
    <WeekScroller label="Seven-day calendar grid">
      <div className="grid min-w-[1050px] grid-cols-7 border-l border-t border-zinc-800">
        {week.map((weekday) => (
          <article key={weekday.day} className="flex flex-col border-b border-r border-zinc-800 bg-zinc-950/70">
            <DayHeader weekday={weekday} compact />
            <ScrollArea className="flex-1 min-h-[110px] max-h-[460px]">
              <div className="space-y-2 p-2">
                <DayContents weekday={weekday} cardClass="aspect-[460/250]" />
              </div>
            </ScrollArea>
          </article>
        ))}
      </div>
    </WeekScroller>
  );
}

function MilestoneRibbon() {
  return (
    <WeekScroller label="Seven-day milestone ribbon">
      <div className="grid min-w-[1050px] grid-cols-7 gap-px bg-zinc-800 border border-zinc-800">
        {week.map((weekday) => (
          <article key={weekday.day} className="min-h-[290px] bg-zinc-950 p-2.5">
            <DayHeader weekday={weekday} />
            <div className="mt-3 space-y-2.5"><DayContents weekday={weekday} cardClass="aspect-[16/10] border-zinc-600" quiet /></div>
          </article>
        ))}
      </div>
    </WeekScroller>
  );
}

function DayRows() {
  return (
    <section className="mt-6 border-l border-t border-zinc-800" aria-label="Seven weekly day rows">
      {week.map((weekday) => (
        <article key={weekday.day} className="grid min-h-24 grid-cols-[78px_1fr] border-b border-r border-zinc-800 bg-zinc-950/70 sm:grid-cols-[110px_1fr]">
          <DayHeader weekday={weekday} vertical />
          <div className="flex min-w-0 gap-2 overflow-x-auto p-2">
            {weekday.events.length ? weekday.events.map((event) => <WeeklyEventCard key={event.title} event={event} className="aspect-[460/215] min-w-56 max-w-80 flex-1" />) : <EmptyState quiet />}
          </div>
        </article>
      ))}
    </section>
  );
}

function WeekScroller({ label, children }: { label: string; children: ReactNode }) {
  return <section className="mt-6 overflow-x-auto pb-3" aria-label={label}>{children}</section>;
}

function DayHeader({ weekday, compact, vertical }: { weekday: Weekday; compact?: boolean; vertical?: boolean }) {
  return (
    <div className={`font-mono ${vertical ? "flex flex-col justify-center border-r border-zinc-800 px-3" : compact ? "flex items-baseline justify-between border-b border-zinc-800 px-3 py-2.5" : "flex items-baseline justify-between px-0.5 py-1"}`}>
      <span className="text-xs font-bold text-zinc-200">{weekday.day}</span>
      <span className="text-[10px] text-zinc-500">{weekday.date}</span>
    </div>
  );
}

function DayContents({ weekday, cardClass, quiet }: { weekday: Weekday; cardClass: string; quiet?: boolean }) {
  if (!weekday.events.length) return <EmptyState quiet={quiet} />;
  return weekday.events.map((event) => <WeeklyEventCard key={event.title} event={event} className={cardClass} />);
}

function EmptyState({ quiet }: { quiet?: boolean }) {
  return <div className={`flex h-full min-h-[94px] items-center justify-center font-mono text-[9px] uppercase tracking-wider text-zinc-700 ${quiet ? "" : "border border-dashed border-zinc-800/80"}`}>No events</div>;
}

function WeeklyEventCard({ event, className }: { event: WeeklyEvent; className: string }) {
  return (
    <article className={`group relative overflow-hidden border bg-zinc-900 ${className}`}>
      <img src={event.image} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-105" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/15 to-black/30" />
      <span className={`absolute right-2 top-2 border px-1.5 py-0.5 font-mono text-[9px] font-black uppercase tracking-wider shadow-[0_1px_3px_#000] ${badgeStyles[event.kind]}`}>{event.label}</span>
      <h2 className="absolute inset-x-2 bottom-2 line-clamp-2 text-[13px] font-black leading-tight text-white" style={outlinedText}>{event.title}</h2>
    </article>
  );
}
