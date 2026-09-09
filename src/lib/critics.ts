/**
 * Source-native critic evidence and player/critic comparison.
 *
 * This module deliberately has no network or persistence boundary. Provider
 * adapters normalize their responses into CriticRecord; this module only
 * validates evidence and describes comparison outcomes.
 */

export const MIN_PLAYER_REVIEW_COUNT = 20;
export const MIN_CRITIC_REVIEW_COUNT = 5;
export const WEEKLY_STALE_AFTER_DAYS = 14;
export const MONTHLY_STALE_AFTER_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CriticSource = "metacritic" | "opencritic";
export type CriticCadence = "weekly" | "monthly";
export type CriticPlatform = "pc" | "mixed" | "console" | "unknown";
export type CriticCollectionBasis = "public_page" | "authorized_api" | "unavailable";
export type OpenCriticTier = "Weak" | "Fair" | "Strong" | "Mighty";
export type ReceptionDirection = "unfavorable" | "mixed" | "favorable";
export type AlignmentLabel =
  | "broadly_aligned"
  | "players_more_favorable"
  | "critics_more_favorable"
  | "clearly_divergent";

export type CriticReason =
  | "record_invalid"
  | "source_id_missing"
  | "source_url_missing"
  | "title_missing"
  | "permission_missing"
  | "identity_unverified"
  | "appid_mismatch"
  | "platform_not_pc"
  | "edition_unverified"
  | "critic_reviews_insufficient"
  | "critic_metric_missing"
  | "player_reviews_insufficient"
  | "player_score_missing"
  | "review_dates_missing"
  | "review_dates_invalid"
  | "player_snapshot_missing"
  | "retrieval_timestamp_missing"
  | "retrieval_timestamp_invalid"
  | "retrieval_stale"
  | "critic_sources_differ";

export interface CriticMatchedIdentity {
  steamAppId: number;
  platformScope: CriticPlatform;
  edition: string;
  /** Human/audit-readable matching evidence, when the adapter has it. */
  evidence: string | null;
}

/**
 * Canonical source-native record shared by provider adapters and this domain.
 * `score` is retained for native numeric scores (Metacritic and OpenCritic's
 * top-critic score); OpenCritic alignment uses `tier`, never a converted score.
 * Unsupported values are null, never zero or -1.
 */
export interface CriticRecord {
  source: CriticSource;
  sourceUrl: string;
  sourceId: string;
  steamAppId: number;
  title: string;
  slug: string;
  edition: string;
  platforms: readonly string[];
  platformScope: CriticPlatform;
  score: number | null;
  tier: OpenCriticTier | null;
  reviewCount: number | null;
  percentRecommended: number | null;
  reviewPeriodStart: string | null;
  reviewPeriodEnd: string | null;
  /** Last successful retrieval; this is not a review publication date. */
  observedAt: string | null;
  collectionBasis: CriticCollectionBasis;
  matchedIdentity: CriticMatchedIdentity | null;
  identityVerified: boolean;
  cadence: CriticCadence;
}
export type CriticFetchResult =
  | { status: "ok"; record: CriticRecord }
  | {
      status: "missing" | "error" | "rate_limited";
      error: string;
      httpStatus: number | null;
    };

/** Steam appdetails' attributed Metacritic value; it cannot be aligned. */
export interface SteamMetacriticReference {
  source: "steam";
  provider: "metacritic";
  steamAppId: number;
  score: number;
  url: string;
}

export interface PlayerReceptionSignal {
  score: number | null;
  reviewCount: number | null;
  observedAt?: string | null;
  source?: string;
  population?: string;
}

export interface RetainedPlayerSnapshot extends PlayerReceptionSignal {
  observedAt: string;
}

export interface CriticRecordValidation {
  ok: boolean;
  record: CriticRecord | null;
  reasons: CriticReason[];
}

export interface CriticFreshness {
  state: "fresh" | "stale" | "unknown";
  checkedAt: string | null;
  ageMs: number | null;
  maxAgeDays: number;
}

export interface ContrastOutcome {
  state: "classified" | "unavailable";
  alignment: AlignmentLabel | null;
  playerDirection: ReceptionDirection | null;
  criticDirection: ReceptionDirection | null;
  reasons: CriticReason[];
}

