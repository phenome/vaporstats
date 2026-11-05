import type { CatalogEntity } from "./catalog";
import type { AppDatabase } from "./db";

import type { ScoreFormulaRecalculation } from "./reception-store";
import { evaluateLiveGameReceptionEligibility, getReceptionMonthCutoffs } from "./reception-evaluation";
import { RECEPTION_PROJECTION_VERSION } from "./reception-projection-types";
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

export type ReceptionMetricKind = "current_player_score" | "lifetime_confidence";
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
  lifetime_approval: number | null;
  observed_at: string;
  source_observed_at: string | null;
  formula_version: string | null;
  recalculation?: ScoreFormulaRecalculation;
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
  lifetime_approval: number | null;
  lifetime_reviews: number | null;
  observed_at: string;
  source_observed_at: string | null;
  formula_version: string | null;
  recalculation?: ScoreFormulaRecalculation;
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

export class ReceptionPublicationUnavailableError extends Error {
  constructor() {
    super("Reception publication unavailable");
    this.name = "ReceptionPublicationUnavailableError";
  }
}

type PublicationRow = { evaluated_at: string };
type ScopeStats = { eligible_total: number; source_timestamp: string | null };
type RankingRow = AppRow & {
  metric_json: string;
  population_json: string | null;
  qualifying_reviews: number;
};
type MonthRow = Omit<ReceptionComparisonPoint, "recalculation"> & {
  recalculation_json: string | null;
};

// Every statement resolves the pointer inside the same read transaction. The
// previous build may be cleaned up immediately after publication without mixing
// its metadata, cohort or page with those of the next build.
const ACTIVE_PUBLICATION = `active AS (
  SELECT b.id, b.evaluated_at
  FROM reception_publication_state s
  JOIN reception_publication_builds b ON b.id = s.published_build_id
  WHERE s.id = 1 AND b.status = 'published'
    AND b.projection_version = ${RECEPTION_PROJECTION_VERSION}
)`;
const PUBLICATION_METADATA = `WITH ${ACTIVE_PUBLICATION} SELECT evaluated_at FROM active`;

function publishedAt(result: { results?: unknown[] }): string {
  const row = result.results?.[0] as PublicationRow | undefined;
  if (!row) throw new ReceptionPublicationUnavailableError();
  return row.evaluated_at;
}

function scopeQuery(filters: ReceptionFilters, type: ReceptionRankingType) {
  const where = appWhere(filters);
  const scope = filters.genres.length || filters.features.length || filters.tags.length ? "filtered" : "global";
  const minimum = scope === "global" ? GLOBAL_MINIMUM : FILTERED_MINIMUM;
  return {
    scope,
    minimum,
    values: [type, ...where.values, minimum],
    sql: `WITH ${ACTIVE_PUBLICATION},
      scoped AS (
        SELECT c.*
        FROM active b
        JOIN reception_publication_current c ON c.build_id = b.id
        JOIN apps a ON a.appid = c.appid
        WHERE c.type = ? AND ${where.sql}
      ),
      eligible AS (
        SELECT * FROM scoped
        WHERE metric_value IS NOT NULL AND qualifying_reviews >= ?
      )`,
  } as const;
}

function eligibilityWindow(type: ReceptionRankingType, evaluatedAt: string): ReceptionEvidenceWindow {
  return {
    start: type === "top_rated_now"
      ? new Date(Date.parse(evaluatedAt) - NINETY_DAYS).toISOString()
      : null,
    end: evaluatedAt,
  };
}

/** Reads a selected page from the last complete reception publication. */
export async function getReceptionRankings(
  db: AppDatabase,
  options: ReceptionRankingOptions = {},
): Promise<ReceptionQueryResult<ReceptionRankingData>> {
  const type = normalizeType(options.type);
  const filters = normalizeOptionsFilters(options);
  const { limit, offset } = pagination(options);
  const query = scopeQuery(filters, type);
  const pageLimit = query.scope === "global"
    ? Math.max(0, Math.min(limit, GLOBAL_DISPLAY_CAP - offset))
    : limit;
  const [metadata, statistics, page] = await db.batch([
    db.prepare(PUBLICATION_METADATA),
    db.prepare(`${query.sql}
      SELECT (SELECT COUNT(*) FROM eligible) AS eligible_total,
             (SELECT MAX(source_timestamp) FROM scoped) AS source_timestamp`)
      .bind(...query.values),
    db.prepare(`${query.sql},
      page AS (
        SELECT appid, metric_json, population_json, qualifying_reviews, metric_value
        FROM eligible
        ORDER BY metric_value DESC, qualifying_reviews DESC, appid ASC
        LIMIT ? OFFSET ?
      )
      SELECT a.*, p.metric_json, p.population_json, p.qualifying_reviews
      FROM page p JOIN apps a ON a.appid = p.appid
      ORDER BY p.metric_value DESC, p.qualifying_reviews DESC, p.appid ASC`)
      .bind(...query.values, pageLimit, offset),
  ]);
  const evaluatedAt = publishedAt(metadata!);
  const stats = statistics!.results![0] as ScopeStats;
  const window = eligibilityWindow(type, evaluatedAt);
  const items: ReceptionRankingItem[] = (page!.results as RankingRow[]).map((row, index) => ({
    rank: offset + index + 1,
    game: appToGame(row),
    metric: JSON.parse(row.metric_json) as ReceptionMetric,
    eligibility: {
      qualifying_reviews: row.qualifying_reviews,
      evidence_window: { ...window },
      population_ref: row.population_json ? JSON.parse(row.population_json) as ReceptionPopulationReference : null,
      minimum_reviews: query.minimum,
      eligible: true,
      reasons: [],
    },
  }));
  const total = query.scope === "global"
    ? Math.min(GLOBAL_DISPLAY_CAP, stats.eligible_total)
    : stats.eligible_total;
  return {
    data: {
      type, filters, evaluated_at: evaluatedAt, scope: query.scope,
      minimum_reviews: query.minimum, eligibility_window: window,
      limit, offset, total, eligible_total: stats.eligible_total,
      has_more: offset + items.length < total, items,
    },
    sourceTimestamp: stats.source_timestamp,
  };
}

