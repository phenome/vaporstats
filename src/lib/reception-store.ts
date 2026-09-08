import type { AppDatabase, AppPreparedStatement } from "./db";
import {
  calculatePlayerScoreCandidate,
  getPlayerScoreWindow,
  type PlayerScoreCandidate,
  type ScoreAnchor,
  type ScoreEvidenceInput,
} from "./player-score";
import {
  selectWholeBuckets,
  type ReviewBucket,
  type ReviewInterval,
  type WholeBucketSelection,
} from "./review-evidence";
import type {
  JsonRecord,
  SteamReviewBucket,
  SteamReviewHistogram,
  SteamReviewSummary,
} from "../../workers/review-source";
import type { SteamEventRecord } from "../../workers/steam-events";

const DAY_MS = 24 * 60 * 60 * 1000;


export interface PersistReceptionObservationInput {
  appid: number;
  summary?: SteamReviewSummary | null;
  histogram?: SteamReviewHistogram | null;
  events?: readonly SteamEventRecord[] | null;
  observedAt: Date | string;
}

export interface StoredReviewBucket {
  appid: number;
  source_id: string;
  granularity: "daily" | "monthly";
  period_start: string;
  period_end: string;
  positive_count: number;
  negative_count: number;
  observed_at: string;
  provenance: string;
}

export interface StoredSummarySnapshot {
  appid: number;
  source_id: string;
  observed_at: string;
  lifetime_positive_count: number;
  lifetime_total_count: number;
  created_at?: string;
}

export interface StoredScoreHistory {
  id: number;
  appid: number;
  observed_at: string;
  score: number;
  formula_version: string;
  current_positive_count: number;
  current_total_count: number;
  historical_positive_count: number;
  historical_total_count: number;
  current_window_start: string;
  current_window_end: string;
  historical_window_start: string;
  historical_window_end: string;
  current_evidence_intervals: string;
  historical_evidence_intervals: string;
  current_source_id: string | null;
  historical_source_id: string | null;
  current_evidence_observed_at: string | null;
  historical_evidence_observed_at: string | null;
  anchor_event_id: string | null;
  anchor_at: string | null;
  provenance: string;
  created_at?: string;
}

export interface StoredScoreState {
  appid: number;
  latest_score_history_id: number | null;
  historical_positive_count: number | null;
  historical_total_count: number | null;
  historical_source_id: string | null;
  historical_window_start: string | null;
  historical_window_end: string | null;
  historical_evidence_intervals: string;
  historical_baseline_observed_at: string | null;
  eligibility_review_count: number | null;
  eligibility_source_id: string | null;
  eligibility_window_start: string | null;
  eligibility_window_end: string | null;
  eligibility_evidence_start: string | null;
  eligibility_evidence_end: string | null;
  eligibility_evidence_intervals: string;
  eligibility_observed_at: string | null;
  eligibility_provenance: string;
  updated_at?: string;
}

export interface StoredSteamEvent {
  event_id: string;
  appid: number;
  category: string | null;
  title: string | null;
  url: string | null;
  start_at: string | null;
  publication_at: string | null;
  observed_at: string;
  source: string;
  provenance: string;
}

export interface PersistReceptionResult {
  appid: number;
  persistedSummary: boolean;
  persistedBuckets: number;
  persistedEvents: number;
  scoreAppended: boolean;
  scoreHistoryId: number | null;
  eligibilityUpdated: boolean;
}

interface SourceRow {
  id: string;
  endpoint: string;
  request_filter: string;
  language: string | null;
  purchase_type: string | null;
  day_range: number | null;
  filter_offtopic_activity: number | null;
  population: string;
  population_flags: string;
  interpretation_version: string;
  identity_key: string;
}

interface EventRow extends StoredSteamEvent {}

interface NormalizedIncomingBucket extends StoredReviewBucket {}

interface IncomingSource {
  sourceId: string;
  endpoint: "appreviews" | "appreviewhistogram";
  requestFilter: string;
  language: string | null;
  purchaseType: string | null;
  dayRange: number | null;
  filterOfftopicActivity: number | null;
  population: string;
  populationFlags: JsonRecord;
  interpretationVersion: string;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid UTC observation time");
  return date.toISOString();
}

function parsedIso(value: unknown): string | null {
  if (typeof value !== "string" || !/Z$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeJson(value: unknown, fallback = "{}"): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? fallback : result;
  } catch {
    return fallback;
  }
}

