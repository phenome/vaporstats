import type { AppDatabase } from "./db";
import { writeTransaction as transaction } from "./db-transaction";
import type { GeminiBatchUsage } from "./media-gemini";
import type { OpenRouterCompletion } from "./media-openrouter";
import {
  countsAsClientErrorPause,
  MAX_CLIENT_ERROR_PAUSES,
  MAX_UNCERTAIN_OUTCOMES_PER_JOB,
  MAX_UNCERTAIN_SENDS,
  PAID_PROVIDERS,
  pauseProvider,
  type PaidWorkCost,
  PROCESSING_STOP_REASONS,
  type ProcessingStopReason,
  transientRetryAt,
  type PaidProvider,
  type ProviderOutcome,
} from "./media-paid-providers";

// Paid-work mutations and reporting share the job and attempt history here.
// Callers supply classified outcomes and persist domain outputs inside the
// ledger's settlement transaction.

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function rows<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(query).bind(...values).all<T>()).results ?? [];
}

export type SimilarityDimension = "gameplay" | "story_world";
type QueuedIdentity = Pick<JobRow, "provider" | "model" | "config_version" | "max_output_tokens" | "input_identity">;
type RetryIdentity = (db: AppDatabase, job: JobRow) => Promise<QueuedIdentity>;
type UnsuccessfulOutcome = Exclude<ProviderOutcome, { class: "success" }>;
type TransitionReport = { reason?: ProcessingStopReason; paused?: boolean };
type ProviderAnswer =
  | { provider: "openrouter"; answer: OpenRouterCompletion }
  | { provider: "gemini"; usage: GeminiBatchUsage | null };
export type ProviderObservation = { detail?: string; answer?: ProviderAnswer };

// Documented Gemini Batch prices, used only to estimate the cost of settled
// work for reporting. They never decide whether work is submitted. Text
// batches submitted to Gemini before the move to OpenRouter still settle.
const INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.125;
const OUTPUT_PRICE_MICRO_USD_PER_TOKEN = 0.75;
const EMBEDDING_INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.1;
/**
 * What one authorized processing run did with media outputs: article
 * extractions, game Overviews and their embeddings. The counts are durable on
 * the run's authorization.
 */
export interface MediaProcessingOutputCounts {
  /** Outputs produced for a source, game or dimension that had none before. */
  new: number;
  /** Active outputs for the run's games that the run kept without producing them. */
  reused: number;
  /** Outputs produced to supersede an earlier version. */
  replaced: number;
  /** Active outputs withdrawn because their article content changed. */
  invalidated: number;
  /**
   * In-scope work that produced no output: an unreachable or unusable article,
   * a refused request (token cap, invalid request or invalid output), or a
   * stale provider result. Transient failures and Credit pauses keep their
   * work queued and count nothing.
   */
  skipped: number;
}

const COUNTED_OUTPUT_COLUMNS = {
  new: "new_outputs",
  replaced: "replaced_outputs",
  invalidated: "invalidated_outputs",
  skipped: "skipped_outputs",
} as const;

/** Adds `count` outputs with `outcome` to `runId`'s durable output counts. */
export async function countOutputs(db: AppDatabase, runId: number, outcome: keyof typeof COUNTED_OUTPUT_COLUMNS, count = 1): Promise<void> {
  if (count <= 0) return;
  const column = COUNTED_OUTPUT_COLUMNS[outcome];
  await db.prepare(`UPDATE media_processing_authorizations SET ${column} = ${column} + ? WHERE run_id = ?`).bind(count, runId).run();
}

/**
 * The request key `runId` queues the work identified by `baseKey` under.
 * Work that was refused, failed, went stale, or became uncertain under an
 * earlier run is retried under a key of this run's own; such an outcome in
 * this run is final for the run, so only a later correction run re-attempts
 * it. Work a retained row reserved but never submitted is also queued under
 * a key of this run's own, so the retained row stays history.
 */
export async function runRequestKey(db: AppDatabase, baseKey: string, runId: number): Promise<string> {
  const base = await first<{ run_id: number; status: JobRow["status"]; retained: number }>(db, "SELECT run_id, status, retained FROM media_processing_jobs WHERE request_key = ?", baseKey);
  const unsubmittedHistory = base?.retained === 1 && base.status === "reserved";
  const endedEarlier = base !== null && base.run_id !== runId && (base.status === "failed" || base.status === "stale" || base.status === "refused" || base.status === "uncertain" || base.status === "uncertain_exhausted" || base.status === "client_error_exhausted");
  return unsubmittedHistory || endedEarlier ? `${baseKey}:retry:${runId}` : baseKey;
}

/**
 * The request key automatic work queues the work identified by `baseKey`
 * under, or null when that work already has an item: waiting, in flight,
 * settled, or ended refused, failed, stale or uncertain, which only a
 * correction set re-attempts. Work a retained row reserved but never
 * submitted is queued under a key of `runId`'s own, so the retained row
 * stays history.
 */
export async function automaticRequestKey(db: AppDatabase, baseKey: string, runId: number): Promise<string | null> {
  const retryPrefix = `${baseKey}:retry:`;
  const items = await rows<{ status: JobRow["status"]; retained: number }>(
    db,
    "SELECT status, retained FROM media_processing_jobs WHERE request_key = ? OR substr(request_key, 1, length(?)) = ?",
    baseKey,
    retryPrefix,
    retryPrefix,
  );
  if (items.some((item) => !(item.retained === 1 && item.status === "reserved"))) return null;
  return items.length > 0 ? `${retryPrefix}${runId}` : baseKey;
}

/**
 * Records how many active outputs for the run's bounded sources and entities
 * the run kept without producing them. It is a snapshot, so repeated advances
 * of one run do not add to it.
 */
