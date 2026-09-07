import { useEffect, useMemo, useState, type ReactNode } from "react";
import "./rankings-prototype.css";
import { AppLink } from "./app-link";
import { getCanonicalGamePath } from "../lib/slug";
import cyberpunkHistory from "./cyberpunk-history.prototype.json";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

/** Throwaway A/B podium comparison; ranking fixtures are not live scores. */
export type RankingsPrototypeVariant = "A" | "B";

type RankingMode = "now" | "allTime";
type Genre = "All" | "Action" | "RPG" | "Puzzle" | "Strategy";
type Tag = "All" | "Open World" | "Single-player" | "Indie" | "Co-op" | "Simulation";
type HistoryPoint = { date: string; value: number };
type HistoryEventKind = "majorPatch" | "earlyAccessEntry" | "version1" | "expansion" | "edition";
type HistoryEvent = { date: string; kind: HistoryEventKind; label: string; sourceUrl?: string };

type Fixture = {
  appid: number;
  title: string;
  genre: Exclude<Genre, "All">;
  tags: readonly Exclude<Tag, "All">[];
  art: string;
  description: string;
  status: "released" | "earlyAccess";
  releaseDate?: string | null;
  currentPositive: number;
  currentReviews: number;
  historicalPositive: number;
  historicalReviews: number;
  recentReviews: number;
  lifetimePositive: number;
  lifetimeReviews: number;
  evidenceWindow: string;
  historicalWindow: string;
  scoreAge: string;
  updateAnchor: string;
  source: string;
  history: readonly HistoryPoint[];
  events?: readonly HistoryEvent[];
  historyLabel?: string;
  historyNote?: string;
};

type RankedFixture = Fixture & {
  currentScore: number | null;
  lifetimeApproval: number | null;
  metric: number | null;
  qualifyingCount: number;
  gate: number;
  eligible: boolean;
};

const GENRES: Genre[] = ["All", "Action", "RPG", "Puzzle", "Strategy"];
const TAGS: Tag[] = ["All", "Open World", "Single-player", "Indie", "Co-op", "Simulation"];

const EVENT_KIND_LABELS: Record<HistoryEventKind, string> = {
  majorPatch: "Major patch",
  earlyAccessEntry: "Early Access entry",
  version1: "Version 1.0",
  expansion: "Expansion",
  edition: "Edition",
};