function canonicalSource(
  source: SteamReviewSummary["provenance"] | SteamReviewHistogram["provenance"],
  expectedEndpoint: "appreviews" | "appreviewhistogram",
): IncomingSource | null {
  if (!source || source.endpoint !== expectedEndpoint) return null;
  const sourceId = typeof source.identityKey === "string" ? source.identityKey.trim() : "";
  if (!sourceId || sourceId !== source.identityKey) return null;
  return {
    sourceId,
    endpoint: expectedEndpoint,
    requestFilter: source.requestFilter,
    language: source.language,
    purchaseType: source.purchaseType,
    dayRange: source.dayRange,
    filterOfftopicActivity: source.filterOfftopicActivity,
    population: source.population,
    populationFlags: source.populationFlags,
    interpretationVersion: source.interpretationVersion,
  };
}

function sourceStatement(db: AppDatabase, source: IncomingSource) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO review_sources
       (id, endpoint, request_filter, language, purchase_type, day_range,
        filter_offtopic_activity, population, population_flags, interpretation_version, identity_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      source.sourceId,
      source.endpoint,
      source.requestFilter,
      source.language,
      source.purchaseType,
      source.dayRange,
      source.filterOfftopicActivity,
      source.population,
      safeJson(source.populationFlags),
      source.interpretationVersion,
      source.sourceId,
    );
}

function bucketKey(row: Pick<StoredReviewBucket, "source_id" | "granularity" | "period_start" | "period_end">): string {
  return `${row.source_id}|${row.granularity}|${row.period_start}|${row.period_end}`;
}

function normalizeBucket(
  bucket: SteamReviewBucket,
  sourceId: string,
): NormalizedIncomingBucket | null {
  if (bucket.sourceId !== sourceId || (bucket.granularity !== "day" && bucket.granularity !== "month")) return null;
  const start = parsedIso(bucket.periodStart);
  const end = parsedIso(bucket.periodEnd);
  const observedAt = parsedIso(bucket.observedAt);
  if (!start || !end || !observedAt || start >= end || end > observedAt || !safeCount(bucket.positiveCount) || !safeCount(bucket.negativeCount)) return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (bucket.granularity === "day") {
    if (endDate.getTime() - startDate.getTime() !== DAY_MS || startDate.getUTCHours() !== 0 || startDate.getUTCMinutes() !== 0 || startDate.getUTCSeconds() !== 0) return null;
  } else if (startDate.getUTCDate() !== 1 || startDate.getUTCHours() !== 0 || startDate.getUTCMinutes() !== 0 || startDate.getUTCSeconds() !== 0) {
    return null;
  }
  return {
    appid: bucket.appid,
    source_id: sourceId,
    granularity: bucket.granularity === "day" ? "daily" : "monthly",
    period_start: start,
    period_end: end,
    positive_count: bucket.positiveCount,
    negative_count: bucket.negativeCount,
    observed_at: observedAt,
    provenance: bucket.provenance,
  };
}

function asDomainBucket(row: StoredReviewBucket): ReviewBucket {
  return {
    sourceId: row.source_id,
    granularity: row.granularity === "daily" ? "day" : "month",
    start: row.period_start,
    end: row.period_end,
    positiveReviews: row.positive_count,
    negativeReviews: row.negative_count,
    observedAt: row.observed_at,
  };
}

function intervalsJson(value: readonly ReviewInterval[]): string {
  return safeJson(value.map((interval) => ({ ...interval })));
}

function selectionFingerprint(selection: WholeBucketSelection, buckets: readonly ReviewBucket[]): string {
  const byKey = new Map(buckets.map((bucket) => [`${bucket.granularity}|${bucket.start}|${bucket.end}`, bucket]));
  return safeJson({
    sourceId: selection.sourceId,
    selected: selection.selectedIntervals.map((interval) => ({
      ...interval,
      positive: byKey.get(`${interval.granularity}|${interval.start}|${interval.end}`)?.positiveReviews ?? null,
      negative: byKey.get(`${interval.granularity}|${interval.start}|${interval.end}`)?.negativeReviews ?? null,
    })),
    gaps: selection.gaps,
  });
}

function bestSource(
  buckets: readonly ReviewBucket[],
  requested: { start: string; end: string },
  asOf: string,
  requireComplete: boolean,
): { sourceId: string | null; selection: WholeBucketSelection | null } {
  const sourceIds = [...new Set(buckets.map((bucket) => bucket.sourceId))];
  let best: { sourceId: string; selection: WholeBucketSelection; observedAt: string } | null = null;
    let ambiguous = false;
  for (const sourceId of sourceIds) {
    const selection = selectWholeBuckets(buckets, requested, { sourceId, asOf });
    if (selection.selectedIntervals.length === 0 || (requireComplete && !selection.countsComplete)) continue;
    const observedAt = selection.observationTimes.at(-1) ?? "";
    if (!best || observedAt > best.observedAt) {
          best = { sourceId, selection, observedAt };
          ambiguous = false;
        } else if (observedAt === best.observedAt && sourceId !== best.sourceId) {
          ambiguous = true;
        }
  }
  return best && !ambiguous ? { sourceId: best.sourceId, selection: best.selection } : { sourceId: null, selection: null };
}