export async function recordReusedOutputs(db: AppDatabase, runId: number, sourceIds: readonly number[], entities: readonly number[]): Promise<void> {
  return transaction(db, async () => {
    const reused = await first<{ count: number }>(
      db,
      `SELECT
         (SELECT COUNT(*) FROM media_article_extractions AS e
           WHERE e.active = 1 AND e.source_id IN (SELECT value FROM json_each(?1))
             AND NOT EXISTS (SELECT 1 FROM media_processing_jobs AS j WHERE j.run_id = ?3 AND j.stage = 'extraction' AND j.status = 'succeeded' AND j.source_id = e.source_id AND j.input_identity = e.input_identity))
       + (SELECT COUNT(*) FROM media_game_overviews AS o
           WHERE o.active = 1 AND o.appid IN (SELECT value FROM json_each(?2))
             AND NOT EXISTS (SELECT 1 FROM media_processing_jobs AS j WHERE j.run_id = ?3 AND j.stage = 'synthesis' AND j.status = 'succeeded' AND j.appid = o.appid AND j.input_identity = o.input_identity))
       + (SELECT COUNT(*) FROM media_game_embeddings AS m
           WHERE m.active = 1 AND m.appid IN (SELECT value FROM json_each(?2))
             AND NOT EXISTS (SELECT 1 FROM media_processing_jobs AS j WHERE j.run_id = ?3 AND j.stage = 'embedding' AND j.status = 'succeeded' AND j.appid = m.appid AND j.dimension = m.dimension AND j.input_identity = m.input_identity))
       AS count`,
      JSON.stringify(sourceIds),
      JSON.stringify(entities),
      runId,
    );
    await db.prepare("UPDATE media_processing_authorizations SET reused_outputs = ? WHERE run_id = ?").bind(Number(reused?.count ?? 0), runId).run();
  });
}

export async function outputCounts(db: AppDatabase, runId: number): Promise<MediaProcessingOutputCounts> {
  const row = await first<{ new_outputs: number; reused_outputs: number; replaced_outputs: number; invalidated_outputs: number; skipped_outputs: number }>(
    db,
    "SELECT new_outputs, reused_outputs, replaced_outputs, invalidated_outputs, skipped_outputs FROM media_processing_authorizations WHERE run_id = ?",
    runId,
  );
  return {
    new: Number(row?.new_outputs ?? 0),
    reused: Number(row?.reused_outputs ?? 0),
    replaced: Number(row?.replaced_outputs ?? 0),
    invalidated: Number(row?.invalidated_outputs ?? 0),
    skipped: Number(row?.skipped_outputs ?? 0),
  };
}

type JobStage = "extraction" | "embedding" | "synthesis" | "explanation";
/**
 * A paid-work queue item. `queued` items wait for their provider. `reserved`
 * and `failed` appear only on retained rows, written under the retired
 * lifetime allowance before the queue existed: new work that a provider or
 * validation definitely refuses is `refused`. `uncertain` marks an item in
 * flight; an uncertain outcome returns it to the queue, and its last allowed
 * one ends it `uncertain_exhausted`. An item that triggered its last allowed
 * pause for an unrecognized client error ends `client_error_exhausted`.
 */
type JobStatus = "queued" | "reserved" | "submitted" | "succeeded" | "failed" | "refused" | "uncertain" | "uncertain_exhausted" | "client_error_exhausted" | "stale";
export type JobRow = { id: number; retained: number; run_id: number; stage: JobStage; appid: number; matched_appid: number | null; dimension: SimilarityDimension | null; source_id: number | null; request_key: string; input_identity: string; model: string; config_version: string; max_input_tokens: number; max_output_tokens: number; reserved_microusd: number; charged_microusd: number | null; reservation_active: number; status: JobStatus; provider: PaidProvider; enqueued_at: string; attempt_count: number; provider_batch_id: string | null; output_json: string | null; usage_json: string; error: string | null };
const JOB_COLUMNS = "id, retained, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider, enqueued_at, attempt_count, provider_batch_id, output_json, usage_json, error";
/**
 * Items that wait in the queue for their provider. A retained row is history
 * and never waits: it is never deleted, submitted or returned to the queue,
 * whether or not its input still matches current work, and an authorized
 * run queues that work as an item of its own.
 */
const WAITING = "(status = 'queued' AND retained = 0)";
/** Retained submissions can still settle. Retained uncertain jobs are history. */
const UNRESOLVED = `(status = 'submitted' OR (status = 'uncertain' AND retained = 0) OR ${WAITING})`;
type QueueInput = {
  provider: PaidProvider;
  run_id: number;
  stage: Exclude<JobStage, "explanation">;
  appid: number;
  dimension?: SimilarityDimension | null;
  source_id: number | null;
  request_key: string;
  input_identity: string;
  model: string;
  config_version: string;
  max_output_tokens: number;
};

/**
 * Adds `item` to the paid-work queue for its provider, once per request key. It
 * holds no article text and reserves no money: the provider's credit limit is
 * the only spending limit. Returns whether it was added.
 */
export async function enqueuePaidWork(db: AppDatabase, item: QueueInput, now: Date): Promise<boolean> {
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO media_processing_jobs (run_id, stage, appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider, enqueued_at, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 'queued', ?, ?, '{}')",
  ).bind(item.run_id, item.stage, item.appid, item.dimension ?? null, item.source_id, item.request_key, item.input_identity, item.model, item.config_version, item.max_output_tokens, item.provider, now.toISOString()).run();
  return inserted.meta.changes === 1;
}

function estimatedCharge(inputTokens: number, outputTokens: number, stage: JobStage): number {
  return stage === "embedding"
    ? Math.ceil(inputTokens * EMBEDDING_INPUT_PRICE_MICRO_USD_PER_TOKEN)
    : Math.ceil(inputTokens * INPUT_PRICE_MICRO_USD_PER_TOKEN + outputTokens * OUTPUT_PRICE_MICRO_USD_PER_TOKEN);
}

