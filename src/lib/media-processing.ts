import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { MIN_USABLE_ARTICLE_CHARS, parseArticleDocument } from "./article-document";
import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import { decodeVector, encodeVector, GEMINI_EMBEDDING_DIMENSIONS } from "./media-embedding-vector";
import {
  createGeminiBatchTransport,
  type GeminiBatchPoll,
  type GeminiBatchTransport,
  type GeminiFetch,
  type GeminiRequest,
} from "./media-gemini";
import {
  createMediaEvidenceSource,
  MEDIA_CATEGORY_NAMES,
  parseMediaOverview,
  parseMediaTagEvidence,
  type MediaEvidenceSource,
} from "./media-overview";
import {
  MAX_MEDIA_ARTICLES_PER_GAME,
  MEDIA_GAME_CHOICES,
  type MediaOutlet,
  type MediaPass,
} from "./media-discovery";
import { fetchOutletArticle, isOutletDenialStop } from "./media-outlet-access";
import {
  createOpenRouterTransport,
  type OpenRouterChatRequest,
  type OpenRouterReasoning,
  type OpenRouterCompletion,
  type OpenRouterFetch,
  type OpenRouterTransport,
} from "./media-openrouter";
import {
  boundedPaidWorkError,
  classifyGeminiOutcome,
  classifyOpenRouterKeyCheck,
  classifyOpenRouterOutcome,
  GeminiBatchFailure,
  OpenRouterHttpError,
  liftProviderPause,
  pauseProvider,
  PAID_PROVIDERS,
  PROCESSING_STOP_REASONS,
  providerState,
  readEntityTurns,
  writeEntityTurns,
  runDailyCreditCheck,
  dailyCreditCheckDue,
  recheckPausedProviders,
  type CreditChecks,
  type OpenRouterKeyCheck,
  type PaidProvider,
  type PaidWorkCost,
  type ProviderOutcome,
  type ProviderState,
} from "./media-paid-providers";
import {
  activeOverviewAppids,
  activePaidWorkEntities,
  applyProviderOutcome,
  automaticRequestKey,
  countOutputs,
  enqueuePaidWork,
  hasOpenExtraction,
  hasPendingExtractions,
  hasRequestKey,
  hasSubmittedOrSucceededExtraction,
  hasUnresolvedPaidWork,
  latestPaidWorkRun,
  markInFlight,
  outputCounts,
  overviewReplacementPending,
  paidWorkCost,
  paidWorkRunAggregate,
  readyPaidWork,
  recordItemError,
  recordLegacyAttempt,
  recordPollError,
  recordReusedOutputs,
  recordSubmittedBatch,
  recoverInFlight,
  refuseItem,
  resolveWithoutProvider,
  returnUnrunBatch,
  runRequestKey,
  setWaitingInputIdentity,
  settleOutput,
  submittedPaidWork,
  type JobRow,
  type MediaProcessingOutputCounts,
  type OutputSettlement,
  type ProviderObservation,
  type SimilarityDimension,
  waitingEntityOrder,
  waitingPaidWorkCount,
} from "./media-paid-ledger";
import {
  ELIGIBLE_MEDIA_ENTITY_SQL,
  GEMINI_EMBEDDING_CONFIG_VERSION,
  GEMINI_EMBEDDING_MODEL,
} from "./media-similarity";

export type { MediaProcessingOutputCounts } from "./media-paid-ledger";

/** The model that generates extractions and Overviews, through OpenRouter chat completions. */
export const OPENROUTER_TEXT_MODEL = "anthropic/claude-haiku-5.5";
const EXTRACTION_CONFIG_VERSION = "media-extraction-2026-09-13-v3";
const SYNTHESIS_CONFIG_VERSION = "media-synthesis-2026-11-18-v6";
const CLEANUP_VERSION = "media-cleanup-2026-09-11-v1";
/** How many paid items each provider may take from the queue in one ingestion tick. */
export const DEFAULT_PAID_SUBMISSIONS_PER_TICK = 60;
/** How long one advance may spend taking paid items from the queue before the rest wait for the next tick. */
export const DEFAULT_PAID_WORK_TIME_BUDGET_MS = 5 * 60 * 1_000;
/**
 * How text requests reason (ADR 0018, amended 2026-11-18). Claude Haiku 5.5
 * thinks adaptively and by default, at medium effort; low is its smallest
 * effort level, and a fixed reasoning budget is not accepted.
 */
const TEXT_REASONING: OpenRouterReasoning = { effort: "low" };
/**
 * The output caps of text requests, reasoning and answer combined (ADR 0018,
 * amended 2026-11-18). Each is a guard against a runaway answer, not an
 * answer budget: cost follows the tokens actually produced, and an answer cut
 * off at its cap pauses OpenRouter as `output_truncated`. The live run after
 * reasoning was set low produced an extraction answer of 1,240 tokens and cut
 * a four-source Overview off at 5,200.
 */
const EXTRACTION_MAX_OUTPUT_TOKENS = 8_000;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 16_000;
const EMBEDDING_MAX_OUTPUT_TOKENS = 1;
/**
 * The input cap of one OpenRouter request, in locally estimated tokens. It
 * keeps every request well below the 100K-token prompt size up to which the
 * documented price applies.
 */
const OPENROUTER_MAX_INPUT_TOKENS = 60_000;
/**
 * Bytes per token of the local input estimate. No OpenRouter token count
 * exists for Anthropic models; tokenizers average more than three bytes of
 * text per token, so this overestimates.
 */
const ESTIMATE_BYTES_PER_TOKEN = 3;
const MAX_EMBEDDING_INPUT_TOKENS = 8_192;
const SIMILARITY_DIMENSIONS = ["gameplay", "story_world"] as const;


const ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL = `app.is_eligible = 1 AND ${ELIGIBLE_MEDIA_ENTITY_SQL} AND (
  app.parent_appid IS NULL OR EXISTS (
    SELECT 1
    FROM apps AS root
    WHERE root.appid = app.parent_appid
      AND root.type = 'game'
      AND root.is_playable = 1
      AND root.is_eligible = 1
      AND root.parent_appid IS NULL
  )
)`;
const SIMILARITY_EXCLUDED_LANGUAGE = /\b(?:quality|rating|ratings|score|scores|popular(?:ity)?|prais(?:e|ed|ing)|acclaim(?:ed|ing)?|reception|critic(?:ism|isms|al)?|criticized|criticism|complaint|complaints|performance|bug(?:s)?|technical|technically|optimization|optimisation|framerate|frame rate|stutter(?:ing)?|crash(?:es|ed)?|awful|excellent|great|bad|good|poor|disappoint(?:ed|ing)?|enjoy(?:ment|able)?|fun)\b/i;

/**
 * An explicitly authorized set of media sources that a processing run may
 * refetch and reprocess in addition to sources new to processing. It may be
 * empty.
 */
export interface MediaProcessingScope {
  affectedSourceIds?: readonly number[];
}

export interface MediaProcessingSummary {
  runId: number;
  status: "queued" | "waiting" | "completed" | "stopped";
  submitted: number;
  completed: number;
  outputs: MediaProcessingOutputCounts;
  stopReasons: string[];
  failed: number;
  uncertain: number;
  overviewAppids: number[];
  /** Paid items waiting in the queue, across every run, by provider. */
  queued: Record<PaidProvider, number>;
  /** Each paid provider's state after this advance. */
  providers: Record<PaidProvider, ProviderState>;
  /** Recorded model cost, for reporting only, and the uncertain item count. */
  cost: PaidWorkCost;
}

export { createGeminiBatchTransport, type GeminiBatchPoll, type GeminiBatchTransport, type GeminiBatchUsage } from "./media-gemini";

export type MediaFetch = GeminiFetch;
export type ArticleFetch = (input: string, init?: RequestInit) => Promise<Response | string>;

export interface MediaProcessingOptions {
  runId?: number;
  transport?: GeminiBatchTransport;
  geminiApiKey?: string;
  /** The OpenRouter transport; built from `openRouterApiKey` when absent. */
  openRouter?: OpenRouterTransport;
  openRouterApiKey?: string;
  /** How long one OpenRouter request may take before its outcome becomes unknown. */
  openRouterTimeoutMs?: number;
  providerFetch?: MediaFetch;
  articleFetch?: ArticleFetch;
  now?: Date | (() => Date);
  /** How many paid items each provider may take from the queue in this advance. */
  submissionsPerTick?: number;
  /** How long this advance may spend taking paid items from the queue. */
  paidWorkTimeBudgetMs?: number;
  /** A monotonic clock in milliseconds that measures `paidWorkTimeBudgetMs`. */
  paidWorkClock?: () => number;
  /**
   * Automatic media ingestion: sources of enrolled entities that are new to
   * processing enter the queue without an authorization, attributed to this
   * scheduled discovery run, and their Overview and embedding work follows.
   */
  automaticRunId?: number;
  /** Providers whose pause the daily credit check just lifted, so they first submit a probe. */
  probe?: readonly PaidProvider[];
  /**
   * Only polls work already submitted, while automatic media ingestion is
   * disabled: no credit check, no new queue item and no paid submission.
   */
  pollOnly?: boolean;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { return null; }
}

function isoNow(value: Date | (() => Date) | undefined): Date {
  const result = typeof value === "function" ? value() : value;
  const date = result ?? new Date();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Invalid media processing clock");
  return new Date(date.getTime());
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function rows<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(query).bind(...values).all<T>()).results ?? [];
}

function transaction(db: AppDatabase, work: () => Promise<void>): Promise<void> {
  return writeTransaction(db, work);
}

/** How long a Gemini error asks to wait: its `Retry-After` header, else a `RetryInfo` detail. */
function cleanLine(value: string): string {
  return value.replace(/[\t ]+/g, " ").replace(/\s+([,.;!?])/g, "$1").trim();
}

/**
 * The article's readable text and its hash. The whole text is kept: the
 * per-request input cap alone decides whether it can be sent, so an article
 * is never extracted from a silently shortened text.
 */
