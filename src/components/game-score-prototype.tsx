import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, ReferenceArea } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

// Three game-page score/history variants, switchable via ?variant=A|B|C.
type Variant = "A" | "B" | "C";
const prototypeEnabled = import.meta.env.DEV || import.meta.env.VITE_PROTOTYPE === "true";

const variants: readonly { key: Variant; name: string }[] = [
  { key: "A", name: "Score board" },
  { key: "B", name: "Evidence rail" },
  { key: "C", name: "Score spine" },
];

const observations = [
  { x: 8, y: 63, score: 78, reviews: "1,984", date: "2025-11-21 18:00 UTC" },
  { x: 23, y: 54, score: 81, reviews: "2,116", date: "2026-01-18 18:00 UTC" },
  { x: 39, y: 71, score: 75, reviews: "322", date: "2026-03-22 18:00 UTC" },
  { x: 55, y: 48, score: 83, reviews: "817", date: "2026-05-30 18:00 UTC" },
  { x: 72, y: 39, score: 86, reviews: "1,426", date: "2026-07-14 18:00 UTC" },
  { x: 92, y: 45, score: 84, reviews: "2,841", date: "2026-09-06 14:05 UTC" },
] as const;

function ScoreDetails({ compact = false }: { compact?: boolean }) {
  return (
    <details className={compact ? "text-xs" : "text-sm"}>
      <summary className="cursor-pointer font-mono text-violet-300 underline decoration-violet-500/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
        How this score is calculated
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-2 border-l border-violet-500/30 pl-4 text-zinc-300 sm:grid-cols-2">
        <div><dt className="text-zinc-500">Qualifying reviews</dt><dd>2,841 in the current window</dd></div>
        <div><dt className="text-zinc-500">Historical influence</dt><dd>20 effective historical reviews</dd></div>
        <div><dt className="text-zinc-500">Uncertainty</dt><dd>About ±2 percentage points</dd></div>
        <div><dt className="text-zinc-500">Source</dt><dd>Steam player reviews only</dd></div>
        <div className="sm:col-span-2"><dt className="text-zinc-500">Method</dt><dd>The current review window is supported by a bounded amount of older evidence. Every new review contributes immediately without outweighing the broader evidence.</dd></div>
      </dl>
      <p className="mt-3 text-zinc-500">Critic ratings are separate and are not blended into the Current Player Score.</p>
    </details>
  );
}

function ScorePlot({ compact = false }: { compact?: boolean }) {
  const [hoveredValue, setHoveredValue] = useState<number | null>(null);
  const samples = observations.map(point => ({ ...point, timestamp: Date.parse(point.date.replace(" ", "T").replace(" UTC", ":00Z")) }));
  const formatDate = (value: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(value);
  return (
    <figure className="min-w-0" aria-labelledby={compact ? "compact-score-chart" : "score-chart-title"}>
      <figcaption id={compact ? "compact-score-chart" : "score-chart-title"} className={compact ? "sr-only" : "mb-3 font-mono text-xs uppercase tracking-wider text-zinc-400"}>Player score history · Steam only</figcaption>
      <ChartContainer config={{ score: { label: "Current Player Score", color: "#a78bfa" } }} className={compact ? "h-[180px] w-full aspect-auto" : "h-[260px] w-full aspect-auto"}>
        <LineChart data={samples} accessibilityLayer margin={{ top: 24, right: 18, left: 0, bottom: 0 }}
          onMouseMove={state => setHoveredValue(typeof state?.activePayload?.[0]?.value === "number" ? state.activePayload[0].value : null)}
          onMouseLeave={() => setHoveredValue(null)}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis dataKey="timestamp" type="number" domain={[samples[0].timestamp, samples[samples.length - 1].timestamp]} allowDataOverflow tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} minTickGap={40} tickFormatter={formatDate} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={34} tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} />
          <ReferenceArea x1={samples[1].timestamp} x2={samples[2].timestamp} fill="#a78bfa" fillOpacity={0.08} stroke="#a78bfa" strokeDasharray="3 3" />
          <ReferenceLine x={samples[2].timestamp} stroke="#a1a1aa" strokeDasharray="3 3" label={{ value: "PATCH", position: "insideTopRight", fill: "#d4d4d8", fontSize: 10 }} />
          <ReferenceLine x={samples[3].timestamp} stroke="#a78bfa" strokeDasharray="1 3" label={{ value: "BOUNDARY", position: "insideTopRight", fill: "#c4b5fd", fontSize: 10 }} />
          {hoveredValue !== null && <ReferenceLine y={hoveredValue} stroke="#a78bfa" strokeDasharray="3 3" />}
          <ChartTooltip isAnimationActive={false} cursor={{ stroke: "#71717a", strokeDasharray: "3 3" }} content={<ChartTooltipContent
            className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100"
            labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ""}
            formatter={(value, _, item) => <span><strong className="text-violet-300">{new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(value))}</strong> · {item.payload.reviews} qualifying Steam reviews</span>} />} />
          <Line dataKey="score" type="monotone" stroke="var(--color-score)" strokeWidth={1.8} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ChartContainer>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] uppercase text-zinc-400" aria-label="Score history legend">
        <span><i className="mr-2 inline-block w-5 border-t-2 border-violet-500" />Observed score</span>
        <span><i className="mr-2 inline-block h-2 w-5 border border-dashed border-violet-400/70 bg-violet-500/10" />Reconstructed interval</span>
        <span><i className="mr-2 inline-block h-3 border-l border-zinc-400" />Verified milestone</span>
        <span><i className="mr-2 inline-block h-3 border-l border-dashed border-violet-400" />Evidence boundary</span>
      </div>
    </figure>
  );
}

