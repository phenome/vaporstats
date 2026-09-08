import type { CatalogEntity } from "./catalog";
import type { AppDatabase } from "./db";

import {
  selectWholeBuckets,
  type ReviewBucket,
  type WholeBucketSelection,
} from "./review-evidence";
import { reconstructPlayerScoreAt } from "./score-reconstruction";
import type { ScoreAnchor } from "./player-score";
import {
  normalizeReceptionFilters,
  type ReceptionFilters,
  type ReceptionRankingType,
} from "./reception-filters";

const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS = 90 * DAY_MS;
const GLOBAL_MINIMUM = 250;
const FILTERED_MINIMUM = 50;
const GLOBAL_DISPLAY_CAP = 100;
const COMPARISON_MONTHS = 12;

export type ReceptionMetricKind = "current_player_score" | "lifetime_approval";
export type ReceptionEligibilityReason =
  | "early_access"
  | "not_full_release"
  | "missing_metric"
  | "unknown_evidence"
  | "below_review_threshold";

export interface ReceptionEvidenceWindow {
  start: string | null;
  end: string | null;
}

export interface ReceptionPopulationReference {
  source_id: string;
  endpoint: "appreviews" | "appreviewhistogram";
  request_filter: string;
  population: string;
  language: string | null;
  purchase_type: string | null;
  filter_offtopic_activity: number | null;
}

export interface ReceptionGate {
  minimum_reviews: number;
  eligible: boolean;
  reasons: ReceptionEligibilityReason[];
}

export interface ReceptionEligibilityAssessment {
  evaluated_at: string;
  qualifying_reviews: number | null;
  evidence_window: ReceptionEvidenceWindow;
  population_ref: ReceptionPopulationReference | null;
  global: ReceptionGate;
  filtered: ReceptionGate;
}

export interface GameReceptionEligibility {
  appid: number;
  evaluated_at: string;
  now: ReceptionEligibilityAssessment;
  all_time: ReceptionEligibilityAssessment;
}

export interface ReceptionItemEligibility {
  qualifying_reviews: number | null;
  evidence_window: ReceptionEvidenceWindow;
  population_ref: ReceptionPopulationReference | null;
  minimum_reviews: number;
  eligible: boolean;
  reasons: ReceptionEligibilityReason[];
}

export interface ReceptionMetric {
  kind: ReceptionMetricKind;
  value: number;
  observed_at: string;
  evidence_start: string | null;
  evidence_end: string | null;
}

export interface ReceptionRankingItem {
  rank: number;
  game: CatalogEntity;
  metric: ReceptionMetric;
  eligibility: ReceptionItemEligibility;
}

export interface ReceptionRankingData {
  type: ReceptionRankingType;
  filters: ReceptionFilters;
  evaluated_at: string;
  scope: "global" | "filtered";
  minimum_reviews: number;
  eligibility_window: ReceptionEvidenceWindow;
  limit: number;
  offset: number;
  total: number;
  eligible_total: number;
  has_more: boolean;
  items: ReceptionRankingItem[];
}

export interface ReceptionRankingOptions {
  type?: ReceptionRankingType;
  filters?: Partial<ReceptionFilters> | null;
  evaluatedAt?: string | Date;
  limit?: number;
  offset?: number;
}

export interface ReceptionComparisonPoint {
  cutoff: string;
  metric_kind: ReceptionMetricKind;
  value: number;
  observed_at: string;
  score_window_end: string | null;
  provenance: "recorded" | "reconstructed" | "lifetime_summary";
  reconstructed_count: number;
  comparison_rank: number;
  compared_count: number;
}

export interface ReceptionComparisonData {
  type: ReceptionRankingType;
  filters: ReceptionFilters;
  appid: number;
  evaluated_at: string;
  population_basis: "current_eligible_group";
  eligible_total: number;
  in_current_group: boolean;
  cutoffs: string[];
  points: ReceptionComparisonPoint[];
  reconstructed_members: number;
}

export interface ReceptionComparisonOptions {
  type?: ReceptionRankingType;
  filters?: Partial<ReceptionFilters> | null;
  appid: number;
  evaluatedAt?: string | Date;
}

export interface ReceptionQueryResult<T> {
  data: T;
  sourceTimestamp: string | null;
}

type AppRow = {
  appid: number;
  name: string;
  slug: string;
  type: string;
  is_eligible: number | boolean;
  is_playable: number | boolean;
  parent_appid: number | null;
  release_date: string | null;
  steam_release_date: string | null;
  original_release_date: string | null;
  original_steam_release_date: string | null;
  release_from_early_access_date: string | null;
  release_date_source: CatalogEntity["release_date_source"];
  is_early_access: number | boolean | null;
  has_left_early_access: number | boolean | null;
  release_status: string;
  description: string | null;
  header_image: string | null;
  header_lqip: string | null;
  icon_hash: string | null;
  icon_lqip: string | null;
  developer: string | null;
  publisher: string | null;
  metacritic_score: number | null;
  metacritic_url: string | null;
  metacritic_observed_at: string | null;
  created_at: string;
  updated_at: string;
};

