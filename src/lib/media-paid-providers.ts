import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import type { OpenRouterCompletion } from "./media-openrouter";

/**
 * Paid providers of media work. Each has one response classifier, one pause
 * state and its own daily credit check. Spending authority lives with the
 * provider: VaporStats keeps no budget and only reports cost.
 */
export const PAID_PROVIDERS = ["gemini", "openrouter"] as const;
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
 *   key, a rejected key, a key without permission, a project precondition
 *   such as billing, or a model it no longer serves); it pauses and nothing
 *   fails or is refused.
 */
export type ProviderOutcome =
  | { class: "success" }
  | { class: "transient"; reason: string; retryAfterMs: number | null }
  | { class: "credit_pause"; reason: CreditPauseReason }
  | { class: "refusal"; reason: string }
  | { class: "uncertain"; reason: string }
  | { class: "missing_configuration"; reason: ConfigurationPauseReason };

export type CreditPauseReason =
  | "prepay_depleted" | "spend_cap"
  | "key_limit" | "credits" | "guardrail_budget" | "workspace_budget";
export type ConfigurationPauseReason = "missing_key" | "rejected_key" | "invalid_key" | "permission_denied" | "forbidden" | "failed_precondition" | "model_unavailable";
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

/**
 * A non-OK OpenRouter answer, as the chat-completion and key transport
 * receives it: an HTTP error status, or a 200 whose body holds only an
 * `error` object, which carries its code instead. OpenRouter sends a 200
 * once a provider has accepted the request, so such an error comes after
 * acceptance, when the request may already be charged.
 */
export class OpenRouterHttpError extends Error {
  readonly status: number;
  /** `error.metadata.limit_source`, such as `openrouter_key_limit`. */
  readonly limitSource: string | null;
  /** `error.metadata.error_type`, such as `permission_denied`. */
  readonly errorType: string | null;
  /** Whether the error carries moderation metadata: the input was flagged. */
  readonly moderated: boolean;
  /** How long the response asks the caller to wait, from `Retry-After`. */
  readonly retryAfterMs: number | null;
  /** Whether OpenRouter answered 200: a provider accepted the request before it failed. */
  readonly accepted: boolean;
  /** The generation id, routing and usage the answer reported, to record whatever its class. */
  readonly answer: OpenRouterCompletion | null;

  constructor(status: number, details: { limitSource?: string | null; errorType?: string | null; moderated?: boolean; retryAfterMs?: number | null; accepted?: boolean; answer?: OpenRouterCompletion | null } = {}) {
    // The provider's message can quote the request, so only the status is kept.
    super(`OpenRouter HTTP ${status}`);
    this.name = "OpenRouterHttpError";
    this.status = status;
    this.limitSource = details.limitSource ?? null;
    this.errorType = details.errorType ?? null;
    this.moderated = details.moderated ?? false;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.accepted = details.accepted ?? false;
    this.answer = details.answer ?? null;
  }
}

/** The OpenRouter transport cannot be built because no API key is configured. */
export class OpenRouterMissingKeyError extends Error {
  constructor() {
    super("OpenRouter API key is required");
    this.name = "OpenRouterMissingKeyError";
  }
}

/** `error_type`s of a 403 that refuse the request's content: a content policy, a refusal, or moderation. */
const OPENROUTER_CONTENT_REFUSAL = /content[\s_-]*polic|refus|moderat/i;

const OPENROUTER_BUDGET_PAUSES: Record<string, CreditPauseReason> = {
  openrouter_key_limit: "key_limit",
  openrouter_guardrail_budget: "guardrail_budget",
  openrouter_workspace_budget: "workspace_budget",
};

/**
 * Classifies one OpenRouter chat-completion or key request: `null` when it
 * answered, otherwise what it threw. Every chat completion may be charged,
 * so a failure that cannot prove the request was never fully sent is
 * uncertain: a client timeout, a connection lost after sending, or a
 * provider failure or timeout reported after a provider accepted it.
 */
