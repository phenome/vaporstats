import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";

/**
 * Paid providers of media work. Each has one response classifier, one pause
 * state and its own daily credit check. Spending authority lives with the
 * provider: VaporStats keeps no budget and only reports cost.
 */
export const PAID_PROVIDERS = ["gemini"] as const;
export type PaidProvider = (typeof PAID_PROVIDERS)[number];

/** A provider request kind. A token count and a poll are free and repeatable; a submission may be charged. */
export type PaidProviderCall = "count" | "submit" | "poll";

/**
 * The class of one provider response. Every caller acts on this class and
 * checks no status code of its own.
 *
 * - `success`: the provider answered the request.
 * - `transient`: the item stays queued and retries with backoff; never a failure.
 * - `credit_pause`: the provider reports exhausted credit or quota; it pauses
 *   until the next daily credit check, and no item counts an attempt.
 * - `refusal`: the request itself is unacceptable; the item is refused for
 *   its input identity and retried only within a correction set.
 * - `uncertain`: the request may have been charged without an answer; it is
 *   never resubmitted blindly.
 * - `missing_configuration`: the provider cannot be used as configured (no
 *   key, a rejected key, a project precondition such as billing, or a model
 *   it no longer serves); it pauses and nothing fails or is refused.
 */
export type ProviderOutcome =
  | { class: "success" }
  | { class: "transient"; reason: string; retryAfterMs: number | null }
  | { class: "credit_pause"; reason: CreditPauseReason }
  | { class: "refusal"; reason: string }
  | { class: "uncertain"; reason: string }
  | { class: "missing_configuration"; reason: ConfigurationPauseReason };

export type CreditPauseReason = "prepay_depleted" | "spend_cap";
export type ConfigurationPauseReason = "missing_key" | "rejected_key" | "failed_precondition" | "model_unavailable";
export type ProviderPauseReason = CreditPauseReason | ConfigurationPauseReason;

/** A non-OK Gemini HTTP response, as the batch transport receives it. */
export class GeminiHttpError extends Error {
  readonly status: number;
  /** The `error.status` code Google returns, such as `RESOURCE_EXHAUSTED`. */
  readonly apiStatus: string | null;
  /** How long the response asks the caller to wait, from `Retry-After` or a `RetryInfo` detail. */
  readonly retryAfterMs: number | null;
  /** The `ErrorInfo` reasons Google returns, such as `API_KEY_INVALID`. */
  readonly reasons: readonly string[];

  constructor(status: number, message: string, apiStatus: string | null = null, retryAfterMs: number | null = null, reasons: readonly string[] = []) {
    super(message);
    this.name = "GeminiHttpError";
    this.status = status;
    this.apiStatus = apiStatus;
    this.retryAfterMs = retryAfterMs;
    this.reasons = reasons;
  }
}

/** A Gemini batch that the provider reports as ended without output, with its bounded error message and batch state. */
export class GeminiBatchFailure extends Error {
  /** The batch state Google reported, such as `BATCH_STATE_EXPIRED`. */
  readonly batchState: string | null;

  constructor(message: string, batchState: string | null = null) {
    super(message);
    this.name = "GeminiBatchFailure";
    this.batchState = batchState;
  }
}

/** The Gemini transport cannot be built because no API key is configured. */
export class GeminiMissingKeyError extends Error {
  constructor() {
    super("Gemini API key is required");
    this.name = "GeminiMissingKeyError";
  }
}

/**
 * Connection failures that happen before any request byte reaches the
 * provider, so a submission that failed with one was certainly not received.
 */