function actualCharge(job: JobRow, usage: GeminiBatchUsage | null): number | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? usage.promptTokenCount;
  if (!Number.isFinite(input) || (input ?? -1) < 0) return null;
  if (job.stage === "embedding") return estimatedCharge(Number(input), 0, "embedding");
  const output = usage.outputTokens ?? usage.candidatesTokenCount;
  const thinking = usage.thinkingTokens ?? usage.thoughtsTokenCount ?? 0;
  if (!Number.isFinite(output) || !Number.isFinite(thinking) || (output ?? -1) < 0 || thinking < 0) return null;
  const outputThinking = Math.min(job.max_output_tokens, Number(output) + thinking);
  return estimatedCharge(Number(input), outputThinking, job.stage);
}

/**
 * The cost recorded when `job` settles, for reporting only: its token usage
 * at the documented batch price, marked estimated. Without provider usage it
 * is zero, marked unknown: neither token caps nor a retained row's
 * reservation are ever presented as spend.
 */
function settledCharge(job: JobRow, usage: GeminiBatchUsage | null): { microusd: number; source: "estimated" | "unknown" } {
  const charge = actualCharge(job, usage);
  return charge === null ? { microusd: 0, source: "unknown" } : { microusd: charge, source: "estimated" };
}

/**
 * The mark of an item whose request is in flight. It is written, with the
 * send time and the item's input identity already recorded, in a committed
 * write before the request is sent, so an item found with it after a restart
 * is uncertain: its request may have reached the provider.
 */
const IN_FLIGHT = "submission in progress";
const SENDING = `(status = 'uncertain' AND retained = 0 AND error = '${IN_FLIGHT}')`;
const WAITING_OR_SENDING = `(${WAITING} OR ${SENDING})`;
/** Why an item found in flight when an advance starts is uncertain: the application stopped while it was sent. */
const IN_FLIGHT_AT_STARTUP = "in_flight_at_startup";

/** The class an attempt's outcome is recorded with. */
type AttemptOutcome = "succeeded" | "refused" | "stale" | "uncertain" | "transient" | "credit_pause" | "missing_configuration";

/** The outcome a job written before per-attempt records existed reports for its one send. */
function legacyAttemptOutcome(status: JobStatus, error: string | null): AttemptOutcome | null {
  if (status === "succeeded" || status === "refused" || status === "stale") return status;
  if (status === "failed") return "refused";
  if (status === "uncertain_exhausted") return "uncertain";
  if (status === "uncertain") return error === IN_FLIGHT ? null : "uncertain";
  if (status === "submitted") return null;
  // A waiting item that was sent before kept an answer that did not settle it.
  return "transient";
}

/**
 * Gives job `jobId`, sent before per-attempt records existed, its one attempt
 * from its own recorded provider ids, usage and cost, so later attempts add
 * to that history instead of hiding it from cost reports. A job never sent,
 * or one with attempts, is left as it is.
 */
export async function recordLegacyAttempt(db: AppDatabase, jobId: number): Promise<void> {
  await transaction(db, () => backfillLegacyAttempt(db, jobId));
}