export function classifyOpenRouterOutcome(error: unknown): ProviderOutcome {
  if (error === null || error === undefined) return { class: "success" };
  if (error instanceof OpenRouterMissingKeyError) return { class: "missing_configuration", reason: "missing_key" };
  if (error instanceof OpenRouterHttpError) {
    const { status, limitSource } = error;
    const retryAfterMs = error.retryAfterMs !== null && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : null;
    // After acceptance, a provider failure or timeout leaves unknown whether
    // the request was charged, so it is never resent automatically.
    if (error.accepted && (status === 408 || status >= 500)) return { class: "uncertain", reason: `accepted_http_${status}` };
    if (status === 402 && limitSource === "openrouter_in_flight_budget") return { class: "transient", reason: "in_flight_budget", retryAfterMs };
    if ((status === 402 || status === 403) && limitSource !== null && OPENROUTER_BUDGET_PAUSES[limitSource]) {
      return { class: "credit_pause", reason: OPENROUTER_BUDGET_PAUSES[limitSource]! };
    }
    // `openrouter_credits`, or a 402 without a limit source: the balance
    // cannot cover the request, and waiting will not help.
    if (status === 402) return { class: "credit_pause", reason: "credits" };
    if (status === 401) return { class: "missing_configuration", reason: "invalid_key" };
    if (status === 408 || status === 429 || status >= 500) return { class: "transient", reason: `http_${status}`, retryAfterMs };
    if (status === 404) return { class: "missing_configuration", reason: "model_unavailable" };
    // A 403 without a budget source refuses the request only for its
    // content. Any other 403, a key without permission included, is about the
    // configuration: it pauses, and never refuses an item.
    if (status === 403 && !error.moderated && !(error.errorType !== null && OPENROUTER_CONTENT_REFUSAL.test(error.errorType))) {
      return { class: "missing_configuration", reason: error.errorType === "permission_denied" ? "permission_denied" : "forbidden" };
    }
    if (status >= 400) return { class: "refusal", reason: `http_${status}` };
    return { class: "transient", reason: `http_${status}`, retryAfterMs };
  }
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  if (UNSENT_NETWORK_CODES.has(code)) return { class: "transient", reason: "network", retryAfterMs: null };
  const name = (error as { name?: unknown })?.name;
  return { class: "uncertain", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "no_response" };
}

/** What the daily credit check learned about the OpenRouter key. */
export type OpenRouterKeyCheck =
  | { class: "credit_remaining" }
  | { class: "credit_pause"; reason: CreditPauseReason }
  | { class: "missing_configuration"; reason: ConfigurationPauseReason }
  | { class: "check_failed"; reason: string };

function budgetSpent(value: unknown): CreditPauseReason | null {
  if (!value || typeof value !== "object") return null;
  const budget = value as { remaining_usd?: unknown; scope?: unknown };
  if (typeof budget.remaining_usd !== "number" || budget.remaining_usd > 0) return null;
  return budget.scope === "workspace" ? "workspace_budget" : budget.scope === "key_limit" ? "key_limit" : "guardrail_budget";
}

/**
 * Classifies the answer of the current-key endpoint (`GET /api/v1/key`):
 * its `data` object, or what the request threw. Credit remains when
 * `limit_remaining` is null (no key limit) or above zero and no budget,
 * `effective_budget` included, is spent.
 */
export function classifyOpenRouterKeyCheck(data: unknown, error: unknown = null): OpenRouterKeyCheck {
  if (error !== null && error !== undefined) {
    const outcome = classifyOpenRouterOutcome(error);
    if (outcome.class === "credit_pause" || outcome.class === "missing_configuration") return outcome;
    return { class: "check_failed", reason: outcome.class === "success" ? "no_answer" : outcome.reason };
  }
  if (!data || typeof data !== "object") return { class: "check_failed", reason: "invalid_answer" };
  const key = data as { limit_remaining?: unknown; budgets?: unknown; effective_budget?: unknown };
  if (key.limit_remaining !== null && typeof key.limit_remaining !== "number") return { class: "check_failed", reason: "invalid_answer" };
  if (typeof key.limit_remaining === "number" && key.limit_remaining <= 0) return { class: "credit_pause", reason: "key_limit" };
  for (const budget of [key.effective_budget, ...(Array.isArray(key.budgets) ? key.budgets : [])]) {
    const spent = budgetSpent(budget);
    if (spent) return { class: "credit_pause", reason: spent };
  }
  return { class: "credit_remaining" };
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
  /**
   * What the last daily credit check found: `probe` when it lifted the pause
   * for the next submission to probe credit, `not_paused`, `credit_remaining`,
   * a pause reason, or `check_failed:<reason>` when the check got no usable
   * answer.
   */
  checkOutcome: string | null;
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
  let stored: { reason?: unknown; pausedAt?: unknown; checkedAt?: unknown; checkOutcome?: unknown } = {};
  try { stored = JSON.parse((await readCheckpoint(db, providerKey(provider))) ?? "{}") ?? {}; } catch { stored = {}; }
  const reason = typeof stored.reason === "string" ? stored.reason as ProviderPauseReason : null;
  return {
    provider,
    paused: reason !== null,
    reason,
    pausedAt: reason !== null && typeof stored.pausedAt === "string" ? stored.pausedAt : null,
    checkedAt: typeof stored.checkedAt === "string" ? stored.checkedAt : null,
    checkOutcome: typeof stored.checkOutcome === "string" ? stored.checkOutcome : null,
  };
}