export interface CriticAlignmentOutcome {
  source: CriticSource;
  state: "classified" | "unavailable";
  /** Primary, review-time alignment. */
  alignment: AlignmentLabel | null;
  playerDirection: ReceptionDirection | null;
  criticDirection: ReceptionDirection | null;
  /** Current contrast is intentionally independent of the primary result. */
  currentContrast: ContrastOutcome;
  freshness: CriticFreshness;
  evidence: {
    critic: CriticRecord;
    reviewTimePlayerSnapshot: RetainedPlayerSnapshot | null;
    currentPlayer: PlayerReceptionSignal | null;
  };
  reasons: CriticReason[];
}

export interface CriticComparisonContext {
  steamAppId: number;
  currentPlayer: PlayerReceptionSignal | null;
  /** Only actual retained snapshots may satisfy review-time alignment. */
  retainedPlayerSnapshots: readonly RetainedPlayerSnapshot[];
  asOf: string | Date;
}

export interface CriticSourcesComparison {
  outcomes: CriticAlignmentOutcome[];
  sourcesDiffer: boolean;
  /** Always null: providers remain source-specific and are never blended. */
  combinedConclusion: null;
  reasons: CriticReason[];
}

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (numeric === -1) return null;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function scoreOrNull(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (numeric === -1) return null;
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
}