async function backfillLegacyAttempt(db: AppDatabase, jobId: number): Promise<void> {
  if (await first<{ id: number }>(db, "SELECT id FROM media_processing_attempts WHERE job_id = ? LIMIT 1", jobId)) return;
  const job = await first<{ provider: PaidProvider; input_identity: string; status: JobStatus; error: string | null; submitted_at: string | null; completed_at: string | null; enqueued_at: string; provider_batch_id: string | null; generation_id: string | null; routed_provider: string | null; routed_model: string | null; usage_json: string; charged_microusd: number | null; cost_source: string | null }>(
    db,
    "SELECT provider, input_identity, status, error, submitted_at, completed_at, enqueued_at, provider_batch_id, generation_id, routed_provider, routed_model, usage_json, charged_microusd, cost_source FROM media_processing_jobs WHERE id = ?",
    jobId,
  );
  if (!job || (job.submitted_at === null && job.provider_batch_id === null && job.charged_microusd === null)) return;
  await db.prepare("INSERT INTO media_processing_attempts (job_id, attempt, provider, input_identity, sent_at, outcome, provider_batch_id, generation_id, routed_provider, routed_model, usage_json, charged_microusd, cost_source, settled_at, error) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(jobId, job.provider, job.input_identity, job.submitted_at ?? job.enqueued_at, legacyAttemptOutcome(job.status, job.error), job.provider_batch_id, job.generation_id, job.routed_provider, job.routed_model, job.usage_json, job.charged_microusd, job.cost_source, job.charged_microusd === null ? null : job.completed_at, job.error === IN_FLIGHT ? null : job.error)
    .run();
}

/**
 * Marks waiting item `job` in flight with its send time and records the send
 * as its next attempt, in one committed write before the request is sent.
 * Returns whether the item was still waiting.
 */
export async function markInFlight(db: AppDatabase, job: JobRow, maxInputTokens: number, now: Date, maxOutputTokens: number = job.max_output_tokens): Promise<boolean> {
  let marked = false;
  await transaction(db, async () => {
    // History of a send recorded before per-attempt records existed comes first.
    await backfillLegacyAttempt(db, job.id);
    const update = await db.prepare(`UPDATE media_processing_jobs SET status = 'uncertain', error = '${IN_FLIGHT}', max_input_tokens = ?, max_output_tokens = ?, submitted_at = ? WHERE id = ? AND ${WAITING}`).bind(maxInputTokens, maxOutputTokens, now.toISOString(), job.id).run();
    if (update.meta.changes !== 1) return;
    marked = true;
    await db.prepare("INSERT INTO media_processing_attempts (job_id, attempt, provider, input_identity, sent_at) VALUES (?1, COALESCE((SELECT MAX(attempt) FROM media_processing_attempts WHERE job_id = ?1), 0) + 1, ?2, ?3, ?4)")
      .bind(job.id, job.provider, job.input_identity, now.toISOString()).run();
  });
  return marked;
}

/** The latest attempt of `jobId` while its outcome is not recorded yet. */
const OPEN_ATTEMPT = "id = (SELECT id FROM media_processing_attempts WHERE job_id = ?1 ORDER BY attempt DESC LIMIT 1) AND outcome IS NULL";

/** Records the outcome of `jobId`'s attempt in flight, if it has one. */
async function closeAttempt(db: AppDatabase, jobId: number, outcome: AttemptOutcome, error: string | null = null): Promise<void> {
  await db.prepare(`UPDATE media_processing_attempts SET outcome = ?2, error = ?3 WHERE ${OPEN_ATTEMPT}`).bind(jobId, outcome, error).run();
}

/** Records the Gemini batch that `jobId`'s attempt in flight created. */
async function recordAttemptBatch(db: AppDatabase, jobId: number, batchId: string): Promise<void> {
  await db.prepare(`UPDATE media_processing_attempts SET provider_batch_id = ?2 WHERE ${OPEN_ATTEMPT}`).bind(jobId, batchId).run();
}

/**
 * Records the usage and cost of `jobId`'s attempt in flight, settled at
 * `now`, and sets the job's recorded cost to the sum of all its attempts.
 */
async function recordAttemptCharge(db: AppDatabase, jobId: number, charge: { usageJson: string; microusd: number; source: string; generationId?: string | null; routedProvider?: string | null; routedModel?: string | null }, now: Date): Promise<void> {
  await db.prepare(`UPDATE media_processing_attempts SET usage_json = ?2, charged_microusd = ?3, cost_source = ?4, settled_at = ?5, generation_id = COALESCE(?6, generation_id), routed_provider = COALESCE(?7, routed_provider), routed_model = COALESCE(?8, routed_model) WHERE ${OPEN_ATTEMPT}`)
    .bind(jobId, charge.usageJson, charge.microusd, charge.source, now.toISOString(), charge.generationId ?? null, charge.routedProvider ?? null, charge.routedModel ?? null).run();
  await db.prepare("UPDATE media_processing_jobs SET charged_microusd = (SELECT SUM(charged_microusd) FROM media_processing_attempts WHERE job_id = ?1) WHERE id = ?1 AND EXISTS (SELECT 1 FROM media_processing_attempts WHERE job_id = ?1 AND charged_microusd IS NOT NULL)").bind(jobId).run();
}

/** Outcomes that settle what a send did, and so end an uncertain streak. */
const DEFINITE_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set(["succeeded", "refused", "stale"]);

/**
 * How many uncertain outcomes `jobId` has had for the input identity of its
 * latest attempt since its last definite outcome, counted back from that
 * attempt, and how many it has had in its lifetime. Only a definite outcome
 * (a success, a refusal or a stale answer) ends the streak; a transient
 * failure, a Credit pause or a configuration pause does not. An attempt for
 * another input identity starts a fresh streak but not a fresh lifetime count.
 */
async function uncertainOutcomes(db: AppDatabase, jobId: number): Promise<{ streak: number; lifetime: number }> {
  const recorded = await rows<{ outcome: AttemptOutcome | null; input_identity: string }>(db, "SELECT outcome, input_identity FROM media_processing_attempts WHERE job_id = ? ORDER BY attempt DESC", jobId);
  let streak = 0;
  for (const attempt of recorded) {
    if (attempt.input_identity !== recorded[0]!.input_identity) break;
    if (attempt.outcome !== null && DEFINITE_OUTCOMES.has(attempt.outcome)) break;
    if (attempt.outcome === "uncertain") streak += 1;
  }
  return { streak, lifetime: recorded.filter((attempt) => attempt.outcome === "uncertain").length };
}

/** Whether an item with these uncertain outcomes must stop as `uncertain_exhausted` instead of being resent. */
function uncertainLimitReached({ streak, lifetime }: { streak: number; lifetime: number }): boolean {
  return streak >= MAX_UNCERTAIN_SENDS || lifetime >= MAX_UNCERTAIN_OUTCOMES_PER_JOB;
}

/**
 * Acts on an uncertain outcome of `job`'s send: the provider may have
 * received it, so its outcome is unknown. The attempt is recorded uncertain.
 * The item returns to the queue, under the provider and identity it now
 * waits with, and is resent under the transient backoff and Credit pauses.
 * At `MAX_UNCERTAIN_SENDS` uncertain outcomes for one input identity without
 * a definite outcome between them, or `MAX_UNCERTAIN_OUTCOMES_PER_JOB` in its
 * lifetime, it ends `uncertain_exhausted`, and only a correction set resends
 * it. A retained row is history: it stays `uncertain` and never waits.
 */
async function retryUncertainItem(db: AppDatabase, job: JobRow, reason: string, now: Date, retryIdentity: RetryIdentity, detail: string | null = null): Promise<void> {
  const current = await first<{ status: JobStatus; retained: number; attempt_count: number }>(db, "SELECT status, retained, attempt_count FROM media_processing_jobs WHERE id = ?", job.id);
  if (!current || (current.status !== "uncertain" && current.status !== "submitted")) return;
  await backfillLegacyAttempt(db, job.id);
  const error = current.retained === 1 && detail !== null ? detail : `uncertain:${reason}`;
  await closeAttempt(db, job.id, "uncertain", error);
  if (current.retained === 1) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'uncertain', error = ? WHERE id = ?").bind(error, job.id).run();
    return;
  }
  if (uncertainLimitReached(await uncertainOutcomes(db, job.id))) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'uncertain_exhausted', error = ?, provider_batch_id = NULL, next_attempt_at = NULL, completed_at = ? WHERE id = ?").bind(`uncertain_exhausted:${reason}`, now.toISOString(), job.id).run();
    await countOutputs(db, job.run_id, "skipped");
    return;
  }
  const failures = current.attempt_count + 1;
  const queued = await retryIdentity(db, job);
  await db.prepare("UPDATE media_processing_jobs SET status = 'queued', provider = ?, model = ?, config_version = ?, max_output_tokens = ?, input_identity = ?, provider_batch_id = NULL, submitted_at = NULL, attempt_count = ?, next_attempt_at = ?, error = ? WHERE id = ?")
    .bind(queued.provider, queued.model, queued.config_version, queued.max_output_tokens, queued.input_identity, failures, transientRetryAt(failures, now, null).toISOString(), `uncertain:${reason}`, job.id).run();
}