type SourceRow = {
  source_id: string;
  endpoint: "appreviews" | "appreviewhistogram";
  request_filter: string;
  population: string;
  language: string | null;
  purchase_type: string | null;
  filter_offtopic_activity: number | null;
};

type BucketRow = ReviewBucket & { appid: number; source: SourceRow; };

type SummaryRow = {
  appid: number;
  source_id: string;
  observed_at: string;
  lifetime_positive_count: number;
  lifetime_total_count: number;
  source: SourceRow;
};

type ScoreRow = {
  id: number;
  appid: number;
  observed_at: string;
  score: number;
  current_evidence_intervals: string;
  score_window_end: string;
};

interface AppEvidence {
  histogram: BucketRow[];
  histogramSource: SourceRow | null;
  summaries: SummaryRow[];
  summarySource: SourceRow | null;
  anchors: ScoreAnchor[];
}

interface EvaluatedApp {
  app: CatalogEntity;
  score: ScoreRow | null;
  summary: SummaryRow | null;
  nowSelection: WholeBucketSelection;
  nowQualifyingReviews: number | null;
  allTimeQualifyingReviews: number | null;
  nowMetric: ReceptionMetric | null;
  allTimeMetric: ReceptionMetric | null;
  nowAssessment: ReceptionEligibilityAssessment;
  allTimeAssessment: ReceptionEligibilityAssessment;
  sourceTimestamp: string | null;
  evidence: AppEvidence;
}

function parseUtc(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value !== "string" || !/Z$/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function evaluationTime(value: string | Date | undefined): string {
  const parsed = parseUtc(value ?? new Date());
  if (parsed === null) throw new RangeError("Invalid reception evaluation time");
  return iso(parsed);
}

function validAppId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeOptionsFilters(options: { filters?: Partial<ReceptionFilters> | null }): ReceptionFilters {
  return normalizeReceptionFilters(options.filters);
}

function normalizeType(type: ReceptionRankingType | undefined): ReceptionRankingType {
  if (type === undefined) return "top_rated_now";
  if (type !== "top_rated_now" && type !== "top_rated_all_time") {
    throw new RangeError("Invalid reception ranking type");
  }
  return type;
}

function evidenceMode(type: ReceptionRankingType): EvidenceMode {
  return type === "top_rated_now" ? "now" : "all_time";
}

function pagination(options: ReceptionRankingOptions): { limit: number; offset: number } {
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Invalid reception ranking limit");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Invalid reception ranking offset");
  }
  return { limit, offset };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function appWhere(filters: ReceptionFilters): { sql: string; values: unknown[] } {
  const clauses = [
    "a.is_eligible = 1",
    "a.is_playable = 1",
    "a.parent_appid IS NULL",
    "a.release_status = 'released'",
    "(a.is_early_access IS NULL OR a.is_early_access = 0)",
  ];
  const values: unknown[] = [];
  const groups: [keyof ReceptionFilters, string][] = [
    ["genres", "genre"],
    ["features", "feature"],
    ["tags", "community_tag"],
  ];
  for (const [key, group] of groups) {
    const ids = filters[key];
    if (ids.length === 0) continue;
    clauses.push(
      `EXISTS (SELECT 1 FROM app_facet_memberships f${group.replace("_", "")} WHERE f${group.replace("_", "")}.appid = a.appid AND f${group.replace("_", "")}.facet_group = ? AND f${group.replace("_", "")}.source_id IN (${placeholders(ids.length)}))`,
    );
    values.push(group, ...ids.map(String));
  }
  return { sql: clauses.join(" AND "), values };
}

async function loadApps(db: AppDatabase, filters: ReceptionFilters): Promise<AppRow[]> {
  const where = appWhere(filters);
  const result = await db
    .prepare(`SELECT a.* FROM apps a WHERE ${where.sql} ORDER BY a.appid ASC`)
    .bind(...where.values)
    .all<AppRow>();
  return result.results ?? [];
}

async function loadApp(db: AppDatabase, appid: number): Promise<AppRow | null> {
  return db.prepare("SELECT * FROM apps WHERE appid = ?").bind(appid).first<AppRow>();
}

