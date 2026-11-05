import type { AppDatabase } from "./db";
import { selectWholeBuckets, type ReviewBucket, type WholeBucketSelection } from "./review-evidence";
import { reconstructPlayerScoreAt } from "./score-reconstruction";
import type { ScoreAnchor } from "./player-score";
import { wilson95 } from "./recent-reception";
import { parseScoreRecalculation } from "./reception-store";
import type {
  GameReceptionEligibility, ReceptionMetric, ReceptionEvidenceWindow,
  ReceptionPopulationReference, ReceptionGate, ReceptionEligibilityAssessment,
  ReceptionEligibilityReason,
} from "./rankings";
import {
  RECEPTION_EVALUATION_BATCH_SIZE,
  type ReceptionProjectionEvaluation, type ReceptionProjectionMonth,
} from "./reception-projection-types";

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const GLOBAL_MINIMUM = 250;
const FILTERED_MINIMUM = 50;
const COMPARISON_MONTHS = 12;
const EVALUATION_INTERVAL = 15 * 60 * 1000;
type AppStatus = { appid: number; is_early_access: boolean | null; release_status: string };

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
  formula_version: string;
  recalculation: unknown;
  current_evidence_observed_at: string | null;
  historical_evidence_observed_at: string | null;
};

interface AppEvidence {
  histogram: BucketRow[];
  histogramSource: SourceRow | null;
  summaries: SummaryRow[];
  summarySource: SourceRow | null;
  anchors: ScoreAnchor[];
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
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
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

async function loadEvidence(
  db: AppDatabase,
  appids: readonly number[],
  evaluatedAt: string,
  includeHistory: boolean,
): Promise<Map<number, AppEvidence>> {
  const evidence = new Map<number, AppEvidence>();
  for (const appid of appids) evidence.set(appid, { histogram: [], histogramSource: null, summaries: [], summarySource: null, anchors: [] });
  if (appids.length === 0) return evidence;
  const inList = placeholders(appids.length);
  const bucketResult = await db
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
  const anchorResult = !includeHistory
    ? { results: [] as Record<string, unknown>[] }
    : await db
        .prepare(
          `SELECT appid, event_id, category, start_at, observed_at, source, provenance
           FROM steam_events
           WHERE appid IN (${inList}) AND observed_at <= ? AND start_at IS NOT NULL`,
        )
        .bind(...appids, evaluatedAt)
        .all<Record<string, unknown>>();
  const summaryResult = await db
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
      granularity: raw.granularity === "monthly" ? "month" : raw.granularity === "weekly" ? "week" : "day",
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
      "SELECT p.appid, h.id, h.observed_at, h.score, h.current_evidence_intervals, h.current_window_end AS score_window_end,\n" +
      "h.formula_version, h.current_evidence_observed_at, h.historical_evidence_observed_at,\n" +
      "CASE WHEN json_valid(h.provenance) THEN json_extract(h.provenance, '$.recalculation') END AS recalculation\n" +
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
  app: AppStatus,
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
  app: AppStatus,
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

function scoreMetadata(score: Pick<ScoreRow, "observed_at" | "formula_version" | "recalculation" | "current_evidence_observed_at" | "historical_evidence_observed_at">): Pick<ReceptionMetric, "formula_version" | "recalculation" | "source_observed_at"> {
  const recalculation = parseScoreRecalculation(score.recalculation);
  return {
    formula_version: score.formula_version,
    source_observed_at: recalculation
      ? sourceTimestamp(score.current_evidence_observed_at, score.historical_evidence_observed_at)
      : score.observed_at,
    ...(recalculation ? { recalculation } : {}),
  };
}

function metricFromScore(score: ScoreRow | null): ReceptionMetric | null {
  if (!score) return null;
  const bounds = scoreEvidenceBounds(score);
  return {
    kind: "current_player_score",
    value: score.score,
    lifetime_approval: null,
    observed_at: score.observed_at,
    ...scoreMetadata(score),
    evidence_start: bounds.start,
    evidence_end: bounds.end,
  };
}

function metricFromSummary(
  summary: Pick<SummaryRow, "observed_at" | "lifetime_positive_count" | "lifetime_total_count"> | null,
): ReceptionMetric | null {
  if (!summary) return null;
  const interval = wilson95(summary.lifetime_positive_count, summary.lifetime_total_count);
  if (!interval) return null;
  return {
    kind: "lifetime_confidence",
    value: interval.lower,
    lifetime_approval: (100 * summary.lifetime_positive_count) / summary.lifetime_total_count,
    observed_at: summary.observed_at,
    source_observed_at: summary.observed_at,
    formula_version: null,
    evidence_start: null,
    evidence_end: null,
  };
}
export function getReceptionMonthCutoffs(evaluatedAt: string): string[] {
  const date = new Date(evaluationTime(evaluatedAt));
  const cutoffs: string[] = [];
  for (let monthsAgo = COMPARISON_MONTHS; monthsAgo >= 1; monthsAgo -= 1) {
    cutoffs.push(iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsAgo + 1, 1)));
  }
  return cutoffs;
}