// Deliberately synthetic aggregate fixtures. Counts are disjoint buckets, not individual reviews.
const FIXTURES: readonly Fixture[] = [
  {
    appid: 1091500,
    title: "Cyberpunk 2077",
    genre: "RPG",
    tags: ["Open World", "Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg",
    description: "Synthetic fixture with a large current evidence bucket.",
    status: "released",
    releaseDate: "2020-12-10",
    currentPositive: 6480,
    currentReviews: 7200,
    historicalPositive: 16,
    historicalReviews: 20,
    recentReviews: 7200,
    lifetimePositive: 430000,
    lifetimeReviews: 520000,
    evidenceWindow: "2026-06-09 → 2026-09-07",
    historicalWindow: "2026-03-11 → 2026-06-08",
    scoreAge: "2026-09-07",
    updateAnchor: "Major Update · 2026-06-09",
    source: "Steam aggregate · off-topic excluded",
    history: cyberpunkHistory.data.map(point => ({ date: point.date, value: 100 * point.positive / point.total })),
    historyLabel: "Monthly Steam review approval",
    historyNote: "Observed monthly Steam totals, not historical Current Player Scores. Verified event dates; timing does not prove causation. Latest month is incomplete.",
    events: [
      { date: "2022-02-15", kind: "majorPatch", label: "Patch 1.5", sourceUrl: "https://www.cyberpunk.net/en/news/41435/patch-1-5-next-generation-update-list-of-changes" },
      { date: "2022-09-06", kind: "majorPatch", label: "Edgerunners · 1.6", sourceUrl: "https://www.cyberpunk.net/en/news/45280/edgerunners-update-patch-1-6-list-of-changes" },
      { date: "2023-09-21", kind: "majorPatch", label: "Update 2.0", sourceUrl: "https://www.cyberpunk.net/en/news/49060/update-2-0" },
      { date: "2023-09-25", kind: "expansion", label: "Phantom Liberty · PC", sourceUrl: "https://www.cyberpunk.net/en/news/49150/cyberpunk-2077-phantom-liberty-out-now" },
      { date: "2023-12-05", kind: "edition", label: "Ultimate Edition", sourceUrl: "https://www.cyberpunk.net/en/news/49696/cyberpunk-2077-ultimate-edition-is-out-now" },
      { date: "2023-12-05", kind: "majorPatch", label: "Update 2.1", sourceUrl: "https://www.cyberpunk.net/en/news/49597/update-2-1-patch-notes" },
    ],
  },
  {
    appid: 1086940,
    title: "Baldur's Gate 3",
    genre: "RPG",
    tags: ["Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg",
    description: "Synthetic fixture with a large, steady evidence bucket.",
    status: "released",
    releaseDate: "2023-08-03",
    currentPositive: 4700,
    currentReviews: 5000,
    historicalPositive: 19,
    historicalReviews: 20,
    recentReviews: 5000,
    lifetimePositive: 490000,
    lifetimeReviews: 515000,
    evidenceWindow: "2026-06-09 → 2026-09-07",
    historicalWindow: "2026-03-11 → 2026-06-08",
    scoreAge: "2026-09-07",
    updateAnchor: "Rolling 90 days · no newer Major Update",
    source: "Steam aggregate · off-topic excluded",
    history: [
      { date: "2025-12", value: 93 },
      { date: "2026-03", value: 93.5 },
      { date: "2026-06", value: 93.1 },
      { date: "2026-09", value: 94.004 },
    ],
    events: [{ date: "2026-06-09", kind: "majorPatch", label: "Major Update" }],
  },
  {
    appid: 1145350,
    title: "Hades II",
    genre: "Action",
    tags: ["Indie", "Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1145350/header.jpg",
    description: "Synthetic category fixture with 120 recent reviews.",
    status: "released",
    releaseDate: "2024-05-06",
    currentPositive: 108,
    currentReviews: 120,
    historicalPositive: 10,
    historicalReviews: 12,
    recentReviews: 120,
    lifetimePositive: 3650,
    lifetimeReviews: 4000,
    evidenceWindow: "2026-06-09 → 2026-09-07",
    historicalWindow: "2026-03-11 → 2026-06-08",
    scoreAge: "2026-09-07",
    updateAnchor: "Rolling 90 days · no newer Major Update",
    source: "Steam aggregate · off-topic excluded",
    history: [
      { date: "2025-12", value: 86 },
      { date: "2026-03", value: 88 },
      { date: "2026-06", value: 89 },
      { date: "2026-09", value: 89.394 },
    ],
    events: [{ date: "2025-12-01", kind: "earlyAccessEntry", label: "Early Access entry" }],
  },
  {
    appid: 1716740,
    title: "Starfield",
    genre: "RPG",
    tags: ["Open World", "Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1716740/header.jpg",
    description: "Synthetic fixture with a large current evidence bucket.",
    status: "released",
    releaseDate: "2023-09-06",
    currentPositive: 6500,
    currentReviews: 10000,
    historicalPositive: 18,
    historicalReviews: 20,
    recentReviews: 10000,
    lifetimePositive: 390000,
    lifetimeReviews: 500000,
    evidenceWindow: "2026-06-09 → 2026-09-07",
    historicalWindow: "2026-03-11 → 2026-06-08",
    scoreAge: "2026-09-07",
    updateAnchor: "Major Update · 2026-06-09",
    source: "Steam aggregate · off-topic excluded",
    history: [
      { date: "2025-12", value: 90 },
      { date: "2026-03", value: 86 },
      { date: "2026-06", value: 79 },
      { date: "2026-09", value: 65.0499 },
    ],
    events: [{ date: "2026-06-09", kind: "majorPatch", label: "Major Update" }],
  },
  {
    appid: 275850,
    title: "No Man's Sky",
    genre: "Action",
    tags: ["Open World", "Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/275850/header.jpg",
    description: "Post-update current evidence is small; the 90-day eligibility count remains separate.",
    status: "released",
    releaseDate: "2016-08-12",
    currentPositive: 10,
    currentReviews: 12,
    historicalPositive: 15,
    historicalReviews: 20,
    recentReviews: 340,
    lifetimePositive: 180000,
    lifetimeReviews: 250000,
    evidenceWindow: "2026-08-12 → 2026-09-07",
    historicalWindow: "2026-05-14 → 2026-08-11",
    scoreAge: "2026-09-07",
    updateAnchor: "Major Update · 2026-08-12",
    source: "Steam aggregate · off-topic excluded",
    history: [
      { date: "2025-12", value: 73 },
      { date: "2026-03", value: 74 },
      { date: "2026-06", value: 75 },
      { date: "2026-09", value: 78.125 },
    ],
    events: [{ date: "2026-08-12", kind: "majorPatch", label: "Major Update" }],
  },
  {
    appid: 620,
    title: "Portal 2",
    genre: "Puzzle",
    tags: ["Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/620/header.jpg",
    description: "Older fixture with retained historical support and low recent activity.",
    status: "released",
    releaseDate: "2011-04-18",
    currentPositive: 0,
    currentReviews: 0,
    historicalPositive: 19,
    historicalReviews: 20,
    recentReviews: 18,
    lifetimePositive: 100000,
    lifetimeReviews: 108000,
    evidenceWindow: "No current bucket",
    historicalWindow: "Retained baseline · 2025-10-01 → 2025-12-29",
    scoreAge: "2025-12-29",
    updateAnchor: "Rolling 90 days · no newer Major Update",
    source: "Steam aggregate · off-topic excluded",
    history: [
      { date: "2024-12", value: 94 },
      { date: "2025-06", value: 94.5 },
      { date: "2025-12", value: 95 },
    ],
  },
  {
    appid: 870780,
    title: "Control",
    genre: "Action",
    tags: ["Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/870780/header.jpg",
    description: "Synthetic category fixture with 80 recent reviews.",
    status: "released",
    releaseDate: "2019-08-27",
    currentPositive: 62,
    currentReviews: 80,
    historicalPositive: 6,
    historicalReviews: 8,
    recentReviews: 80,
    lifetimePositive: 85000,
    lifetimeReviews: 110000,
    evidenceWindow: "2026-06-09 → 2026-09-07",
    historicalWindow: "2026-03-11 → 2026-06-08",
    scoreAge: "2026-09-07",
    updateAnchor: "Rolling 90 days · no newer Major Update",
    source: "Steam aggregate · off-topic excluded",
    history: [
      { date: "2025-12", value: 73 },
      { date: "2026-03", value: 71 },
      { date: "2026-06", value: 70 },
      { date: "2026-09", value: 77.273 },
    ],
  },
  {
    appid: 835960,
    title: "The Talos Principle 2",
    genre: "Puzzle",
    tags: ["Single-player"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/835960/header.jpg",
    description: "No compatible aggregate evidence in this fixture.",
    status: "released",
    releaseDate: null,
    currentPositive: 0,
    currentReviews: 0,
    historicalPositive: 0,
    historicalReviews: 0,
    recentReviews: 0,
    lifetimePositive: 0,
    lifetimeReviews: 0,
    evidenceWindow: "No current bucket",
    historicalWindow: "No historical bucket",
    scoreAge: "No score yet",
    updateAnchor: "No known Major Update anchor",
    source: "Steam aggregate · no compatible evidence",
    history: [],
  },
  {
    appid: 2868840,
    title: "Slay the Spire 2",
    genre: "Strategy",
    tags: ["Indie", "Co-op"],
    art: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2868840/header.jpg",
    description: "Early Access fixture shown outside official rankings.",
    status: "earlyAccess",
    releaseDate: "2026-03-05",
    currentPositive: 74,
    currentReviews: 90,
    historicalPositive: 5,
    historicalReviews: 6,
    recentReviews: 90,
    lifetimePositive: 3000,
    lifetimeReviews: 3600,
    evidenceWindow: "2026-06-09 → 2026-09-07",
    historicalWindow: "2026-03-11 → 2026-06-08",
    scoreAge: "2026-09-07",
    updateAnchor: "Rolling 90 days · no newer Major Update",
    source: "Steam aggregate · off-topic excluded",
    history: [
      { date: "2026-03", value: 79 },
      { date: "2026-06", value: 78 },
      { date: "2026-09", value: 82.292 },
    ],
  },
];

const numberFormat = new Intl.NumberFormat(undefined);
const oneDecimalFormat = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function formatNumber(value: number) {
  return numberFormat.format(value);
}

function formatScore(value: number | null) {
  return value === null ? "—" : oneDecimalFormat.format(value);
}

const historyDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const releaseDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const eventDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function parseTimelineDate(value: string) {
  const normalized = /^\d{4}-\d{2}$/.test(value) ? value + "-01" : value;
  const timestamp = Date.parse(normalized + "T00:00:00Z");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatHistoryDate(value: string) {
  const timestamp = parseTimelineDate(value);
  return timestamp === null ? value : historyDateFormat.format(new Date(timestamp));
}

function formatReleaseDate(value?: string | null) {
  const timestamp = value ? parseTimelineDate(value) : null;
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return date.getUTCFullYear() === new Date().getUTCFullYear() ? releaseDateFormat.format(date) : String(date.getUTCFullYear());
}

function formatEventDate(value: string) {
  const timestamp = parseTimelineDate(value);
  return timestamp === null ? value : eventDateFormat.format(new Date(timestamp));
}

function currentPlayerScore(game: Fixture) {
  if (game.currentReviews === 0 && game.historicalReviews === 0) return null;
  if (game.historicalReviews > 0) {
    const h = Math.min(20, game.historicalReviews);
    const historicalApproval = game.historicalPositive / game.historicalReviews;
    return (100 * (game.currentPositive + h * historicalApproval)) / (game.currentReviews + h);
  }
  return (100 * (game.currentPositive + 0.5)) / (game.currentReviews + 1);
}

function lifetimeApproval(game: Fixture) {
  return game.lifetimeReviews > 0 ? (100 * game.lifetimePositive) / game.lifetimeReviews : null;
}

function isGlobalScope(genre: Genre, tag: Tag) {
  return genre === "All" && tag === "All";
}

function deriveGame(game: Fixture, mode: RankingMode, genre: Genre, tag: Tag): RankedFixture {
  const gate = isGlobalScope(genre, tag) ? 250 : 50;
  const currentScore = currentPlayerScore(game);
  const lifetime = lifetimeApproval(game);
  const metric = mode === "now" ? currentScore : lifetime;
  const qualifyingCount = mode === "now" ? game.recentReviews : game.lifetimeReviews;
  return {
    ...game,
    currentScore,
    lifetimeApproval: lifetime,
    metric,
    qualifyingCount,
    gate,
    eligible: game.status === "released" && metric !== null && qualifyingCount >= gate,
  };
}

function matchesFilter(game: Fixture, genre: Genre, tag: Tag) {
  return (genre === "All" || game.genre === genre) && (tag === "All" || game.tags.includes(tag as Exclude<Tag, "All">));
}

function sortRanked(a: RankedFixture, b: RankedFixture, mode: RankingMode) {
  const metricDifference = (b.metric ?? -1) - (a.metric ?? -1);
  if (metricDifference !== 0) return metricDifference;
  if (b.qualifyingCount !== a.qualifyingCount) return b.qualifyingCount - a.qualifyingCount;
  return a.appid - b.appid;
}

function modeLabel(mode: RankingMode) {
  return mode === "now" ? "Top Rated Now" : "Top Rated All Time";
}

function gateLabel(game: RankedFixture, mode: RankingMode) {
  const window = mode === "now" ? "90-day" : "lifetime";
  return `${formatNumber(game.qualifyingCount)} ${window} reviews · ${game.gate === 250 ? "global" : "category"} gate ${formatNumber(game.gate)}`;
}


function PrototypeControls({
  mode,
  genre,
  tag,
  onModeChange,
  onGenreChange,
  onTagChange,
  onReset,
  sidebar = false,
}: {
  mode: RankingMode;
  genre: Genre;
  tag: Tag;
  onModeChange: (mode: RankingMode) => void;
  onGenreChange: (genre: Genre) => void;
  onTagChange: (tag: Tag) => void;
  onReset: () => void;
  sidebar?: boolean;
}) {
  return (
    <div className={sidebar ? "rp-controls rp-controls-sidebar" : "rp-controls"}>
      <fieldset className="rp-mode-group">
        <legend>Reception mode</legend>
        <div className="rp-mode-buttons">
          <button type="button" aria-pressed={mode === "now"} onClick={() => onModeChange("now")}>
            Now
          </button>
          <button type="button" aria-pressed={mode === "allTime"} onClick={() => onModeChange("allTime")}>
            All Time
          </button>
        </div>
      </fieldset>

      {sidebar ? (
        <fieldset className="rp-sidebar-genres">
          <legend>Genre</legend>
          <div className="rp-genre-list">
            {GENRES.map((option) => (
              <button
                type="button"
                key={option}
                aria-pressed={genre === option}
                onClick={() => onGenreChange(option)}
              >
                <span>{option}</span>
                <span aria-hidden="true">{option === "All" ? "·" : formatNumber(FIXTURES.filter((game) => game.genre === option).length)}</span>
              </button>
            ))}
          </div>
        </fieldset>
      ) : (
        <label className="rp-select-label">
          Genre
          <select value={genre} onChange={(event) => onGenreChange(event.target.value as Genre)}>
            {GENRES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="rp-select-label">
        Tag / category
        <select value={tag} onChange={(event) => onTagChange(event.target.value as Tag)}>
          {TAGS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <button className="rp-reset" type="button" onClick={onReset}>
        Reset filters
      </button>
    </div>
  );
}

function Methodology({ mode }: { mode: RankingMode }) {
  return (
    <details className="rp-methodology">
      <summary>Methodology &amp; evidence</summary>
      <div className="rp-methodology-body">
        <p>
          <strong>Illustrative review data.</strong> These static fixtures are synthetic Steam aggregate snapshots for comparing layouts, not live scores.
        </p>
        <dl className="rp-methodology-list">
          <div>
            <dt>Current Player Score</dt>
            <dd>S = 100 × (P + h × pH) / (N + h), with h = min(20, historical reviews). Without historical evidence, S = 100 × (P + 0.5) / (N + 1).</dd>
          </div>
          <div>
            <dt>{mode === "now" ? "Now eligibility" : "All Time eligibility"}</dt>
            <dd>{mode === "now" ? "Actual reviews in the latest 90 days; 250 for the global scope and 50 for a genre/tag scope." : "Compatible lifetime reviews; 250 for the global scope and 50 for a genre/tag scope."}</dd>
          </div>
          <div>
            <dt>Window separation</dt>
            <dd>Current and historical buckets are disjoint and retain their source/filter compatibility. Eligibility counts do not replace scoring evidence.</dd>
          </div>
          <div>
            <dt>History</dt>
            <dd>Recorded aggregate values remain visible, including retained scores when newer evidence runs out. Empty evidence means no score; proximity to an update is not a causal claim.</dd>
          </div>
          <div>
            <dt>Ordering</dt>
            <dd>Full-precision metric first, then qualifying count, then app ID. Early Access stays in a separate unranked work-in-progress section.</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function Header({ mode, rankedCount, scope }: { mode: RankingMode; rankedCount: number; scope: string }) {
  return (
    <header className="rp-header">
      <div>
        <p className="rp-kicker">PLAYER RECEPTION</p>
        <h1>Top rated</h1>
        <p className="rp-subtitle">{modeLabel(mode)} · illustrative synthetic aggregate fixtures, not live rankings.</p>
      </div>
      <div className="rp-header-stat">
        <strong>{formatNumber(rankedCount)}</strong>
        <span>ranked in {scope}</span>
      </div>
    </header>
  );
}

function ScoreCell({ game, mode, prominent = false }: { game: RankedFixture; mode: RankingMode; prominent?: boolean }) {
  return (
    <div className={prominent ? "rp-score rp-score-prominent" : "rp-score"}>
      <div className="rp-score-slot is-active">
        <strong>{formatScore(game.metric)}</strong>
        <span>{mode === "now" ? "Current Player Score" : "Lifetime Approval"}</span>
      </div>
    </div>
  );
}
function HistoryEventLabel({ viewBox, event, edge, active, tooltipId, shortLabel, onActivate, onDeactivate }: {
  viewBox?: { x?: number; y?: number };
  event: HistoryEvent & { lane: number };
  edge: boolean;
  active: boolean;
  tooltipId: string;
  shortLabel: string;
  onActivate: () => void;
  onDeactivate: () => void;
}) {
  return <foreignObject x={(viewBox?.x ?? 0) + (edge ? -46 : 3)} y={(viewBox?.y ?? 0) + event.lane * 26} width={44} height={26}>
    <button type="button" className="rp-event-label" aria-label={event.label + " · " + formatEventDate(event.date)}
      aria-describedby={active ? tooltipId : undefined}
      onMouseEnter={onActivate} onFocus={onActivate} onClick={onActivate} onBlur={onDeactivate}
      onMouseLeave={event => { if (document.activeElement !== event.currentTarget) onDeactivate(); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onDeactivate(); } }}>
      {shortLabel}
    </button>
  </foreignObject>;
}
function HistoryChart({ game }: { game: RankedFixture }) {
  const [activeEvent, setActiveEvent] = useState<number | null>(null);
  const [hoveredValue, setHoveredValue] = useState<number | null>(null);
  const historySamples = game.history
    .map(point => ({ ...point, timestamp: parseTimelineDate(point.date) }))
    .filter((point): point is HistoryPoint & { timestamp: number } => point.timestamp !== null);
  if (!historySamples.length) return <p className="rp-no-history">No recorded history yet.</p>;
  const start = historySamples[0].timestamp;
  const end = historySamples[historySamples.length - 1].timestamp;
  const laneEnds = [-Infinity, -Infinity, -Infinity, -Infinity];
  const events = (game.events ?? []).flatMap(event => {
    const timestamp = parseTimelineDate(event.date);
    if (timestamp === null || timestamp < start || timestamp > end) return [];
    const fraction = (timestamp - start) / Math.max(1, end - start);
    const available = laneEnds.findIndex(previous => fraction - previous > .16);
    const lane = available < 0 ? 3 : available;
    laneEnds[lane] = fraction;
    return [{ ...event, timestamp, lane }];
  });
  const selectedEvent = activeEvent === null ? undefined : events[activeEvent];
  const metricLabel = game.historyLabel ?? "Illustrative Current Player Score";
  const shortLabels: Record<string, string> = { "Patch 1.5": "1.5", "Edgerunners · 1.6": "1.6", "Update 2.0": "2.0", "Phantom Liberty · PC": "PL", "Ultimate Edition": "UE", "Update 2.1": "2.1", "Major Update": "Patch", "Early Access entry": "EA", "Version 1.0": "1.0" };
  return (
    <div className="rp-history-chart">
      <ChartContainer config={{ value: { label: metricLabel, color: "#a78bfa" } }} className="rp-recharts-container w-full h-[240px] aspect-auto">
        <LineChart data={historySamples} accessibilityLayer margin={{ top: 12, right: 18, left: 0, bottom: 0 }}
          onMouseMove={state => setHoveredValue(typeof state?.activePayload?.[0]?.value === "number" ? state.activePayload[0].value : null)}
          onMouseLeave={() => { setHoveredValue(null); if (!document.activeElement?.classList.contains("rp-event-label")) setActiveEvent(null); }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis dataKey="timestamp" type="number" domain={[start, end]} allowDataOverflow tickLine={false} axisLine={false}
            stroke="#71717a" fontSize={10} minTickGap={40} tickFormatter={value => formatHistoryDate(new Date(value).toISOString().slice(0, 10))} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={34} tickLine={false} axisLine={false} stroke="#71717a" fontSize={10} tickFormatter={value => formatNumber(value)} />
          {events.map((event, index) => (
            <ReferenceLine key={event.kind + event.date} x={event.timestamp} stroke="#a78bfa" strokeDasharray="3 3"
              onMouseEnter={() => setActiveEvent(index)} onClick={() => setActiveEvent(index)}
              onMouseLeave={() => { if (!document.activeElement?.classList.contains("rp-event-label")) setActiveEvent(null); }}
              label={<HistoryEventLabel event={event} edge={event.timestamp > start + (end - start) * .88}
                active={activeEvent === index} tooltipId={"event-tooltip-" + game.appid}
                shortLabel={shortLabels[event.label] ?? event.label.slice(0, 4)}
                onActivate={() => setActiveEvent(index)} onDeactivate={() => setActiveEvent(null)} />} />
          ))}
          {hoveredValue !== null && !selectedEvent && <ReferenceLine y={hoveredValue} stroke="#a78bfa" strokeDasharray="3 3" />}
          <ChartTooltip {...(selectedEvent ? { active: true, position: { x: 42, y: 118 }, wrapperStyle: { visibility: "visible" as const } } : {})}
            isAnimationActive={false}
            cursor={selectedEvent ? false : { stroke: "#71717a", strokeDasharray: "3 3" }}
            content={props => <div id={selectedEvent ? "event-tooltip-" + game.appid : undefined} role="tooltip"><ChartTooltipContent label={props.label}
              active={selectedEvent ? true : props.active}
              payload={selectedEvent ? [{ dataKey: "value", name: "event", value: formatEventDate(selectedEvent.date), color: "#a78bfa", payload: selectedEvent }] : props.payload}
              className="!bg-zinc-950 !opacity-100 border-zinc-700 shadow-2xl text-zinc-100"
              labelFormatter={(_, payload) => selectedEvent ? selectedEvent.label : formatHistoryDate(payload?.[0]?.payload?.date ?? "")}
              formatter={value => selectedEvent
                ? <span>{EVENT_KIND_LABELS[selectedEvent.kind]} · {formatEventDate(selectedEvent.date)}</span>
                : <span><strong className="text-violet-300">{formatScore(Number(value))}</strong> · {metricLabel}</span>} /></div>} />
          <Line dataKey="value" type="linear" stroke="var(--color-value)" strokeWidth={1.8} dot={false} activeDot={selectedEvent ? false : { r: 3 }} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ChartContainer>
      <div className="rp-chart-legend"><span><i className="rp-chart-key rp-chart-key-score" aria-hidden="true" />{metricLabel}</span></div>
      <p className="rp-chart-note">{game.historyNote ?? "Illustrative reception and milestone data, not verified history."}</p>
    </div>
  );
}

function EvidenceDetails({ game, mode }: { game: RankedFixture; mode: RankingMode }) {
  return (
    <div className="rp-evidence rp-reception-preview">
      <div className="rp-preview-heading">
        <div><h3>{game.title}</h3><p>{gateLabel(game, mode)} · score evidence {game.scoreAge}</p></div>
        <AppLink href={getCanonicalGamePath(game.appid, game.title)}>Game details ↗</AppLink>
      </div>
      <HistoryChart key={game.appid} game={game} />
    </div>
  );
}

function PodiumHistory({ games, mode }: { games: RankedFixture[]; mode: RankingMode }) {
  const [selectedId, setSelectedId] = useState(games[0]?.appid);
  const selected = games.find(game => game.appid === selectedId) ?? games[0];
  if (!selected) return null;
  return (
    <details className="rp-podium-history">
      <summary>Evidence &amp; history</summary>
      <div role="tablist" aria-label="Podium game history" className="rp-history-tabs">
        {games.map((game, index) => (
          <button type="button" role="tab" key={game.appid} id={`history-tab-${game.appid}`}
            aria-selected={selected.appid === game.appid} aria-controls="podium-history-panel"
            tabIndex={selected.appid === game.appid ? 0 : -1}
            onClick={() => setSelectedId(game.appid)}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? games.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + games.length) % games.length;
              setSelectedId(games[next].appid);
              document.getElementById(`history-tab-${games[next].appid}`)?.focus();
            }}>
            <span>#{index + 1}</span> {game.title}
          </button>
        ))}
      </div>
      <section role="tabpanel" id="podium-history-panel" aria-labelledby={`history-tab-${selected.appid}`} tabIndex={0}>
        <EvidenceDetails game={selected} mode={mode} />
      </section>
    </details>
  );
}

function Tags({ game }: { game: Fixture }) {
  return (
    <div className="rp-tags">
      <span>{game.genre}</span>
      {game.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
      {game.status === "earlyAccess" && <span className="rp-status-wip">Early Access</span>}
    </div>
  );
}

function GameIdentity({ game, rank }: { game: Fixture; rank?: number }) {
  const releaseDate = formatReleaseDate(game.releaseDate);
  return (
    <div className="rp-game-identity">
      {rank !== undefined && <span className="rp-rank">{rank}</span>}
      <img src={game.art} alt="" loading="lazy" />
      <div>
        <strong>{game.title}</strong>
        {releaseDate && <span className="rp-release-date">{releaseDate}</span>}
        <Tags game={game} />
      </div>
    </div>
  );
}
function EmptyState({ onReset, message = "No games match these filters." }: { onReset: () => void; message?: string }) {
  return (
    <div className="rp-empty">
      <strong>{message}</strong>
      <p>Try another genre or tag, or return to the full catalog.</p>
      <button type="button" onClick={onReset}>Reset filters</button>
    </div>
  );
}

function UnrankedCatalog({ games, earlyAccess, mode }: { games: RankedFixture[]; earlyAccess: RankedFixture[]; mode: RankingMode }) {
  return (
    <div className="rp-catalog-states">
      <section className="rp-unranked-section" aria-labelledby="rp-unranked-title">
        <div className="rp-section-heading">
          <div>
            <p className="rp-kicker">CATALOG CONTEXT</p>
            <h2 id="rp-unranked-title">Outside this leaderboard</h2>
          </div>
          <span>{formatNumber(games.length)} titles</span>
        </div>
        {games.length === 0 ? (
          <p className="rp-muted">Every released title in this scope clears the selected gate.</p>
        ) : (
          <div className="rp-unranked-list">
            {games.map((game) => (
              <details key={game.appid}>
                <summary>
                  <GameIdentity game={game} />
                  <span className="rp-unranked-reason">
                    {game.metric === null ? "No score yet" : `${formatNumber(game.qualifyingCount)} qualifying · gate ${formatNumber(game.gate)}`}
                  </span>
                </summary>
                <EvidenceDetails game={game} mode={mode} />
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="rp-wip-section" aria-labelledby="rp-wip-title">
        <div className="rp-section-heading">
          <div>
            <p className="rp-kicker">SEPARATE STATE</p>
            <h2 id="rp-wip-title">Work in progress</h2>
          </div>
          <span>Early Access · unranked</span>
        </div>
        {earlyAccess.length === 0 ? (
          <p className="rp-muted">No Early Access titles in this scope.</p>
        ) : (
          earlyAccess.map((game) => (
            <details className="rp-wip-row" key={game.appid}>
              <summary>
                <GameIdentity game={game} />
                <span>Sentiment visible, rank withheld</span>
              </summary>
              <EvidenceDetails game={game} mode={mode} />
            </details>
          ))
        )}
      </section>
    </div>
  );
}

function VariantA({ view, controls, podium }: { view: View; controls: ReactNode; podium: RankingsPrototypeVariant }) {
  const topThree = view.ranked.slice(0, 3);
  const remaining = view.ranked.slice(3);
  return (
    <div className="rp-variant rp-variant-a">
      <Header mode={view.mode} rankedCount={view.ranked.length} scope={view.scope} />
      {controls}
      {view.ranked.length === 0 ? <EmptyState onReset={view.onReset} /> : (
        <>
          <section className={`rp-a-hero-grid rp-podium-${podium.toLowerCase()}`} aria-label={`${modeLabel(view.mode)} top three`}>
            {topThree.map((game, index) => (
              <article className={`rp-a-hero rp-a-hero-${index + 1}`} key={game.appid}>
                <div className="rp-a-hero-body">
                  <div className="rp-a-hero-art">
                    <img src={game.art} alt="" loading="lazy" />
                    <span className="rp-a-hero-rank" role="img" aria-label={`Rank ${index + 1}`}>
                      <svg viewBox="0 0 64 64" aria-hidden="true">
                        <circle cx="32" cy="32" r="29" fill="#171125" />
                        <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100" strokeDasharray="22 3" transform="rotate(-40 32 32)" />
                        <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth=".7" />
                        <text x="32" y="33" textAnchor="middle" dominantBaseline="middle" fill="currentColor">{index + 1}</text>
                      </svg>
                    </span>
                  </div>
                  <div className="rp-a-hero-content">
                    <p className="rp-kicker">#{index + 1} IN THIS VIEW</p>
                    <h2>{game.title}</h2>
                    {formatReleaseDate(game.releaseDate) && <span className="rp-release-date">{formatReleaseDate(game.releaseDate)}</span>}
                    <Tags game={game} />
                    <ScoreCell game={game} mode={view.mode} prominent={index === 0} />
                    <div className="rp-a-hero-qualifying">
                      <span>Qualifying reviews</span>
                      <strong>{formatNumber(game.qualifyingCount)}</strong>
                      <small>{view.mode === "now" ? "90-day window" : "lifetime window"}</small>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </section>
          <PodiumHistory games={topThree} mode={view.mode} />
          {remaining.length > 0 && (
            <section className="rp-a-table rp-a-remaining" aria-label="Remaining ranked games">
              <div className="rp-a-table-head"><span>Ranked 4+</span><span>Game</span><span>Scores</span><span>Qualifying reviews</span></div>
              {remaining.map((game, index) => (
                <details className="rp-a-row" key={game.appid}>
                  <summary>
                    <span className="rp-a-rank">{index + 4}</span>
                    <GameIdentity game={game} />
                    <ScoreCell game={game} mode={view.mode} />
                    <span className="rp-a-qualifying">{formatNumber(game.qualifyingCount)}<small>{view.mode === "now" ? "90-day reviews" : "lifetime reviews"}</small></span>
                  </summary>
                  <EvidenceDetails game={game} mode={view.mode} />
                </details>
              ))}
            </section>
          )}
        </>
      )}
      <UnrankedCatalog games={view.excluded} earlyAccess={view.earlyAccess} mode={view.mode} />
      <Methodology mode={view.mode} />
    </div>
  );
}

type View = {
  mode: RankingMode;
  scope: string;
  ranked: RankedFixture[];
  excluded: RankedFixture[];
  earlyAccess: RankedFixture[];
  onReset: () => void;
};

export function RankingsPrototype({ variant }: { variant: RankingsPrototypeVariant }) {
  const [mode, setMode] = useState<RankingMode>("now");
  const [genre, setGenre] = useState<Genre>("All");
  const [tag, setTag] = useState<Tag>("All");

  const matching = useMemo(() => FIXTURES.filter((game) => matchesFilter(game, genre, tag)), [genre, tag]);
  const derived = useMemo(() => matching.map((game) => deriveGame(game, mode, genre, tag)), [matching, mode, genre, tag]);
  const ranked = useMemo(() => derived.filter((game) => game.eligible).sort((a, b) => sortRanked(a, b, mode)), [derived, mode]);
  const excluded = useMemo(() => derived.filter((game) => game.status === "released" && !game.eligible).sort((a, b) => sortRanked(a, b, mode)), [derived, mode]);
  const earlyAccess = useMemo(() => derived.filter((game) => game.status === "earlyAccess"), [derived]);

  useEffect(() => {
    console.info("[RankingsPrototype] state", {
      variant,
      mode,
      genre,
      tag,
      rankedAppIds: ranked.map((game) => game.appid),
    });
  }, [variant, mode, genre, tag, ranked]);

  const scope = isGlobalScope(genre, tag) ? "global" : `${genre === "All" ? "all genres" : genre}${tag === "All" ? "" : ` · ${tag}`}`;
  const onReset = () => {
    setMode("now");
    setGenre("All");
    setTag("All");
  };
  const controls = (
    <PrototypeControls
      mode={mode}
      genre={genre}
      tag={tag}
      onModeChange={setMode}
      onGenreChange={setGenre}
      onTagChange={setTag}
      onReset={onReset}
    />
  );
  const view: View = {
    mode,
    scope,
    ranked,
    excluded,
    earlyAccess,
    onReset,
  };

  return (
    <section className="rankings-prototype" data-variant={variant} data-mode={mode} data-genre={genre} data-tag={tag}>
      <VariantA view={view} controls={controls} podium={variant} />
    </section>
  );
}