function CurrentScore({ minimal = false }: { minimal?: boolean }) {
  return (
    <div className={minimal ? "border-l-4 border-violet-500 pl-4" : "border border-violet-500/50 bg-violet-500/10 p-5"}>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-300">Current Player Score</p>
      <p className="mt-2 flex items-end gap-2 text-violet-100"><strong className="font-mono text-6xl leading-none tabular-nums">84</strong><span className="pb-1 text-sm">% positive</span></p>
      <p className="mt-3 text-sm text-zinc-300">2,841 qualifying Steam reviews</p>
      <p className="mt-1 font-mono text-xs text-zinc-500">Evidence 1 day ago · 2026-09-06 14:05 UTC</p>
    </div>
  );
}

function VariantA() {
  return (
    <section id="player-score" className="scroll-mt-28 border border-zinc-800 bg-zinc-950" aria-labelledby="score-a-title">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800 px-5 py-4">
        <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-400">Player score / 90-day evidence</p><h2 id="score-a-title" className="mt-1 font-mono text-xl font-bold text-zinc-100">Current Player Score</h2></div>
        <div className="flex gap-1" aria-label="Score history range"><button className="border border-zinc-800 px-3 py-2 font-mono text-xs text-zinc-400">30 days</button><button className="border border-violet-500 bg-violet-500/15 px-3 py-2 font-mono text-xs text-violet-200">90 days</button><button className="border border-zinc-800 px-3 py-2 font-mono text-xs text-zinc-400">All history</button></div>
      </header>
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,3fr)_minmax(0,6fr)_minmax(0,3fr)]">
        <div className="min-w-0 p-5 lg:border-r lg:border-zinc-800"><CurrentScore /><div className="mt-5"><ScoreDetails compact /></div></div>
        <div className="min-w-0 border-y border-zinc-800 p-5 lg:border-y-0 lg:border-r"><ScorePlot /></div>
        <aside className="min-w-0 space-y-6 p-5" aria-label="Score evidence context">
          <div><p className="font-mono text-[10px] uppercase text-zinc-500">Evidence age</p><p className="mt-1 text-zinc-200">1 day ago</p><p className="font-mono text-xs text-zinc-500">2026-09-06 14:05 UTC</p></div>
          <div><p className="font-mono text-[10px] uppercase text-zinc-500">Critic reception</p><p className="mt-1 text-zinc-200">Metacritic · 78/100</p><p className="text-sm text-zinc-500">Auxiliary source-native context. Not blended with the Steam score.</p></div>
        </aside>
      </div>
      <footer className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">Verified milestones mark recorded events alongside score evidence; they do not explain score movement.</footer>
    </section>
  );
}