function rawBaseline(state: StoredScoreState | null): ScoreEvidenceInput | null {
  if (!state || !state.historical_source_id || state.historical_positive_count === null || state.historical_total_count === null || !state.historical_window_start || !state.historical_window_end || state.historical_total_count <= 0) return null;
  let selectedIntervals: ReviewInterval[] = [];
  try {
    const parsed = JSON.parse(state.historical_evidence_intervals);
    if (Array.isArray(parsed)) selectedIntervals = parsed;
  } catch {
    selectedIntervals = [];
  }
  return {
    sourceId: state.historical_source_id,
    positiveReviews: state.historical_positive_count,
    negativeReviews: Math.max(0, state.historical_total_count - state.historical_positive_count),
    totalReviews: state.historical_total_count,
    selectedIntervals,
    requested: { start: state.historical_window_start, end: state.historical_window_end },
    observationTimes: state.historical_baseline_observed_at ? [state.historical_baseline_observed_at] : [],
    observedAt: state.historical_baseline_observed_at,
  };
}

function eventIdentity(event: SteamEventRecord): string | null {
  const value = event.eventId ?? event.announcementId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}



function isMajorEvent(row: Pick<StoredSteamEvent, "category" | "provenance">): boolean {
  if (row.category === "major_update" || row.category === "14") return true;
  try {
    const parsed = JSON.parse(row.provenance) as { rawCategory?: unknown };
    return parsed.rawCategory === 14 || parsed.rawCategory === "14";
  } catch {
    return false;
  }
}

function anchorFor(events: readonly StoredSteamEvent[], evaluatedAt: string): ScoreAnchor | null {
  const evaluatedAtMs = Date.parse(evaluatedAt);
  let latest: StoredSteamEvent | null = null;
  for (const event of events) {
    const start = event.start_at ? Date.parse(event.start_at) : Number.NaN;
    if (!isMajorEvent(event) || !Number.isFinite(start) || start >= evaluatedAtMs) continue;
    if (!latest || start > Date.parse(latest.start_at!)) latest = event;
  }
  return latest?.start_at
    ? { category: 14, start: latest.start_at, eventId: latest.event_id, sourceId: latest.source }
    : null;
}

function sourceMetadata(source: SourceRow | undefined): Record<string, unknown> | null {
  if (!source) return null;
  let flags: unknown = {};
  try {
    flags = JSON.parse(source.population_flags);
  } catch {
    flags = {};
  }
  return {
    sourceId: source.id,
    endpoint: source.endpoint,
    requestFilter: source.request_filter,
    population: source.population,
    populationFlags: flags,
    interpretationVersion: source.interpretation_version,
  };
}

async function rows<T>(db: AppDatabase, query: string, ...params: unknown[]): Promise<T[]> {
  const result = await db.prepare(query).bind(...params).all<T>();
  return result.results ?? [];
}

export async function getReviewBuckets(db: AppDatabase, appid: number, sourceId?: string): Promise<StoredReviewBucket[]> {
  return sourceId
    ? rows(db, `SELECT appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance FROM review_buckets WHERE appid = ? AND source_id = ? ORDER BY period_start, period_end`, appid, sourceId)
    : rows(db, `SELECT appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance FROM review_buckets WHERE appid = ? ORDER BY period_start, period_end`, appid);
}

export async function getReviewSummarySnapshots(db: AppDatabase, appid: number, sourceId?: string): Promise<StoredSummarySnapshot[]> {
  return sourceId
    ? rows(db, `SELECT appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count, created_at FROM review_summary_snapshots WHERE appid = ? AND source_id = ? ORDER BY observed_at`, appid, sourceId)
    : rows(db, `SELECT appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count, created_at FROM review_summary_snapshots WHERE appid = ? ORDER BY observed_at`, appid);
}

export async function getPlayerScoreHistory(db: AppDatabase, appid: number): Promise<StoredScoreHistory[]> {
  return rows(db, `SELECT id, appid, observed_at, score, formula_version, current_positive_count, current_total_count, historical_positive_count, historical_total_count, current_window_start, current_window_end, historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals, current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at, anchor_event_id, anchor_at, provenance, created_at FROM player_score_history WHERE appid = ? ORDER BY id`, appid);
}

