import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { CaretDown } from "@phosphor-icons/react";
import type {
  ReceptionComparisonData,
  ReceptionMetricKind,
  ReceptionRankingData,
  ReceptionRankingItem,
} from "../lib/rankings";
import type { ReceptionFilters, ReceptionRankingType } from "../lib/reception-filters";
import type { FacetDictionaryEntry } from "../lib/taxonomy";
import { rankingComparisonQueryOptions, type RankingComparisonQuery } from "../lib/rankings-query";
import { formatNumber } from "../lib/format";
import { getCanonicalGamePath } from "../lib/slug";
import { AppLink } from "./app-link";
import { RankingFacetSelect } from "./ranking-facet-select";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";
import "./rankings-page.css";

export interface RankingsPageNavigation {
  type?: ReceptionRankingType;
  filters?: Partial<ReceptionFilters>;
  offset?: number;
}

export interface RankingsPageViewProps {
  data: ReceptionRankingData;
  facets?: FacetDictionaryEntry[];
  activeType?: ReceptionRankingType;
  activeFilters?: ReceptionFilters;
  activeOffset?: number;
  isFetching?: boolean;
  onNavigate?: (next: RankingsPageNavigation) => void;
}

type MetricLabel = "Current Player Score" | "Lifetime Approval";
type ComparisonPayload = { value?: unknown; cutoff?: unknown };

const scoreFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

function isComparisonPayload(value: unknown): value is ComparisonPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metricLabel(kind: ReceptionMetricKind): MetricLabel {
  return kind === "current_player_score" ? "Current Player Score" : "Lifetime Approval";
}

function parseUtcDate(value: string): Date | null {
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function releaseLabel(value: string | null): string | null {
  if (!value) return null;
  const date = parseUtcDate(value);
  if (!date) return null;
  return date.getUTCFullYear() === new Date().getUTCFullYear() ? dateFormat.format(date) : String(date.getUTCFullYear());
}

function formatCutoff(value: string): string {
  const date = parseUtcDate(value);
  return date ? monthFormat.format(date) : value;
}


function Artwork({ game, className = "" }: { game: ReceptionRankingItem["game"]; className?: string }) {
  const src = game.header_image || game.header_lqip || null;
  return (
    <span className={`ranking-artwork ${className}`} style={game.header_lqip ? { backgroundImage: `url(${game.header_lqip})` } : undefined}>
      {src ? <img src={src} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.opacity = "0"; }} /> : null}
    </span>
  );
}

function GameLink({ game, className = "" }: { game: ReceptionRankingItem["game"]; className?: string }) {
  return <AppLink href={getCanonicalGamePath(game.appid, game.name)} className={className} onClick={(event) => event.stopPropagation()}>{game.name}</AppLink>;
}

function ScoreCell({ item, prominent = false }: { item: ReceptionRankingItem; prominent?: boolean }) {
  const label = metricLabel(item.metric.kind);
  const qualifyingText = item.eligibility.qualifying_reviews === null ? "Review count unavailable" : `${formatNumber(item.eligibility.qualifying_reviews)} reviews`;
  const context = `${qualifyingText}; ${formatNumber(item.eligibility.minimum_reviews)} reviews required for this ranking.`;
  return (
    <div className={`ranking-score ${prominent ? "is-prominent" : ""}`}>
      <strong title={`${label}: ${scoreFormat.format(item.metric.value)}`} aria-label={`${label}: ${scoreFormat.format(item.metric.value)}`}>{scoreFormat.format(item.metric.value)}</strong>
      <span title={context} tabIndex={0} aria-label={context}>{qualifyingText}</span>
    </div>
  );
}

function RankMedallion({ rank }: { rank: number }) {
  return <span className={`rank-medallion rank-medallion-${rank}`} role="img" aria-label={`Rank ${rank}`}>{rank}</span>;
}

function CardMeta({ item }: { item: ReceptionRankingItem }) {
  const release = releaseLabel(item.game.release_date || item.game.steam_release_date);
  return <div className="ranking-card-meta">{release ? <span>{release}</span> : null}{item.game.is_early_access ? <span>Early Access</span> : null}</div>;
}

function PodiumCard({ item, rank }: { item: ReceptionRankingItem; rank: number }) {
  return (
    <article className={`podium-card podium-card-${rank}`}>
      <div className="podium-card-body">
        <div className="podium-art-wrap">
          <AppLink href={getCanonicalGamePath(item.game.appid, item.game.name)} className="podium-art-link" aria-label={`${item.game.name} game details`}><Artwork game={item.game} /></AppLink>
          <RankMedallion rank={rank} />
        </div>
        <div className="podium-content">
          <h2><GameLink game={item.game} /></h2>
          <div className="podium-summary"><CardMeta item={item} /><ScoreCell item={item} prominent={rank === 1} /></div>
        </div>
      </div>
    </article>
  );
}