function VariantB() {
  return (
    <section id="player-score" className="scroll-mt-28 border-y border-zinc-800 py-7" aria-labelledby="score-b-title">
      <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-end">
        <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-400">Steam reception / evidence trail</p><h2 id="score-b-title" className="mt-2 max-w-2xl font-mono text-2xl font-bold text-zinc-100">How players rated this game</h2><p className="mt-2 max-w-2xl text-sm text-zinc-400">The timeline shows observed evidence, reconstruction, and verified milestones. It does not assign causes.</p></div>
        <CurrentScore minimal />
      </div>
      <div className="mt-8"><ScorePlot /></div>
      <div className="mt-7 grid gap-8 lg:grid-cols-[2fr_1fr]">
        <ol className="border-l border-zinc-700 pl-6">
          <li className="relative pb-6"><i className="absolute -left-[29px] top-1 h-2 w-2 rounded-full bg-violet-400" /><time className="font-mono text-xs text-zinc-500">6 SEP 2026</time><h3 className="text-zinc-100">Observed score · 84% positive</h3><p className="text-sm text-zinc-400">2,841 qualifying reviews · Steam player reviews</p></li>
          <li className="relative pb-6"><i className="absolute -left-[29px] top-1 h-2 w-2 border border-violet-400 bg-zinc-950" /><time className="font-mono text-xs text-zinc-500">30 MAY 2026</time><h3 className="text-zinc-100">Evidence boundary · current window begins</h3><p className="text-sm text-zinc-400">Model boundary after a verified material update; not a causal claim.</p></li>
          <li className="relative"><i className="absolute -left-[29px] top-1 h-2 w-2 bg-zinc-500" /><time className="font-mono text-xs text-zinc-500">22 MAR 2026</time><h3 className="text-zinc-100">Verified milestone · Major Update</h3><p className="text-sm text-zinc-400">Source: Steam developer update category. Shipment not independently verified.</p></li>
        </ol>
        <aside className="space-y-5"><ScoreDetails /><div className="border-t border-zinc-800 pt-4"><p className="font-mono text-[10px] uppercase text-zinc-500">Critic reception · separate source</p><p className="mt-1 text-zinc-200">Metacritic · 78/100 · 63 critic reviews</p><p className="mt-1 text-sm text-zinc-500">Published critic record; not combined with the player score.</p></div></aside>
      </div>
    </section>
  );
}

function VariantC() {
  return (
    <section id="player-score" className="scroll-mt-28" aria-labelledby="score-c-title">
      <div className="grid gap-4 border-y border-zinc-800 py-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-7">
        <div className="lg:border-r lg:border-violet-500/40 lg:pr-6"><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-400">Score context</p><h2 id="score-c-title" className="mt-1 text-sm text-zinc-300">Current Player Score</h2><p className="mt-2 font-mono text-5xl font-bold text-violet-200 tabular-nums">84</p><p className="text-xs text-zinc-500">% positive · Steam only</p><p className="mt-3 font-mono text-[10px] text-zinc-500">2,841 reviews · evidence 1 day ago</p></div>
        <div className="min-w-0"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-xs uppercase text-zinc-400">Reception alongside activity</p><p className="font-mono text-[10px] text-zinc-500">NOV 2025 — SEP 2026</p></div><ScorePlot compact /></div>
      </div>
      <details className="border-b border-zinc-800 py-3">
        <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Open score evidence and methodology</summary>
        <div className="mt-4 grid gap-5 md:grid-cols-2"><ScoreDetails /><div><p className="font-mono text-[10px] uppercase text-zinc-500">Milestone context</p><p className="mt-2 text-sm text-zinc-300">PATCH · 22 Mar 2026 &nbsp; BOUNDARY · 30 May 2026</p><p className="mt-1 text-sm text-zinc-500">Verified dates shown alongside the evidence; no score movement is attributed to them.</p><p className="mt-4 font-mono text-[10px] uppercase text-zinc-500">Critic reception</p><p className="mt-1 text-sm text-zinc-300">Metacritic · 78/100 · separate source</p></div></div>
      </details>
    </section>
  );
}

export function GameScorePrototype() {
  const [variant, setVariant] = useState<Variant>("A");

  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
    if (selected === "A" || selected === "B" || selected === "C") setVariant(selected);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable]")) return;
      const index = variants.findIndex((item) => item.key === variant);
      choose(variants[(index + (event.key === "ArrowRight" ? 1 : -1) + variants.length) % variants.length].key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [variant]);

  function choose(next: Variant) {
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url);
  }

  if (!prototypeEnabled) return null;

  const index = variants.findIndex((item) => item.key === variant);
  return (
    <>
      {variant === "A" ? <VariantA /> : variant === "B" ? <VariantB /> : <VariantC />}
      <nav className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/20 bg-zinc-100 px-2 py-1.5 font-mono text-xs text-zinc-950 shadow-2xl" aria-label="Prototype variants">
        <button type="button" className="rounded-full px-3 py-2 hover:bg-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600" onClick={() => choose(variants[(index - 1 + variants.length) % variants.length].key)} aria-label="Previous variant">←</button>
        <span className="min-w-36 text-center">{variant} · {variants[index].name}</span>
        <button type="button" className="rounded-full px-3 py-2 hover:bg-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600" onClick={() => choose(variants[(index + 1) % variants.length].key)} aria-label="Next variant">→</button>
      </nav>
    </>
  );
}