function appToGame(row: AppRow): CatalogEntity {
  return {
    appid: row.appid,
    name: row.name,
    slug: row.slug,
    type: row.type,
    is_eligible: Number(row.is_eligible) === 1,
    is_playable: Number(row.is_playable) === 1,
    parent_appid: row.parent_appid ?? null,
    release_date: row.release_date ?? null,
    steam_release_date: row.steam_release_date ?? null,
    original_release_date: row.original_release_date ?? null,
    original_steam_release_date: row.original_steam_release_date ?? null,
    release_from_early_access_date: row.release_from_early_access_date ?? null,
    release_date_source: row.release_date_source ?? null,
    is_early_access: row.is_early_access == null ? null : Number(row.is_early_access) === 1,
    has_left_early_access: row.has_left_early_access == null ? null : Number(row.has_left_early_access) === 1,
    release_status: (row.release_status || "released") as CatalogEntity["release_status"],
    description: row.description ?? "",
    header_image: row.header_image ?? "",
    header_lqip: row.header_lqip ?? null,
    icon_hash: row.icon_hash ?? null,
    icon_lqip: row.icon_lqip ?? null,
    developer: row.developer ?? "",
    publisher: row.publisher ?? "",
    metacritic_score: row.metacritic_score ?? null,
    metacritic_url: row.metacritic_url ?? null,
    metacritic_observed_at: row.metacritic_observed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sourceRef(source: SourceRow | null): ReceptionPopulationReference | null {
  if (!source) return null;
  return {
    source_id: source.source_id,
    endpoint: source.endpoint,
    request_filter: source.request_filter,
    population: source.population,
    language: source.language,
    purchase_type: source.purchase_type,
    filter_offtopic_activity: source.filter_offtopic_activity,
  };
}

function sourceCompatible(source: SourceRow, type: "histogram" | "summary"): boolean {
  if (type === "histogram") return source.endpoint === "appreviewhistogram";
  return source.endpoint === "appreviews" &&
    source.language === "all" &&
    source.purchase_type === "all" &&
    source.filter_offtopic_activity === 1 &&
    /(?:^|&)filter=all(?:&|$)/.test(source.request_filter);
}

function chooseSource<T extends { source: SourceRow; observed_at?: string | null; observedAt?: string | null }>(
  values: readonly T[],
  type: "histogram" | "summary",
  evaluatedAt: string,
): SourceRow | null {
  const evaluatedAtMs = parseUtc(evaluatedAt)!;
  const newestBySource = new Map<string, { source: SourceRow; observed: number }>();
  for (const value of values) {
    if (!sourceCompatible(value.source, type)) continue;
    const observed = parseUtc(value.observed_at ?? value.observedAt);
    if (observed === null || observed > evaluatedAtMs) continue;
    const prior = newestBySource.get(value.source.source_id);
    if (!prior || observed > prior.observed) newestBySource.set(value.source.source_id, { source: value.source, observed });
  }
  const candidates = [...newestBySource.values()];
  if (candidates.length === 0) return null;
  const newest = Math.max(...candidates.map((candidate) => candidate.observed));
  const tied = candidates.filter((candidate) => candidate.observed === newest);
  return tied.length === 1 ? tied[0]!.source : null;
}

type EvidenceMode = "now" | "all_time" | "both";

async function loadEvidence(
  db: AppDatabase,
  appids: readonly number[],
  evaluatedAt: string,
  mode: EvidenceMode,
): Promise<Map<number, AppEvidence>> {
  const evidence = new Map<number, AppEvidence>();
  for (const appid of appids) evidence.set(appid, { histogram: [], histogramSource: null, summaries: [], summarySource: null, anchors: [] });
  if (appids.length === 0) return evidence;
  const inList = placeholders(appids.length);
  const bucketResult = mode === "all_time"
    ? { results: [] as Record<string, unknown>[] }
    : await db
        .prepare(
          `SELECT b.appid, b.source_id, b.granularity, b.period_start, b.period_end,
                  b.positive_count, b.negative_count, b.observed_at,
                  s.id AS joined_source_id, s.endpoint AS source_endpoint,
                  s.request_filter AS source_request_filter, s.population AS source_population,
                  s.language AS source_language, s.purchase_type AS source_purchase_type,
                  s.filter_offtopic_activity AS source_filter_offtopic_activity
           FROM review_buckets b
           JOIN review_sources s ON s.id = b.source_id
           WHERE b.appid IN (${inList})
             AND b.period_end <= ? AND b.observed_at <= ?
             AND s.endpoint = 'appreviewhistogram'`,
        )
        .bind(...appids, evaluatedAt, evaluatedAt)
        .all<Record<string, unknown>>();
  const anchorResult = mode === "all_time"
    ? { results: [] as Record<string, unknown>[] }
    : await db
        .prepare(
          `SELECT appid, event_id, category, start_at, observed_at, source, provenance
           FROM steam_events
           WHERE appid IN (${inList}) AND observed_at <= ? AND start_at IS NOT NULL`,
        )
        .bind(...appids, evaluatedAt)
        .all<Record<string, unknown>>();
  const summaryResult = mode === "now"
    ? { results: [] as Record<string, unknown>[] }
    : await db
        .prepare(
          `SELECT r.appid, r.source_id, r.observed_at,
                  r.lifetime_positive_count, r.lifetime_total_count,
                  s.id AS joined_source_id, s.endpoint AS source_endpoint,
                  s.request_filter AS source_request_filter, s.population AS source_population,
                  s.language AS source_language, s.purchase_type AS source_purchase_type,
                  s.filter_offtopic_activity AS source_filter_offtopic_activity
           FROM review_summary_snapshots r
           JOIN review_sources s ON s.id = r.source_id
           WHERE r.appid IN (${inList})
             AND r.observed_at <= ? AND s.endpoint = 'appreviews'
             AND NOT EXISTS (
               SELECT 1 FROM review_summary_snapshots newer
               WHERE newer.appid = r.appid AND newer.source_id = r.source_id
                 AND newer.observed_at <= ? AND newer.observed_at > r.observed_at
             )`,
        )
        .bind(...appids, evaluatedAt, evaluatedAt)
        .all<Record<string, unknown>>();
  for (const raw of bucketResult.results ?? []) {
    const appid = Number(raw.appid);
    const source = {
      source_id: String(raw.joined_source_id ?? raw.source_id),
      endpoint: String(raw.source_endpoint) as SourceRow["endpoint"],
      request_filter: String(raw.source_request_filter ?? ""),
      population: String(raw.source_population ?? "unknown"),
      language: (raw.source_language as string | null) ?? null,
      purchase_type: (raw.source_purchase_type as string | null) ?? null,
      filter_offtopic_activity: raw.source_filter_offtopic_activity == null ? null : Number(raw.source_filter_offtopic_activity),
    } satisfies SourceRow;
    const row: BucketRow = { source, appid,
      sourceId: source.source_id,
      granularity: raw.granularity === "monthly" ? "month" : "day",
      start: String(raw.period_start),
      end: String(raw.period_end),
      positiveReviews: Number.isSafeInteger(raw.positive_count) ? Number(raw.positive_count) : null,
      negativeReviews: Number.isSafeInteger(raw.negative_count) ? Number(raw.negative_count) : null,
      observedAt: raw.observed_at == null ? null : String(raw.observed_at),
      complete: true,
    };
    evidence.get(appid)?.histogram.push(row);
  }
  for (const raw of anchorResult.results ?? []) {
    const appid = Number(raw.appid);
    const category = String(raw.category ?? "");
    let rawCategory: unknown = null;
    try {
      const parsed = JSON.parse(String(raw.provenance ?? "{}"));
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as { rawCategory?: unknown };
        rawCategory = record.rawCategory;
      }
    } catch {
      rawCategory = null;
    }
    if (category !== "major_update" && category !== "14" && rawCategory !== 14 && rawCategory !== "14") continue;
    const start = parseUtc(typeof raw.start_at === "string" ? raw.start_at : null);
    if (start === null) continue;
    const entry = evidence.get(appid);
    if (entry) entry.anchors.push({ category: 14, start: iso(start), eventId: String(raw.event_id), sourceId: String(raw.source ?? "") });
  }
  for (const raw of summaryResult.results ?? []) {
    const appid = Number(raw.appid);
    const source = {
      source_id: String(raw.joined_source_id ?? raw.source_id),
      endpoint: String(raw.source_endpoint) as SourceRow["endpoint"],
      request_filter: String(raw.source_request_filter ?? ""),
      population: String(raw.source_population ?? "unknown"),
      language: (raw.source_language as string | null) ?? null,
      purchase_type: (raw.source_purchase_type as string | null) ?? null,
      filter_offtopic_activity: raw.source_filter_offtopic_activity == null ? null : Number(raw.source_filter_offtopic_activity),
    } satisfies SourceRow;
    const row: SummaryRow = {
      appid,
      source_id: source.source_id,
      observed_at: String(raw.observed_at),
      lifetime_positive_count: Number(raw.lifetime_positive_count),
      lifetime_total_count: Number(raw.lifetime_total_count),
      source,
    };
    evidence.get(appid)?.summaries.push(row);
  }
  for (const entry of evidence.values()) {
    entry.histogramSource = chooseSource(entry.histogram, "histogram", evaluatedAt);
    entry.summarySource = chooseSource(entry.summaries, "summary", evaluatedAt);
  }
  return evidence;
}

async function loadScores(
  db: AppDatabase,
  appids: readonly number[],
  evaluatedAt: string,
): Promise<Map<number, ScoreRow[]>> {
  const scores = new Map<number, ScoreRow[]>();
  for (const appid of appids) scores.set(appid, []);
  if (appids.length === 0) return scores;
  const result = await db
    .prepare(
      "WITH appids(appid) AS (VALUES " + appids.map(() => "(?)").join(",") + ")\n" +
      "SELECT p.appid, h.id, h.observed_at, h.score, h.current_evidence_intervals, h.current_window_end AS score_window_end\n" +
      "FROM appids p JOIN player_score_history h ON h.id = (\n" +
      "  SELECT candidate.id FROM player_score_history candidate\n" +
      "  WHERE candidate.appid = p.appid AND candidate.observed_at <= ?\n" +
      "  ORDER BY candidate.observed_at DESC, candidate.id DESC LIMIT 1\n" +
      ")",
    )
    .bind(...appids, evaluatedAt)
    .all<ScoreRow>();
  for (const row of result.results ?? []) scores.get(row.appid)?.push(row);
  return scores;
}

function latestScore(rows: readonly ScoreRow[], evaluatedAt: string): ScoreRow | null {
  const evaluatedAtMs = parseUtc(evaluatedAt)!;
  return rows
    .filter((row) => parseUtc(row.observed_at) !== null && parseUtc(row.observed_at)! <= evaluatedAtMs)
    .filter((row) => Number.isFinite(row.score) && row.score >= 0 && row.score <= 100)
    .sort((left, right) => (parseUtc(right.observed_at)! - parseUtc(left.observed_at)!) || right.id - left.id)[0] ?? null;
}

function latestSummary(rows: readonly SummaryRow[], source: SourceRow | null, evaluatedAt: string): SummaryRow | null {
  if (!source) return null;
  const evaluatedAtMs = parseUtc(evaluatedAt)!;
  return rows
    .filter((row) => row.source_id === source.source_id)
    .filter((row) => parseUtc(row.observed_at) !== null && parseUtc(row.observed_at)! <= evaluatedAtMs)
    .filter((row) => Number.isSafeInteger(row.lifetime_positive_count) && Number.isSafeInteger(row.lifetime_total_count))
    .filter((row) => row.lifetime_total_count >= 0 && row.lifetime_positive_count >= 0 && row.lifetime_positive_count <= row.lifetime_total_count)
    .sort((left, right) => (parseUtc(right.observed_at)! - parseUtc(left.observed_at)!))[0] ?? null;
}

function sourceTimestamp(...values: readonly (string | null | undefined)[]): string | null {
  let newest: number | null = null;
  for (const value of values) {
    const time = parseUtc(value);
    if (time !== null && (newest === null || time > newest)) newest = time;
  }
  return newest === null ? null : iso(newest);
}

function selectionReviewCount(selection: WholeBucketSelection): number | null {
  if (selection.selectedIntervals.length === 0 || selection.countOverflow) return null;
  if (!selection.countsComplete && selection.knownTotalReviews === 0) return null;
  return selection.knownTotalReviews;
}

function gate(
  app: CatalogEntity,
  metric: ReceptionMetric | null,
  qualifyingReviews: number | null,
  minimumReviews: number,
): ReceptionGate {
  const reasons: ReceptionEligibilityReason[] = [];
  if (app.is_early_access === true) reasons.push("early_access");
  if (app.release_status !== "released") reasons.push("not_full_release");
  if (metric === null) reasons.push("missing_metric");
  if (qualifyingReviews === null) reasons.push("unknown_evidence");
  else if (qualifyingReviews < minimumReviews) reasons.push("below_review_threshold");
  return { minimum_reviews: minimumReviews, eligible: reasons.length === 0, reasons };
}

function assessment(
  app: CatalogEntity,
  evaluatedAt: string,
  metric: ReceptionMetric | null,
  qualifyingReviews: number | null,
  evidenceWindow: ReceptionEvidenceWindow,
  population: SourceRow | null,
): ReceptionEligibilityAssessment {
  return {
    evaluated_at: evaluatedAt,
    qualifying_reviews: qualifyingReviews,
    evidence_window: evidenceWindow,
    population_ref: sourceRef(population),
    global: gate(app, metric, qualifyingReviews, GLOBAL_MINIMUM),
    filtered: gate(app, metric, qualifyingReviews, FILTERED_MINIMUM),
  };
}

function scoreEvidenceBounds(score: ScoreRow): ReceptionEvidenceWindow {
  let decoded: unknown;
  try {
    decoded = JSON.parse(score.current_evidence_intervals);
  } catch {
    return { start: null, end: null };
  }
  if (!Array.isArray(decoded)) return { start: null, end: null };
  let start: number | null = null;
  let end: number | null = null;
  for (const value of decoded) {
    if (typeof value !== "object" || value === null) continue;
    const interval = value as { start?: unknown; end?: unknown };
    const intervalStart = parseUtc(typeof interval.start === "string" ? interval.start : null);
    const intervalEnd = parseUtc(typeof interval.end === "string" ? interval.end : null);
    if (intervalStart === null || intervalEnd === null || intervalStart >= intervalEnd) continue;
    start = start === null ? intervalStart : Math.min(start, intervalStart);
    end = end === null ? intervalEnd : Math.max(end, intervalEnd);
  }
  return { start: start === null ? null : iso(start), end: end === null ? null : iso(end) };
}

function metricFromScore(score: ScoreRow | null): ReceptionMetric | null {
  if (!score) return null;
  const bounds = scoreEvidenceBounds(score);
  return {
    kind: "current_player_score",
    value: score.score,
    observed_at: score.observed_at,
    evidence_start: bounds.start,
    evidence_end: bounds.end,
  };
}

function metricFromSummary(summary: SummaryRow | null): ReceptionMetric | null {
  if (!summary || summary.lifetime_total_count <= 0) return null;
  return {
    kind: "lifetime_approval",
    value: (100 * summary.lifetime_positive_count) / summary.lifetime_total_count,
    observed_at: summary.observed_at,
    evidence_start: null,
    evidence_end: null,
  };
}

async function evaluateApps(
  db: AppDatabase,
  rows: readonly AppRow[],
  mode: EvidenceMode,
  evaluatedAt: string,
): Promise<EvaluatedApp[]> {
  const appids = rows.map((row) => row.appid);
  const [evidence, scores] = await Promise.all([
    loadEvidence(db, appids, evaluatedAt, mode),
    mode === "all_time" ? Promise.resolve(new Map<number, ScoreRow[]>()) : loadScores(db, appids, evaluatedAt),
  ]);
  const evaluatedAtMs = parseUtc(evaluatedAt)!;
  const nowStart = iso(evaluatedAtMs - NINETY_DAYS);
  return rows.map((row) => {
    const app = appToGame(row);
    const appEvidence = evidence.get(row.appid)!;
    const score = latestScore(scores.get(row.appid) ?? [], evaluatedAt);
    const summary = latestSummary(appEvidence.summaries, appEvidence.summarySource, evaluatedAt);
    const nowSelection = appEvidence.histogramSource
      ? selectWholeBuckets(appEvidence.histogram, { start: nowStart, end: evaluatedAt }, {
          sourceId: appEvidence.histogramSource.source_id,
          asOf: evaluatedAt,
        })
      : selectWholeBuckets([], { start: nowStart, end: evaluatedAt });
    const nowQualifyingReviews = selectionReviewCount(nowSelection);
    const allTimeQualifyingReviews = summary?.lifetime_total_count ?? null;
    const nowMetric = metricFromScore(score);
    const allTimeMetric = metricFromSummary(summary);
    const nowAssessment = assessment(app, evaluatedAt, nowMetric, nowQualifyingReviews, { start: nowStart, end: evaluatedAt }, appEvidence.histogramSource);
    const allTimeAssessment = assessment(app, evaluatedAt, allTimeMetric, allTimeQualifyingReviews, { start: null, end: evaluatedAt }, appEvidence.summarySource);
    const sourceTimes: (string | null | undefined)[] = [];
    if (mode !== "all_time") sourceTimes.push(nowMetric?.observed_at, ...nowSelection.observationTimes);
    if (mode !== "now") sourceTimes.push(allTimeMetric?.observed_at, ...(summary ? [summary.observed_at] : []));
    return {
      app,
      score,
      summary,
      nowSelection,
      nowQualifyingReviews,
      allTimeQualifyingReviews,
      nowMetric,
      allTimeMetric,
      nowAssessment,
      allTimeAssessment,
      sourceTimestamp: sourceTimestamp(...sourceTimes),
      evidence: appEvidence,
    };
  });
}

function selectedMetric(app: EvaluatedApp, type: ReceptionRankingType): ReceptionMetric | null {
  return type === "top_rated_now" ? app.nowMetric : app.allTimeMetric;
}

function selectedAssessment(app: EvaluatedApp, type: ReceptionRankingType, minimum: number): ReceptionItemEligibility {
  const assessmentValue = type === "top_rated_now" ? app.nowAssessment : app.allTimeAssessment;
  const selected = minimum === GLOBAL_MINIMUM ? assessmentValue.global : assessmentValue.filtered;
  return {
    qualifying_reviews: assessmentValue.qualifying_reviews,
    evidence_window: assessmentValue.evidence_window,
    population_ref: assessmentValue.population_ref,
    minimum_reviews: selected.minimum_reviews,
    eligible: selected.eligible,
    reasons: [...selected.reasons],
  };
}

function sortEvaluated(left: EvaluatedApp, right: EvaluatedApp, type: ReceptionRankingType): number {
  const leftMetric = selectedMetric(left, type)!;
  const rightMetric = selectedMetric(right, type)!;
  if (rightMetric.value !== leftMetric.value) return rightMetric.value - leftMetric.value;
  const leftCount = type === "top_rated_now" ? left.nowQualifyingReviews! : left.allTimeQualifyingReviews!;
  const rightCount = type === "top_rated_now" ? right.nowQualifyingReviews! : right.allTimeQualifyingReviews!;
  return rightCount - leftCount || left.app.appid - right.app.appid;
}

function eligibleApps(evaluated: readonly EvaluatedApp[], type: ReceptionRankingType, minimum: number): EvaluatedApp[] {
  return evaluated.filter((app) => {
    const assessmentValue = type === "top_rated_now" ? app.nowAssessment : app.allTimeAssessment;
    return (minimum === GLOBAL_MINIMUM ? assessmentValue.global : assessmentValue.filtered).eligible;
  }).sort((left, right) => sortEvaluated(left, right, type));
}

function maxTimestamp(values: readonly (string | null)[]): string | null {
  return sourceTimestamp(...values);
}

/** Returns a current Top Rated Now or Top Rated All Time ranking. */
export async function getReceptionRankings(
  db: AppDatabase,
  options: ReceptionRankingOptions = {},
): Promise<ReceptionQueryResult<ReceptionRankingData>> {
  const type = normalizeType(options.type);
  const filters = normalizeOptionsFilters(options);
  const { limit, offset } = pagination(options);
  const evaluatedAt = evaluationTime(options.evaluatedAt);
  const scope = filters.genres.length || filters.features.length || filters.tags.length ? "filtered" : "global";
  const minimumReviews = scope === "global" ? GLOBAL_MINIMUM : FILTERED_MINIMUM;
  const rows = await loadApps(db, filters);
  const evaluated = await evaluateApps(db, rows, evidenceMode(type), evaluatedAt);
  const eligible = eligibleApps(evaluated, type, minimumReviews);
  const total = scope === "global" ? Math.min(GLOBAL_DISPLAY_CAP, eligible.length) : eligible.length;
  const page = eligible.slice(offset, Math.min(offset + limit, total));
  const items = page.map((app, index) => {
    const rank = offset + index + 1;
    return {
      rank,
      game: app.app,
      metric: selectedMetric(app, type)!,
      eligibility: selectedAssessment(app, type, minimumReviews),
    };
  });
  const data: ReceptionRankingData = {
    type,
    filters,
    evaluated_at: evaluatedAt,
    scope,
    minimum_reviews: minimumReviews,
    eligibility_window: type === "top_rated_now"
      ? { start: iso(parseUtc(evaluatedAt)! - NINETY_DAYS), end: evaluatedAt }
      : { start: null, end: evaluatedAt },
    limit,
    offset,
    total,
    eligible_total: eligible.length,
    has_more: offset + items.length < total,
    items,
  };
  return {
    data,
    sourceTimestamp: maxTimestamp(evaluated.map((item) => item.sourceTimestamp)),
  };
}

function monthCutoffs(evaluatedAt: string): string[] {
  const date = new Date(parseUtc(evaluatedAt)!);
  const cutoffs: string[] = [];
  for (let monthsAgo = COMPARISON_MONTHS; monthsAgo >= 1; monthsAgo -= 1) {
    cutoffs.push(iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsAgo + 1, 1)));
  }
  return cutoffs;
}

