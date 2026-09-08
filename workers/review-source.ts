const REVIEW_SUMMARY_ENDPOINT = "https://store.steampowered.com/appreviews/";
const REVIEW_HISTOGRAM_ENDPOINT = "https://store.steampowered.com/appreviewhistogram/";
const REVIEW_SUMMARY_SOURCE = "appreviews";
const REVIEW_HISTOGRAM_SOURCE = "appreviewhistogram";

export const REVIEW_SOURCE_INTERPRETATION_VERSION = "steam-review-source-v1";
export const DEFAULT_REVIEW_SOURCE_OPTIONS = {
  filter: "all",
  language: "all",
  purchaseType: "all",
  dayRange: 30,
  filterOfftopicActivity: 1,
} as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export interface ReviewSourceOptions {
  customFetch?: typeof fetch;
  observedAt?: Date | string;
  filter?: string;
  language?: string;
  purchaseType?: string;
  dayRange?: number;
  filterOfftopicActivity?: number | boolean;
  signal?: AbortSignal;
}

export interface ReviewRequestFilter {
  filter: string;
  language: string;
  purchaseType: string;
  dayRange: number;
  filterOfftopicActivity: number;
  numPerPage: 0;
}

export interface ReviewSourceProvenance {
  endpoint: string;
  requestFilter: string;
  language: string | null;
  purchaseType: string | null;
  dayRange: number | null;
  filterOfftopicActivity: number | null;
  population: string;
  populationFlags: JsonRecord;
  interpretationVersion: string;
  identityKey: string;
}

export interface SteamReviewSummary {
  appid: number;
  numReviews: number | null;
  lifetimePositiveCount: number;
  lifetimeNegativeCount: number;
  lifetimeTotalCount: number;
  reviewScore: number | null;
  reviewScoreDesc: string | null;
  observedAt: string;
  sourceId: string;
  provenance: ReviewSourceProvenance;
}


export type HistogramGranularity = "day" | "week" | "month";

export interface SteamReviewBucket {
  appid: number;
  sourceId: string;
  granularity: HistogramGranularity;
  periodStart: string;
  periodEnd: string;
  positiveCount: number;
  negativeCount: number;
  observedAt: string;
  provenance: "steam.appreviewhistogram";
}

export interface SteamReviewHistogramEvent {
  type: JsonValue;
  startEpochSeconds: number | null;
  endEpochSeconds: number | null;
  startAt: string | null;
  endAt: string | null;
}

export interface SteamReviewHistogram {
  appid: number;
  observedAt: string;
  sourceId: string;
  sourceWindow: {
    startEpochSeconds: number | null;
    endEpochSeconds: number | null;
    startAt: string | null;
    endAt: string | null;
  };
  rollupType: string | null;
  buckets: SteamReviewBucket[];
  openBuckets: SteamReviewBucket[];
  events: SteamReviewHistogramEvent[];
  provenance: ReviewSourceProvenance;
  unknownFlags: JsonRecord;
  unknownBuckets: JsonValue[];
}

export interface SourceFailure {
  ok: false;
  outcome: "failure" | "rate_limited";
  rateLimited: boolean;
  status: number | null;
  message: string;
  observedAt: string | null;
  endpoint: string;
}

export interface ReviewSummarySuccess {
  ok: true;
  outcome: "success";
  value: SteamReviewSummary;
}

export interface ReviewHistogramSuccess {
  ok: true;
  outcome: "success";
  value: SteamReviewHistogram;
}

export type ReviewSummaryResult = ReviewSummarySuccess | SourceFailure;
export type ReviewHistogramResult = ReviewHistogramSuccess | SourceFailure;


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value ?? null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return String(value);
}

function isoFromDate(value: Date | string | undefined): string | null {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}


