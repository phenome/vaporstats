import { useEffect, useMemo, useState, type ReactNode } from "react";
import "./rankings-prototype.css";

/** UI-only throwaway Wayfinder prototype: three ranking layouts over synthetic Steam aggregates. */
export type RankingsPrototypeVariant = "A" | "B" | "C";

type RankingMode = "now" | "allTime";
type Genre = "All" | "Action" | "RPG" | "Puzzle" | "Strategy";
type Tag = "All" | "Open World" | "Single-player" | "Indie" | "Co-op" | "Simulation";
type HistoryPoint = { date: string; value: number };
type HistoryEventKind = "majorPatch" | "earlyAccessEntry" | "version1";
type HistoryEvent = { date: string; kind: HistoryEventKind; label: string };

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
    history: [
      { date: "2025-12", value: 78 },
      { date: "2026-03", value: 82 },
      { date: "2026-06", value: 86 },
      { date: "2026-09", value: 89.9723 },
    ],
    events: [
      { date: "2026-06-09", kind: "majorPatch", label: "Major Update" },
      { date: "2026-09-01", kind: "version1", label: "Version 1.0" },
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
  const slots = [
    { label: "Current Player Score", value: game.currentScore, active: mode === "now" },
    { label: "Lifetime Approval", value: game.lifetimeApproval, active: mode === "allTime" },
  ];
  return (
    <div className={prominent ? "rp-score rp-score-prominent" : "rp-score"}>
      <div className="rp-score-slots">
        {slots.map((slot) => (
          <div className={slot.active ? "rp-score-slot is-active" : "rp-score-slot"} key={slot.label}>
            <strong>{formatScore(slot.value)}</strong>
            <span>{slot.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryChart({ game }: { game: RankedFixture }) {
  const chartId = `history-${game.appid}`;
  const historySamples = game.history
    .map((point) => ({ ...point, timestamp: parseTimelineDate(point.date) }))
    .filter((point): point is HistoryPoint & { timestamp: number } => point.timestamp !== null);
  if (historySamples.length === 0) {
    return <p className="rp-no-history">No recorded history yet.</p>;
  }
  const values = historySamples.map((point) => point.value);
  const min = Math.max(0, Math.min(...values) - 4);
  const max = Math.min(100, Math.max(...values) + 4);
  const domainStart = Math.min(...historySamples.map((point) => point.timestamp));
  const domainEnd = Math.max(...historySamples.map((point) => point.timestamp));
  const timeToX = (timestamp: number) => domainEnd === domainStart ? 50 : ((timestamp - domainStart) / (domainEnd - domainStart)) * 100;
  const points = historySamples
    .map((point) => {
      const x = timeToX(point.timestamp);
      const y = 92 - ((point.value - min) / Math.max(1, max - min)) * 76;
      return `${x},${y}`;
    })
    .join(" ");
  const events = (game.events ?? [])
    .map((event) => ({ ...event, timestamp: parseTimelineDate(event.date) }))
    .filter((event): event is HistoryEvent & { timestamp: number } => event.timestamp !== null && event.timestamp >= domainStart && event.timestamp <= domainEnd);
  return (
    <div className="rp-history-chart">
      <svg viewBox="0 0 100 100" role="img" aria-labelledby={`${chartId}-title`} preserveAspectRatio="none">
        <title id={chartId + "-title"}>{game.title} reception history, values from {formatHistoryDate(historySamples[0].date)} to {formatHistoryDate(historySamples[historySamples.length - 1].date)}</title>
        <line x1="0" y1="92" x2="100" y2="92" className="rp-chart-axis" />
        {events.map((event) => {
          const x = timeToX(event.timestamp);
          return (
            <g key={event.kind + event.date} className="rp-chart-event">
              <line x1={x} y1="8" x2={x} y2="92" data-kind={event.kind} />
              <title>{EVENT_KIND_LABELS[event.kind]}: {event.label} · {formatEventDate(event.date)}</title>
            </g>
          );
        })}
        <polyline points={points} className="rp-chart-line" />
      </svg>
      <div className="rp-chart-legend" aria-label="History chart legend">
        <span><i className="rp-chart-key rp-chart-key-score" aria-hidden="true" />Player score</span>
        {events.map((event) => (
          <span key={event.kind + event.date}><i className={`rp-chart-key rp-chart-key-${event.kind}`} aria-hidden="true" />{event.label} · <time dateTime={event.date}>{formatEventDate(event.date)}</time></span>
        ))}
      </div>
      <p className="rp-chart-note">Illustrative milestones provide context only; they do not establish causation.</p>
      <ol className="rp-chart-labels">
        {historySamples.map((point) => (
          <li key={point.date}>
            <span>{formatHistoryDate(point.date)}</span>
            <strong>{formatScore(point.value)}</strong>
          </li>
        ))}
      </ol>
    </div>
  );
}

function EvidenceDetails({ game, mode }: { game: RankedFixture; mode: RankingMode }) {
  const historicalWeight = Math.min(20, game.historicalReviews);
  return (
    <div className="rp-evidence">
      <div className="rp-evidence-copy">
        <p className="rp-evidence-kicker">Evidence detail</p>
        <p>{game.description}</p>
      </div>
      <dl className="rp-evidence-grid">
        <div>
          <dt>Current scoring bucket</dt>
          <dd>{formatNumber(game.currentPositive)} positive / {formatNumber(game.currentReviews)} total</dd>
          <small>{game.evidenceWindow}</small>
        </div>
        <div>
          <dt>Historical support</dt>
          <dd>{formatNumber(game.historicalPositive)} positive / {formatNumber(game.historicalReviews)} total</dd>
          <small>{game.historicalWindow} · effective weight {formatNumber(historicalWeight)}</small>
        </div>
        <div>
          <dt>Eligibility evidence</dt>
          <dd>{gateLabel(game, mode)}</dd>
          <small>Separate from the patch-aware scoring window</small>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>{game.source}</dd>
          <small>Score age: {game.scoreAge}</small>
        </div>
      </dl>
      <p className="rp-anchor-note">{game.updateAnchor}. Aggregate history is retained for context; association with an event does not establish causation.</p>
      <HistoryChart game={game} />
    </div>
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

function VariantA({ view, controls }: { view: View; controls: ReactNode }) {
  const topThree = view.ranked.slice(0, 3);
  const remaining = view.ranked.slice(3);
  return (
    <div className="rp-variant rp-variant-a">
      <Header mode={view.mode} rankedCount={view.ranked.length} scope={view.scope} />
      {controls}
      {view.ranked.length === 0 ? <EmptyState onReset={view.onReset} /> : (
        <>
          <section className="rp-a-hero-grid" aria-label={`${modeLabel(view.mode)} top three`}>
            {topThree.map((game, index) => (
              <article className={`rp-a-hero rp-a-hero-${index + 1}`} key={game.appid}>
                <div className="rp-a-hero-body">
                  <div className="rp-a-hero-art">
                    <img src={game.art} alt="" loading="lazy" />
                    <span className="rp-a-hero-rank">#{index + 1}</span>
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
                <details className="rp-a-hero-evidence">
                  <summary>Evidence &amp; history</summary>
                  <EvidenceDetails game={game} mode={view.mode} />
                </details>
              </article>
            ))}
          </section>
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
function VariantB({ view, controls }: { view: View; controls: ReactNode }) {
  const first = view.ranked[0];
  return (
    <div className="rp-variant rp-variant-b">
      <div className="rp-b-sidebar">
        <div className="rp-b-sidebar-title">
          <p className="rp-kicker">DISCOVER</p>
          <h1>Top rated</h1>
          <p>Browse reception by mode, genre, and tag.</p>
        </div>
        {controls}
        <Methodology mode={view.mode} />
      </div>
      <main className="rp-b-main">
        <div className="rp-b-main-heading">
          <div>
            <p className="rp-kicker">{view.scope.toUpperCase()} / {view.mode === "now" ? "LATEST 90 DAYS" : "LIFETIME"}</p>
            <h2>{modeLabel(view.mode)}</h2>
          </div>
          <span>{formatNumber(view.ranked.length)} ranked</span>
        </div>
        {!first ? <EmptyState onReset={view.onReset} /> : (
          <>
            <article className="rp-b-lead">
              <img src={first.art} alt="" loading="lazy" />
              <div className="rp-b-lead-copy">
                <p className="rp-kicker">#1 IN THIS VIEW</p>
                <h3>{first.title}</h3>
                <p>{first.description}</p>
                <Tags game={first} />
                <div className="rp-b-lead-metrics"><ScoreCell game={first} mode={view.mode} prominent /><span>{gateLabel(first, view.mode)}</span></div>
              </div>
              <details className="rp-b-lead-evidence">
                <summary>View evidence</summary>
                <EvidenceDetails game={first} mode={view.mode} />
              </details>
            </article>
            <ol className="rp-b-editorial-list" start={2}>
              {view.ranked.slice(1).map((game, index) => (
                <li key={game.appid}>
                  <article className="rp-b-editorial-row">
                    <GameIdentity game={game} rank={index + 2} />
                    <div className="rp-b-editorial-copy"><p>{game.description}</p><span>{gateLabel(game, view.mode)}</span></div>
                    <ScoreCell game={game} mode={view.mode} />
                    <details><summary>Evidence</summary><EvidenceDetails game={game} mode={view.mode} /></details>
                  </article>
                </li>
              ))}
            </ol>
          </>
        )}
        <UnrankedCatalog games={view.excluded} earlyAccess={view.earlyAccess} mode={view.mode} />
      </main>
    </div>
  );
}

function VariantC({ view, controls }: { view: View; controls: ReactNode }) {
  return (
    <div className="rp-variant rp-variant-c">
      <Header mode={view.mode} rankedCount={view.ranked.length} scope={view.scope} />
      {controls}
      <div className="rp-c-shell">
        <nav className="rp-c-master" aria-label="Ranked games">
          <div className="rp-c-master-heading"><span>Ranked games</span><strong>{formatNumber(view.ranked.length)}</strong></div>
          {view.ranked.map((game, index) => (
            <button type="button" aria-pressed={view.selected?.appid === game.appid} className={view.selected?.appid === game.appid ? "is-selected" : ""} key={game.appid} onClick={() => view.onSelect(game.appid)}>
              <span>{index + 1}</span><span>{game.title}</span><strong>{formatScore(game.metric)}</strong>
            </button>
          ))}
          {view.ranked.length === 0 && <EmptyState onReset={view.onReset} />}
          {view.excluded.length > 0 && <div className="rp-c-subheading">Not ranked</div>}
          {view.excluded.map((game) => (
            <button type="button" aria-pressed={view.selected?.appid === game.appid} className={view.selected?.appid === game.appid ? "is-selected rp-is-unranked" : "rp-is-unranked"} key={game.appid} onClick={() => view.onSelect(game.appid)}>
              <span>—</span><span>{game.title}</span><strong>{game.metric === null ? "—" : formatScore(game.metric)}</strong>
            </button>
          ))}
          {view.earlyAccess.length > 0 && <div className="rp-c-subheading">Early Access · unranked</div>}
          {view.earlyAccess.map((game) => (
            <button type="button" aria-pressed={view.selected?.appid === game.appid} className={view.selected?.appid === game.appid ? "is-selected rp-is-unranked" : "rp-is-unranked"} key={game.appid} onClick={() => view.onSelect(game.appid)}>
              <span>—</span><span>{game.title}</span><strong>WIP</strong>
            </button>
          ))}
        </nav>
        <section className="rp-c-detail" aria-live="polite">
          {view.selected ? (
            <article>
              <div className="rp-c-detail-header">
                <img src={view.selected.art} alt="" loading="lazy" />
                <div><p className="rp-kicker">{view.selected.status === "earlyAccess" ? "Early Access · " : ""}{view.selected.genre}</p><h2>{view.selected.title}</h2>{formatReleaseDate(view.selected.releaseDate) && <span className="rp-release-date">{formatReleaseDate(view.selected.releaseDate)}</span>}<Tags game={view.selected} /></div>
                <ScoreCell game={view.selected} mode={view.mode} prominent />
              </div>
              <p className="rp-c-detail-description">{view.selected.description}</p>
              <div className="rp-c-detail-rule" />
              <EvidenceDetails game={view.selected} mode={view.mode} />
            </article>
          ) : (
            <EmptyState onReset={view.onReset} message="Select a title to inspect its evidence." />
          )}
        </section>
      </div>
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
  selected: RankedFixture | null;
  onSelect: (appid: number) => void;
  onReset: () => void;
};

export function RankingsPrototype({ variant }: { variant: RankingsPrototypeVariant }) {
  const [mode, setMode] = useState<RankingMode>("now");
  const [genre, setGenre] = useState<Genre>("All");
  const [tag, setTag] = useState<Tag>("All");
  const [selectedId, setSelectedId] = useState<number | null>(FIXTURES[0]?.appid ?? null);

  const matching = useMemo(() => FIXTURES.filter((game) => matchesFilter(game, genre, tag)), [genre, tag]);
  const derived = useMemo(() => matching.map((game) => deriveGame(game, mode, genre, tag)), [matching, mode, genre, tag]);
  const ranked = useMemo(() => derived.filter((game) => game.eligible).sort((a, b) => sortRanked(a, b, mode)), [derived, mode]);
  const excluded = useMemo(() => derived.filter((game) => game.status === "released" && !game.eligible).sort((a, b) => sortRanked(a, b, mode)), [derived, mode]);
  const earlyAccess = useMemo(() => derived.filter((game) => game.status === "earlyAccess"), [derived]);
  const candidateIds = useMemo(() => new Set(derived.map((game) => game.appid)), [derived]);
  const selected = derived.find((game) => game.appid === selectedId) ?? null;

  useEffect(() => {
    if (selectedId !== null && candidateIds.has(selectedId)) return;
    setSelectedId(ranked[0]?.appid ?? excluded[0]?.appid ?? earlyAccess[0]?.appid ?? null);
  }, [candidateIds, excluded, earlyAccess, ranked, selectedId]);

  useEffect(() => {
    console.info("[RankingsPrototype] state", {
      variant,
      mode,
      genre,
      tag,
      rankedAppIds: ranked.map((game) => game.appid),
      selectedAppId: selected?.appid ?? null,
    });
  }, [variant, mode, genre, tag, ranked, selected]);

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
      sidebar={variant === "B"}
    />
  );
  const view: View = {
    mode,
    scope,
    ranked,
    excluded,
    earlyAccess,
    selected,
    onSelect: setSelectedId,
    onReset,
  };

  return (
    <section className="rankings-prototype" data-variant={variant} data-mode={mode} data-genre={genre} data-tag={tag}>
      {variant === "A" && <VariantA view={view} controls={controls} />}
      {variant === "B" && <VariantB view={view} controls={controls} />}
      {variant === "C" && <VariantC view={view} controls={controls} />}
    </section>
  );
}