type HistoricalScore = {
  cutoff: string;
  appid: number;
  observed_at: string;
  score: number;
  score_window_end: string | null;
};
type HistoricalSummary = {
  cutoff: string;
  appid: number;
  source_id: string;
  observed_at: string;
  lifetime_positive_count: number;
  lifetime_total_count: number;
};

async function loadScoreCutoffs(
  db: AppDatabase,
  appids: readonly number[],
  cutoffs: readonly string[],
): Promise<Map<string, HistoricalScore>> {
  const result = new Map<string, HistoricalScore>();
  if (appids.length === 0 || cutoffs.length === 0) return result;
  const rows = await db
    .prepare(
      "WITH cutoffs(cutoff) AS (VALUES " + cutoffs.map(() => "(?)").join(",") + "), appids(appid) AS (VALUES " + appids.map(() => "(?)").join(",") + ")\n" +
      "SELECT c.cutoff, p.appid, h.observed_at, h.score, h.current_window_end AS score_window_end\n" +
      "FROM cutoffs c CROSS JOIN appids p\n" +
      "JOIN player_score_history h ON h.id = (\n" +
      "  SELECT candidate.id FROM player_score_history candidate\n" +
      "  WHERE candidate.appid = p.appid AND candidate.observed_at < c.cutoff\n" +
      "  ORDER BY candidate.observed_at DESC, candidate.id DESC LIMIT 1\n" +
      ")",
    )
    .bind(...cutoffs, ...appids)
    .all<HistoricalScore>();
  for (const row of rows.results ?? []) result.set(row.cutoff + "|" + row.appid, row);
  return result;
}