/** Derives requested standings from shared monthly values, never stored ranks. */
export async function getReceptionComparison(
  db: AppDatabase,
  options: ReceptionComparisonOptions,
): Promise<ReceptionQueryResult<ReceptionComparisonData | null>> {
  if (!validAppId(options.appid)) throw new RangeError("Invalid reception comparison AppID");
  const type = normalizeType(options.type);
  const filters = normalizeOptionsFilters(options);
  const query = scopeQuery(filters, type);
  const history = `${query.sql},
    history AS (
      SELECT m.*, e.qualifying_reviews
      FROM eligible e
      JOIN reception_publication_months m
        ON m.history_key = e.history_key AND m.appid = e.appid AND m.type = e.type
      CROSS JOIN active b
      WHERE EXISTS (SELECT 1 FROM eligible WHERE appid = ?)
        AND m.cutoff >= strftime('%Y-%m-01T00:00:00.000Z', b.evaluated_at, 'start of month', '-11 months')
        AND m.cutoff <= strftime('%Y-%m-01T00:00:00.000Z', b.evaluated_at, 'start of month')
    )`;
  const countTie = type === "top_rated_now" ? "qualifying_reviews" : "lifetime_reviews";
  const [metadata, statistics, points] = await db.batch([
    db.prepare(PUBLICATION_METADATA),
    db.prepare(`${history}
      SELECT
        EXISTS (SELECT 1 FROM apps WHERE appid = ?) AS target_exists,
        EXISTS (SELECT 1 FROM eligible WHERE appid = ?) AS in_current_group,
        (SELECT COUNT(*) FROM eligible) AS eligible_total,
        (SELECT COUNT(DISTINCT appid) FROM history WHERE provenance = 'reconstructed') AS reconstructed_members,
        (SELECT MAX(timestamp) FROM (
          SELECT source_timestamp AS timestamp FROM scoped
          UNION ALL SELECT source_observed_at AS timestamp FROM history
        )) AS source_timestamp`)
      .bind(...query.values, options.appid, options.appid, options.appid),
    db.prepare(`${history},
      standings AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY cutoff ORDER BY value DESC, ${countTie} DESC, appid ASC) AS comparison_rank,
          COUNT(*) OVER (PARTITION BY cutoff) AS compared_count,
          SUM(CASE WHEN provenance = 'reconstructed' THEN 1 ELSE 0 END) OVER (PARTITION BY cutoff) AS reconstructed_count
        FROM history
      )
      SELECT cutoff, metric_kind, value, lifetime_approval, lifetime_reviews,
        observed_at, source_observed_at, formula_version, recalculation_json,
        score_window_end, provenance, comparison_rank, compared_count, reconstructed_count
      FROM standings WHERE appid = ? ORDER BY cutoff ASC`)
      .bind(...query.values, options.appid, options.appid),
  ]);
  const evaluatedAt = publishedAt(metadata!);
  const stats = statistics!.results![0] as ScopeStats & {
    target_exists: number; in_current_group: number; reconstructed_members: number;
  };
  if (!stats.target_exists) return { data: null, sourceTimestamp: null };
  return {
    data: {
      type, filters, appid: options.appid, evaluated_at: evaluatedAt,
      population_basis: "current_eligible_group",
      eligible_total: stats.eligible_total,
      in_current_group: stats.in_current_group === 1,
      cutoffs: getReceptionMonthCutoffs(evaluatedAt),
      points: (points!.results as MonthRow[]).map(({ recalculation_json, ...point }) => ({
        ...point,
        ...(recalculation_json ? { recalculation: JSON.parse(recalculation_json) as ScoreFormulaRecalculation } : {}),
      })),
      reconstructed_members: stats.reconstructed_members,
    },
    sourceTimestamp: stats.source_timestamp,
  };
}

/** Returns bounded live assessments for the individual game's evidence. */
export async function getGameReceptionEligibility(
  db: AppDatabase,
  appid: number,
  evaluatedAt?: string | Date,
): Promise<GameReceptionEligibility | null> {
  if (!validAppId(appid)) throw new RangeError("Invalid reception eligibility AppID");
  const value = evaluatedAt ?? new Date();
  if (typeof value === "string" && !/Z$/i.test(value)) throw new RangeError("Invalid reception evaluation time");
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) throw new RangeError("Invalid reception evaluation time");
  return evaluateLiveGameReceptionEligibility(db, appid, at.toISOString());
}