export async function getPlayerScoreState(db: AppDatabase, appid: number): Promise<StoredScoreState | null> {
  return db.prepare(`SELECT appid, latest_score_history_id, historical_positive_count, historical_total_count, historical_source_id, historical_window_start, historical_window_end, historical_evidence_intervals, historical_baseline_observed_at, eligibility_review_count, eligibility_source_id, eligibility_window_start, eligibility_window_end, eligibility_evidence_start, eligibility_evidence_end, eligibility_evidence_intervals, eligibility_observed_at, eligibility_provenance, updated_at FROM player_score_state WHERE appid = ?`).bind(appid).first<StoredScoreState>();
}

export async function getSteamEvents(db: AppDatabase, appid: number): Promise<StoredSteamEvent[]> {
  return rows(db, `SELECT event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance FROM steam_events WHERE appid = ? ORDER BY start_at, publication_at, event_id`, appid);
}









function stateValues(
  appid: number,
  prior: StoredScoreState | null,
  candidate: PlayerScoreCandidate | null,
  eligibility: { selection: WholeBucketSelection | null; sourceId: string | null },
  eligibilityObservedAt: string,
  provenance: Record<string, unknown>,
): unknown[] {
  const historical = candidate?.inputs.historical;
  let priorIntervals: ReviewInterval[] = [];
    if (prior) {
      try {
        const parsed = JSON.parse(prior.historical_evidence_intervals);
        if (Array.isArray(parsed)) priorIntervals = parsed;
      } catch {
        priorIntervals = [];
      }
    }
    const selectedEligibility = eligibility.selection?.selectedIntervals ?? [];
  const first = selectedEligibility[0]?.start ?? null;
  const last = selectedEligibility.at(-1)?.end ?? null;
  return [
    appid,
    candidate ? null : prior?.latest_score_history_id ?? null,
    historical?.positiveReviews ?? prior?.historical_positive_count ?? null,
    historical?.totalReviews ?? prior?.historical_total_count ?? null,
    historical?.sourceId ?? prior?.historical_source_id ?? null,
    historical?.requested?.start ?? prior?.historical_window_start ?? null,
    historical?.requested?.end ?? prior?.historical_window_end ?? null,
    intervalsJson(historical?.selectedIntervals ?? (prior ? priorIntervals : [])),
    historical?.observedAt ?? prior?.historical_baseline_observed_at ?? null,
    eligibility.selection ? eligibility.selection.knownTotalReviews : null,
    eligibility.selection ? eligibility.sourceId : null,
    eligibility.selection?.requested.start ?? null,
    eligibility.selection?.requested.end ?? null,
    first,
    last,
    intervalsJson(selectedEligibility),
    eligibilityObservedAt,
    safeJson(provenance),
  ];
}