function sourceDateOrNull(value: unknown): string | null {
  const text = cleanString(value);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

function normalizeTier(value: unknown): OpenCriticTier | null {
  const text = cleanString(value).toLowerCase();
  if (text === "weak") return "Weak";
  if (text === "fair") return "Fair";
  if (text === "strong") return "Strong";
  if (text === "mighty") return "Mighty";
  return null;
}

function normalizeSource(value: unknown): CriticSource | null {
  return value === "metacritic" || value === "opencritic" ? value : null;
}

function normalizeCadence(value: unknown): CriticCadence {
  return value === "weekly" ? "weekly" : "monthly";
}

function normalizeCollectionBasis(value: unknown): CriticCollectionBasis {
  return value === "public_page" || value === "authorized_api" ? value : "unavailable";
}

function normalizePlatform(value: unknown): CriticPlatform {
  return value === "pc" || value === "mixed" || value === "console" || value === "unknown" ? value : "unknown";
}

function normalizePlatforms(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function normalizeMatchedIdentity(value: unknown): CriticMatchedIdentity | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const steamAppId = positiveInteger(raw.steamAppId);
  if (steamAppId === null) return null;
  return {
    steamAppId,
    platformScope: normalizePlatform(raw.platformScope),
    edition: cleanString(raw.edition),
    evidence: cleanString(raw.evidence) || null,
  };
}

/**
 * Normalizes the canonical provider shape without making missing values look
 * like zero. This is intentionally not a fetch/parser adapter.
 */
export function normalizeCriticRecord(input: unknown): CriticRecord | null {
  const raw = asRecord(input);
  if (!raw) return null;
  const source = normalizeSource(raw.source);
  const steamAppId = positiveInteger(raw.steamAppId);
  if (!source || steamAppId === null) return null;
  return {
    source,
    sourceUrl: cleanString(raw.sourceUrl),
    sourceId: cleanString(raw.sourceId),
    steamAppId,
    title: cleanString(raw.title),
    slug: cleanString(raw.slug),
    edition: cleanString(raw.edition),
    platforms: normalizePlatforms(raw.platforms),
    platformScope: normalizePlatform(raw.platformScope),
    score: scoreOrNull(raw.score),
    tier: normalizeTier(raw.tier),
    reviewCount: nonnegativeIntegerOrNull(raw.reviewCount),
    percentRecommended: scoreOrNull(raw.percentRecommended),
    reviewPeriodStart: sourceDateOrNull(raw.reviewPeriodStart),
    reviewPeriodEnd: sourceDateOrNull(raw.reviewPeriodEnd),
    observedAt: sourceDateOrNull(raw.observedAt),
    collectionBasis: normalizeCollectionBasis(raw.collectionBasis),
    matchedIdentity: normalizeMatchedIdentity(raw.matchedIdentity),
    identityVerified: raw.identityVerified === true,
    cadence: normalizeCadence(raw.cadence),
  };
}

function pushReason(reasons: CriticReason[], reason: CriticReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/** Validates source attribution and exact identity, without applying time gates. */
export function validateCriticRecord(input: unknown, expectedSteamAppId?: number): CriticRecordValidation {
  const record = normalizeCriticRecord(input);
  if (!record) return { ok: false, record: null, reasons: ["record_invalid"] };

  const reasons: CriticReason[] = [];
  if (!record.sourceId) pushReason(reasons, "source_id_missing");
  if (!record.sourceUrl) pushReason(reasons, "source_url_missing");
  if (!record.title) pushReason(reasons, "title_missing");
  if (record.collectionBasis === "unavailable") pushReason(reasons, "permission_missing");
  if (!record.identityVerified && !record.matchedIdentity) pushReason(reasons, "identity_unverified");
  if (expectedSteamAppId !== undefined && record.steamAppId !== expectedSteamAppId) pushReason(reasons, "appid_mismatch");
  if (record.matchedIdentity) {
    if (record.matchedIdentity.steamAppId !== record.steamAppId) pushReason(reasons, "appid_mismatch");
    if (record.matchedIdentity.platformScope !== "pc" && record.matchedIdentity.platformScope !== "mixed") pushReason(reasons, "platform_not_pc");
    if (record.matchedIdentity.edition && record.edition && record.matchedIdentity.edition !== record.edition) pushReason(reasons, "edition_unverified");
  }
  if (record.platformScope !== "pc" && record.platformScope !== "mixed") pushReason(reasons, "platform_not_pc");
  return { ok: reasons.length === 0, record, reasons };
}

/** A Steam appdetails Metacritic score is display evidence, not alignment evidence. */
export function normalizeSteamMetacriticReference(input: unknown): SteamMetacriticReference | null {
  const raw = asRecord(input);
  if (!raw || raw.source !== "steam" || raw.provider !== "metacritic") return null;
  const steamAppId = positiveInteger(raw.steamAppId);
  const score = scoreOrNull(raw.score);
  const url = cleanString(raw.url);
  if (steamAppId === null || score === null || !url) return null;
  return { source: "steam", provider: "metacritic", steamAppId, score, url };
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateWindow(record: CriticRecord): { start: Date; end: Date; endExclusive: boolean } | null {
  if (!record.reviewPeriodStart || !record.reviewPeriodEnd) return null;
  const start = toDate(record.reviewPeriodStart);
  const end = toDate(record.reviewPeriodEnd);
  if (!start || !end || end < start) return null;
  return { start, end, endExclusive: isDateOnly(record.reviewPeriodEnd) };
}

function isWithinReviewWindow(observedAt: string, window: { start: Date; end: Date; endExclusive: boolean }): boolean {
  const observed = toDate(observedAt);
  if (!observed || observed < window.start) return false;
  return window.endExclusive ? observed < new Date(window.end.getTime() + DAY_MS) : observed <= window.end;
}

/**
 * Retrieval freshness is based on the last successful check. Publication age
 * (reviewPeriodStart/reviewPeriodEnd) is deliberately not used for this.
 */
export function getCriticFreshness(record: CriticRecord, asOf: string | Date = new Date()): CriticFreshness {
  const maxAgeDays = record.cadence === "weekly" ? WEEKLY_STALE_AFTER_DAYS : MONTHLY_STALE_AFTER_DAYS;
  const checkedAt = record.observedAt;
  const now = toDate(asOf);
  const checked = toDate(checkedAt);
  if (!checkedAt || !checked) return { state: "unknown", checkedAt: checkedAt ?? null, ageMs: null, maxAgeDays };
  if (!now) return { state: "unknown", checkedAt, ageMs: null, maxAgeDays };
  const ageMs = now.getTime() - checked.getTime();
  if (ageMs < 0) return { state: "unknown", checkedAt, ageMs, maxAgeDays };
  return {
    state: ageMs <= maxAgeDays * DAY_MS ? "fresh" : "stale",
    checkedAt,
    ageMs,
    maxAgeDays,
  };
}

export function classifyPlayerScore(score: number | null | undefined): ReceptionDirection | null {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) return null;
  if (score < 40) return "unfavorable";
  if (score < 70) return "mixed";
  return "favorable";
}

/** Source-native category mapping; no scores are subtracted or blended. */
export function classifyCriticRecord(record: CriticRecord): ReceptionDirection | null {
  if (record.source === "metacritic") {
    if (typeof record.score !== "number" || !Number.isFinite(record.score) || record.score < 0 || record.score > 100) return null;
    if (record.score < 50) return "unfavorable";
    if (record.score < 75) return "mixed";
    return "favorable";
  }
  if (record.tier === "Weak") return "unfavorable";
  if (record.tier === "Fair") return "mixed";
  if (record.tier === "Strong" || record.tier === "Mighty") return "favorable";
  if (typeof record.score === "number" && Number.isFinite(record.score) && record.score >= 0 && record.score <= 100) {
    if (record.score < 50) return "unfavorable";
    if (record.score < 75) return "mixed";
    return "favorable";
  }
  return null;
}

function directionRank(direction: ReceptionDirection): number {
  return direction === "unfavorable" ? 0 : direction === "mixed" ? 1 : 2;
}

export function describeAlignment(
  playerDirection: ReceptionDirection,
  criticDirection: ReceptionDirection,
): AlignmentLabel {
  if (playerDirection === criticDirection) return "broadly_aligned";
  if (Math.abs(directionRank(playerDirection) - directionRank(criticDirection)) === 2) return "clearly_divergent";
  return directionRank(playerDirection) > directionRank(criticDirection)
    ? "players_more_favorable"
    : "critics_more_favorable";
}

function hasAtLeastReviews(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function playerSignalValid(signal: PlayerReceptionSignal | null): boolean {
  return signal !== null && hasAtLeastReviews(signal.reviewCount, MIN_PLAYER_REVIEW_COUNT) && classifyPlayerScore(signal.score) !== null;
}

function currentContrast(
  record: CriticRecord,
  validation: CriticRecordValidation,
  freshness: CriticFreshness,
  currentPlayer: PlayerReceptionSignal | null,
): ContrastOutcome {
  const reasons = [...validation.reasons];
  const criticDirection = classifyCriticRecord(record);
  const playerDirection = classifyPlayerScore(currentPlayer?.score);
  if (!hasAtLeastReviews(record.reviewCount, MIN_CRITIC_REVIEW_COUNT)) pushReason(reasons, "critic_reviews_insufficient");
  if (criticDirection === null) pushReason(reasons, "critic_metric_missing");
  if (!playerSignalValid(currentPlayer)) pushReason(reasons, "player_reviews_insufficient");
  if (playerDirection === null) pushReason(reasons, "player_score_missing");
  if (freshness.state === "unknown") {
    pushReason(reasons, record.observedAt ? "retrieval_timestamp_invalid" : "retrieval_timestamp_missing");
  } else if (freshness.state === "stale") {
    pushReason(reasons, "retrieval_stale");
  }
  const state = reasons.length === 0 ? "classified" : "unavailable";
  return {
    state,
    alignment: state === "classified" && playerDirection && criticDirection ? describeAlignment(playerDirection, criticDirection) : null,
    playerDirection,
    criticDirection,
    reasons,
  };
}
interface ReviewSnapshotSummary {
  selected: RetainedPlayerSnapshot | null;
  hasInsufficientReviews: boolean;
  hasMissingScore: boolean;
}

function inspectReviewSnapshots(
  record: CriticRecord,
  snapshots: readonly RetainedPlayerSnapshot[],
): ReviewSnapshotSummary {
  const window = dateWindow(record);
  const summary: ReviewSnapshotSummary = {
    selected: null,
    hasInsufficientReviews: false,
    hasMissingScore: false,
  };
  if (!window) return summary;
  let selectedAt = -Infinity;
  for (const snapshot of snapshots) {
    if (!isWithinReviewWindow(snapshot.observedAt, window)) continue;
    if (!hasAtLeastReviews(snapshot.reviewCount, MIN_PLAYER_REVIEW_COUNT)) summary.hasInsufficientReviews = true;
    if (classifyPlayerScore(snapshot.score) === null) summary.hasMissingScore = true;
    if (!hasAtLeastReviews(snapshot.reviewCount, MIN_PLAYER_REVIEW_COUNT) || classifyPlayerScore(snapshot.score) === null) continue;
    const observedAt = Date.parse(snapshot.observedAt);
    if (observedAt > selectedAt) {
      selectedAt = observedAt;
      summary.selected = snapshot;
    }
  }
  return summary;
}

/** Selects a real retained snapshot, never a reconstructed historical value. */
export function findReviewTimePlayerSnapshot(
  record: CriticRecord,
  snapshots: readonly RetainedPlayerSnapshot[],
): RetainedPlayerSnapshot | null {
  return inspectReviewSnapshots(record, snapshots).selected;
}

export function evaluateCriticAlignment(
  record: CriticRecord,
  context: CriticComparisonContext,
): CriticAlignmentOutcome {
  const validation = validateCriticRecord(record, context.steamAppId);
  const canonicalRecord = validation.record ?? record;
  const freshness = getCriticFreshness(canonicalRecord, context.asOf);
  const current = currentContrast(canonicalRecord, validation, freshness, context.currentPlayer);
  const reasons = [...validation.reasons];
  const criticDirection = classifyCriticRecord(canonicalRecord);
  const snapshotSummary = inspectReviewSnapshots(canonicalRecord, context.retainedPlayerSnapshots);
  const reviewSnapshot = snapshotSummary.selected;
  const playerDirection = classifyPlayerScore(reviewSnapshot?.score);

  if (!hasAtLeastReviews(canonicalRecord.reviewCount, MIN_CRITIC_REVIEW_COUNT)) pushReason(reasons, "critic_reviews_insufficient");
  if (criticDirection === null) pushReason(reasons, "critic_metric_missing");
  if (!canonicalRecord.reviewPeriodStart || !canonicalRecord.reviewPeriodEnd) {
    pushReason(reasons, "review_dates_missing");
  } else if (!dateWindow(canonicalRecord)) {
    pushReason(reasons, "review_dates_invalid");
  }
  if (!reviewSnapshot) {
    if (snapshotSummary.hasInsufficientReviews) {
      pushReason(reasons, "player_reviews_insufficient");
    } else if (snapshotSummary.hasMissingScore) {
      pushReason(reasons, "player_score_missing");
    } else {
      pushReason(reasons, "player_snapshot_missing");
    }
  }
  if (reviewSnapshot && playerDirection === null) pushReason(reasons, "player_score_missing");
  if (freshness.state === "unknown") {
    pushReason(reasons, canonicalRecord.observedAt ? "retrieval_timestamp_invalid" : "retrieval_timestamp_missing");
  } else if (freshness.state === "stale") {
    pushReason(reasons, "retrieval_stale");
  }

  const state = reasons.length === 0 ? "classified" : "unavailable";
  return {
    source: canonicalRecord.source,
    state,
    alignment: state === "classified" && playerDirection && criticDirection ? describeAlignment(playerDirection, criticDirection) : null,
    playerDirection,
    criticDirection,
    currentContrast: current,
    freshness,
    evidence: {
      critic: canonicalRecord,
      reviewTimePlayerSnapshot: reviewSnapshot,
      currentPlayer: context.currentPlayer,
    },
    reasons,
  };
}

/**
 * Evaluates providers independently. Even when both are available, there is
 * intentionally no combined critic score or conclusion.
 */
export function compareCriticSources(
  records: readonly CriticRecord[],
  context: CriticComparisonContext,
): CriticSourcesComparison {
  const outcomes = records.map((record) => evaluateCriticAlignment(record, context));
  const classified = outcomes.filter((outcome) => outcome.state === "classified");
  const criticDirections = new Set(classified.map((outcome) => outcome.criticDirection));
  const sourcesDiffer = classified.length > 1 && criticDirections.size > 1;
  const reasons: CriticReason[] = [];
  if (sourcesDiffer) reasons.push("critic_sources_differ");
  return { outcomes, sourcesDiffer, combinedConclusion: null, reasons };
}