function validAppId(appid: number): boolean {
  return Number.isSafeInteger(appid) && appid > 0;
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function optionalInteger(value: unknown): number | null {
  return value === undefined || value === null ? null : nonnegativeInteger(value);
}

function optionsFor(value: ReviewSourceOptions | typeof fetch | undefined): ReviewSourceOptions {
  return typeof value === "function" ? { customFetch: value } : value ?? {};
}

function requestFilter(options: ReviewSourceOptions): ReviewRequestFilter | SourceFailure {
  const filter = options.filter ?? DEFAULT_REVIEW_SOURCE_OPTIONS.filter;
  const language = options.language ?? DEFAULT_REVIEW_SOURCE_OPTIONS.language;
  const purchaseType = options.purchaseType ?? DEFAULT_REVIEW_SOURCE_OPTIONS.purchaseType;
  const dayRange = options.dayRange ?? DEFAULT_REVIEW_SOURCE_OPTIONS.dayRange;
  const rawOfftopic = options.filterOfftopicActivity ?? DEFAULT_REVIEW_SOURCE_OPTIONS.filterOfftopicActivity;
  const filterOfftopicActivity = typeof rawOfftopic === "boolean" ? (rawOfftopic ? 1 : 0) : rawOfftopic;
  if (!filter || !language || !purchaseType || !Number.isSafeInteger(dayRange) || dayRange < 1 || dayRange > 365) {
    return failure("Invalid Steam review request filters", null, false, REVIEW_SUMMARY_ENDPOINT, isoFromDate(options.observedAt));
  }
  if (!Number.isSafeInteger(filterOfftopicActivity) || (filterOfftopicActivity !== 0 && filterOfftopicActivity !== 1)) {
    return failure("Invalid Steam review off-topic filter", null, false, REVIEW_SUMMARY_ENDPOINT, isoFromDate(options.observedAt));
  }
  return { filter, language, purchaseType, dayRange, filterOfftopicActivity, numPerPage: 0 };
}

function requestKey(request: ReviewRequestFilter): string {
  return [
    `filter=${encodeURIComponent(request.filter)}`,
    `language=${encodeURIComponent(request.language)}`,
    `purchase_type=${encodeURIComponent(request.purchaseType)}`,
    `day_range=${request.dayRange}`,
    `filter_offtopic_activity=${request.filterOfftopicActivity}`,
    `num_per_page=${request.numPerPage}`,
  ].join("&");
}

function sourceIdentity(
  source: string,
  requestFilter: string,
  population: string,
  populationFlags: JsonRecord
): string {
  return [
    source,
    requestFilter,
    "population=" + population,
    "flags=" + encodeURIComponent(JSON.stringify(populationFlags)),
    "interpretation=" + REVIEW_SOURCE_INTERPRETATION_VERSION,
  ].join("|");
}

function provenance(
  endpoint: string,
  request: ReviewRequestFilter,
  population: string,
  populationFlags: JsonRecord
): ReviewSourceProvenance {
  const requestFilter = requestKey(request);
  return {
    endpoint,
    requestFilter,
    language: request.language,
    purchaseType: request.purchaseType,
    dayRange: request.dayRange,
    filterOfftopicActivity: request.filterOfftopicActivity,
    population,
    populationFlags,
    interpretationVersion: REVIEW_SOURCE_INTERPRETATION_VERSION,
    identityKey: sourceIdentity(endpoint, requestFilter, population, populationFlags),
  };
}

function histogramProvenance(
  endpoint: string,
  population: string,
  populationFlags: JsonRecord
): ReviewSourceProvenance {
  return {
    endpoint,
    requestFilter: "none",
    language: null,
    purchaseType: null,
    dayRange: null,
    filterOfftopicActivity: null,
    population,
    populationFlags,
    interpretationVersion: REVIEW_SOURCE_INTERPRETATION_VERSION,
    identityKey: sourceIdentity(endpoint, "none", population, populationFlags),
  };
}

function failure(
  message: string,
  status: number | null,
  rateLimited: boolean,
  endpoint: string,
  observedAt: string | null
): SourceFailure {
  return {
    ok: false,
    outcome: rateLimited ? "rate_limited" : "failure",
    rateLimited,
    status,
    message,
    observedAt,
    endpoint,
  };
}

interface ResponseJson {
  ok: true;
  body: unknown;
  observedAt: string;
}

async function readResponse(
  response: Response,
  endpoint: string,
  requestedAt: string
): Promise<ResponseJson | SourceFailure> {
  const observedAt = requestedAt;
  if (response.status === 429) {
    return failure("Steam rate limit", 429, true, endpoint, observedAt);
  }
  if (!response.ok) {
    return failure(`Steam request failed with HTTP ${response.status}`, response.status, false, endpoint, observedAt);
  }
  try {
    return { ok: true, body: await response.json(), observedAt };
  } catch {
    return failure("Steam returned invalid JSON", response.status, false, endpoint, observedAt);
  }
}

function validSuccess(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

/** Fetches only Steam's aggregate query_summary; review records are never requested or retained. */
export async function fetchSteamReviewSummary(
  appid: number,
  optionsOrFetch?: ReviewSourceOptions | typeof fetch
): Promise<ReviewSummaryResult> {
  const options = optionsFor(optionsOrFetch);
  const requestedAt = isoFromDate(options.observedAt);
  const endpoint = REVIEW_SUMMARY_ENDPOINT + appid;
  if (requestedAt === null) return failure("Invalid observedAt", null, false, endpoint, null);
  if (!validAppId(appid)) return failure("Invalid Steam AppID", null, false, endpoint, requestedAt);
  const request = requestFilter(options);
  if (!("filter" in request)) return { ...request, endpoint };
  const url = endpoint + "?json=1&" + requestKey(request);
  let response: Response;
  try {
    response = await (options.customFetch ?? fetch)(url, { signal: options.signal });
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Steam request failed", null, false, endpoint, requestedAt);
  }
  const parsed = await readResponse(response, endpoint, requestedAt);
  if (!parsed.ok) return parsed;
  const body = parsed.body;
  if (!isRecord(body) || !validSuccess(body.success) || !isRecord(body.query_summary)) {
    return failure("Steam review summary schema mismatch", response.status, false, endpoint, parsed.observedAt);
  }
  const summary = body.query_summary;
  const lifetimePositiveCount = nonnegativeInteger(summary.total_positive);
  const lifetimeNegativeCount = nonnegativeInteger(summary.total_negative);
  const lifetimeTotalCount = nonnegativeInteger(summary.total_reviews);
  if (lifetimePositiveCount === null || lifetimeNegativeCount === null || lifetimeTotalCount === null) {
    return failure("Steam review summary counts are invalid", response.status, false, endpoint, parsed.observedAt);
  }
  if (lifetimeNegativeCount > lifetimeTotalCount || lifetimePositiveCount !== lifetimeTotalCount - lifetimeNegativeCount) {
    return failure("Steam review summary counts are inconsistent", response.status, false, endpoint, parsed.observedAt);
  }
  const numReviews = optionalInteger(summary.num_reviews);
  const reviewScore = optionalInteger(summary.review_score);
  if (summary.num_reviews !== undefined && numReviews === null) {
    return failure("Steam review summary window count is invalid", response.status, false, endpoint, parsed.observedAt);
  }
  if (summary.review_score !== undefined && summary.review_score !== null && reviewScore === null) {
    return failure("Steam review summary score is invalid", response.status, false, endpoint, parsed.observedAt);
  }
  if (reviewScore !== null && reviewScore > 10) {
    return failure("Steam review summary score is invalid", response.status, false, endpoint, parsed.observedAt);
  }
  const reviewScoreDesc = summary.review_score_desc === undefined || summary.review_score_desc === null
    ? null
    : typeof summary.review_score_desc === "string" ? summary.review_score_desc : null;
  if (summary.review_score_desc !== undefined && summary.review_score_desc !== null && reviewScoreDesc === null) {
    return failure("Steam review summary description is invalid", response.status, false, endpoint, parsed.observedAt);
  }
  const population = "summary:" + request.purchaseType + ":" + request.filter + ":" + request.language + ":" + request.filterOfftopicActivity;
  const reviewProvenance = provenance(REVIEW_SUMMARY_SOURCE, request, population, {
    filter: request.filter,
    language: request.language,
    purchase_type: request.purchaseType,
    day_range: request.dayRange,
    filter_offtopic_activity: request.filterOfftopicActivity,
    num_per_page: request.numPerPage,
  });
  const sourceId = reviewProvenance.identityKey;
  return {
    ok: true,
    outcome: "success",
    value: {
      appid,
      numReviews,
      lifetimePositiveCount,
      lifetimeNegativeCount,
      lifetimeTotalCount,
      reviewScore,
      reviewScoreDesc,
      observedAt: parsed.observedAt,
      sourceId,
      provenance: reviewProvenance,
    },
  };
}

function epochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function isoFromEpoch(value: number | null): string | null {
  if (value === null || value > 8_640_000_000) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function utcBoundary(value: number, granularity: HistogramGranularity): boolean {
  const date = new Date(value * 1000);
  if (date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0) return false;
  if (granularity === "month") return date.getUTCDate() === 1;
  return true;
}

function intervalEnd(value: number, granularity: HistogramGranularity): number | null {
  const date = new Date(value * 1000);
  if (granularity === "day") return value + 86_400;
  if (granularity === "week") return value + 7 * 86_400;
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return Math.floor(nextMonth.getTime() / 1000);
}

function bucketFrom(
  appid: number,
  sourceId: string,
  raw: unknown,
  granularity: HistogramGranularity,
  observedAt: string
): SteamReviewBucket | null {
  if (!isRecord(raw)) return null;
  const start = epochSeconds(raw.date);
  const positiveCount = nonnegativeInteger(raw.recommendations_up);
  const negativeCount = nonnegativeInteger(raw.recommendations_down);
  if (start === null || positiveCount === null || negativeCount === null || !utcBoundary(start, granularity)) return null;
  const end = intervalEnd(start, granularity);
  if (end === null) return null;
  const periodStart = isoFromEpoch(start);
  const periodEnd = isoFromEpoch(end);
  if (periodStart === null || periodEnd === null) return null;
  return {
    appid,
    sourceId,
    granularity,
    periodStart,
    periodEnd,
    positiveCount,
    negativeCount,
    observedAt,
    provenance: "steam.appreviewhistogram",
  };
}

function histogramFlags(body: Record<string, unknown>): { flags: JsonRecord; unknown: JsonRecord } {
  const flags: JsonRecord = {};
  const unknown: JsonRecord = {};
  for (const key of ["count_all_reviews", "expand_graph"]) {
    if (key in body) flags[key] = jsonValue(body[key]);
    else unknown[key] = null;
  }
  for (const [key, value] of Object.entries(body)) {
    if (key.endsWith("_flag") || key.startsWith("is_")) flags[key] = jsonValue(value);
  }
  return { flags, unknown };
}

function parseHistogramEvents(value: unknown): SteamReviewHistogramEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SteamReviewHistogramEvent[] => {
    if (!isRecord(entry)) return [];
    const startEpochSeconds = epochSeconds(entry.start_date);
    const endEpochSeconds = epochSeconds(entry.end_date);
    return [{
      type: jsonValue(entry.type),
      startEpochSeconds,
      endEpochSeconds,
      startAt: isoFromEpoch(startEpochSeconds),
      endAt: isoFromEpoch(endEpochSeconds),
    }];
  });
}

/** Fetches Steam's observed histogram shape without deriving counts or joining populations. */
export async function fetchSteamReviewHistogram(
  appid: number,
  optionsOrFetch?: ReviewSourceOptions | typeof fetch
): Promise<ReviewHistogramResult> {
  const options = optionsFor(optionsOrFetch);
  const requestedAt = isoFromDate(options.observedAt);
  const endpoint = REVIEW_HISTOGRAM_ENDPOINT + appid;
  if (requestedAt === null) return failure("Invalid observedAt", null, false, endpoint, null);
  if (!validAppId(appid)) return failure("Invalid Steam AppID", null, false, endpoint, requestedAt);
  let response: Response;
  try {
    response = await (options.customFetch ?? fetch)(endpoint, { signal: options.signal });
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Steam request failed", null, false, endpoint, requestedAt);
  }
  const parsed = await readResponse(response, endpoint, requestedAt);
  if (!parsed.ok) return parsed;
  const body = parsed.body;
  if (!isRecord(body) || !validSuccess(body.success) || !isRecord(body.results)) {
    return failure("Steam review histogram schema mismatch", response.status, false, endpoint, parsed.observedAt);
  }
  const results = body.results;
  const rollupType = typeof results.rollup_type === "string" ? results.rollup_type : null;
  const flags = histogramFlags(body);
  const population = body.count_all_reviews === true ? "all_reviews" : body.count_all_reviews === false ? "filtered_reviews" : "unknown";
  const histogramProvenanceValue = histogramProvenance(REVIEW_HISTOGRAM_SOURCE, population, {
    count_all_reviews: flags.flags.count_all_reviews ?? null,
  });
  const sourceId = histogramProvenanceValue.identityKey;
  const buckets: SteamReviewBucket[] = [];
  const openBuckets: SteamReviewBucket[] = [];
  const unknownBuckets: JsonValue[] = [];
  const addBuckets = (entries: unknown, granularity: HistogramGranularity): void => {
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      const bucket = bucketFrom(appid, sourceId, raw, granularity, parsed.observedAt);
      if (!bucket) {
        unknownBuckets.push(jsonValue(raw));
      } else if (new Date(bucket.periodEnd).getTime() <= new Date(parsed.observedAt).getTime()) {
        buckets.push(bucket);
      } else {
        openBuckets.push(bucket);
      }
    }
  };
  addBuckets(results.recent, "day");
  addBuckets(results.weeks, "week");
  if (rollupType === "month") addBuckets(results.rollups, "month");
  else if (rollupType === "week") addBuckets(results.rollups, "week");
  else if (Array.isArray(results.rollups)) {
    for (const raw of results.rollups) unknownBuckets.push(jsonValue(raw));
  }
  return {
    ok: true,
    outcome: "success",
    value: {
      appid,
      observedAt: parsed.observedAt,
      sourceId,
      sourceWindow: {
        startEpochSeconds: epochSeconds(results.start_date),
        endEpochSeconds: epochSeconds(results.end_date),
        startAt: isoFromEpoch(epochSeconds(results.start_date)),
        endAt: isoFromEpoch(epochSeconds(results.end_date)),
      },
      rollupType,
      buckets,
      openBuckets,
      events: parseHistogramEvents(body.past_events),
      provenance: histogramProvenanceValue,
      unknownFlags: flags.unknown,
      unknownBuckets,
    },
  };
}