/**
 * Items found uncertain when an advance starts: advances never overlap, so
 * an item still in flight was sent by a process that stopped before
 * recording its answer, and any other was held uncertain before uncertain
 * items were resent automatically. Each is acted on as an uncertain outcome.
 */
export async function recoverInFlight(db: AppDatabase, now: Date, retryIdentity: RetryIdentity): Promise<number[]> {
  return transaction(db, async () => {
    const found = await rows<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE status = 'uncertain' AND retained = 0 ORDER BY id`);
    for (const job of found) {
      const reason = job.error === IN_FLIGHT ? IN_FLIGHT_AT_STARTUP : (job.error ?? "no_response").replace(/^uncertain:/, "");
      await retryUncertainItem(db, job, reason, now, retryIdentity);
    }
    return found.map(({ run_id }) => run_id);
  });
}

/** Refuses `job` for its input identity with `reason`, counting it skipped once. */
export async function refuseItem(db: AppDatabase, job: JobRow, reason: string, now: Date): Promise<void> {
  await transaction(db, () => recordRefusal(db, job, reason, now));
}

async function recordRefusal(db: AppDatabase, job: JobRow, reason: string, now: Date): Promise<void> {
  const refused = await db.prepare(`UPDATE media_processing_jobs SET status = 'refused', error = ?, next_attempt_at = NULL, completed_at = ? WHERE id = ? AND ${WAITING_OR_SENDING}`).bind(reason, now.toISOString(), job.id).run();
  if (refused.meta.changes !== 1) return;
  await countOutputs(db, job.run_id, "skipped");
  await closeAttempt(db, job.id, "refused", reason);
}

/**
 * Resolves a waiting item whose work turned out to need no provider. An item
 * never sent never cost anything and is removed; one with recorded attempts
 * ends `stale`, so its attempts and their cost stay reported. If supplied,
 * `prepare` updates related output or source state in the same transaction
 * and returns whether the item needs no provider.
 */
export async function resolveWithoutProvider(
  db: AppDatabase,
  job: JobRow,
  prepare?: () => Promise<boolean>,
): Promise<void> {
  await transaction(db, async () => {
    if (prepare && !await prepare()) return;
    await backfillLegacyAttempt(db, job.id);
    await db.prepare(`UPDATE media_processing_jobs SET status = 'stale', next_attempt_at = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND ${WAITING} AND EXISTS (SELECT 1 FROM media_processing_attempts WHERE job_id = ?1)`).bind(job.id).run();
    await db.prepare(`DELETE FROM media_processing_jobs WHERE id = ? AND ${WAITING}`).bind(job.id).run();
  });
}

/**
 * Acts on a classified provider outcome that left `job` unsubmitted. A
 * transient outcome keeps it queued with backoff and counts an attempt; a
 * Credit pause or missing configuration pauses its provider and counts
 * nothing; a refusal refuses it for its input identity.
 */
export async function applyProviderOutcome(
  db: AppDatabase,
  job: JobRow,
  outcome: UnsuccessfulOutcome,
  now: Date,
  retryIdentity: RetryIdentity,
  { detail, answer }: ProviderObservation = {},
): Promise<TransitionReport> {
  if (answer) await transaction(db, () => recordProviderAnswer(db, job, answer, now));
  return transaction(db, async () => {
    if (outcome.class === "uncertain") {
      await retryUncertainItem(db, job, outcome.reason, now, retryIdentity, detail);
      return { reason: PROCESSING_STOP_REASONS.UNCERTAIN_SUBMISSION };
    }
    if (outcome.class === "refusal") {
      await recordRefusal(db, job, outcome.reason, now);
      return { reason: outcome.reason === PROCESSING_STOP_REASONS.INPUT_TOKEN_CAP
        ? PROCESSING_STOP_REASONS.INPUT_TOKEN_CAP
        : PROCESSING_STOP_REASONS.PROVIDER_REFUSAL };
    }
    if (outcome.class === "credit_pause" || outcome.class === "missing_configuration") {
      if (outcome.class === "missing_configuration" && countsAsClientErrorPause(outcome)) {
        await backOffClientError(db, job, now, { pause: outcome });
      } else {
        await db.prepare(`UPDATE media_processing_jobs SET status = 'queued', error = NULL, submitted_at = NULL WHERE id = ? AND ${SENDING}`).bind(job.id).run();
        await closeAttempt(db, job.id, outcome.class, outcome.reason);
      }
      await pauseProvider(db, job.provider, outcome.reason, now);
      return { paused: true };
    }
    const failures = job.attempt_count + 1;
    const retryAt = transientRetryAt(failures, now, outcome.retryAfterMs);
    const error = `transient:${outcome.reason}`;
    await db.prepare(`UPDATE media_processing_jobs SET status = 'queued', attempt_count = ?, next_attempt_at = ?, error = ?, submitted_at = NULL WHERE id = ? AND ${WAITING_OR_SENDING}`).bind(failures, retryAt.toISOString(), error, job.id).run();
    await closeAttempt(db, job.id, "transient", error);
    return { reason: PROCESSING_STOP_REASONS.TRANSIENT_PROVIDER_FAILURE };
  });
}

/** A client error and a throwing item share one retry count per input identity. */
async function backOffClientError(
  db: AppDatabase,
  job: JobRow,
  now: Date,
  failure: { pause: Extract<ProviderOutcome, { class: "missing_configuration" }> } | { detail: string },
): Promise<void> {
  const pause = "pause" in failure ? failure.pause : null;
  const current = await first<{ attempt_count: number; input_identity: string; client_error_pauses: number; client_error_identity: string | null }>(
    db,
    `SELECT attempt_count, input_identity, client_error_pauses, client_error_identity FROM media_processing_jobs WHERE id = ? AND ${pause ? WAITING_OR_SENDING : WAITING}`,
    job.id,
  );
  if (!current) return;
  if (pause) await closeAttempt(db, job.id, pause.class, pause.reason);
  const occurrences = (current.client_error_identity === current.input_identity ? current.client_error_pauses : 0) + 1;
  if (occurrences >= MAX_CLIENT_ERROR_PAUSES) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'client_error_exhausted', error = ?, next_attempt_at = NULL, completed_at = ?, client_error_pauses = ?, client_error_identity = ? WHERE id = ?")
      .bind(`client_error_exhausted:${pause?.reason ?? PROCESSING_STOP_REASONS.ITEM_ERROR}`, now.toISOString(), occurrences, current.input_identity, job.id).run();
    await countOutputs(db, job.run_id, "skipped");
    return;
  }
  const failures = current.attempt_count + 1;
  const error = "pause" in failure ? `client_error:${failure.pause.reason}` : `${PROCESSING_STOP_REASONS.ITEM_ERROR}:${failure.detail}`;
  await db.prepare(`UPDATE media_processing_jobs SET status = 'queued', attempt_count = ?, next_attempt_at = ?, error = ?, client_error_pauses = ?, client_error_identity = ?${pause ? ", submitted_at = NULL" : ""} WHERE id = ?`)
    .bind(failures, transientRetryAt(failures, now, null).toISOString(), error, occurrences, current.input_identity, job.id).run();
}

/**
 * Acts on an unexpected exception while `job` was handled: one no
 * classifier anticipated, such as a defect in handling its article. It is
 * caught at the item's boundary, so the advance's other items still
 * progress.
 *
 * - An item in flight or submitted may have reached its provider: it is
 *   uncertain, and returns to the queue under `retryUncertainItem`, which
 *   stops it after three sends as `uncertain_exhausted`.
 * - A waiting item is a problem on the project side, like an unrecognized
 *   client error: it is recorded with the bounded reason and backed off like
 *   a transient failure, and its `MAX_CLIENT_ERROR_PAUSES`-th occurrence for
 *   one input identity, counted with its client-error pauses, ends it
 *   `client_error_exhausted`, which only a correction set resends. It
 *   pauses no provider.
 *
 * A failure to record this outcome propagates to the media boundary.
 */
export async function recordItemError(db: AppDatabase, job: JobRow, reason: string, now: Date, retryIdentity: RetryIdentity): Promise<TransitionReport> {
  return transaction(db, async () => {
    const state = await first<{ status: JobStatus; error: string | null }>(db, "SELECT status, error FROM media_processing_jobs WHERE id = ?", job.id);
    if (state && ((state.status === "uncertain" && state.error === IN_FLIGHT) || state.status === "submitted")) {
      await retryUncertainItem(db, job, `${PROCESSING_STOP_REASONS.ITEM_ERROR}:${reason}`, now, retryIdentity);
      return { reason: PROCESSING_STOP_REASONS.UNCERTAIN_SUBMISSION };
    }
    await backOffClientError(db, job, now, { detail: reason });
    return {};
  });
}

/**
 * The cost an OpenRouter answer reports, for reporting only: `usage.cost`,
 * in credits, taken as US dollars. Without it the cost is zero, marked unknown.
 */
function reportedCharge(completion: OpenRouterCompletion): { microusd: number; source: "provider_reported" | "unknown" } {
  const cost = completion.usage.cost;
  return cost === null ? { microusd: 0, source: "unknown" } : { microusd: Math.round(cost * 1_000_000), source: "provider_reported" };
}

/**
 * Records what an OpenRouter answer to `job` reported on its attempt in
 * flight: its token usage, generation id, routed provider and model, and its
 * cost. The job keeps the latest answer's identifiers and usage, and the cost
 * of all its attempts, so a resent item keeps every charge.
 */
async function recordOpenRouterAnswer(db: AppDatabase, job: JobRow, answer: OpenRouterCompletion, now: Date): Promise<void> {
  const charge = reportedCharge(answer);
  const { promptTokens, completionTokens, reasoningTokens } = answer.usage;
  const usageJson = JSON.stringify({ promptTokens, completionTokens, ...(reasoningTokens === null ? {} : { reasoningTokens }) });
  await db.prepare("UPDATE media_processing_jobs SET usage_json = ?, cost_source = CASE WHEN cost_source = 'provider_reported' THEN cost_source ELSE ? END, generation_id = ?, routed_provider = ?, routed_model = ? WHERE id = ?")
    .bind(usageJson, charge.source, answer.generationId, answer.provider, answer.model, job.id).run();
  await recordAttemptCharge(db, job.id, { usageJson, microusd: charge.microusd, source: charge.source, generationId: answer.generationId, routedProvider: answer.provider, routedModel: answer.model }, now);
}

/** Records the usage and estimated cost a polled batch reported, on `job` and its attempt. */
async function recordGeminiBatchCharge(db: AppDatabase, job: JobRow, usage: GeminiBatchUsage | null, now: Date): Promise<void> {
  const usageJson = usage ? JSON.stringify(usage) : "{}";
  const charge = settledCharge(job, usage);
  await backfillLegacyAttempt(db, job.id);
  await db.prepare("UPDATE media_processing_jobs SET usage_json = ?, charged_microusd = ?, cost_source = ? WHERE id = ?").bind(usageJson, charge.microusd, charge.source, job.id).run();
  await recordAttemptCharge(db, job.id, { usageJson, microusd: charge.microusd, source: charge.source }, now);
}

/**
 * Returns the item of a batch the provider ended without running it to the
 * queue, under the provider and identity it now waits with. A retained row
 * is never returned to the queue: it ends `stale` with its recorded values
 * kept, and an authorized run queues its work anew.
 */
async function requeueUnrunBatch(db: AppDatabase, job: JobRow, retry: { attemptCount: number; nextAttemptAt: string | null; error: string | null }, now: Date, retryIdentity: RetryIdentity): Promise<void> {
  if (job.retained === 1) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', error = ?, completed_at = ? WHERE id = ? AND status = 'submitted'").bind(retry.error ?? "provider ended the batch without output", now.toISOString(), job.id).run();
    return;
  }
  const queued = await retryIdentity(db, job);
  await db.prepare("UPDATE media_processing_jobs SET status = 'queued', provider = ?, model = ?, config_version = ?, max_output_tokens = ?, input_identity = ?, provider_batch_id = NULL, submitted_at = NULL, attempt_count = ?, next_attempt_at = ?, error = ? WHERE id = ? AND status = 'submitted' AND retained = 0")
    .bind(queued.provider, queued.model, queued.config_version, queued.max_output_tokens, queued.input_identity, retry.attemptCount, retry.nextAttemptAt, retry.error, job.id).run();
}

export async function hasPendingExtractions(db: AppDatabase, appid: number): Promise<boolean> {
  return (await first<{ pending: number }>(db, `SELECT 1 AS pending FROM media_processing_jobs WHERE appid = ? AND stage = 'extraction' AND (status = 'submitted' OR ${WAITING}) LIMIT 1`, appid)) !== null;
}

/**
 * Whether `appid`'s active Overview is about to be replaced: an Overview
 * rebuild is queued, waiting or submitted, or extraction work that will
 * change its contributions is. Its embedding work then waits until the new
 * Overview is active, so no embedding is submitted for an Overview the same
 * advance replaces (#80).
 */
export async function overviewReplacementPending(db: AppDatabase, appid: number): Promise<boolean> {
  return (await first<{ pending: number }>(db, `SELECT 1 AS pending FROM media_processing_jobs WHERE appid = ? AND stage IN ('extraction', 'synthesis') AND (status = 'submitted' OR ${WAITING}) LIMIT 1`, appid)) !== null;
}

export async function activeOverviewAppids(db: AppDatabase, entities: readonly number[]): Promise<number[]> {
  const active = await rows<{ appid: number }>(db, "SELECT DISTINCT appid FROM media_game_overviews WHERE active = 1 AND appid IN (SELECT value FROM json_each(?)) ORDER BY appid", JSON.stringify(entities));
  return active.map(({ appid }) => appid);
}

/** Joins the batch identifier and status to the attempt recorded before submission. */
export async function recordSubmittedBatch(db: AppDatabase, job: JobRow, batchId: string): Promise<boolean> {
  return transaction(db, async () => {
    const update = await db.prepare(`UPDATE media_processing_jobs SET status = 'submitted', provider_batch_id = ?, error = NULL WHERE id = ? AND ${SENDING} AND provider_batch_id IS NULL`).bind(batchId, job.id).run();
    if (update.meta.changes !== 1) return false;
    await recordAttemptBatch(db, job.id, batchId);
    return true;
  });
}

type UnrunBatchOutcome = Extract<ProviderOutcome, { class: "credit_pause" | "missing_configuration" | "transient" }>;

export async function recordPollError(db: AppDatabase, job: JobRow, outcome: UnrunBatchOutcome, detail: string, now: Date): Promise<TransitionReport> {
  return transaction(db, async () => {
    await db.prepare("UPDATE media_processing_jobs SET error = ? WHERE id = ? AND status = 'submitted'").bind(detail, job.id).run();
    if (outcome.class === "transient") return {};
    await pauseProvider(db, job.provider, outcome.reason, now);
    return { paused: true };
  });
}

export async function returnUnrunBatch(db: AppDatabase, job: JobRow, outcome: UnrunBatchOutcome, now: Date, retryIdentity: RetryIdentity): Promise<TransitionReport> {
  return transaction(db, async () => {
    if (outcome.class === "transient") {
      const failures = job.attempt_count + 1;
      const error = `transient:${outcome.reason}`;
      await closeAttempt(db, job.id, "transient", error);
      await requeueUnrunBatch(db, job, { attemptCount: failures, nextAttemptAt: transientRetryAt(failures, now, null).toISOString(), error }, now, retryIdentity);
      return { reason: PROCESSING_STOP_REASONS.TRANSIENT_PROVIDER_FAILURE };
    }
    await closeAttempt(db, job.id, outcome.class, outcome.reason);
    await requeueUnrunBatch(db, job, { attemptCount: job.attempt_count, nextAttemptAt: null, error: null }, now, retryIdentity);
    await pauseProvider(db, job.provider, outcome.reason, now);
    return { paused: true };
  });
}

export type OutputSettlement =
  | { status: "succeeded"; outputJson: string; replaced: boolean }
  | { status: "refused"; error: string | null }
  | { status: "stale" };

async function recordProviderAnswer(db: AppDatabase, job: JobRow, answer: ProviderAnswer, now: Date): Promise<void> {
  if (answer.provider === "openrouter") await recordOpenRouterAnswer(db, job, answer.answer, now);
  else await recordGeminiBatchCharge(db, job, answer.usage, now);
}

/** Commits observed cost before atomically applying output, attempt outcome and authorization counts. */
export async function settleOutput(
  db: AppDatabase,
  job: JobRow,
  now: Date,
  answer: ProviderAnswer,
  persist: () => Promise<OutputSettlement>,
): Promise<OutputSettlement["status"]> {
  await transaction(db, () => recordProviderAnswer(db, job, answer, now));
  return transaction(db, async () => {
    const result = await persist();
    if (result.status === "succeeded") {
      await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?")
        .bind(result.outputJson, now.toISOString(), job.id).run();
      await countOutputs(db, job.run_id, result.replaced ? "replaced" : "new");
    } else {
      const error = result.status === "refused" ? result.error : null;
      const recordedError = error ?? (answer.provider === "gemini" ? job.error : null);
      await db.prepare("UPDATE media_processing_jobs SET status = ?, error = ?, completed_at = ? WHERE id = ?")
        .bind(result.status, recordedError, now.toISOString(), job.id).run();
      if (job.stage !== "explanation") await countOutputs(db, job.run_id, "skipped");
    }
    await closeAttempt(db, job.id, result.status);
    return result.status;
  });
}

export async function paidWorkRunAggregate(db: AppDatabase, runId: number) {
  return await first<{ succeeded: number; failed: number; uncertain: number; pending: number; jobs: number; hard: number; waiting: number }>(
    db,
    `SELECT COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
       COALESCE(SUM(status IN ('failed', 'refused', 'stale', 'client_error_exhausted')), 0) AS failed,
       COALESCE(SUM(status IN ('uncertain', 'uncertain_exhausted') OR (${WAITING} AND error LIKE 'uncertain:%')), 0) AS uncertain,
       COALESCE(SUM(${UNRESOLVED}), 0) AS pending,
       COUNT(*) AS jobs,
       COALESCE(SUM(status IN ('failed', 'uncertain_exhausted', 'client_error_exhausted') OR (status = 'refused' AND submitted_at IS NOT NULL)), 0) AS hard,
       COALESCE(SUM(${WAITING}), 0) AS waiting
     FROM media_processing_jobs WHERE run_id = ?`,
    runId,
  );
}

export function readyPaidWork(db: AppDatabase, provider: PaidProvider, now: Date): Promise<JobRow[]> {
  return rows<JobRow>(
    db,
    `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE provider = ? AND ${WAITING} AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)) ORDER BY julianday(enqueued_at), id`,
    provider,
    now.toISOString(),
  );
}

export function waitingEntityOrder(db: AppDatabase, provider: PaidProvider): Promise<Array<{ appid: number }>> {
  return rows<{ appid: number }>(
    db,
    `SELECT appid FROM media_processing_jobs WHERE provider = ? AND ${WAITING} GROUP BY appid ORDER BY MIN(julianday(enqueued_at)), appid`,
    provider,
  );
}

/**
 * Reports recorded cost: every attempt's settled charge, by the UTC month it
 * settled in, on the provider the attempt was sent to. A job recorded before
 * per-attempt records existed counts as its own one attempt. Reservations,
 * active or not, are never cost.
 */
export async function paidWorkCost(db: AppDatabase, now: Date): Promise<PaidWorkCost> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const providers = {} as PaidWorkCost["providers"];
  for (const provider of PAID_PROVIDERS) {
    const row = await db.prepare(
      `SELECT
         COALESCE(SUM(charged), 0) AS all_time,
         COALESCE(SUM(CASE WHEN julianday(settled_at) >= julianday(?2) AND julianday(settled_at) < julianday(?3) THEN charged ELSE 0 END), 0) AS month_to_date
       FROM (
         SELECT charged_microusd AS charged, settled_at FROM media_processing_attempts
         WHERE provider = ?1 AND charged_microusd IS NOT NULL
         UNION ALL
         SELECT charged_microusd, completed_at FROM media_processing_jobs AS job
         WHERE provider = ?1 AND charged_microusd IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM media_processing_attempts AS attempt WHERE attempt.job_id = job.id)
       )`,
    ).bind(provider, monthStart.toISOString(), nextMonth.toISOString()).first<{ all_time: number; month_to_date: number }>();
    providers[provider] = { monthToDateMicrousd: Number(row?.month_to_date ?? 0), allTimeMicrousd: Number(row?.all_time ?? 0) };
  }
  const uncertain = await db.prepare(
    "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE status IN ('uncertain', 'uncertain_exhausted') OR (status = 'queued' AND retained = 0 AND error LIKE 'uncertain:%')",
  ).first<{ count: number }>();
  return { reportingOnly: true, month: monthStart.toISOString().slice(0, 7), providers, uncertain: Number(uncertain?.count ?? 0) };
}

export async function activePaidWorkEntities(db: AppDatabase, provider: PaidProvider): Promise<Set<number>> {
  const active = await rows<{ appid: number }>(db, `SELECT DISTINCT appid FROM media_processing_jobs WHERE provider = ? AND (status = 'submitted' OR ${WAITING})`, provider);
  return new Set(active.map(({ appid }) => appid));
}

export async function waitingPaidWorkCount(db: AppDatabase, provider: PaidProvider): Promise<number> {
  const count = await first<{ count: number }>(db, `SELECT COUNT(*) AS count FROM media_processing_jobs WHERE provider = ? AND ${WAITING}`, provider);
  return Number(count?.count ?? 0);
}

export function submittedPaidWork(db: AppDatabase): Promise<JobRow[]> {
  return rows<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE status = 'submitted' ORDER BY id`);
}