async function writeProviderState(db: AppDatabase, state: ProviderState): Promise<void> {
  await writeCheckpoint(db, providerKey(state.provider), JSON.stringify({ reason: state.reason, pausedAt: state.pausedAt, checkedAt: state.checkedAt, checkOutcome: state.checkOutcome }));
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

/** The credit checks that providers with a credit endpoint run; a provider without one is probed. */
export type CreditChecks = Partial<Record<PaidProvider, () => Promise<OpenRouterKeyCheck>>>;

/**
 * Runs the daily credit check when it is due: in the first call at or after
 * 06:00 UTC on a UTC day that has no check yet. A provider with a credit
 * endpoint in `checks` is asked first, outside any write transaction: when
 * credit remains its pause is lifted, when it reports no credit the provider
 * is paused, and when the check gets no usable answer the state is kept. A
 * provider without one has its Credit pause and configuration pause, except
 * a missing key's, lifted so its next submission probes credit. The day,
 * each provider's check time and its outcome are recorded in one write, so a
 * restart never runs it twice that day; a missed earlier day is never made
 * up. Returns the providers whose pause it lifted to probe.
 */
export async function runDailyCreditCheck(db: AppDatabase, now: Date, checks: CreditChecks = {}): Promise<PaidProvider[] | null> {
  if (now.getUTCHours() < CREDIT_CHECK_HOUR_UTC) return null;
  const day = now.toISOString().slice(0, 10);
  if (await readCheckpoint(db, CREDIT_CHECK_KEY) === day) return null;
  const answers = new Map<PaidProvider, OpenRouterKeyCheck>();
  for (const provider of PAID_PROVIDERS) {
    const check = checks[provider];
    if (check) answers.set(provider, await check());
  }
  const lifted: PaidProvider[] = [];
  await writeTransaction(db, async () => {
    if (await readCheckpoint(db, CREDIT_CHECK_KEY) === day) return;
    await writeCheckpoint(db, CREDIT_CHECK_KEY, day);
    const checkedAt = now.toISOString();
    for (const provider of PAID_PROVIDERS) {
      const state = await providerState(db, provider);
      const answer = answers.get(provider);
      if (!answer) {
        const probe = state.paused && state.reason !== "missing_key";
        if (probe) lifted.push(provider);
        await writeProviderState(db, probe
          ? { ...state, paused: false, reason: null, pausedAt: null, checkedAt, checkOutcome: "probe" }
          : { ...state, checkedAt, checkOutcome: state.paused ? state.reason : "not_paused" });
        continue;
      }
      if (answer.class === "credit_remaining") {
        await writeProviderState(db, { ...state, paused: false, reason: null, pausedAt: null, checkedAt, checkOutcome: "credit_remaining" });
      } else if (answer.class === "check_failed") {
        await writeProviderState(db, { ...state, checkedAt, checkOutcome: `check_failed:${answer.reason}` });
      } else {
        const pausedAt = state.reason === answer.reason ? state.pausedAt : checkedAt;
        await writeProviderState(db, { ...state, paused: true, reason: answer.reason, pausedAt, checkedAt, checkOutcome: answer.reason });
      }
    }
  });
  return lifted;
}

/**
 * When each entity last took a turn in `provider`'s queue: a sequence number
 * per entity, larger for a later turn. It is durable, so fair selection
 * continues across ticks and restarts instead of starting over each tick.
 */
export interface EntityTurns {
  next: number;
  last: Map<number, number>;
}

const turnsKey = (provider: PaidProvider) => `media:queue-turns:${provider}`;

export async function readEntityTurns(db: AppDatabase, provider: PaidProvider): Promise<EntityTurns> {
  let stored: { next?: unknown; last?: unknown } = {};
  try { stored = JSON.parse((await readCheckpoint(db, turnsKey(provider))) ?? "{}") ?? {}; } catch { stored = {}; }
  const last = new Map<number, number>();
  for (const [appid, turn] of Object.entries(stored.last && typeof stored.last === "object" ? stored.last : {})) {
    if (Number.isSafeInteger(Number(appid)) && Number.isSafeInteger(turn)) last.set(Number(appid), turn as number);
  }
  return { next: Number.isSafeInteger(stored.next) ? stored.next as number : 0, last };
}

export async function writeEntityTurns(db: AppDatabase, provider: PaidProvider, turns: EntityTurns): Promise<void> {
  await writeCheckpoint(db, turnsKey(provider), JSON.stringify({ next: turns.next, last: Object.fromEntries(turns.last) }));
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