function cleanArticle(html: string): { content: string; hash: string } | null {
  const document = parseArticleDocument(html);
  if (!document) return null;
  for (const node of Array.from(document.querySelectorAll("script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,[aria-label*='ad' i],[class*='ad' i],[id*='ad' i]"))) node.remove();
  let root: Element | null = document.querySelector("article");
  try {
    const readable = new Readability(document).parse() as { content?: string; textContent?: string } | null;
    if (readable?.content) root = parseArticleDocument(`<!doctype html><html><body>${readable.content}</body></html>`)?.body ?? root;
    if (!root && readable?.textContent) {
      const text = readable.textContent.split(/\n+/).map(cleanLine).filter(Boolean).join("\n");
      return text.length >= MIN_USABLE_ARTICLE_CHARS ? { content: text, hash: sha256(text) } : null;
    }
  } catch { /* article fallback below */ }
  root ??= document.body;
  if (!root) return null;
  const lines: string[] = [];
  for (const node of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote"))) {
    const text = cleanLine(node.textContent ?? "");
    if (!text) continue;
    const line = /^li$/i.test(node.tagName) ? `- ${text}` : text;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  if (lines.length === 0) lines.push(...(root.textContent ?? "").split(/\n+/).map(cleanLine).filter(Boolean));
  const content = lines.join("\n");
  return content.length >= MIN_USABLE_ARTICLE_CHARS ? { content, hash: sha256(content) } : null;
}

function metadataFor(source: SourceRow): Record<string, unknown> {
  return {
    appid: source.appid,
    originalUrl: source.original_url,
    title: source.title,
    outlet: source.outlet,
    author: source.author,
    publishedAt: source.published_at,
    updatedAt: source.updated_at,
    type: source.type,
    handsOn: source.hands_on,
    affiliation: source.affiliation,
    platform: source.platform,
    buildContext: source.build_context,
  };
}

function extractionIdentityFor(
  source: SourceRow,
  hash: string,
  model: string,
  configVersion: string,
  cleanupVersion: string,
): string {
  return sha256(stableJson({ stage: "extraction", hash, cleanupVersion, model, configVersion, metadata: metadataFor(source) }));
}

function extractionIdentity(source: SourceRow, hash: string): string {
  return extractionIdentityFor(source, hash, OPENROUTER_TEXT_MODEL, EXTRACTION_CONFIG_VERSION, CLEANUP_VERSION);
}

/** The input identity of new Overview work for `appid`'s current extractions. */
function synthesisIdentity(appid: number, extractions: ExtractionRow[]): string {
  return synthesisIdentityFor(appid, extractions, OPENROUTER_TEXT_MODEL, SYNTHESIS_CONFIG_VERSION);
}

/** Whether Overview work `job` still describes `extractions`, under the model and configuration it was queued with. */
function synthesisIsCurrent(job: JobRow, extractions: ExtractionRow[]): boolean {
  return synthesisIdentityFor(job.appid, extractions, job.model, job.config_version) === job.input_identity;
}

function synthesisIdentityFor(appid: number, extractions: ExtractionRow[], model: string, configVersion: string): string {
  return sha256(stableJson({ stage: "synthesis", appid, model, configVersion, extractions: extractions.map((row) => ({ sourceId: row.source_id, inputIdentity: row.input_identity })).sort((a, b) => a.sourceId - b.sourceId) }));
}

/** One OpenRouter chat completion for the text model that asks for JSON output. */
function chatRequest(maxTokens: number, ...messages: OpenRouterChatRequest["messages"]): OpenRouterChatRequest {
  return { model: OPENROUTER_TEXT_MODEL, messages, response_format: { type: "json_object" }, reasoning: TEXT_REASONING, max_tokens: maxTokens };
}

/** A conservative local estimate of `request`'s input tokens. */
function estimatedInputTokens(request: OpenRouterChatRequest): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(request.messages), "utf8") / ESTIMATE_BYTES_PER_TOKEN);
}

function makeExtractionRequest(source: SourceRow, content: string): OpenRouterChatRequest {
  return chatRequest(EXTRACTION_MAX_OUTPUT_TOKENS, { role: "system", content: `Analyze only this article about Steam app ${source.appid}. Return JSON only. Keep wording grounded in article evidence. Use these optional category names inside categories and contribution.category: ${MEDIA_CATEGORY_NAMES.join("; ")}. Top-level keys must be categories, contributions, traits, qualifications, provenance, and optional originatingAssessment and similarityInputs. similarityInputs may contain gameplay and storyWorld arrays of direct descriptive evidence about game mechanics or story/world themes. Do not use quality, ratings, popularity, praise, criticism, or technical complaints as similarity inputs. Do not invent unsupported dimensions. Contributions are objects with text and category; traits and qualifications are arrays of strings. Traits must be concise, factual game descriptors sourced only from the article.` }, { role: "user", content });
}

function makeSynthesisRequest(appid: number, name: string, extractions: ExtractionRow[], sources: SourceRow[]): OpenRouterChatRequest {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const evidence = extractions.map((row) => {
    const source = sourceById.get(row.source_id);
    return source ? {
      sourceIdentity: row.input_identity,
      sourceUrl: source.original_url,
      outlet: source.outlet,
      pass: source.pass,
      contentHash: row.content_hash,
      context: metadataFor(source),
      extraction: parseExtraction(row.output_json),
    } : null;
  }).filter((item) => item !== null);
  return chatRequest(SYNTHESIS_MAX_OUTPUT_TOKENS, { role: "user", content: `Synthesize the current assessments for ${name || `game ${appid}`}: each outlet's initial assessment (pass "initial") and any later assessment by an outlet already represented (pass "later"). A later article from the same outlet is that outlet's own follow-up, not additional support. A null publishedAt is an unknown date; never place such an article in time by inference. Return JSON only as {"statements":[{"text":"...","sourceUrls":["..."]}],"categories":[{"name":"...","findings":[{"text":"...","sourceUrls":["..."],"contested":true}]}],"prosCons":{"pros":[{"text":"...","sourceUrls":["..."]}],"cons":[...]},"tags":[{"label":"...","sourceUrls":["..."]}],"similarityInputs":{"gameplay":["..."],"storyWorld":["..."]}}. Write flowing, concise, game-first Overview statements. Write every Overview text field as a direct game observation; never mention coverage, critics, reviewers, reviews, outlets, publications, sources, assessments, agreement, consensus, or frequency. Multiple citation URLs communicate repeated support. Include only supported sections named ${MEDIA_CATEGORY_NAMES.join("; ")}; omit unsupported sections. Provide one global pros/cons overview, omit unsupported sides, and do not force neutral characteristics into pros or cons. Every entry must cite every supporting article URL. Tags are concise factual game descriptors and must be derived only from the supplied extraction.traits arrays, never from statements, categories, pros/cons, or summary wording. Cite every current extraction that supports each tag. Normalize semantically equivalent supported trait descriptions to one meaningful label without merging distinct characteristics or inventing missing traits. Preserve disputed traits when a supplied extraction supports them; do not include quality judgments, rankings, scores, reception, popularity, praise, performance, bugs, or technical complaints as tags. Return similarityInputs as the canonical aggregate of all supplied current extraction.contributions and any directly supported mechanics or story/world themes. Use gameplay for mechanics, systems, controls, combat, progression, and player-facing structure; use storyWorld for setting, narrative, characters, factions, and world themes. Keep each item a concise direct game description and omit a dimension when no supported evidence exists. Never put quality, praise, popularity, ratings, reception, criticism, performance, bugs, optimization, framerate, or other technical complaints in similarityInputs. Do not use Overview prose, tags, pros, or cons as similarityInputs. Evidence belongs only to app ${appid}; do not transfer incidental comparisons, DLC, expansion, bundle, or focused edition evidence.\n${JSON.stringify(evidence)}` });
}

const CATEGORY_NAMES = new Set<string>(MEDIA_CATEGORY_NAMES);

type Contribution = { text: string; category?: string; sourceIdentity: string };
type SimilarityInputs = { gameplay?: string[]; storyWorld?: string[] };
type StoredExtraction = {
  categories?: Record<string, string[]>;
  contributions: Contribution[];
  traits: string[];
  qualifications: string[];
  provenance: Array<{ sourceIdentity: string; sourceUrl: string }>;
  similarityInputs?: SimilarityInputs;
  originatingAssessment?: string;
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value
      .filter((item): item is string => typeof item === "string")
      .map((item) => cleanLine(item).slice(0, 1_000))
      .filter(Boolean))]
      .slice(0, 30)
    : [];
}

function similarityStrings(value: unknown): string[] {
  return strings(value).filter((item) => !SIMILARITY_EXCLUDED_LANGUAGE.test(item)).sort((left, right) => left.localeCompare(right));
}

function parseSimilarityInputs(value: unknown): SimilarityInputs | undefined {
  const root = jsonObject(value);
  const gameplay = similarityStrings(root.gameplay);
  const storyWorld = similarityStrings(root.storyWorld);
  if (gameplay.length === 0 && storyWorld.length === 0) return undefined;
  return {
    ...(gameplay.length > 0 ? { gameplay } : {}),
    ...(storyWorld.length > 0 ? { storyWorld } : {}),
  };
}

function parseExtraction(value: unknown): StoredExtraction {
  const root = jsonObject(parseJson(value));
  const rawCategories = jsonObject(root.categories);
  const categories: Record<string, string[]> = {};
  for (const name of CATEGORY_NAMES) {
    const values = strings(rawCategories[name]);
    if (values.length > 0) categories[name] = values;
  }
  const contributions: Contribution[] = [];
  if (Array.isArray(root.contributions)) {
    for (const item of root.contributions) {
      const object = jsonObject(item);
      const text = typeof object.text === "string" ? cleanLine(object.text).slice(0, 1_000) : "";
      const category = typeof object.category === "string" && CATEGORY_NAMES.has(object.category) ? object.category : null;
      if (text && category) {
        contributions.push({ text, category, sourceIdentity: typeof object.sourceIdentity === "string" ? object.sourceIdentity : "" });
      }
    }
  }
  const provenance = Array.isArray(root.provenance) ? root.provenance.map((item) => {
    const object = jsonObject(item);
    return { sourceIdentity: typeof object.sourceIdentity === "string" ? object.sourceIdentity : "", sourceUrl: typeof object.sourceUrl === "string" ? object.sourceUrl : "" };
  }).filter((item) => item.sourceIdentity && item.sourceUrl).slice(0, 30) : [];
  const originatingAssessment = typeof root.originatingAssessment === "string"
    ? cleanLine(root.originatingAssessment).slice(0, 500)
    : "";
  const similarityInputs = parseSimilarityInputs(root.similarityInputs);
  return {
    categories: Object.keys(categories).length > 0 ? categories : undefined,
    contributions: contributions.slice(0, 40),
    traits: strings(root.traits),
    qualifications: strings(root.qualifications),
    provenance,
    ...(similarityInputs ? { similarityInputs } : {}),
    ...(originatingAssessment ? { originatingAssessment } : {}),
  };
}

function storedExtractionJson(value: unknown, sourceIdentity: string, sourceUrl: string): string {
  const parsed = parseExtraction(value);
  const contributions = parsed.contributions.map((item) => ({ ...item, sourceIdentity }));
  return JSON.stringify({
    ...(parsed.categories ? { categories: parsed.categories } : {}),
    contributions,
    traits: parsed.traits,
    qualifications: parsed.qualifications,
    provenance: [{ sourceIdentity, sourceUrl }],
    ...(parsed.similarityInputs ? { similarityInputs: parsed.similarityInputs } : {}),
    ...(parsed.originatingAssessment ? { originatingAssessment: parsed.originatingAssessment } : {}),
  });
}

type AuthorizationRow = { run_id: number; status: string; stop_reason: string | null; billing_confirmation: string | null; affected_source_ids: string };