export async function latestPaidWorkRun(db: AppDatabase): Promise<number | undefined> {
  const job = await first<{ run_id: number }>(db, "SELECT run_id FROM media_processing_jobs ORDER BY id DESC LIMIT 1");
  return job?.run_id;
}

export async function hasUnresolvedPaidWork(db: AppDatabase): Promise<boolean> {
  return (await first(db, `SELECT 1 FROM media_processing_jobs WHERE ${UNRESOLVED} LIMIT 1`)) !== null;
}

export async function hasOpenExtraction(db: AppDatabase, runId: number, sourceId: number): Promise<boolean> {
  return (await first(db, `SELECT 1 FROM media_processing_jobs WHERE run_id = ? AND source_id = ? AND stage = 'extraction' AND ${UNRESOLVED} LIMIT 1`, runId, sourceId)) !== null;
}

export async function hasRequestKey(db: AppDatabase, requestKey: string): Promise<boolean> {
  return (await first(db, "SELECT id FROM media_processing_jobs WHERE request_key = ?", requestKey)) !== null;
}

export async function hasSubmittedOrSucceededExtraction(db: AppDatabase, job: JobRow, sourceId: number, identity: string): Promise<boolean> {
  return (await first(db, "SELECT id FROM media_processing_jobs WHERE id <> ? AND stage = 'extraction' AND source_id = ? AND input_identity = ? AND status IN ('submitted', 'succeeded') LIMIT 1", job.id, sourceId, identity)) !== null;
}

export async function setWaitingInputIdentity(db: AppDatabase, job: JobRow, identity: string): Promise<void> {
  await db.prepare(`UPDATE media_processing_jobs SET input_identity = ? WHERE id = ? AND ${WAITING}`).bind(identity, job.id).run();
}