export async function persistReceptionObservation(
  db: AppDatabase,
  input: PersistReceptionObservationInput,
): Promise<PersistReceptionResult> {
  if (!Number.isSafeInteger(input.appid) || input.appid <= 0) throw new RangeError("Invalid Steam AppID");
  const evaluatedAt = iso(input.observedAt);
  const summary = input.summary ?? null;
  const histogram = input.histogram ?? null;
  const summarySource = summary ? canonicalSource(summary.provenance, "appreviews") : null;
  const histogramSource = histogram ? canonicalSource(histogram.provenance, "appreviewhistogram") : null;
  const validSummary = summary && summary.appid === input.appid && summarySource && summary.sourceId === summarySource.sourceId && safeCount(summary.lifetimePositiveCount) && safeCount(summary.lifetimeTotalCount) && summary.lifetimePositiveCount <= summary.lifetimeTotalCount ? summary : null;
  const validHistogram = histogram && histogram.appid === input.appid && histogramSource && histogram.sourceId === histogramSource.sourceId ? histogram : null;
  const incomingBuckets = validHistogram
    ? validHistogram.buckets.map((bucket) => normalizeBucket(bucket, histogramSource!.sourceId)).filter((bucket): bucket is NormalizedIncomingBucket => bucket !== null)
    : [];
  const incomingEvents = (input.events ?? []).filter((event) => event && event.appid === input.appid && eventIdentity(event) !== null);

  const [existingBuckets, existingSummaries, priorState, existingEvents, sourceRows] = await Promise.all([
    getReviewBuckets(db, input.appid),
    validSummary && summarySource ? getReviewSummarySnapshots(db, input.appid, summarySource.sourceId) : Promise.resolve([] as StoredSummarySnapshot[]),
    getPlayerScoreState(db, input.appid),
    getSteamEvents(db, input.appid),
    rows<SourceRow>(db, `SELECT id, endpoint, request_filter, language, purchase_type, day_range, filter_offtopic_activity, population, population_flags, interpretation_version, identity_key FROM review_sources`),
  ]);
  
  const existingByKey = new Map(existingBuckets.map((bucket) => [bucketKey(bucket), bucket]));
  const beforeBuckets = [...existingByKey.values()];
  
  for (const bucket of incomingBuckets) {
    const key = bucketKey(bucket);
    const old = existingByKey.get(key);
    if (!old || bucket.observed_at >= old.observed_at) existingByKey.set(key, bucket);
  }
  const effectiveBuckets = [...existingByKey.values()];
  const domainBefore = beforeBuckets.map(asDomainBucket);
  const domainAfter = effectiveBuckets.map(asDomainBucket);
  
  const eventRows = new Map<string, EventRow>(existingEvents.map((event) => [event.event_id, event]));
  const eventStatements = incomingEvents.map((event) => {
    const eventId = eventIdentity(event)!;
    const observedAt = iso(event.observedAt || evaluatedAt);
    const provenance = safeJson({
      rawCategory: event.rawCategory,
      startAt: event.startAt,
      publicationAt: event.publicationAt,
      url: event.url,
      source: event.source,
      provenance: event.provenance,
    });
    const existing = eventRows.get(eventId);
    if (!existing || observedAt >= existing.observed_at) {
      eventRows.set(eventId, {
        event_id: eventId,
        appid: input.appid,
        category: event.category === "unknown" && existing?.category != null && existing.category !== "unknown" ? existing.category : event.category,
        title: event.title ?? existing?.title ?? null,
        url: event.url ?? existing?.url ?? null,
        start_at: event.startAt ?? existing?.start_at ?? null,
        publication_at: event.publicationAt ?? existing?.publication_at ?? null,
        observed_at: observedAt,
        source: existing?.source ?? event.source,
        provenance,
      });
    }
    return db.prepare(
      `INSERT INTO steam_events (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         category = CASE WHEN excluded.category = 'unknown' AND steam_events.category IS NOT NULL AND steam_events.category <> 'unknown' THEN steam_events.category ELSE excluded.category END,
         title = COALESCE(excluded.title, steam_events.title),
         url = COALESCE(excluded.url, steam_events.url),
         start_at = COALESCE(excluded.start_at, steam_events.start_at),
         publication_at = COALESCE(excluded.publication_at, steam_events.publication_at),
         observed_at = CASE WHEN excluded.observed_at > steam_events.observed_at THEN excluded.observed_at ELSE steam_events.observed_at END,
         provenance = excluded.provenance,
         updated_at = CURRENT_TIMESTAMP
       WHERE excluded.observed_at >= steam_events.observed_at`,
    ).bind(eventId, input.appid, event.category, event.title, event.url, event.startAt, event.publicationAt, observedAt, event.source, provenance);
  });
  const currentEvaluation = validHistogram ? iso(validHistogram.observedAt) : evaluatedAt;
  const nextAnchor = anchorFor([...eventRows.values()], currentEvaluation);
  const currentWindow = getPlayerScoreWindow(currentEvaluation, nextAnchor);
  const historicalWindow = { start: new Date(Date.parse(currentWindow.start) - 90 * DAY_MS).toISOString(), end: currentWindow.start };
  const beforeCurrent = bestSource(domainBefore, currentWindow, currentEvaluation, true);
  const afterCurrent = bestSource(domainAfter, currentWindow, currentEvaluation, true);
  const beforeHistorical = beforeCurrent.sourceId ? selectWholeBuckets(domainBefore, historicalWindow, { sourceId: beforeCurrent.sourceId, asOf: currentEvaluation }) : null;
  const afterHistorical = afterCurrent.sourceId ? selectWholeBuckets(domainAfter, historicalWindow, { sourceId: afterCurrent.sourceId, asOf: currentEvaluation }) : null;
  const changedRelevant = validHistogram !== null && (
    beforeCurrent.sourceId !== afterCurrent.sourceId ||
    (beforeCurrent.selection && afterCurrent.selection && selectionFingerprint(beforeCurrent.selection, domainBefore) !== selectionFingerprint(afterCurrent.selection, domainAfter)) ||
    (!beforeCurrent.selection && !!afterCurrent.selection) ||
    (beforeHistorical && afterHistorical?.countsComplete && selectionFingerprint(beforeHistorical, domainBefore) !== selectionFingerprint(afterHistorical, domainAfter)) ||
    (!beforeHistorical && !!afterHistorical && afterHistorical.countsComplete)
  );
  const historicalInput = afterHistorical?.countsComplete && afterHistorical.selectedIntervals.length > 0 ? afterHistorical : null;
  const retained = rawBaseline(priorState);
  const candidate = validHistogram && afterCurrent.selection?.countsComplete && afterCurrent.selection.selectedIntervals.length > 0 && changedRelevant
    ? calculatePlayerScoreCandidate({
        current: afterCurrent.selection,
        historical: historicalInput,
        retainedBaseline: retained,
        evaluatedAt: currentEvaluation,
        observedAt: afterCurrent.selection.observationTimes.at(-1) ?? validHistogram.observedAt,
        anchor: nextAnchor,
      })
    : null;
  const eligibilityWindow = getPlayerScoreWindow(currentEvaluation, null);
  const eligibility = validHistogram ? bestSource(domainAfter, eligibilityWindow, currentEvaluation, false) : { sourceId: null, selection: null };
  const histogramSourceRow = sourceRows.find((source) => source.id === (afterCurrent.sourceId ?? histogramSource?.sourceId));
  const unknownMetadata = validHistogram
    ? {
        sourceObservationAt: validHistogram.observedAt,
        sourceWindow: validHistogram.sourceWindow,
        rollupType: validHistogram.rollupType,
        unknownFlags: validHistogram.unknownFlags,
        unknownBucketCount: validHistogram.unknownBuckets.length,
        eventProvenance: validHistogram.events.length > 0 ? { count: validHistogram.events.length, observedAt: validHistogram.observedAt } : null,
      }
    : null;
  const stateProvenance = {
    ...(priorState ? (() => { try { return JSON.parse(priorState.eligibility_provenance); } catch { return {}; } })() : {}),
    ...(unknownMetadata ? { histogram: unknownMetadata } : {}),
    source: sourceMetadata(histogramSourceRow ?? (histogramSource ? { id: histogramSource.sourceId, endpoint: histogramSource.endpoint, request_filter: histogramSource.requestFilter, language: histogramSource.language, purchase_type: histogramSource.purchaseType, day_range: histogramSource.dayRange, filter_offtopic_activity: histogramSource.filterOfftopicActivity, population: histogramSource.population, population_flags: safeJson(histogramSource.populationFlags), interpretation_version: histogramSource.interpretationVersion, identity_key: histogramSource.sourceId } : undefined)),
  };
  const statements: AppPreparedStatement[] = [];
  if (validSummary && summarySource) statements.push(sourceStatement(db, summarySource));
  if (validHistogram && histogramSource) statements.push(sourceStatement(db, histogramSource));
  const summaryObservedAt = validSummary ? iso(validSummary.observedAt) : null;
  let persistedSummary = false;
  if (validSummary && summarySource && summaryObservedAt) {
    const dayStart = summaryObservedAt.slice(0, 10) + "T00:00:00.000Z";
    const nextDay = new Date(Date.parse(dayStart) + DAY_MS).toISOString();
    const newestSameDay = existingSummaries.filter((row) => row.observed_at >= dayStart && row.observed_at < nextDay).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
    if (!newestSameDay || summaryObservedAt > newestSameDay.observed_at) {
      statements.push(db.prepare(`DELETE FROM review_summary_snapshots WHERE appid = ? AND source_id = ? AND observed_at >= ? AND observed_at < ? AND observed_at < ?`).bind(input.appid, summarySource.sourceId, dayStart, nextDay, summaryObservedAt));
      statements.push(db.prepare(`INSERT OR IGNORE INTO review_summary_snapshots (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count) VALUES (?, ?, ?, ?, ?)`).bind(input.appid, summarySource.sourceId, summaryObservedAt, validSummary.lifetimePositiveCount, validSummary.lifetimeTotalCount));
      persistedSummary = true;
    }
  }
  for (const bucket of incomingBuckets) {
    statements.push(db.prepare(
      `INSERT INTO review_buckets (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(appid, source_id, granularity, period_start, period_end) DO UPDATE SET
         positive_count = excluded.positive_count,
         negative_count = excluded.negative_count,
         observed_at = excluded.observed_at,
         provenance = excluded.provenance
       WHERE excluded.observed_at > review_buckets.observed_at OR (excluded.observed_at = review_buckets.observed_at AND (excluded.positive_count <> review_buckets.positive_count OR excluded.negative_count <> review_buckets.negative_count))`,
    ).bind(input.appid, bucket.source_id, bucket.granularity, bucket.period_start, bucket.period_end, bucket.positive_count, bucket.negative_count, bucket.observed_at, bucket.provenance));
  }
  statements.push(...eventStatements);
  let stateAdded = false;
  if (validHistogram) {
    const state = stateValues(input.appid, priorState, candidate, eligibility, validHistogram.observedAt, stateProvenance);
    statements.push(db.prepare(
      `INSERT INTO player_score_state
       (appid, latest_score_history_id, historical_positive_count, historical_total_count, historical_source_id, historical_window_start, historical_window_end, historical_evidence_intervals, historical_baseline_observed_at, eligibility_review_count, eligibility_source_id, eligibility_window_start, eligibility_window_end, eligibility_evidence_start, eligibility_evidence_end, eligibility_evidence_intervals, eligibility_observed_at, eligibility_provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(appid) DO UPDATE SET
         latest_score_history_id = CASE WHEN excluded.latest_score_history_id IS NOT NULL THEN excluded.latest_score_history_id ELSE player_score_state.latest_score_history_id END,
         historical_positive_count = excluded.historical_positive_count,
         historical_total_count = excluded.historical_total_count,
         historical_source_id = excluded.historical_source_id,
         historical_window_start = excluded.historical_window_start,
         historical_window_end = excluded.historical_window_end,
         historical_evidence_intervals = excluded.historical_evidence_intervals,
         historical_baseline_observed_at = excluded.historical_baseline_observed_at,
         eligibility_review_count = excluded.eligibility_review_count,
         eligibility_source_id = excluded.eligibility_source_id,
         eligibility_window_start = excluded.eligibility_window_start,
         eligibility_window_end = excluded.eligibility_window_end,
         eligibility_evidence_start = excluded.eligibility_evidence_start,
         eligibility_evidence_end = excluded.eligibility_evidence_end,
         eligibility_evidence_intervals = excluded.eligibility_evidence_intervals,
         eligibility_observed_at = excluded.eligibility_observed_at,
         eligibility_provenance = excluded.eligibility_provenance,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(...state));
    stateAdded = true;
  }
  if (candidate) {
    const current = candidate.inputs.current;
    const historical = candidate.inputs.historical;
    statements.push(db.prepare(
      `INSERT INTO player_score_history
       (appid, observed_at, score, formula_version, current_positive_count, current_total_count, historical_positive_count, historical_total_count, current_window_start, current_window_end, historical_window_start, historical_window_end, current_evidence_intervals, historical_evidence_intervals, current_source_id, historical_source_id, current_evidence_observed_at, historical_evidence_observed_at, anchor_event_id, anchor_at, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.appid,
      candidate.observedAt ?? validHistogram?.observedAt ?? evaluatedAt,
      candidate.score,
      candidate.formulaVersion,
      current.positiveReviews ?? 0,
      current.totalReviews ?? 0,
      historical?.positiveReviews ?? 0,
      historical?.totalReviews ?? 0,
      candidate.scoreWindow?.start ?? current.requested?.start ?? currentEvaluation,
      candidate.scoreWindow?.end ?? current.requested?.end ?? currentEvaluation,
      historical?.requested?.start ?? historicalWindow.start,
      historical?.requested?.end ?? historicalWindow.end,
      intervalsJson(current.selectedIntervals),
      intervalsJson(historical?.selectedIntervals ?? []),
      current.sourceId,
      historical?.sourceId ?? null,
      current.observationTimes.at(-1) ?? current.observedAt,
      historical?.observationTimes.at(-1) ?? historical?.observedAt ?? null,
      candidate.anchor?.eventId ?? null,
      candidate.anchor?.start ?? null,
      safeJson({
        current: { requested: current.requested, selected: current.selectedIntervals, gaps: current.gaps, observationTimes: current.observationTimes, source: sourceMetadata(sourceRows.find((source) => source.id === current.sourceId)) },
        historical: historical ? { requested: historical.requested, selected: historical.selectedIntervals, gaps: historical.gaps, observationTimes: historical.observationTimes } : null,
        anchor: candidate.anchor,
        formulaVersion: candidate.formulaVersion,
        inputs: candidate.inputs,
      }),
    ));
    // The score insert must precede this pointer update in the same transaction.
    statements.push(db.prepare(`UPDATE player_score_state SET latest_score_history_id = (SELECT id FROM player_score_history WHERE appid = ? ORDER BY id DESC LIMIT 1), updated_at = CURRENT_TIMESTAMP WHERE appid = ?`).bind(input.appid, input.appid));
  }
  if (statements.length > 0) await db.batch(statements);
  let scoreHistoryId: number | null = null;
  if (candidate) {
    const latest = await db.prepare(`SELECT id FROM player_score_history WHERE appid = ? ORDER BY id DESC LIMIT 1`).bind(input.appid).first<{ id: number }>();
    scoreHistoryId = latest?.id ?? null;
  }
  return {
    appid: input.appid,
    persistedSummary,
    persistedBuckets: incomingBuckets.length,
    persistedEvents: incomingEvents.length,
    scoreAppended: candidate !== null,
    scoreHistoryId,
    eligibilityUpdated: stateAdded,
  };
}

function monthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function nextMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}