type SourceRow = { id: number; appid: number; pass: MediaPass; original_url: string; title: string; outlet: MediaOutlet; author: string | null; published_at: string | null; updated_at: string | null; retrieved_at: string; type: string; hands_on: number | null; affiliation: string | null; platform: string | null; build_context: string | null; normalized_content_hash: string | null; cleanup_version: string | null; processing_content: string | null; processing_input_identity: string | null; processing_run_id: number | null };
const SOURCE_COLUMNS = "id, appid, pass, original_url, title, outlet, author, published_at, updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context, normalized_content_hash, cleanup_version, processing_content, processing_input_identity, processing_run_id";
function parseAffectedSourceIds(value: string): number[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
}

/** Records that `runId` changed `sourceId`'s active contribution: it activated or withdrew the source's extraction. */
async function markContributionChanged(db: AppDatabase, sourceId: number, runId: number): Promise<void> {
  await db.prepare("UPDATE media_sources SET contribution_run_id = ? WHERE id = ?").bind(runId, sourceId).run();
}

/**
 * The games among `entities` that `runId` may give Overview and embedding
 * work: those whose current contributions the run changed, and those with a
 * source in the run's authorized affected set. Within these games a missing,
 * failed or refused Overview or embedding is built; a current one is kept.
 * Every other game keeps its outputs whatever its version identities or
 * earlier jobs, and receives no paid work.
 */
async function rebuildScopeGames(db: AppDatabase, runId: number, entities: readonly number[]): Promise<Set<number>> {
  const scoped = await rows<{ appid: number }>(
    db,
    `SELECT DISTINCT appid FROM media_sources
     WHERE appid IN (SELECT value FROM json_each(?2))
       AND (contribution_run_id = ?1
         OR id IN (SELECT value FROM media_processing_authorizations, json_each(affected_source_ids) WHERE run_id = ?1))`,
    runId,
    JSON.stringify(entities),
  );
  return new Set(scoped.map(({ appid }) => appid));
}

type ExtractionRow = { id: number; source_id: number; input_identity: string; content_hash: string; cleanup_version: string; model: string; config_version: string; output_json: string; active: number };
/**
 * What one advance does with the paid-work queue: the submission bound per
 * provider, which providers are paused, outlets stopped in this advance, and
 * the reasons and counts each run reports.
 */
type QueueAdvance = {
  db: AppDatabase;
  now: Date;
  clock: () => Date;
  transport: GeminiBatchTransport | null;
  openRouter: OpenRouterTransport | null;
  /** Configured provider keys, redacted from every recorded error. */
  secrets: Array<string | undefined>;
  /** Whether this advance has spent its time for taking paid items. */
  outOfTime: () => boolean;
  articleFetch: ArticleFetch;
  remaining: Record<PaidProvider, number>;
  paused: Set<PaidProvider>;
  outletStops: Map<MediaOutlet, string>;
  reasons: Map<number, Set<string>>;
  submitted: Map<number, number>;
  requestsSent: number;
  textSucceeded: number;
  textFailed: number;
};

function noteReason(advance: QueueAdvance, runId: number, reason: string): void {
  const reasons = advance.reasons.get(runId) ?? new Set<string>();
  reasons.add(reason);
  advance.reasons.set(runId, reasons);
}

async function holdItem(advance: QueueAdvance, job: JobRow, outcome: Exclude<ProviderOutcome, { class: "success" }>, observation?: ProviderObservation): Promise<void> {
  const report = await applyProviderOutcome(advance.db, job, outcome, advance.now, queuedIdentity, observation);
  if (report.paused) advance.paused.add(job.provider);
  if (report.reason) noteReason(advance, job.run_id, report.reason);
}

async function holdThrowingItem(advance: QueueAdvance, job: JobRow, error: unknown): Promise<void> {
  const reason = boundedPaidWorkError(error, advance.secrets);
  noteReason(advance, job.run_id, PROCESSING_STOP_REASONS.ITEM_ERROR);
  const report = await recordItemError(advance.db, job, reason, advance.now, queuedIdentity);
  if (report.reason) noteReason(advance, job.run_id, report.reason);
}

function countSubmission(advance: QueueAdvance, outcome: ProviderOutcome): void {
  // During submission, the network reason identifies a failure before the
  // request went out. Uncertain sends may already have reached the provider.
  if (outcome.class === "transient" && outcome.reason === "network") return;
  advance.requestsSent += 1;
}

/** Counts `request`'s input tokens, or returns the classified failure. A count is free and never uncertain. */
async function countItemTokens(transport: GeminiBatchTransport, model: string, request: GeminiRequest): Promise<number | Exclude<ProviderOutcome, { class: "success" }>> {
  try {
    return await transport.countTokens(model, request);
  } catch (error) {
    const outcome = classifyGeminiOutcome("count", error);
    return outcome.class === "success" ? { class: "transient", reason: "count_without_result", retryAfterMs: null } : outcome;
  }
}

/**
 * Counts and submits the Gemini embedding batch `request` for `job`. Before
 * the request is sent, the item is durably marked in flight with its send
 * time and recorded as an attempt, so a restart finds it uncertain and
 * resends it only under the ledger's bound. Every outcome is
 * classified once and acted on here. Without a transport
 * that submits embedding batches, Gemini waits paused for its key.
 */
async function sendItem(advance: QueueAdvance, job: JobRow, model: string, request: GeminiRequest, maxInputTokens: number): Promise<void> {
  const { db, now, transport } = advance;
  if (!transport?.submitEmbeddingBatch) return holdItem(advance, job, { class: "missing_configuration", reason: "missing_key" });
  const counted = await countItemTokens(transport, model, request);
  if (typeof counted !== "number") return holdItem(advance, job, counted);
  if (!Number.isInteger(counted) || counted < 0 || counted > maxInputTokens) {
    return holdItem(advance, job, { class: "refusal", reason: "input_token_cap" });
  }
  if (!await markInFlight(db, job, counted, now)) return;
  let result: { name: string } | null = null;
  let outcome: ProviderOutcome;
  try {
    result = await transport.submitEmbeddingBatch(job.model, [{ key: job.request_key, request }]);
    outcome = classifyGeminiOutcome("submit", null);
  } catch (error) {
    outcome = classifyGeminiOutcome("submit", error);
  }
  countSubmission(advance, outcome);
  if (outcome.class !== "success") return holdItem(advance, job, outcome);
  // Accepted without a batch to poll: whether it runs, and is charged, is unknown.
  if (!result?.name) return holdItem(advance, job, { class: "uncertain", reason: "no_batch_identifier" });
  if (await recordSubmittedBatch(db, job, result.name)) {
    advance.submitted.set(job.run_id, (advance.submitted.get(job.run_id) ?? 0) + 1);
  }
}

/**
 * Sends `request` for text item `job` as one OpenRouter chat completion.
 * Input over the cap, by a conservative local estimate, is refused unsent.
 * Before sending, the item is recorded in flight with its send time in a
 * committed write; its input identity is already recorded. No write
 * transaction is open while the request is in flight. A fully sent request
 * whose outcome is unknown is uncertain and returns the item to the queue
 * under the ledger's bound; every other outcome is classified
 * once and acted on here.
 * Without an OpenRouter transport, OpenRouter waits paused for its key.
 */
async function sendTextItem(advance: QueueAdvance, job: JobRow, request: OpenRouterChatRequest): Promise<void> {
  const { db, now, openRouter } = advance;
  if (!openRouter) return holdItem(advance, job, { class: "missing_configuration", reason: "missing_key" });
  const estimated = estimatedInputTokens(request);
  if (estimated > OPENROUTER_MAX_INPUT_TOKENS) return holdItem(advance, job, { class: "refusal", reason: "input_token_cap" });
  // An item queued under an earlier cap records the cap it is sent with.
  if (!await markInFlight(db, job, estimated, now, request.max_tokens)) return;
  let completion: OpenRouterCompletion | null = null;
  let outcome: ProviderOutcome;
  try {
    completion = await openRouter.complete(request);
    outcome = classifyOpenRouterOutcome(null, completion);
  } catch (error) {
    outcome = classifyOpenRouterOutcome(error);
    // An error answer can still report a generation and a charge.
    if (error instanceof OpenRouterHttpError) completion = error.answer ?? null;
  }
  countSubmission(advance, outcome);
  if (outcome.class !== "success") {
    // A cut-off answer or an error answer may still report a charge.
    const answer = completion ? { provider: "openrouter" as const, answer: completion } : undefined;
    return holdItem(advance, job, outcome, { answer });
  }
  advance.submitted.set(job.run_id, (advance.submitted.get(job.run_id) ?? 0) + 1);
  const answer = completion!;
  const status = await settleOutput(db, job, now, { provider: "openrouter", answer }, () =>
    job.stage === "extraction"
      ? persistExtraction(db, job, answer.content, now)
      : persistOverview(db, job, answer.content, now));
  if (status === "succeeded") advance.textSucceeded += 1;
  else advance.textFailed += 1;
}

async function currentSource(db: AppDatabase, sourceId: number): Promise<SourceRow | null> {
  return first<SourceRow>(db, `SELECT ${SOURCE_COLUMNS} FROM media_sources WHERE id = ?`, sourceId);
}
function similarityInputIdentity(dimension: SimilarityDimension, input: readonly string[]): string {
  return similarityInputIdentityFor(dimension, input, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION);
}

function similarityInputIdentityFor(dimension: SimilarityDimension, input: readonly string[], model: string, dimensions: number, configVersion: string): string {
  return sha256(stableJson({ stage: "embedding", dimension, input: [...input], model, dimensions, configVersion }));
}
function makeEmbeddingRequest(input: readonly string[]): GeminiRequest {
  return {
    model: `models/${GEMINI_EMBEDDING_MODEL}`,
    content: { parts: [{ text: input.join("\n") }] },
    embedContentConfig: { outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS },
  };
}

function similarityInputsForOverview(value: unknown): SimilarityInputs | undefined {
  return parseSimilarityInputs(jsonObject(parseJson(value)).similarityInputs);
}

function overviewSimilarityInput(value: unknown, dimension: SimilarityDimension): string[] {
  const inputs = similarityInputsForOverview(value);
  return inputs?.[dimension === "gameplay" ? "gameplay" : "storyWorld"] ?? [];
}