async function loadSummaryCutoffs(
  db: AppDatabase,
  sourceByApp: ReadonlyMap<number, string>,
  cutoffs: readonly string[],
): Promise<Map<string, HistoricalSummary>> {
  const result = new Map<string, HistoricalSummary>();
  if (sourceByApp.size === 0 || cutoffs.length === 0) return result;
  const pairs = [...sourceByApp.entries()];
  const rows = await db
    .prepare(
      "WITH cutoffs(cutoff) AS (VALUES " + cutoffs.map(() => "(?)").join(",") + "), pairs(appid, source_id) AS (VALUES " + pairs.map(() => "(?, ?)").join(",") + ")\n" +
      "SELECT c.cutoff, p.appid, p.source_id, h.observed_at, h.lifetime_positive_count, h.lifetime_total_count\n" +
      "FROM cutoffs c CROSS JOIN pairs p\n" +
      "JOIN review_summary_snapshots h ON h.appid = p.appid AND h.source_id = p.source_id AND h.observed_at = (\n" +
      "  SELECT candidate.observed_at FROM review_summary_snapshots candidate\n" +
      "  WHERE candidate.appid = p.appid AND candidate.source_id = p.source_id AND candidate.observed_at < c.cutoff\n" +
      "  ORDER BY candidate.observed_at DESC LIMIT 1\n" +
      ")",
    )
    .bind(...cutoffs, ...pairs.flat())
    .all<HistoricalSummary>();
  for (const row of rows.results ?? []) result.set(row.cutoff + "|" + row.appid, row);
  return result;
}