function HistoryChart({ data }: { data: ReceptionComparisonData }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const points = useMemo(() => {
    const byCutoff = new Map(data.points.map((point) => [point.cutoff, point]));
    return data.cutoffs.map((cutoff) => ({ cutoff, value: byCutoff.get(cutoff)?.value ?? null }));
  }, [data]);
  const label = metricLabel(data.points[0]?.metric_kind ?? (data.type === "top_rated_now" ? "current_player_score" : "lifetime_approval"));
  const methodology = data.type === "top_rated_now"
    ? data.reconstructed_members > 0
      ? `Recorded scores are preferred; ${data.reconstructed_members} member${data.reconstructed_members === 1 ? "" : "s"} include reconstructed historical estimates from retained review evidence.`
      : "Recorded scores are used when available; missing historical months remain unfilled."
    : "All Time uses compatible lifetime-summary snapshots only; histogram evidence is not mixed in.";
  if (!data.cutoffs.length) return <p className="ranking-muted">No monthly comparison data yet.</p>;
  return (
    <div className="comparison-chart" tabIndex={0} aria-label={`${label} monthly comparison`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setHovered(null); setTooltipVisible(false); } }}>
      <ChartContainer config={{ value: { label, color: "#a78bfa" } }} className="comparison-chart-inner">
        <LineChart
          data={points}
          accessibilityLayer
          margin={{ top: 12, right: 12, left: 2, bottom: 0 }}
          onMouseMove={(state) => {
            const active = state?.activePayload?.[0]?.payload;
            if (isComparisonPayload(active) && typeof active.value === "number") { setHovered(active.value); setTooltipVisible(true); }
          }}
          onMouseLeave={() => { setHovered(null); setTooltipVisible(false); }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis dataKey="cutoff" tickFormatter={(value) => formatCutoff(String(value))} stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(value) => formatNumber(value)} stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} width={32} />
          {hovered !== null && <ReferenceLine y={hovered} stroke="#a78bfa" strokeDasharray="3 3" />}
          <ChartTooltip
            active={tooltipVisible}
            cursor={{ stroke: "#71717a", strokeDasharray: "3 3" }}
            content={<ChartTooltipContent className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100" labelFormatter={(value) => formatCutoff(String(value))} formatter={(value) => [typeof value === "number" ? scoreFormat.format(value) : "No data", label]} />}
          />
          <Line dataKey="value" type="monotone" stroke="#a78bfa" strokeWidth={2} dot={false} activeDot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
      <p className="comparison-note" title={methodology}>Monthly comparison uses completed UTC month-end observations. Missing months remain unfilled. {methodology}</p>
    </div>
  );
}

function ComparisonPanel({ query }: { query: RankingComparisonQuery }) {
  const comparison = useQuery(rankingComparisonQueryOptions(query));
  return <div className="row-history-panel">{comparison.isLoading ? <p className="ranking-muted">Loading monthly comparison…</p> : comparison.isError ? <p className="ranking-muted">Monthly comparison unavailable.</p> : comparison.data ? <HistoryChart data={comparison.data} /> : <p className="ranking-muted">No monthly comparison data yet.</p>}</div>;
}

function LazyComparison({ query }: { query: RankingComparisonQuery }) {
  const [open, setOpen] = useState(false);
  return <details className="history-comparison" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Monthly comparison</summary>{open && <ComparisonPanel query={query} />}</details>;
}

function PodiumHistory({ items, type, filters }: { items: ReceptionRankingItem[]; type: ReceptionRankingType; filters: ReceptionFilters }) {
  const [selected, setSelected] = useState(items[0]?.game.appid ?? null);
  const current = items.find((item) => item.game.appid === selected) ?? items[0];
  if (!current) return null;
  return (
    <details className="podium-history">
      <summary>Evidence &amp; history</summary>
      <div role="tablist" aria-label="Podium game history" className="history-tabs">
        {items.map((item, index) => <button type="button" role="tab" key={item.game.appid} id={`ranking-history-tab-${item.game.appid}`} aria-selected={item.game.appid === current.game.appid} aria-controls="ranking-history-panel" tabIndex={item.game.appid === current.game.appid ? 0 : -1} onClick={() => setSelected(item.game.appid)} onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length; setSelected(items[next].game.appid); document.getElementById(`ranking-history-tab-${items[next].game.appid}`)?.focus(); }}><span>#{index + 1}</span> {item.game.name}</button>)}
      </div>
      <section id="ranking-history-panel" role="tabpanel" aria-labelledby={`ranking-history-tab-${current.game.appid}`} tabIndex={0} className="history-panel">
        <div className="history-heading"><div><h3>{current.game.name}</h3><p>{metricLabel(current.metric.kind)} · qualifying evidence {current.eligibility.evidence_window.start ? `${current.eligibility.evidence_window.start} → ${current.eligibility.evidence_window.end ?? "present"}` : "not available"}</p></div><AppLink href={getCanonicalGamePath(current.game.appid, current.game.name)}>Game details ↗</AppLink></div>
        <LazyComparison query={{ type, filters, appid: current.game.appid }} />
      </section>
    </details>
  );
}