type HistoricalScore = Omit<ScoreRow, "current_evidence_intervals"> & {
  cutoff: string;
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
      "SELECT c.cutoff, p.appid, h.id, h.observed_at, h.score, h.current_window_end AS score_window_end,\n" +
      "h.formula_version, h.current_evidence_observed_at, h.historical_evidence_observed_at,\n" +
      "CASE WHEN json_valid(h.provenance) THEN json_extract(h.provenance, '$.recalculation') END AS recalculation\n" +
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

/** Re-evaluate shortly, and immediately after any inclusive whole-window boundary. */
function nextEvaluationAt(evidence: AppEvidence, evaluatedAt: string): string {
  const now = parseUtc(evaluatedAt)!;
  let next = (Math.floor(now / EVALUATION_INTERVAL) + 1) * EVALUATION_INTERVAL;
  for (const bucket of evidence.histogram) {
    const start = parseUtc(bucket.start);
    if (start === null) continue;
    const expires = start + NINETY_DAYS + 1;
    if (expires > now) next = Math.min(next, expires);
  }
  return iso(next);
}

/** Derives compact values from at most one explicit batch; never writes observations. */
export async function evaluateReceptionProjectionBatch(
  db: AppDatabase,
  appids: readonly number[],
  evaluatedAt: string,
  options: { includeHistory?: boolean } = {},
): Promise<ReceptionProjectionEvaluation[]> {
  if (appids.length > RECEPTION_EVALUATION_BATCH_SIZE) throw new RangeError("Reception evaluation batch exceeds limit");
  if (appids.some((appid) => !validAppId(appid))) throw new RangeError("Invalid reception evaluation AppID");
  const at = evaluationTime(evaluatedAt);
  const ids = [...new Set(appids)];
  if (ids.length === 0) return [];
  const apps = await db.prepare(
    `SELECT appid, is_early_access, release_status FROM apps WHERE appid IN (${placeholders(ids.length)}) ORDER BY appid`,
  ).bind(...ids).all<{ appid: number; is_early_access: number | null; release_status: string }>();
  const rows = apps.results ?? [];
  const existingIds = rows.map((row) => row.appid);
  const [evidence, scores] = await Promise.all([
    loadEvidence(db, existingIds, at, options.includeHistory !== false),
    loadScores(db, existingIds, at),
  ]);
  const includeHistory = options.includeHistory !== false;
  const cutoffs = includeHistory ? getReceptionMonthCutoffs(at) : [];
  const sourceByApp = new Map<number, string>();
  for (const [appid, entry] of evidence) {
    if (entry.summarySource) sourceByApp.set(appid, entry.summarySource.source_id);
  }
  const [historicalScores, historicalSummaries] = await Promise.all([
    includeHistory ? loadScoreCutoffs(db, existingIds, cutoffs) : Promise.resolve(new Map<string, HistoricalScore>()),
    includeHistory ? loadSummaryCutoffs(db, sourceByApp, cutoffs) : Promise.resolve(new Map<string, HistoricalSummary>()),
  ]);
  const start = iso(parseUtc(at)! - NINETY_DAYS);
  return rows.map((row) => {
    const entry = evidence.get(row.appid)!;
    const score = latestScore(scores.get(row.appid) ?? [], at);
    const summary = latestSummary(entry.summaries, entry.summarySource, at);
    const selection = entry.histogramSource
      ? selectWholeBuckets(entry.histogram, { start, end: at }, { sourceId: entry.histogramSource.source_id, asOf: at })
      : selectWholeBuckets([], { start, end: at });
    const nowMetric = metricFromScore(score);
    const allTimeMetric = metricFromSummary(summary);
    const months: ReceptionProjectionMonth[] = [];
    for (const cutoff of cutoffs) {
      const recorded = historicalScores.get(cutoff + "|" + row.appid);
      if (recorded && Number.isFinite(recorded.score) && recorded.score >= 0 && recorded.score <= 100 && parseUtc(recorded.observed_at) !== null) {
        months.push({
          appid: row.appid, type: "top_rated_now", cutoff, metric_kind: "current_player_score",
          value: recorded.score, lifetime_approval: null, lifetime_reviews: null,
          observed_at: recorded.observed_at, ...scoreMetadata(recorded),
          score_window_end: recorded.score_window_end, provenance: "recorded",
          score_history_id: recorded.id,
        });
      } else {
        const candidate = entry.histogramSource
          ? reconstructPlayerScoreAt(entry.histogram, entry.anchors, cutoff, entry.histogramSource.source_id)
          : null;
        if (candidate && Number.isFinite(candidate.score) && candidate.score >= 0 && candidate.score <= 100 && candidate.observedAt && parseUtc(candidate.observedAt) !== null) {
          months.push({
            appid: row.appid, type: "top_rated_now", cutoff, metric_kind: "current_player_score",
            value: candidate.score, lifetime_approval: null, lifetime_reviews: null,
            observed_at: candidate.observedAt, source_observed_at: candidate.observedAt,
            formula_version: candidate.formulaVersion, score_window_end: candidate.scoreWindow?.end ?? null,
            provenance: "reconstructed", score_history_id: null,
          });
        }
      }
      const historicalSummary = historicalSummaries.get(cutoff + "|" + row.appid);
      const metric = metricFromSummary(historicalSummary ?? null);
      if (historicalSummary && metric && parseUtc(metric.observed_at) !== null) {
        months.push({
          appid: row.appid, type: "top_rated_all_time", cutoff, metric_kind: "lifetime_confidence",
          value: metric.value, lifetime_approval: metric.lifetime_approval,
          lifetime_reviews: historicalSummary.lifetime_total_count,
          observed_at: metric.observed_at, source_observed_at: metric.source_observed_at,
          formula_version: null, score_window_end: null, provenance: "lifetime_summary", score_history_id: null,
        });
      }
    }
    return {
      current: {
        appid: row.appid,
        nowScoreHistoryId: score?.id ?? null,
        now: {
          metric: nowMetric, qualifyingReviews: selectionReviewCount(selection),
          populationRef: sourceRef(entry.histogramSource),
          sourceTimestamp: sourceTimestamp(nowMetric?.source_observed_at, ...selection.observationTimes),
        },
        allTime: {
          metric: allTimeMetric, qualifyingReviews: summary?.lifetime_total_count ?? null,
          populationRef: sourceRef(entry.summarySource),
          sourceTimestamp: sourceTimestamp(allTimeMetric?.observed_at, summary?.observed_at),
        },
        nextEvaluationAt: nextEvaluationAt(entry, at),
      },
      months,
    };
  });
}

/** Preserves bounded live eligibility for individual game APIs. */
export async function evaluateLiveGameReceptionEligibility(
  db: AppDatabase,
  appid: number,
  evaluatedAt: string,
): Promise<GameReceptionEligibility | null> {
  const at = evaluationTime(evaluatedAt);
  const [projection] = await evaluateReceptionProjectionBatch(db, [appid], at, { includeHistory: false });
  if (!projection) return null;
  const status = await db.prepare("SELECT is_early_access, release_status FROM apps WHERE appid = ?")
    .bind(appid).first<{ is_early_access: number | null; release_status: string }>();
  if (!status) return null;
  const app: AppStatus = {
    appid,
    is_early_access: status.is_early_access == null ? null : Number(status.is_early_access) === 1,
    release_status: status.release_status || "released",
  };
  const { now, allTime } = projection.current;
  return {
    appid, evaluated_at: at,
    now: assessment(app, at, now.metric, now.qualifyingReviews,
      { start: iso(parseUtc(at)! - NINETY_DAYS), end: at }, now.populationRef),
    all_time: assessment(app, at, allTime.metric, allTime.qualifyingReviews,
      { start: null, end: at }, allTime.populationRef),
  };
}