/** Returns a lazy twelve-month score comparison for one selected game. */
export async function getReceptionComparison(
  db: AppDatabase,
  options: ReceptionComparisonOptions,
): Promise<ReceptionQueryResult<ReceptionComparisonData | null>> {
  if (!validAppId(options.appid)) throw new RangeError("Invalid reception comparison AppID");
  const type = normalizeType(options.type);
  const filters = normalizeOptionsFilters(options);
  const evaluatedAt = evaluationTime(options.evaluatedAt);
  const target = await loadApp(db, options.appid);
  if (!target) return { data: null, sourceTimestamp: null };
  const scope = filters.genres.length || filters.features.length || filters.tags.length ? "filtered" : "global";
  const minimumReviews = scope === "global" ? GLOBAL_MINIMUM : FILTERED_MINIMUM;
  const rows = await loadApps(db, filters);
  const evaluated = await evaluateApps(db, rows, evidenceMode(type), evaluatedAt);
  const eligible = eligibleApps(evaluated, type, minimumReviews);
  const targetInGroup = eligible.some((item) => item.app.appid === options.appid);
  const cutoffs = monthCutoffs(evaluatedAt);
  const points: ReceptionComparisonPoint[] = [];
  const reconstructedMembers = new Set<number>();
  let comparisonTimestamp: string | null = null;
  if (targetInGroup) {
    const appids = eligible.map((item) => item.app.appid);
    const qualifyingCountByApp = new Map<number, number>(
      eligible.map((item) => [
        item.app.appid,
        type === "top_rated_now" ? item.nowQualifyingReviews! : item.allTimeQualifyingReviews!,
      ]),
    );
    const scoreMap = new Map<string, HistoricalScore>();
    const summaryMap = new Map<string, HistoricalSummary>();
    if (type === "top_rated_now") {
      for (const [key, row] of await loadScoreCutoffs(db, appids, cutoffs)) scoreMap.set(key, row);
    } else {
      const sourceByApp = new Map<number, string>();
      for (const item of eligible) {
        const sourceId = item.allTimeAssessment.population_ref?.source_id;
        if (sourceId) sourceByApp.set(item.app.appid, sourceId);
      }
      for (const [key, row] of await loadSummaryCutoffs(db, sourceByApp, cutoffs)) summaryMap.set(key, row);
    }
    for (const cutoff of cutoffs) {
      type HistoricalValue = {
        appid: number;
        value: number;
        observed_at: string;
        score_window_end: string | null;
        provenance: "recorded" | "reconstructed" | "lifetime_summary";
      };
      const historical: HistoricalValue[] = [];
      for (const item of eligible) {
        const appid = item.app.appid;
        if (type === "top_rated_now") {
          const score = scoreMap.get(cutoff + "|" + appid);
          if (score && Number.isFinite(score.score) && score.score >= 0 && score.score <= 100 && parseUtc(score.observed_at) !== null) {
            historical.push({ appid, value: score.score, observed_at: score.observed_at, score_window_end: score.score_window_end, provenance: "recorded" });
            continue;
          }
          const sourceId = item.nowAssessment.population_ref?.source_id;
          const candidate = sourceId
            ? reconstructPlayerScoreAt(item.evidence.histogram, item.evidence.anchors, cutoff, sourceId)
            : null;
          if (candidate && Number.isFinite(candidate.score) && candidate.score >= 0 && candidate.score <= 100 && candidate.observedAt && parseUtc(candidate.observedAt) !== null) {
            reconstructedMembers.add(appid);
            historical.push({
              appid,
              value: candidate.score,
              observed_at: candidate.observedAt,
              score_window_end: candidate.scoreWindow?.end ?? null,
              provenance: "reconstructed",
            });
          }
        } else {
          const summary = summaryMap.get(cutoff + "|" + appid);
          if (summary && summary.lifetime_total_count > 0 && summary.lifetime_positive_count >= 0 && summary.lifetime_positive_count <= summary.lifetime_total_count && parseUtc(summary.observed_at) !== null) {
            historical.push({
              appid,
              value: 100 * summary.lifetime_positive_count / summary.lifetime_total_count,
              observed_at: summary.observed_at,
              score_window_end: null,
              provenance: "lifetime_summary",
            });
          }
        }
      }
      historical.sort((left, right) => right.value - left.value || qualifyingCountByApp.get(right.appid)! - qualifyingCountByApp.get(left.appid)! || left.appid - right.appid);
      const reconstructedCount = historical.filter((item) => item.provenance === "reconstructed").length;
      for (const item of historical) comparisonTimestamp = sourceTimestamp(comparisonTimestamp, item.observed_at);
      const targetPoint = historical.findIndex((item) => item.appid === options.appid);
      if (targetPoint >= 0) {
        const value = historical[targetPoint]!;
        points.push({
          cutoff,
          metric_kind: type === "top_rated_now" ? "current_player_score" : "lifetime_approval",
          value: value.value,
          observed_at: value.observed_at,
          score_window_end: value.score_window_end,
          provenance: value.provenance,
          reconstructed_count: reconstructedCount,
          comparison_rank: targetPoint + 1,
          compared_count: historical.length,
        });
      }
    }
  }
  const data: ReceptionComparisonData = {
    type,
    filters,
    appid: options.appid,
    evaluated_at: evaluatedAt,
    population_basis: "current_eligible_group",
    eligible_total: eligible.length,
    in_current_group: targetInGroup,
    cutoffs,
    points,
    reconstructed_members: reconstructedMembers.size,
  };
  return {
    data,
    sourceTimestamp: maxTimestamp([
      comparisonTimestamp,
      ...evaluated.map((item) => item.sourceTimestamp),
    ]),
  };
}

/** Returns the reusable current Now and All Time eligibility assessments. */
export async function getGameReceptionEligibility(
  db: AppDatabase,
  appid: number,
  evaluatedAt?: string | Date,
): Promise<GameReceptionEligibility | null> {
  if (!validAppId(appid)) throw new RangeError("Invalid reception eligibility AppID");
  const at = evaluationTime(evaluatedAt);
  const row = await loadApp(db, appid);
  if (!row) return null;
  const evaluated = await evaluateApps(db, [row], "both", at);
  const app = evaluated[0]!;
  return {
    appid,
    evaluated_at: at,
    now: app.nowAssessment,
    all_time: app.allTimeAssessment,
  };
}