function RankingRow({ item, query }: { item: ReceptionRankingItem; query: RankingComparisonQuery }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ranking-row" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span className="table-rank">{item.rank}</span><span className="table-game"><AppLink href={getCanonicalGamePath(item.game.appid, item.game.name)} className="table-art-link" aria-label={item.game.name + " game details"} onClick={(event) => event.stopPropagation()}><Artwork game={item.game} /></AppLink><span><strong><GameLink game={item.game} /></strong><CardMeta item={item} /></span></span><ScoreCell item={item} /><span className="row-disclosure" aria-hidden="true"><CaretDown size={16} weight="bold" /></span></summary>
      {open && <ComparisonPanel query={query} />}
    </details>
  );
}


function FacetControls({ facets, filters, onNavigate }: { facets: FacetDictionaryEntry[]; filters: ReceptionFilters; onNavigate?: (next: RankingsPageNavigation) => void }) {
  const setFilter = (group: keyof ReceptionFilters, values: number[]) => onNavigate?.({ filters: { ...filters, [group]: values }, offset: 0 });
  return <section className="facet-controls" aria-label="Ranking filters"><RankingFacetSelect group="genre" entries={facets} selected={filters.genres} onChange={(values) => setFilter("genres", values)} /><RankingFacetSelect group="feature" entries={facets} selected={filters.features} onChange={(values) => setFilter("features", values)} /><RankingFacetSelect group="community_tag" entries={facets} selected={filters.tags} onChange={(values) => setFilter("tags", values)} /></section>;
}

export function RankingsPageView({ data, facets = [], activeType, activeFilters, activeOffset, isFetching = false, onNavigate }: RankingsPageViewProps) {
  const type = activeType ?? data.type;
  const filters = activeFilters ?? data.filters;
  const offset = activeOffset ?? data.offset;
  const topThree = offset === 0 ? data.items.slice(0, 3) : [];
  const remaining = offset === 0 ? data.items.slice(3) : data.items;
  const comparisonQuery = (item: ReceptionRankingItem): RankingComparisonQuery => ({ type, filters, appid: item.game.appid });
  const reset = () => onNavigate?.({ type: "top_rated_now", filters: { genres: [], features: [], tags: [] }, offset: 0 });
  const previousOffset = Math.max(0, offset - (data.limit || 25));
  const nextOffset = offset + (data.limit || 25);
  return (
    <div className="rankings-page">
      <header className="rankings-header"><div><p className="rankings-kicker">PLAYER RECEPTION</p><h1>Top rated</h1><p className="rankings-subtitle">{type === "top_rated_now" ? "Top Rated Now" : "Top Rated All Time"} · current eligible catalog</p></div><div className="rankings-stat"><strong>{formatNumber(data.eligible_total)}</strong><span>ranked in {data.scope}</span></div></header>
      <section className="rankings-controls">
        <fieldset className="mode-control"><legend>Reception mode</legend><div className="mode-buttons"><button type="button" aria-pressed={type === "top_rated_now"} onClick={() => onNavigate?.({ type: "top_rated_now", offset: 0 })}>Now</button><button type="button" aria-pressed={type === "top_rated_all_time"} onClick={() => onNavigate?.({ type: "top_rated_all_time", offset: 0 })}>All Time</button></div></fieldset>
        <FacetControls facets={facets} filters={filters} onNavigate={onNavigate} />
        <button type="button" className="reset-filters" onClick={reset}>Reset filters</button>
      </section>
      <div className="rankings-status" aria-live="polite">{isFetching ? "Updating rankings…" : `${formatNumber(data.total)} titles in scope · ${formatNumber(data.minimum_reviews)} reviews required`}</div>
      {data.items.length === 0 ? <section className="rankings-empty"><strong>No games match these filters.</strong><p>Try another facet or return to the full catalog.</p><button type="button" onClick={reset}>Reset filters</button></section> : <>
        {topThree.length > 0 && <section className="podium-grid" aria-label={`${type === "top_rated_now" ? "Top Rated Now" : "Top Rated All Time"} top three`}>{topThree.map((item, index) => <PodiumCard item={item} rank={index + 1} key={item.game.appid} />)}</section>}
        {topThree.length > 0 && <PodiumHistory items={topThree} type={type} filters={filters} />}
        <section className="ranking-table" aria-label="Remaining ranked games"><div className="ranking-table-head"><span>Rank</span><span>Game</span><span>Score</span><span className="sr-only">History</span></div>{remaining.map((item) => <RankingRow key={item.game.appid} item={item} query={comparisonQuery(item)} />)}</section>
        <nav className="ranking-pagination" aria-label="Rankings pages"><button type="button" disabled={offset <= 0} onClick={() => onNavigate?.({ offset: previousOffset })}>Previous</button><span>{formatNumber(offset + 1)}–{formatNumber(Math.min(offset + data.items.length, data.eligible_total))} of {formatNumber(data.eligible_total)}</span><button type="button" disabled={!data.has_more} onClick={() => onNavigate?.({ offset: nextOffset })}>Next</button></nav>
      </>}
    </div>
  );
}