export interface CompactReviewEvidenceResult {
  monthsCompacted: number;
  dailyBucketsDeleted: number;
  monthlyBucketsWritten: number;
}

export async function compactReviewEvidence(db: AppDatabase, now: Date | string = new Date()): Promise<CompactReviewEvidenceResult> {
  const asOf = new Date(iso(now));
  const cutoff = new Date(Date.UTC(asOf.getUTCFullYear() - 1, asOf.getUTCMonth(), asOf.getUTCDate(), asOf.getUTCHours(), asOf.getUTCMinutes(), asOf.getUTCSeconds(), asOf.getUTCMilliseconds()));
  const daily = await rows<StoredReviewBucket>(db, `SELECT appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance FROM review_buckets WHERE granularity = 'daily' AND period_end <= ? ORDER BY appid, source_id, period_start`, cutoff.toISOString());
  const monthly = await rows<StoredReviewBucket>(db, `SELECT appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance FROM review_buckets WHERE granularity = 'monthly'`);
  const monthlyMap = new Map(monthly.map((row) => [JSON.stringify([row.appid, row.source_id, row.period_start, row.period_end]), row]));
  const grouped = new Map<string, StoredReviewBucket[]>();
  for (const row of daily) {
    const month = monthStart(new Date(row.period_start));
    const end = nextMonth(month);
    const key = JSON.stringify([row.appid, row.source_id, month.toISOString(), end.toISOString()]);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  const writes: { row: StoredReviewBucket; days: StoredReviewBucket[] }[] = [];
  for (const [key, list] of grouped) {
    const [appid, sourceId, periodStart, periodEnd] = JSON.parse(key) as [number, string, string, string];
    const month = new Date(periodStart);
    const end = new Date(periodEnd);
    const expectedDays = Math.round((end.getTime() - month.getTime()) / DAY_MS);
    const byStart = new Map(list.map((row) => [row.period_start, row]));
    const complete = byStart.size === expectedDays && [...byStart.values()].every((row) => new Date(row.period_start).getUTCHours() === 0 && new Date(row.period_end).getTime() - new Date(row.period_start).getTime() === DAY_MS);
    if (!complete) {
          const replacement = monthlyMap.get(key);
          const latestPartial = list.map((row) => row.observed_at).sort().at(-1) ?? "";
          if (!replacement || replacement.observed_at < latestPartial) continue;
          writes.push({ row: replacement, days: list });
          continue;
        }
    const existing = monthlyMap.get(key);
    const latestObserved = [...byStart.values()].map((row) => row.observed_at).sort().at(-1)!;
    const totalPositive = [...byStart.values()].reduce((sum, row) => sum + row.positive_count, 0);
    const totalNegative = [...byStart.values()].reduce((sum, row) => sum + row.negative_count, 0);
    const row: StoredReviewBucket = {
      appid,
      source_id: sourceId,
      granularity: "monthly",
      period_start: periodStart,
      period_end: periodEnd,
      positive_count: totalPositive,
      negative_count: totalNegative,
      observed_at: latestObserved,
      provenance: "derived.complete-calendar-month",
    };
    writes.push({ row: existing && existing.observed_at > latestObserved ? existing : row, days: [...byStart.values()] });
  }
  const statements: AppPreparedStatement[] = [];
  let deleted = 0;
  for (const { row, days } of writes) {
    statements.push(db.prepare(
      `INSERT INTO review_buckets (appid, source_id, granularity, period_start, period_end, positive_count, negative_count, observed_at, provenance)
       VALUES (?, ?, 'monthly', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(appid, source_id, granularity, period_start, period_end) DO UPDATE SET positive_count = excluded.positive_count, negative_count = excluded.negative_count, observed_at = excluded.observed_at, provenance = excluded.provenance
       WHERE excluded.observed_at > review_buckets.observed_at OR (excluded.observed_at = review_buckets.observed_at AND (excluded.positive_count <> review_buckets.positive_count OR excluded.negative_count <> review_buckets.negative_count))`,
    ).bind(row.appid, row.source_id, row.period_start, row.period_end, row.positive_count, row.negative_count, row.observed_at, row.provenance));
    if (row.granularity === "monthly") {
      for (const day of days) {
        statements.push(db.prepare(`DELETE FROM review_buckets WHERE appid = ? AND source_id = ? AND granularity = 'daily' AND period_start = ? AND period_end = ?`).bind(day.appid, day.source_id, day.period_start, day.period_end));
        deleted++;
      }
    }
  }
  if (statements.length > 0) await db.batch(statements);
  return { monthsCompacted: writes.length, dailyBucketsDeleted: deleted, monthlyBucketsWritten: writes.length };
}