const UNSENT_NETWORK_CODES = new Set([
  "ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "FailedToOpenSocket",
  "UND_ERR_CONNECT_TIMEOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const SPEND_CAP = /spend(?:ing)?[\s_-]*(?:cap|limit)/i;
const REJECTED_KEY_REASONS = new Set(["API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED"]);
const REJECTED_KEY = /api[\s_-]*key\s+(?:not\s+valid|invalid|expired)/i;
/** Batches the provider ended without running them: their items wait again. */
const ENDED_UNRUN_BATCH = /EXPIRE|CANCEL/i;
const CREDIT_DEPLETED = /prepay|credits?\s+(?:are\s+|is\s+)?(?:depleted|exhausted)|spend(?:ing)?[\s_-]*(?:cap|limit)/i;

function retryAfterFrom(error: GeminiHttpError): number | null {
  return error.retryAfterMs !== null && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : null;
}

/**
 * Classifies one Gemini outcome of `call`: `null` when the call returned,
 * otherwise what it threw. A batch that a poll reports as ended without
 * output is passed as a `GeminiBatchFailure`.
 *
 * An error about the project rather than the request (a rejected key, a
 * failed project precondition such as billing, or a model the provider no
 * longer serves) pauses the provider, so queued work waits instead of being
 * refused. Only a request that is itself unacceptable is refused. A poll
 * asks about one batch, so an error the provider gives a poll about that
 * batch leaves its item uncertain rather than refused.
 */
export function classifyGeminiOutcome(call: PaidProviderCall, error: unknown): ProviderOutcome {
  if (error === null || error === undefined) return { class: "success" };
  if (error instanceof GeminiMissingKeyError) return { class: "missing_configuration", reason: "missing_key" };
  if (error instanceof GeminiBatchFailure) {
    if (CREDIT_DEPLETED.test(error.message)) return { class: "credit_pause", reason: SPEND_CAP.test(error.message) ? "spend_cap" : "prepay_depleted" };
    if (error.batchState !== null && ENDED_UNRUN_BATCH.test(error.batchState)) return { class: "transient", reason: `batch_${error.batchState.replace(/^(?:BATCH|JOB)_STATE_/i, "").toLowerCase()}`, retryAfterMs: null };
    return { class: "refusal", reason: "batch_failed" };
  }
  if (error instanceof GeminiHttpError) {
    const status = error.status;
    if (status === 402) return { class: "credit_pause", reason: "prepay_depleted" };
    if (status === 429) {
      return SPEND_CAP.test(error.message)
        ? { class: "credit_pause", reason: "spend_cap" }
        : { class: "transient", reason: "http_429", retryAfterMs: retryAfterFrom(error) };
    }
    if (status === 408 || status >= 500) return { class: "transient", reason: `http_${status}`, retryAfterMs: retryAfterFrom(error) };
    if (status === 401 || status === 403 || error.reasons.some((reason) => REJECTED_KEY_REASONS.has(reason)) || REJECTED_KEY.test(error.message)) {
      return { class: "missing_configuration", reason: "rejected_key" };
    }
    if (error.apiStatus === "FAILED_PRECONDITION") return { class: "missing_configuration", reason: "failed_precondition" };
    if (call === "poll" && status >= 400) return { class: "uncertain", reason: `http_${status}` };
    if (status === 404) return { class: "missing_configuration", reason: "model_unavailable" };
    if (status >= 400) return { class: "refusal", reason: `http_${status}` };
    return { class: "transient", reason: `http_${status}`, retryAfterMs: null };
  }
  // A connection failure or timeout without an HTTP response. Counts and
  // polls are free to repeat. A submission is repeated only when the failure
  // proves the provider never received it.
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  if (call !== "submit" || UNSENT_NETWORK_CODES.has(code)) return { class: "transient", reason: "network", retryAfterMs: null };
  return { class: "uncertain", reason: "no_response" };
}

const TICK_MS = 15 * 60 * 1_000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000;

/**
 * When an item that just had its `failures`-th consecutive transient failure
 * may be submitted again: the next tick, then doubling, capped at 24 hours,
 * and never before the provider's `Retry-After`.
 */
export function transientRetryAt(failures: number, now: Date, retryAfterMs: number | null): Date {
  const backoff = Math.min(TICK_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
  return new Date(now.getTime() + Math.max(backoff, retryAfterMs ?? 0));
}

export interface ProviderState {
  provider: PaidProvider;
  paused: boolean;
  reason: ProviderPauseReason | null;
  /** When the current pause began. */
  pausedAt: string | null;
  /** When the last daily credit check ran for this provider. */
  checkedAt: string | null;
}

const providerKey = (provider: PaidProvider) => `media:provider:${provider}`;
const CREDIT_CHECK_KEY = "media:daily-credit-check";
const CREDIT_CHECK_HOUR_UTC = 6;

async function readCheckpoint(db: AppDatabase, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM checkpoints WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeCheckpoint(db: AppDatabase, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO checkpoints (key, value, cursor, updated_at) VALUES (?, ?, NULL, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").bind(key, value).run();
}

export async function providerState(db: AppDatabase, provider: PaidProvider): Promise<ProviderState> {
  let stored: { reason?: unknown; pausedAt?: unknown; checkedAt?: unknown } = {};
  try { stored = JSON.parse((await readCheckpoint(db, providerKey(provider))) ?? "{}") ?? {}; } catch { stored = {}; }
  const reason = typeof stored.reason === "string" ? stored.reason as ProviderPauseReason : null;
  return {
    provider,
    paused: reason !== null,
    reason,
    pausedAt: reason !== null && typeof stored.pausedAt === "string" ? stored.pausedAt : null,
    checkedAt: typeof stored.checkedAt === "string" ? stored.checkedAt : null,
  };
}

async function writeProviderState(db: AppDatabase, state: ProviderState): Promise<void> {
  await writeCheckpoint(db, providerKey(state.provider), JSON.stringify({ reason: state.reason, pausedAt: state.pausedAt, checkedAt: state.checkedAt }));
}

/** Pauses `provider` for `reason` from `now`; an existing pause keeps its start time. */
export async function pauseProvider(db: AppDatabase, provider: PaidProvider, reason: ProviderPauseReason, now: Date): Promise<void> {
  const state = await providerState(db, provider);
  if (state.reason === reason) return;
  await writeProviderState(db, { ...state, paused: true, reason, pausedAt: state.pausedAt ?? now.toISOString() });
}

/** Lifts a pause of `provider`, keeping its last credit check time. */
export async function liftProviderPause(db: AppDatabase, provider: PaidProvider): Promise<void> {
  const state = await providerState(db, provider);
  if (!state.paused) return;
  await writeProviderState(db, { ...state, paused: false, reason: null, pausedAt: null });
}

/**
 * Runs the daily credit check when it is due: in the first call at or after
 * 06:00 UTC on a UTC day that has no check yet. It records the day and lifts
 * every provider's Credit pause and configuration pause except a missing
 * key's in one write,
 * so a restart never runs it twice that day; a missed earlier day is never
 * made up. Returns the providers whose pause it lifted, which probe credit
 * with their next submission.
 */
export async function runDailyCreditCheck(db: AppDatabase, now: Date): Promise<PaidProvider[] | null> {
  if (now.getUTCHours() < CREDIT_CHECK_HOUR_UTC) return null;
  const day = now.toISOString().slice(0, 10);
  if (await readCheckpoint(db, CREDIT_CHECK_KEY) === day) return null;
  const lifted: PaidProvider[] = [];
  await writeTransaction(db, async () => {
    if (await readCheckpoint(db, CREDIT_CHECK_KEY) === day) return;
    await writeCheckpoint(db, CREDIT_CHECK_KEY, day);
    for (const provider of PAID_PROVIDERS) {
      const state = await providerState(db, provider);
      const probe = state.paused && state.reason !== "missing_key";
      if (probe) lifted.push(provider);
      await writeProviderState(db, probe
        ? { ...state, paused: false, reason: null, pausedAt: null, checkedAt: now.toISOString() }
        : { ...state, checkedAt: now.toISOString() });
    }
  });
  return lifted;
}

/** Model cost per provider, for reporting only: VaporStats compares it with nothing. */
export interface PaidWorkCost {
  reportingOnly: true;
  /** The UTC calendar month that `monthToDateMicrousd` covers, as `YYYY-MM`. */
  month: string;
  providers: Record<PaidProvider, { monthToDateMicrousd: number; allTimeMicrousd: number }>;
  /** Paid items submitted without an answer, including retained ones; their old reservations are not cost. */
  uncertain: number;
}

/**
 * Reports recorded cost: every settled charge, by the UTC month it settled
 * in. Reservations, active or not, are never cost.
 */
export async function paidWorkCost(db: AppDatabase, now: Date): Promise<PaidWorkCost> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const providers = {} as PaidWorkCost["providers"];
  for (const provider of PAID_PROVIDERS) {
    const row = await db.prepare(
      `SELECT
         COALESCE(SUM(charged_microusd), 0) AS all_time,
         COALESCE(SUM(CASE WHEN julianday(completed_at) >= julianday(?2) AND julianday(completed_at) < julianday(?3) THEN charged_microusd ELSE 0 END), 0) AS month_to_date
       FROM media_processing_jobs
       WHERE provider = ?1 AND charged_microusd IS NOT NULL`,
    ).bind(provider, monthStart.toISOString(), nextMonth.toISOString()).first<{ all_time: number; month_to_date: number }>();
    providers[provider] = { monthToDateMicrousd: Number(row?.month_to_date ?? 0), allTimeMicrousd: Number(row?.all_time ?? 0) };
  }
  const uncertain = await db.prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE status = 'uncertain'").first<{ count: number }>();
  return { reportingOnly: true, month: monthStart.toISOString().slice(0, 7), providers, uncertain: Number(uncertain?.count ?? 0) };
}