async function persistExtraction(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<OutputSettlement> {
  if (job.source_id === null) return { status: "refused", error: null };
  const source = await currentSource(db, job.source_id!);
  if (!source || source.processing_input_identity !== job.input_identity) {
    if (source) await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
    return { status: "stale" };
  }
  const eligible = await first<{ appid: number }>(
    db,
    `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`,
    source.appid,
  );
  if (!eligible) {
    await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
    return { status: "stale" };
  }
  const parsed = parseExtraction(output);
  if (parsed.contributions.length === 0 && parsed.traits.length === 0 && !parsed.categories && !parsed.similarityInputs) {
    await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
    return { status: "refused", error: "invalid_output: no supported contributions" };
  }
  const stored = storedExtractionJson(output, job.input_identity, source.original_url);
  const earlier = await first<{ id: number }>(db, "SELECT id FROM media_article_extractions WHERE source_id = ? LIMIT 1", source.id);
  await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
  await db.prepare("INSERT OR IGNORE INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(source.id, job.input_identity, source.normalized_content_hash ?? "", CLEANUP_VERSION, job.model, job.config_version, stored, now.toISOString()).run();
  await markContributionChanged(db, source.id, job.run_id);
  return { status: "succeeded", outputJson: stored, replaced: earlier !== null };
}

type GameEvidence = { sources: SourceRow[]; extractions: ExtractionRow[]; evidenceSources: Map<string, MediaEvidenceSource> };

/** `appid`'s sources, its active extractions, and the evidence each current extraction lends an Overview. */
async function currentGameEvidence(db: AppDatabase, appid: number): Promise<GameEvidence> {
  const sources = await rows<SourceRow>(db, `SELECT ${SOURCE_COLUMNS} FROM media_sources WHERE appid = ?`, appid);
  const extractions = await rows<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id IN (SELECT id FROM media_sources WHERE appid = ?) AND active = 1", appid);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const evidenceSources = new Map<string, MediaEvidenceSource>();
  for (const extraction of extractions) {
    const source = sourceById.get(extraction.source_id);
    if (!source) continue;
    const originatingAssessment = parseExtraction(extraction.output_json).originatingAssessment;
    evidenceSources.set(source.original_url, createMediaEvidenceSource({
      outlet: source.outlet,
      url: source.original_url,
      contentHash: extraction.content_hash,
      author: source.author,
      title: source.title,
      originatingAssessment,
      current: true,
    }));
  }
  return { sources, extractions, evidenceSources };
}

/**
 * Rewrites `appid`'s tag memberships to the tags of `overview`, the Overview
 * becoming active, each tied to the current extraction of a source it cites.
 * Every activation of an Overview calls it, so tag results match the active
 * Overview.
 */
async function replaceTagMemberships(db: AppDatabase, appid: number, overview: unknown, evidence: GameEvidence, now: Date): Promise<void> {
  await db.prepare("DELETE FROM media_tag_memberships WHERE appid = ?").bind(appid).run();
  const sourceByUrl = new Map(evidence.sources.map((source) => [source.original_url, source]));
  const extractionBySourceId = new Map(evidence.extractions.map((extraction) => [extraction.source_id, extraction]));
  for (const { tag, sourceUrls } of parseMediaTagEvidence(overview, evidence.evidenceSources)) {
    for (const sourceUrl of sourceUrls) {
      const source = sourceByUrl.get(sourceUrl);
      const extraction = source ? extractionBySourceId.get(source.id) : undefined;
      if (!source || !extraction) continue;
      await db.prepare("INSERT OR IGNORE INTO media_tag_memberships (appid, tag_slug, tag_label, source_id, extraction_input_identity, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(appid, tag.slug, tag.label, source.id, extraction.input_identity, now.toISOString()).run();
    }
  }
}

async function persistOverview(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<OutputSettlement> {
  const eligible = await first<{ appid: number }>(
    db,
    `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`,
    job.appid,
  );
  if (!eligible) {
    return { status: "stale" };
  }
  const evidence = await currentGameEvidence(db, job.appid);
  const { evidenceSources } = evidence;
  if (!synthesisIsCurrent(job, evidence.extractions)) {
    return { status: "stale" };
  }
  const tagEvidence = parseMediaTagEvidence(output, evidenceSources);
  const overview = parseMediaOverview(output, job.appid, evidenceSources);
  if (!overview) {
    return { status: "refused", error: "invalid_output: no cited statements" };
  }
  const similarityInputs = similarityInputsForOverview(output);
  const storedOverview = {
    ...overview,
    tags: tagEvidence.map(({ tag, sourceUrls }) => ({ ...tag, sourceUrls })),
    ...(similarityInputs ? { similarityInputs } : {}),
  };
  const previous = await first<{ output_json: string }>(db, "SELECT output_json FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1", job.appid);
  for (const dimension of SIMILARITY_DIMENSIONS) {
    const oldInput = overviewSimilarityInput(previous?.output_json, dimension);
    const nextInput = overviewSimilarityInput(storedOverview, dimension);
    const oldIdentity = oldInput.length > 0 ? similarityInputIdentity(dimension, oldInput) : null;
    const nextIdentity = nextInput.length > 0 ? similarityInputIdentity(dimension, nextInput) : null;
    if (oldIdentity && oldIdentity === nextIdentity) {
      await db.prepare("UPDATE media_game_embeddings SET overview_input_identity = ? WHERE appid = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ? AND active = 1").bind(job.input_identity, job.appid, dimension, nextIdentity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION).run();
    } else {
      await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND dimension = ? AND active = 1").bind(job.appid, dimension).run();
    }
  }
  const earlier = await first<{ id: number }>(db, "SELECT id FROM media_game_overviews WHERE appid = ? LIMIT 1", job.appid);
  await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(job.appid).run();
  await db.prepare("INSERT OR IGNORE INTO media_game_overviews (appid, input_identity, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(job.appid, job.input_identity, job.model, job.config_version, JSON.stringify(storedOverview), now.toISOString()).run();
  await replaceTagMemberships(db, job.appid, storedOverview, evidence, now);
  return { status: "succeeded", outputJson: JSON.stringify(storedOverview), replaced: earlier !== null };
}

function embeddingValues(value: unknown): unknown {
  const root = jsonObject(parseJson(value));
  const embedding = jsonObject(root.embedding);
  if (Array.isArray(embedding.values)) return embedding.values;
  if (Array.isArray(root.values)) return root.values;
  if (Array.isArray(root.embeddings) && root.embeddings.length > 0) {
    return jsonObject(root.embeddings[0]).values;
  }
  return null;
}

function embeddingOverviewIdentity(job: JobRow): string | null {
  if (job.source_id !== null || !job.dimension) return null;
  const match = new RegExp(`^embedding:${job.appid}:${job.dimension}:([a-f0-9]{64}):${job.input_identity}(?::retry:${job.run_id})?$`).exec(job.request_key);
  return match?.[1] ?? null;
}

async function persistEmbedding(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<OutputSettlement> {
  const overviewInputIdentity = embeddingOverviewIdentity(job);
  if (!overviewInputIdentity || !job.dimension) return { status: "stale" };
  const eligible = await first<{ appid: number }>(
    db,
    `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`,
    job.appid,
  );
  if (!eligible) {
    await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND active = 1").bind(job.appid).run();
    return { status: "stale" };
  }
  const overview = await first<{ input_identity: string; output_json: string }>(db, "SELECT input_identity, output_json FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1", job.appid);
  const input = overviewSimilarityInput(overview?.output_json, job.dimension);
  if (!overview || overview.input_identity !== overviewInputIdentity || input.length === 0 || similarityInputIdentity(job.dimension, input) !== job.input_identity) return { status: "stale" };
  const vector = encodeVector(embeddingValues(output));
  if (!vector) {
    return { status: "refused", error: "invalid_output: incompatible vector" };
  }
  const existing = await first<{ id: number }>(db, "SELECT id FROM media_game_embeddings WHERE appid = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ? ORDER BY id DESC LIMIT 1", job.appid, job.dimension, job.input_identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION);
  const earlier = await first<{ id: number }>(db, "SELECT id FROM media_game_embeddings WHERE appid = ? AND dimension = ? LIMIT 1", job.appid, job.dimension);
  await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND dimension = ? AND active = 1").bind(job.appid, job.dimension).run();
  if (existing) {
    await db.prepare("UPDATE media_game_embeddings SET overview_input_identity = ?, vector = ?, active = 1 WHERE id = ? AND appid = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ?").bind(overviewInputIdentity, vector, existing.id, job.appid, job.dimension, job.input_identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION).run();
  } else {
    await db.prepare("INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(job.appid, job.dimension, job.input_identity, overviewInputIdentity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION, vector, now.toISOString()).run();
  }
  return { status: "succeeded", outputJson: JSON.stringify({ dimensions: GEMINI_EMBEDDING_DIMENSIONS, dimension: job.dimension, inputIdentity: job.input_identity, overviewInputIdentity }), replaced: earlier !== null };
}

/**
 * The provider, model, configuration and input identity an item returned to
 * the queue waits with. Text generation runs only on OpenRouter, so an
 * extraction or Overview item from a Gemini text batch waits as OpenRouter
 * work for the text model; an Overview item that still describes its game's
 * current contributions takes the identity of new Overview work for them.
 * An embedding item keeps its own.
 */
async function queuedIdentity(db: AppDatabase, job: JobRow): Promise<Pick<JobRow, "provider" | "model" | "config_version" | "max_output_tokens" | "input_identity">> {
  if (job.stage === "extraction") {
    return { provider: "openrouter", model: OPENROUTER_TEXT_MODEL, config_version: EXTRACTION_CONFIG_VERSION, max_output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS, input_identity: job.input_identity };
  }
  if (job.stage === "synthesis") {
    const { extractions } = await currentGameEvidence(db, job.appid);
    const identity = extractions.length > 0 && synthesisIsCurrent(job, extractions) ? synthesisIdentity(job.appid, extractions) : job.input_identity;
    return { provider: "openrouter", model: OPENROUTER_TEXT_MODEL, config_version: SYNTHESIS_CONFIG_VERSION, max_output_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS, input_identity: identity };
  }
  return { provider: job.provider, model: job.model, config_version: job.config_version, max_output_tokens: job.max_output_tokens, input_identity: job.input_identity };
}

type SubmittedPollSummary = {
  polled: Set<number>;
  succeeded: number;
  failed: number;
  uncertain: number;
};

/**
 * Polls submitted batches. A poll is free, so polling continues while its
 * provider is paused. Every answer is classified once: a transient failure
 * keeps the batch submitted for the next poll; a Credit pause or
 * configuration error pauses the provider and keeps the batch submitted; an
 * error about the batch itself, or a batch that failed after acceptance,
 * makes it uncertain, so it is resent under the ledger. A batch
 * the provider ended for exhausted credit returns its item to the queue with
 * no attempt counted; one it expired or cancelled returns it with backoff,
 * like a transient failure.
 */
async function pollSubmittedJobs(advance: QueueAdvance, jobs: readonly JobRow[]): Promise<SubmittedPollSummary> {
  const { transport } = advance;
  const summary: SubmittedPollSummary = { polled: new Set(), succeeded: 0, failed: 0, uncertain: 0 };
  if (!transport) return summary;
  for (const job of jobs) {
    summary.polled.add(job.id);
    try {
      await pollSubmittedJob(advance, job, summary);
    } catch (error) {
      await holdThrowingItem(advance, job, error);
      summary.uncertain += 1;
    }
  }
  return summary;
}

/** Polls one submitted batch and acts on its classified answer, adding it to `summary`. */
async function pollSubmittedJob(advance: QueueAdvance, job: JobRow, summary: SubmittedPollSummary): Promise<void> {
  const { db, now, transport, secrets } = advance;
  if (!transport) return;
  if (!job.provider_batch_id) {
    summary.uncertain += 1;
    return;
  }
  await recordLegacyAttempt(db, job.id);
  let result: GeminiBatchPoll;
  try {
    result = await transport.pollBatch(job.provider_batch_id);
  } catch (error) {
    const outcome = classifyGeminiOutcome("poll", error);
    const detail = boundedPaidWorkError(error, secrets);
    if (outcome.class === "uncertain" || outcome.class === "refusal") {
      // An error about the batch itself: whether it ran is unknown.
      await holdItem(advance, job, { class: "uncertain", reason: outcome.reason }, { detail });
    } else if (outcome.class !== "success") {
      const report = await recordPollError(db, job, outcome, detail, now);
      if (report.paused) advance.paused.add(job.provider);
    }
    summary.uncertain += 1;
    return;
  }
  if (result.state === "pending") {
    summary.uncertain += 1;
    return;
  }
  if (result.state === "failed") {
    const outcome = classifyGeminiOutcome("poll", new GeminiBatchFailure(boundedPaidWorkError(result.error ?? "batch failed", secrets), result.batchState ?? null));
    if (outcome.class === "credit_pause" || outcome.class === "missing_configuration" || outcome.class === "transient") {
      const report = await returnUnrunBatch(db, job, outcome, now, queuedIdentity);
      if (report.paused) advance.paused.add(job.provider);
      if (report.reason) noteReason(advance, job.run_id, report.reason);
      summary.uncertain += 1;
      return;
    }
    if (outcome.class === "uncertain") {
      // The batch was accepted and then failed: it may have run and been
      // charged. Its reported usage is recorded, and the item is resent.
      await holdItem(advance, job, outcome, {
        detail: boundedPaidWorkError(result.error ?? "batch failed", secrets),
        answer: { provider: "gemini", usage: result.usage ?? null },
      });
      summary.uncertain += 1;
      return;
    }
  }
  const status = await settleOutput(db, job, now, { provider: "gemini", usage: result.usage ?? null }, async () => {
    if (result.state === "failed") return { status: "refused", error: boundedPaidWorkError(result.error, secrets) };
    if (job.stage === "extraction") return persistExtraction(db, job, result.output, now);
    if (job.stage === "embedding") return persistEmbedding(db, job, result.output, now);
    if (job.stage === "explanation") return { status: "stale" };
    return persistOverview(db, job, result.output, now);
  });
  if (status === "succeeded") summary.succeeded += 1;
  else summary.failed += 1;
}

const SUPPORTED_MEDIA_GAMES = new Set(Object.values(MEDIA_GAME_CHOICES));

function parseSelectedGames(value: string): number[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = null; }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > SUPPORTED_MEDIA_GAMES.size) throw new Error("Media discovery run has no bounded selected games");
  const selected = parsed.filter((id): id is number => Number.isInteger(id));
  if (selected.length !== parsed.length || new Set(selected).size !== selected.length || selected.some((id) => !SUPPORTED_MEDIA_GAMES.has(id))) {
    throw new Error("Media discovery run has no bounded selected games");
  }
  return selected.sort((a, b) => a - b);
}

async function eligibleProcessingEntities(db: AppDatabase, selectedRoots: readonly number[]): Promise<number[]> {
  if (selectedRoots.length === 0) return [];
  const encodedRoots = JSON.stringify(selectedRoots);
  const eligible = await rows<{ appid: number }>(
    db,
    `SELECT app.appid
     FROM apps AS app
     WHERE ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}
       AND (
         (app.appid IN (SELECT value FROM json_each(?)) AND app.parent_appid IS NULL)
         OR app.parent_appid IN (
           SELECT root.appid
           FROM apps AS root
           WHERE root.appid IN (SELECT value FROM json_each(?))
             AND root.type = 'game'
             AND root.is_playable = 1
             AND root.is_eligible = 1
             AND root.parent_appid IS NULL
         )
       )
     ORDER BY app.appid`,
    encodedRoots,
    encodedRoots,
  );
  return eligible.map(({ appid }) => appid);
}

/** The eligible entities of every enrolled root: the root and its eligible DLC and expansions. */
async function enrolledEntities(db: AppDatabase): Promise<number[]> {
  const roots = await rows<{ appid: number }>(db, "SELECT appid FROM media_enrollments ORDER BY appid");
  return eligibleProcessingEntities(db, roots.map(({ appid }) => appid));
}

async function loadAuthorization(
  db: AppDatabase,
  runId?: number,
  submittedRunIds: readonly number[] = [],
): Promise<{ auth: AuthorizationRow; selectedGames: number[] } | null> {
  const auth = runId === undefined
    ? await first<AuthorizationRow & { selected_games: string }>(db, "SELECT a.run_id, a.status, a.stop_reason, a.billing_confirmation, a.affected_source_ids, r.selected_games FROM media_processing_authorizations a JOIN media_discovery_runs r ON r.id = a.run_id WHERE a.status IN ('queued', 'waiting') AND r.status NOT IN ('queued', 'running') ORDER BY a.run_id DESC LIMIT 1")
    : await first<AuthorizationRow & { selected_games: string }>(db, "SELECT a.run_id, a.status, a.stop_reason, a.billing_confirmation, a.affected_source_ids, r.selected_games FROM media_processing_authorizations a JOIN media_discovery_runs r ON r.id = a.run_id WHERE a.run_id = ? AND a.status IN ('queued', 'waiting') AND r.status NOT IN ('queued', 'running')", runId);
  if (!auth) {
    if (runId !== undefined) {
      const terminal = await first<{ run_id: number }>(
        db,
        "SELECT a.run_id FROM media_processing_authorizations a JOIN media_discovery_runs r ON r.id = a.run_id WHERE a.run_id = ? AND a.status IN ('completed', 'stopped') AND r.status NOT IN ('queued', 'running')",
        runId,
      );
      if (!terminal) throw new Error("Media processing authorization not found");
    }
    return null;
  }
  return { auth, selectedGames: parseSelectedGames(auth.selected_games) };
}

/**
 * Validates an affected set for `selectedGames`: distinct media source ids,
 * each belonging to an eligible entity of the selected games, so the set is
 * bounded by those entities' article ceilings.
 */
async function validatedAffectedSourceIds(db: AppDatabase, selectedGames: readonly number[], value: readonly number[] | undefined): Promise<number[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(value).size !== value.length) {
    throw new Error("Affected media sources must be distinct positive ids");
  }
  const ids = [...value].sort((a, b) => a - b);
  if (ids.length === 0) return ids;
  const entities = await eligibleProcessingEntities(db, selectedGames);
  const known = await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_sources WHERE id IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    JSON.stringify(ids),
    JSON.stringify(entities),
  );
  if (Number(known?.count ?? 0) !== ids.length) throw new Error("Affected media sources must belong to the run's eligible games");
  return ids;
}

async function authorizeMediaProcessingNow(db: AppDatabase, runId: number, scope: MediaProcessingScope): Promise<{ runId: number; status: string }> {
  if (!Number.isInteger(runId) || runId <= 0) throw new Error("runId must be a positive integer");
  const run = await first<{ id: number; selected_games: string; status: string }>(db, "SELECT id, selected_games, status FROM media_discovery_runs WHERE id = ?", runId);
  if (!run) throw new Error("Media discovery run not found");
  if (run.status === "queued" || run.status === "running") throw new Error("Media discovery run is still running");
  const affected = await validatedAffectedSourceIds(db, parseSelectedGames(run.selected_games), scope.affectedSourceIds);
  const existing = await first<{ affected_source_ids: string }>(db, "SELECT affected_source_ids FROM media_processing_authorizations WHERE run_id = ?", runId);
  if (existing && scope.affectedSourceIds !== undefined && JSON.stringify(parseAffectedSourceIds(existing.affected_source_ids)) !== JSON.stringify(affected)) {
    throw new Error("Media processing run is already authorized with a different affected set");
  }
  await transaction(db, async () => {
    await db.prepare("INSERT OR IGNORE INTO media_processing_authorizations (run_id, status, affected_source_ids) VALUES (?, 'queued', ?)").bind(runId, JSON.stringify(affected)).run();
    await db.prepare("UPDATE media_processing_authorizations SET updated_at = CURRENT_TIMESTAMP WHERE run_id = ?").bind(runId).run();
  });
  const result = await first<{ status: string }>(db, "SELECT status FROM media_processing_authorizations WHERE run_id = ?", runId);
  return { runId, status: result?.status ?? "queued" };
}

let mediaProcessingQueue: Promise<unknown> = Promise.resolve();

/**
 * Stop reasons that describe a passing condition of one advance rather than
 * the run's work, so a later advance recomputes them. They include the
 * retired pricing, capability and allowance preconditions that older runs
 * recorded.
 */
const PASSING_STOPS = /^(?:pricing_unconfirmed|capability_unconfirmed|missing_gemini_batch_transport|lifetime_budget|transient_provider_failure|uncertain_submission|missing_gemini_embedding_batch|provider_paused:.*|count_tokens:.*)$/;

/** The explicit stop reasons a run recorded about its work, without passing conditions. */
function recordedWorkStops(stopReason: string | null): string[] {
  return (stopReason ?? "").split("; ").filter((reason) => reason && !PASSING_STOPS.test(reason));
}

/**
 * Authorizes paid processing for a completed discovery run. The run processes
 * sources new to processing plus `scope.affectedSourceIds`, which may be
 * empty; the set is fixed when the run is first authorized.
 */
export function authorizeMediaProcessing(db: AppDatabase, runId: number, scope: MediaProcessingScope = {}): Promise<{ runId: number; status: string }> {
  const next = mediaProcessingQueue
    .catch(() => undefined)
    .then(() => authorizeMediaProcessingNow(db, runId, scope));
  mediaProcessingQueue = next;
  return next;
}

type OpenAuthorization = { auth: AuthorizationRow; selectedGames: number[] };

/** Every authorization whose discovery finished and whose processing is not finished, oldest first. */
async function openAuthorizations(db: AppDatabase): Promise<OpenAuthorization[]> {
  const open = await rows<AuthorizationRow & { selected_games: string }>(
    db,
    "SELECT a.run_id, a.status, a.stop_reason, a.billing_confirmation, a.affected_source_ids, r.selected_games FROM media_processing_authorizations a JOIN media_discovery_runs r ON r.id = a.run_id WHERE a.status IN ('queued', 'waiting') AND r.status NOT IN ('queued', 'running') ORDER BY a.run_id",
  );
  return open.map((auth) => ({ auth, selectedGames: parseSelectedGames(auth.selected_games) }));
}

/** The sources of `entities` that processing considers: at most each entity's own 15-article ceiling. */
async function boundedSources(db: AppDatabase, entities: readonly number[]): Promise<SourceRow[]> {
  const allSources = await rows<SourceRow>(db, `SELECT ${SOURCE_COLUMNS} FROM media_sources WHERE appid IN (SELECT value FROM json_each(?)) ORDER BY appid, id`, JSON.stringify(entities));
  const sourceCountByGame = new Map<number, number>();
  return allSources.filter((source) => {
    const count = sourceCountByGame.get(source.appid) ?? 0;
    if (count >= MAX_MEDIA_ARTICLES_PER_GAME) return false;
    sourceCountByGame.set(source.appid, count + 1);
    return true;
  });
}

/**
 * A run takes a source that is new to processing, or an affected source it
 * has not taken yet. A source a run took under the retired flow with text
 * still retained is taken again, so its pending work is queued. Every other
 * source keeps its outputs without a fetch or paid work.
 */
function inScope(source: SourceRow, runId: number, affected: ReadonlySet<number>): boolean {
  return source.processing_run_id === null
    || (source.processing_run_id !== runId && affected.has(source.id))
    || (source.processing_run_id === runId && source.processing_content !== null);
}

async function isEligibleEntity(db: AppDatabase, appid: number): Promise<boolean> {
  return (await first<{ appid: number }>(db, `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`, appid)) !== null;
}

/**
 * Queues an extraction for every source run `runId` takes: sources new to
 * processing, and the sources of its authorized `affected` set. Taking the source and
 * queuing its item is one write; the article is fetched only when the item
 * is submitted, so a waiting item holds no text.
 */
async function enqueueExtractions(advance: QueueAdvance, runId: number, affected: ReadonlySet<number>, entities: readonly number[]): Promise<void> {
  const { db, now } = advance;
  for (const source of await boundedSources(db, entities)) {
    if (!inScope(source, runId, affected)) continue;
    await transaction(db, async () => {
      const current = await currentSource(db, source.id);
      if (!current || !inScope(current, runId, affected)) return;
      if (!await hasOpenExtraction(db, runId, current.id)) {
        await enqueuePaidWork(db, { provider: "openrouter", run_id: runId, stage: "extraction", appid: current.appid, source_id: current.id, request_key: `extraction:${current.id}:run:${runId}`, input_identity: `source:${current.id}`, model: OPENROUTER_TEXT_MODEL, config_version: EXTRACTION_CONFIG_VERSION, max_output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS }, now);
      }
      await db.prepare("UPDATE media_sources SET processing_run_id = ?, processing_content = NULL WHERE id = ?").bind(runId, current.id).run();
    });
  }
}

/**
 * Queues Overview and embedding work for the games `runId` may rebuild: an
 * authorized run's rebuild scope, or every one of `entities` for automatic
 * work. An Overview is queued only when its game has no queued or in-flight
 * extraction, and its current contributions differ from those its active
 * Overview was built from, or it has none. A model or configuration version
 * change alone queues nothing. Automatic work never queues again work that
 * already has an item, whatever its outcome.
 */
async function enqueueOverviewWork(advance: QueueAdvance, runId: number, entities: readonly number[], automatic = false): Promise<void> {
  const { db, now } = advance;
  const scopeGames = automatic ? [...entities].sort((a, b) => a - b) : [...await rebuildScopeGames(db, runId, entities)].sort((a, b) => a - b);
  for (const appid of scopeGames) {
    if (await hasPendingExtractions(db, appid)) continue;
    const evidence = await currentGameEvidence(db, appid);
    if (evidence.extractions.length === 0) continue;
    // An Overview stays current while it was built from exactly the game's
    // current contributions, whatever model or configuration built it.
    const activeOverview = await first<{ input_identity: string; model: string; config_version: string }>(db, "SELECT input_identity, model, config_version FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1", appid);
    if (activeOverview && synthesisIdentityFor(appid, evidence.extractions, activeOverview.model, activeOverview.config_version) === activeOverview.input_identity) continue;
    const identity = synthesisIdentity(appid, evidence.extractions);
    const old = await first<{ id: number; output_json: string }>(db, "SELECT id, output_json FROM media_game_overviews WHERE appid = ? AND input_identity = ? ORDER BY id DESC LIMIT 1", appid, identity);
    if (old) {
      await transaction(db, async () => {
        await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(appid).run();
        await db.prepare("UPDATE media_game_overviews SET active = 1 WHERE id = ?").bind(old.id).run();
        await replaceTagMemberships(db, appid, old.output_json, await currentGameEvidence(db, appid), now);
      });
      continue;
    }
    const requestKey = automatic
      ? await automaticRequestKey(db, `synthesis:${appid}:${identity}`, runId)
      : await runRequestKey(db, `synthesis:${appid}:${identity}`, runId);
    if (!requestKey || await hasRequestKey(db, requestKey)) continue;
    await enqueuePaidWork(db, { provider: "openrouter", run_id: runId, stage: "synthesis", appid, source_id: null, request_key: requestKey, input_identity: identity, model: OPENROUTER_TEXT_MODEL, config_version: SYNTHESIS_CONFIG_VERSION, max_output_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS }, now);
  }
  await enqueueEmbeddings(advance, runId, scopeGames, automatic);
}

/**
 * Queues an embedding for each dimension whose `similarityInputs` changed in
 * an active Overview of `scopeGames`, unless that Overview is about to be
 * replaced.
 */
async function enqueueEmbeddings(advance: QueueAdvance, runId: number, scopeGames: readonly number[], automatic: boolean): Promise<void> {
  const { db, now } = advance;
  const overviews = await rows<{ appid: number; input_identity: string; output_json: string }>(
    db,
    "SELECT appid, input_identity, output_json FROM media_game_overviews WHERE active = 1 AND appid IN (SELECT value FROM json_each(?)) ORDER BY appid",
    JSON.stringify(scopeGames),
  );
  for (const overview of overviews) {
    if (!await isEligibleEntity(db, overview.appid)) {
      await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND active = 1").bind(overview.appid).run();
      continue;
    }
    if (await overviewReplacementPending(db, overview.appid)) continue;
    for (const dimension of SIMILARITY_DIMENSIONS) {
      const input = overviewSimilarityInput(overview.output_json, dimension);
      const identity = input.length > 0 ? similarityInputIdentity(dimension, input) : null;
      if (!identity) {
        await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND dimension = ? AND active = 1").bind(overview.appid, dimension).run();
        continue;
      }
      // A vector linked to this Overview stays current while it embeds the
      // Overview's input, whatever embedding model or configuration produced it.
      const linked = await first<{ input_identity: string; model: string; dimensions: number; config_version: string }>(db, "SELECT input_identity, model, dimensions, config_version FROM media_game_embeddings WHERE appid = ? AND dimension = ? AND overview_input_identity = ? AND active = 1 ORDER BY id DESC LIMIT 1", overview.appid, dimension, overview.input_identity);
      if (linked && similarityInputIdentityFor(dimension, input, linked.model, linked.dimensions, linked.config_version) === linked.input_identity) continue;
      const existing = await first<{ id: number; vector: unknown }>(
        db,
        "SELECT id, vector FROM media_game_embeddings WHERE appid = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ? ORDER BY id DESC LIMIT 1",
        overview.appid,
        dimension,
        identity,
        GEMINI_EMBEDDING_MODEL,
        GEMINI_EMBEDDING_DIMENSIONS,
        GEMINI_EMBEDDING_CONFIG_VERSION,
      );
      if (existing && decodeVector(existing.vector)) {
        await transaction(db, async () => {
          await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND dimension = ? AND active = 1").bind(overview.appid, dimension).run();
          await db.prepare("UPDATE media_game_embeddings SET overview_input_identity = ?, active = 1 WHERE id = ? AND appid = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ?").bind(overview.input_identity, existing.id, overview.appid, dimension, identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION).run();
        });
        continue;
      }
      const baseKey = `embedding:${overview.appid}:${dimension}:${overview.input_identity}:${identity}`;
      const requestKey = automatic ? await automaticRequestKey(db, baseKey, runId) : await runRequestKey(db, baseKey, runId);
      if (!requestKey || await hasRequestKey(db, requestKey)) continue;
      await enqueuePaidWork(db, { provider: "gemini", run_id: runId, stage: "embedding", appid: overview.appid, dimension, source_id: null, request_key: requestKey, input_identity: identity, model: GEMINI_EMBEDDING_MODEL, config_version: GEMINI_EMBEDDING_CONFIG_VERSION, max_output_tokens: EMBEDDING_MAX_OUTPUT_TOKENS }, now);
    }
  }
}

/**
 * Fetches the article of a selected extraction item, applies the
 * content-change rules, and submits it when paid work is still needed. The
 * cleaned text exists only in this call and is never stored. Returns whether
 * the item used a turn.
 */
async function takeExtractionTurn(advance: QueueAdvance, job: JobRow): Promise<boolean> {
  const { db, now } = advance;
  const source = job.source_id === null ? null : await currentSource(db, job.source_id);
  if (!source || !await isEligibleEntity(db, source.appid)) {
    await resolveWithoutProvider(db, job);
    return false;
  }
  const stopped = advance.outletStops.get(source.outlet);
  if (stopped) {
    noteReason(advance, job.run_id, `${source.outlet}:${stopped}`);
    // An Outlet denial is permanent, so its article can never be fetched.
    if (isOutletDenialStop(stopped)) await refuseItem(db, job, "outlet_denied", now);
    // A day stop holds the item waiting; it keeps its place.
    return false;
  }
  const fetched = await fetchOutletArticle(db, {
    url: source.original_url, outlet: source.outlet, appid: source.appid, pass: source.pass,
    runId: job.run_id, fetch: advance.articleFetch, clock: advance.clock,
  });
  if (fetched && "stop" in fetched) {
    advance.outletStops.set(source.outlet, fetched.stop);
    noteReason(advance, job.run_id, `${source.outlet}:${fetched.stop}`);
    if (isOutletDenialStop(fetched.stop)) await refuseItem(db, job, "outlet_denied", now);
    return true;
  }
  const cleaned = fetched ? cleanArticle(fetched.html) : null;
  if (!cleaned) {
    const reason = fetched === null ? "article_unreachable" : "article_unusable";
    await refuseItem(db, job, reason, now);
    noteReason(advance, job.run_id, `${source.outlet}:${reason}`);
    return true;
  }
  let identity: string | null = null;
  let kept = false;
  let current: SourceRow | null = null;
  await transaction(db, async () => {
    current = await currentSource(db, source.id);
    if (!current) return;
    identity = extractionIdentity(current, cleaned.hash);
    const prior = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND active = 1 LIMIT 1", source.id);
    // Only changed cleaned content re-extracts. A metadata, model,
    // configuration or cleanup version change keeps the active extraction.
    kept = prior !== null && prior.content_hash === cleaned.hash;
    if (prior && !kept) {
      const extractions = await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
      const overviews = await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(current.appid).run();
      const embeddings = await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND active = 1").bind(current.appid).run();
      await countOutputs(db, job.run_id, "invalidated", extractions.meta.changes + overviews.meta.changes + embeddings.meta.changes);
      await markContributionChanged(db, source.id, job.run_id);
    }
    await db.prepare("UPDATE media_sources SET normalized_content_hash = ?, cleanup_version = ?, processing_content = NULL, processing_input_identity = ?, processing_run_id = ? WHERE id = ?").bind(cleaned.hash, CLEANUP_VERSION, identity, job.run_id, source.id).run();
    if (kept) await resolveWithoutProvider(db, job);
  });
  if (kept || !identity || !current) return true;
  const knownExtraction = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND input_identity = ? LIMIT 1", source.id, identity);
  if (knownExtraction) {
    await transaction(db, async () => {
      await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
      await db.prepare("UPDATE media_article_extractions SET active = 1 WHERE id = ?").bind(knownExtraction.id).run();
      await markContributionChanged(db, source.id, job.run_id);
      await resolveWithoutProvider(db, job);
    });
    return true;
  }
  // The same input in a submitted batch or extracted under another item
  // needs no second request. An uncertain request of the same input does not
  // count: only a correction set takes its source again, to resend it.
  if (await hasSubmittedOrSucceededExtraction(db, job, source.id, identity)) {
    await resolveWithoutProvider(db, job);
    return true;
  }
  await setWaitingInputIdentity(db, job, identity);
  await sendTextItem(advance, { ...job, input_identity: identity }, makeExtractionRequest(current, cleaned.content));
  return true;
}

/** Submits a selected Overview item while it still describes the game's current contributions. */
async function takeSynthesisTurn(advance: QueueAdvance, job: JobRow): Promise<boolean> {
  const { db } = advance;
  if (!await isEligibleEntity(db, job.appid)) {
    await resolveWithoutProvider(db, job);
    return false;
  }
  // New extraction work for the game would change its contributions: the
  // Overview waits for it.
  if (await hasPendingExtractions(db, job.appid)) return false;
  const evidence = await currentGameEvidence(db, job.appid);
  if (evidence.extractions.length === 0 || !synthesisIsCurrent(job, evidence.extractions)) {
    await resolveWithoutProvider(db, job);
    return false;
  }
  const game = await first<{ name: string }>(db, "SELECT name FROM apps WHERE appid = ?", job.appid);
  await sendTextItem(advance, job, makeSynthesisRequest(job.appid, game?.name ?? "", evidence.extractions, evidence.sources));
  return true;
}

/** Submits a selected embedding item while it still embeds its active Overview's input. */
async function takeEmbeddingTurn(advance: QueueAdvance, job: JobRow): Promise<boolean> {
  const { db } = advance;
  if (!advance.transport?.submitEmbeddingBatch) {
    noteReason(advance, job.run_id, PROCESSING_STOP_REASONS.MISSING_GEMINI_EMBEDDING_BATCH);
    return false;
  }
  const overviewInputIdentity = embeddingOverviewIdentity(job);
  const overview = await first<{ input_identity: string; output_json: string }>(db, "SELECT input_identity, output_json FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1", job.appid);
  const input = job.dimension ? overviewSimilarityInput(overview?.output_json, job.dimension) : [];
  if (!await isEligibleEntity(db, job.appid) || !overview || !job.dimension || overview.input_identity !== overviewInputIdentity || input.length === 0 || similarityInputIdentity(job.dimension, input) !== job.input_identity) {
    await resolveWithoutProvider(db, job);
    return false;
  }
  // The Overview it embeds is about to be replaced: the item waits.
  if (await overviewReplacementPending(db, job.appid)) return false;
  await sendItem(advance, job, GEMINI_EMBEDDING_MODEL, makeEmbeddingRequest(input), MAX_EMBEDDING_INPUT_TOKENS);
  return true;
}

async function takeTurn(advance: QueueAdvance, job: JobRow): Promise<boolean> {
  if (job.stage === "extraction") return takeExtractionTurn(advance, job);
  if (job.stage === "synthesis") return takeSynthesisTurn(advance, job);
  if (job.stage === "embedding") return takeEmbeddingTurn(advance, job);
  await resolveWithoutProvider(advance.db, job);
  return false;
}

/**
 * Submits ready items of every active provider in fair rounds. Entities are
 * ordered by when they last took a turn, oldest first and never first, then
 * by the enqueue time of their oldest waiting item, then by entity; each
 * round, every entity contributes its oldest ready item. Turns are durable,
 * so whatever the per-tick bound and the number of entities, every entity
 * with ready work takes a turn within ceil(entities / bound) ticks. A
 * provider whose pause was just lifted by the daily credit check first
 * submits its oldest ready embedding item as a probe. A Credit pause stops
 * the provider for the rest of the advance and leaves every item queued.
 * Taking stops at the per-tick bound on items or elapsed time; the items
 * left keep their place for the next tick.
 */
/**
 * Whether `job` is retrying after a failure it took itself, such as a
 * transient failure, an uncertain outcome or an unrecognized client error.
 * A credit probe never picks such an item, so an item that keeps failing
 * cannot take the provider's first turn after every daily check.
 */
function inBackoff(job: JobRow): boolean {
  return job.attempt_count > 0;
}

async function submitQueuedWork(advance: QueueAdvance, probing: Set<PaidProvider>): Promise<void> {
  const { db, now } = advance;
  for (const provider of PAID_PROVIDERS) {
    const configured = provider === "openrouter" ? advance.openRouter !== null : advance.transport !== null;
    if (!configured || advance.paused.has(provider) || advance.remaining[provider] <= 0 || advance.outOfTime()) continue;
    const ready = await readyPaidWork(db, provider, now);
    if (ready.length === 0) continue;
    const entityOrder = await waitingEntityOrder(db, provider);
    const byEntity = new Map<number, JobRow[]>();
    for (const job of ready) byEntity.set(job.appid, [...(byEntity.get(job.appid) ?? []), job]);
    const turns: JobRow[] = [];
    if (probing.has(provider)) {
      probing.delete(provider);
      const probe = ready.find((job) => job.stage === "embedding" && !inBackoff(job));
      if (probe) {
        turns.push(probe);
        byEntity.set(probe.appid, byEntity.get(probe.appid)!.filter((job) => job.id !== probe.id));
      }
    }
    const entityTurns = await readEntityTurns(db, provider);
    const lastTurn = (appid: number) => entityTurns.last.get(appid) ?? -1;
    // Array.prototype.sort is stable, so equal last turns keep the
    // enqueue-time order.
    const entities = entityOrder.map(({ appid }) => appid).filter((appid) => byEntity.has(appid)).sort((a, b) => lastTurn(a) - lastTurn(b));
    for (let taken = true; taken;) {
      taken = false;
      for (const appid of entities) {
        const job = byEntity.get(appid)!.shift();
        if (!job) continue;
        turns.push(job);
        taken = true;
      }
    }
    for (const job of turns) {
      if (advance.paused.has(provider) || advance.remaining[provider] <= 0 || advance.outOfTime()) break;
      let took: boolean;
      try {
        took = await takeTurn(advance, job);
      } catch (error) {
        await holdThrowingItem(advance, job, error);
        took = true;
      }
      if (took) {
        advance.remaining[provider] -= 1;
        entityTurns.last.set(job.appid, entityTurns.next);
        entityTurns.next += 1;
      }
    }
    // Only entities that still have work keep their last turn.
    const active = await activePaidWorkEntities(db, provider);
    for (const appid of entityTurns.last.keys()) if (!active.has(appid)) entityTurns.last.delete(appid);
    await writeEntityTurns(db, provider, entityTurns);
  }
}

type RunOutcome = Omit<MediaProcessingSummary, "queued" | "providers" | "cost">;

/** Records `run`'s status and reasons after this advance and reports its outcome. */
async function finishRun(advance: QueueAdvance, run: OpenAuthorization): Promise<RunOutcome> {
  const { db, now } = advance;
  const { auth, selectedGames } = run;
  const entities = await eligibleProcessingEntities(db, selectedGames);
  const sources = await boundedSources(db, entities);
  const affected = new Set(parseAffectedSourceIds(auth.affected_source_ids));
  const runAggregate = await paidWorkRunAggregate(db, auth.run_id);
  const overviewAppids = await activeOverviewAppids(db, entities);
  const entitySet = new Set(entities);
  const gamesWithSources = [...new Set(sources.filter((source) => entitySet.has(source.appid)).map((source) => source.appid))];
  const coveredGames = new Set(overviewAppids);
  const allCovered = gamesWithSources.every((appid) => coveredGames.has(appid));
  const pending = Number(runAggregate?.pending ?? 0);
  const reasons = [...(advance.reasons.get(auth.run_id) ?? [])];
  if (Number(runAggregate?.waiting ?? 0) > 0) {
    for (const provider of PAID_PROVIDERS) {
      const state = await providerState(db, provider);
      if (state.paused) reasons.push(`provider_paused:${provider}:${state.reason}`);
    }
  }
  const workStop = reasons.some((reason) =>
    reason === PROCESSING_STOP_REASONS.INPUT_TOKEN_CAP || reason === PROCESSING_STOP_REASONS.PROVIDER_REFUSAL);
  const terminalFailure = pending === 0 && Number(runAggregate?.hard ?? 0) > 0;
  if (!workStop && terminalFailure) reasons.unshift(PROCESSING_STOP_REASONS.TERMINAL_FAILURE);
  // Sources an outlet stop deferred stay queued; once nothing waits, the run
  // has done all the work it was authorized for.
  const remainingInScope = sources.some((source) => inScope(source, auth.run_id, affected));
  const hasJobs = Number(runAggregate?.jobs ?? 0) > 0;
  const status: MediaProcessingSummary["status"] = pending > 0 || (!allCovered && !terminalFailure && !workStop && remainingInScope)
    ? (auth.status === "queued" && !hasJobs && sources.length === 0 ? "queued" : "waiting")
    : terminalFailure || (!allCovered && workStop) ? "stopped" : "completed";
  // While a game is left without an Overview, the run keeps every explicit
  // reason recorded by its earlier advances, except passing conditions.
  const earlierReasons = allCovered ? [] : recordedWorkStops(auth.stop_reason);
  const stopReasons = [...new Set([...reasons, ...earlierReasons])];
  await transaction(db, async () => {
    await db.prepare("UPDATE media_processing_authorizations SET status = ?, stop_reason = ?, updated_at = ? WHERE run_id = ? AND status <> 'stopped'").bind(status, stopReasons.length > 0 ? stopReasons.join("; ") : null, now.toISOString(), auth.run_id).run();
    // A finished run has no pending work left for text the retired flow retained.
    if (status === "completed" || status === "stopped") await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE processing_run_id = ? AND processing_content IS NOT NULL").bind(auth.run_id).run();
  });
  await recordReusedOutputs(db, auth.run_id, sources.map((source) => source.id), entities);
  return {
    runId: auth.run_id,
    status,
    submitted: advance.submitted.get(auth.run_id) ?? 0,
    completed: Number(runAggregate?.succeeded ?? 0),
    outputs: await outputCounts(db, auth.run_id),
    stopReasons,
    failed: Number(runAggregate?.failed ?? 0),
    uncertain: Number(runAggregate?.uncertain ?? 0),
    overviewAppids,
  };
}

/** The queue depth, provider states and cost every summary reports. */
async function queueReport(db: AppDatabase, now: Date): Promise<Pick<MediaProcessingSummary, "queued" | "providers" | "cost">> {
  const queued = {} as MediaProcessingSummary["queued"];
  const providers = {} as MediaProcessingSummary["providers"];
  for (const provider of PAID_PROVIDERS) {
    queued[provider] = await waitingPaidWorkCount(db, provider);
    providers[provider] = await providerState(db, provider);
  }
  return { queued, providers, cost: await paidWorkCost(db, now) };
}

type ProviderTransports = { transport: GeminiBatchTransport | null; openRouter: OpenRouterTransport | null };

/**
 * Builds each paid provider's transport from its configured key. A missing
 * key pauses the provider for as long as it is missing; a key configured
 * again lifts that pause at once.
 */
async function configureProviders(db: AppDatabase, options: MediaProcessingOptions, now: Date): Promise<ProviderTransports> {
  const configured: ProviderTransports = { transport: options.transport ?? null, openRouter: options.openRouter ?? null };
  const outcomes: Record<PaidProvider, ProviderOutcome> = { gemini: { class: "success" }, openrouter: { class: "success" } };
  if (!configured.transport) {
    try { configured.transport = createGeminiBatchTransport(options.geminiApiKey ?? "", options.providerFetch); }
    catch (error) { outcomes.gemini = classifyGeminiOutcome("submit", error); }
  }
  if (!configured.openRouter) {
    try { configured.openRouter = createOpenRouterTransport(options.openRouterApiKey, options.providerFetch as OpenRouterFetch | undefined, { timeoutMs: options.openRouterTimeoutMs }); }
    catch (error) { outcomes.openrouter = classifyOpenRouterOutcome(error); }
  }
  for (const provider of PAID_PROVIDERS) {
    const outcome = outcomes[provider];
    if (outcome.class === "missing_configuration") await pauseProvider(db, provider, outcome.reason, now);
    else if ((await providerState(db, provider)).reason === "missing_key") await liftProviderPause(db, provider);
  }
  return configured;
}

/** The daily credit checks of providers with a credit endpoint: OpenRouter's current-key check. */
function creditChecks(openRouter: OpenRouterTransport | null): CreditChecks {
  return {
    openrouter: async (): Promise<OpenRouterKeyCheck> => {
      if (!openRouter) return { class: "missing_configuration", reason: "missing_key" };
      try { return classifyOpenRouterKeyCheck(await openRouter.currentKey()); }
      catch (error) { return classifyOpenRouterKeyCheck(null, error); }
    },
  };
}

/**
 * One advance of the paid-work queue, run inside the ingestion tick: it
 * settles the provider configuration, runs the daily credit check when due,
 * polls submitted batches, queues the work of every open authorization, and
 * submits ready items fairly. Extraction results polled in this advance let
 * their Overview work be queued and submitted in the same advance.
 */
async function advanceMediaProcessingNow(db: AppDatabase, options: MediaProcessingOptions = {}): Promise<MediaProcessingSummary> {
  const now = isoNow(options.now);
  const { transport, openRouter } = await configureProviders(db, options, now);
  const perTick = options.submissionsPerTick ?? DEFAULT_PAID_SUBMISSIONS_PER_TICK;
  const elapsed = options.paidWorkClock ?? (() => performance.now());
  const startedAt = elapsed();
  const timeBudgetMs = options.paidWorkTimeBudgetMs ?? DEFAULT_PAID_WORK_TIME_BUDGET_MS;
  const advance: QueueAdvance = {
    db,
    now,
    clock: () => isoNow(options.now),
    transport,
    openRouter,
    secrets: [options.geminiApiKey, options.openRouterApiKey],
    outOfTime: () => elapsed() - startedAt >= timeBudgetMs,
    articleFetch: options.articleFetch ?? fetch,
    remaining: Object.fromEntries(PAID_PROVIDERS.map((provider) => [provider, perTick])) as Record<PaidProvider, number>,
    paused: new Set(),
    outletStops: new Map(),
    reasons: new Map(),
    submitted: new Map(),
    requestsSent: 0,
    textSucceeded: 0,
    textFailed: 0,
  };
  for (const runId of await recoverInFlight(db, now, queuedIdentity)) {
    noteReason(advance, runId, PROCESSING_STOP_REASONS.UNCERTAIN_SUBMISSION);
  }
  const pollOnly = options.pollOnly === true;
  const probing = new Set(pollOnly ? [] : [...(options.probe ?? []), ...(await runDailyCreditCheck(db, now, creditChecks(openRouter)) ?? [])]);
  for (const provider of PAID_PROVIDERS) if ((await providerState(db, provider)).paused) advance.paused.add(provider);

  const globallySubmitted = await submittedPaidWork(db);
  const prePoll = await pollSubmittedJobs(advance, globallySubmitted);
  const authorization = pollOnly ? null : await loadAuthorization(db, options.runId);
  const open = pollOnly ? [] : await openAuthorizations(db);
  const entitiesByRun = new Map<number, number[]>();
  for (const run of open) {
    const entities = await eligibleProcessingEntities(db, run.selectedGames);
    entitiesByRun.set(run.auth.run_id, entities);
    await enqueueExtractions(advance, run.auth.run_id, new Set(parseAffectedSourceIds(run.auth.affected_source_ids)), entities);
    await enqueueOverviewWork(advance, run.auth.run_id, entities);
  }
  // Automatic work: sources of enrolled entities that are new to processing
  // enter the queue without an authorization; authorized runs take theirs first.
  const automatic = pollOnly || options.automaticRunId === undefined ? null : { runId: options.automaticRunId, entities: await enrolledEntities(db) };
  if (automatic) {
    await enqueueExtractions(advance, automatic.runId, new Set(), automatic.entities);
    await enqueueOverviewWork(advance, automatic.runId, automatic.entities, true);
  }
  if (!pollOnly) await submitQueuedWork(advance, probing);
  // Stages chain within one advance: text answers settle as they arrive, so
  // their Overview work, and then the embeddings of Overviews built here,
  // are queued and taken in the same advance. Each batch submitted in this
  // advance is polled once.
  const currentPoll: SubmittedPollSummary = { polled: new Set(prePoll.polled), succeeded: 0, failed: 0, uncertain: 0 };
  const pollNewBatches = async () => {
    const submitted = await submittedPaidWork(db);
    const polled = await pollSubmittedJobs(advance, submitted.filter((job) => !currentPoll.polled.has(job.id)));
    for (const id of polled.polled) currentPoll.polled.add(id);
    currentPoll.succeeded += polled.succeeded;
    currentPoll.failed += polled.failed;
    currentPoll.uncertain += polled.uncertain;
  };
  for (let stage = 0; stage < 2 && !pollOnly; stage += 1) {
    await pollNewBatches();
    for (const run of open) await enqueueOverviewWork(advance, run.auth.run_id, entitiesByRun.get(run.auth.run_id)!);
    if (automatic) await enqueueOverviewWork(advance, automatic.runId, automatic.entities, true);
    await submitQueuedWork(advance, probing);
  }
  await pollNewBatches();

  const outcomes = new Map<number, RunOutcome>();
  for (const run of open) outcomes.set(run.auth.run_id, await finishRun(advance, run));
  const report = await queueReport(db, now);
  const target = authorization ? outcomes.get(authorization.auth.run_id) : undefined;
  if (target) return { ...target, ...report };

  const reconciliationRunId = globallySubmitted.at(-1)?.run_id ?? options.runId ?? options.automaticRunId ?? await latestPaidWorkRun(db);
  if (reconciliationRunId === undefined) throw new Error("Media processing authorization not found");
  const recorded = await first<{ stop_reason: string | null }>(db, "SELECT stop_reason FROM media_processing_authorizations WHERE run_id = ?", reconciliationRunId);
  const entities = automatic?.entities ?? (pollOnly ? globallySubmitted.map(({ appid }) => appid) : await enrolledEntities(db));
  return {
    runId: reconciliationRunId,
    status: await hasUnresolvedPaidWork(db) ? "waiting" : "completed",
    submitted: advance.requestsSent,
    completed: advance.textSucceeded + prePoll.succeeded + currentPoll.succeeded,
    outputs: await outputCounts(db, reconciliationRunId),
    stopReasons: (recorded?.stop_reason ?? "").split("; ").filter(Boolean),
    failed: advance.textFailed + prePoll.failed + currentPoll.failed,
    uncertain: prePoll.uncertain + currentPoll.uncertain,
    overviewAppids: await activeOverviewAppids(db, entities),
    ...report,
  };
}

/**
 * Runs the daily credit check of the daily media run when it is due, whether
 * or not paid work waits. It records the day and lifts the pauses the check
 * lifts; `onRecorded` runs in that same write. Returns the providers whose
 * pause was lifted so their next submission probes credit, which the next
 * advance takes as `probe`, or null when the check was not due. Serialized
 * with every other queue write.
 */
export function runMediaDailyCreditCheck(
  db: AppDatabase,
  now: Date,
  options: Pick<MediaProcessingOptions, "openRouter" | "openRouterApiKey" | "openRouterTimeoutMs" | "providerFetch"> = {},
  onRecorded?: () => Promise<void>,
): Promise<PaidProvider[] | null> {
  const next = mediaProcessingQueue
    .catch(() => undefined)
    .then(async () => {
      return runDailyCreditCheck(db, now, creditChecks(textTransport(options)), onRecorded);
    });
  mediaProcessingQueue = next;
  return next;
}

/**
 * Database handles whose process has run its startup recheck. One process
 * keeps one handle, so a new handle is a new process: a restart, or a test
 * that reopens its database.
 */
const rechecked = new WeakSet<AppDatabase>();

/**
 * On the first call for `db` in this process, rechecks every paused provider
 * as the daily credit check does (2026-11-18), so a deployed fix for a
 * configuration pause takes effect without waiting for 06:00 UTC: the
 * OpenRouter key check, and Gemini's probe rule. When the daily credit check
 * is due now it covers the recheck, which then does nothing. It never runs
 * the daily media run or records the daily checkpoint. Returns the providers
 * lifted to probe, which the next advance takes as `probe`. Serialized with
 * every other queue write.
 */
export function recheckPausedProvidersAtStartup(
  db: AppDatabase,
  now: Date,
  options: Pick<MediaProcessingOptions, "openRouter" | "openRouterApiKey" | "openRouterTimeoutMs" | "providerFetch"> = {},
): Promise<PaidProvider[]> {
  if (rechecked.has(db)) return Promise.resolve([]);
  rechecked.add(db);
  const next = mediaProcessingQueue
    .catch(() => undefined)
    .then(async () => {
      if (await dailyCreditCheckDue(db, now)) return [];
      return recheckPausedProviders(db, now, creditChecks(textTransport(options)));
    });
  mediaProcessingQueue = next;
  return next;
}

/** The OpenRouter transport of `options`, or null when no key is configured. */
function textTransport(options: Pick<MediaProcessingOptions, "openRouter" | "openRouterApiKey" | "openRouterTimeoutMs" | "providerFetch">): OpenRouterTransport | null {
  if (options.openRouter) return options.openRouter;
  try { return createOpenRouterTransport(options.openRouterApiKey, options.providerFetch as OpenRouterFetch | undefined, { timeoutMs: options.openRouterTimeoutMs }); }
  catch { return null; }
}

export function advanceMediaProcessing(
  db: AppDatabase,
  options: MediaProcessingOptions = {},
): Promise<MediaProcessingSummary> {
  const next = mediaProcessingQueue
    .catch(() => undefined)
    .then(() => advanceMediaProcessingNow(db, options));
  mediaProcessingQueue = next;
  return next;
}

