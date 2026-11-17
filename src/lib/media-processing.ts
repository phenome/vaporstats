import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import {
  createMediaEvidenceSource,
  MEDIA_CATEGORY_NAMES,
  parseMediaOverview,
  parseMediaTagEvidence,
  type MediaEvidenceSource,
} from "./media-overview";
import {
  MAX_MEDIA_ARTICLES_PER_GAME,
  MAX_MEDIA_ARTICLES_TOTAL,
  MEDIA_GAME_CHOICES,
  MEDIA_OUTLETS,
  type MediaOutlet,
} from "./media-discovery";
import { finishOutletAttempt, reserveOutletAttempt } from "./media-outlet-access";
import {
  createOpenRouterTransport,
  type OpenRouterChatRequest,
  type OpenRouterCompletion,
  type OpenRouterFetch,
  type OpenRouterTransport,
} from "./media-openrouter";
import {
  classifyGeminiOutcome,
  classifyOpenRouterKeyCheck,
  classifyOpenRouterOutcome,
  GeminiBatchFailure,
  GeminiHttpError,
  GeminiMissingKeyError,
  liftProviderPause,
  paidWorkCost,
  pauseProvider,
  PAID_PROVIDERS,
  providerState,
  readEntityTurns,
  writeEntityTurns,
  runDailyCreditCheck,
  transientRetryAt,
  type CreditChecks,
  type OpenRouterKeyCheck,
  type PaidProvider,
  type PaidWorkCost,
  type ProviderOutcome,
  type ProviderState,
} from "./media-paid-providers";
import {
  ELIGIBLE_MEDIA_ENTITY_SQL,
  GEMINI_EMBEDDING_CONFIG_VERSION,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL,
} from "./media-similarity";

/** The model that generates extractions and Overviews, through OpenRouter chat completions. */
export const OPENROUTER_TEXT_MODEL = "anthropic/claude-haiku-5.5";
const EXTRACTION_CONFIG_VERSION = "media-extraction-2026-09-13-v3";
const SYNTHESIS_CONFIG_VERSION = "media-synthesis-2026-09-13-v5";
const CLEANUP_VERSION = "media-cleanup-2026-09-11-v1";
// Documented Gemini Batch prices, used only to estimate the cost of settled
// work for reporting. They never decide whether work is submitted. Text
// batches submitted to Gemini before the move to OpenRouter still settle.
const INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.125;
const OUTPUT_PRICE_MICRO_USD_PER_TOKEN = 0.75;
const EMBEDDING_INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.1;
/** How many paid items each provider may take from the queue in one ingestion tick. */
export const DEFAULT_PAID_SUBMISSIONS_PER_TICK = 60;
/** How long one advance may spend taking paid items from the queue before the rest wait for the next tick. */
export const DEFAULT_PAID_WORK_TIME_BUDGET_MS = 5 * 60 * 1_000;
const EXTRACTION_MAX_OUTPUT_TOKENS = 1_200;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 3_200;
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
const MAX_ARTICLE_CHARS = 120_000;
const MAX_REDIRECTS = 5;
const MAX_ERROR_LENGTH = 256;
const SIMILARITY_DIMENSIONS = ["gameplay", "story_world"] as const;
type SimilarityDimension = (typeof SIMILARITY_DIMENSIONS)[number];

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

type GeminiRequest = Record<string, unknown>;
type GeminiInlineRequest = { key: string; request: GeminiRequest };

export interface GeminiBatchUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiBatchPoll {
  state: "pending" | "succeeded" | "failed";
  output?: unknown;
  usage?: GeminiBatchUsage | null;
  error?: string | null;
  /** The provider's state of a batch that ended without output, such as `BATCH_STATE_EXPIRED`. */
  batchState?: string | null;
}

/**
 * Gemini Batch: embeddings, and polls of batches already submitted. Text
 * generation is no longer submitted to Gemini.
 */
export interface GeminiBatchTransport {
  countTokens(model: string, request: GeminiRequest): Promise<number>;
  submitEmbeddingBatch?(model: string, requests: readonly GeminiInlineRequest[]): Promise<{ name: string }>;
  pollBatch(name: string): Promise<GeminiBatchPoll>;
}

export type MediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
}

/** `error`'s message on one bounded line, with every configured secret and bearer token redacted. */
function boundedError(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, MAX_ERROR_LENGTH);
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
function retryAfterMs(response: Response, details: unknown): number | null {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  for (const detail of Array.isArray(details) ? details : []) {
    const delay = jsonObject(detail).retryDelay;
    const match = typeof delay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
    if (match) return Number(match[1]) * 1_000;
  }
  return null;
}

function providerError(response: Response, body: unknown): GeminiHttpError {
  const root = jsonObject(body);
  const nested = jsonObject(root.error);
  const message = nested.message ?? root.error;
  return new GeminiHttpError(
    response.status,
    typeof message === "string" ? message : `Gemini HTTP ${response.status}`,
    typeof nested.status === "string" ? nested.status : null,
    retryAfterMs(response, nested.details),
    (Array.isArray(nested.details) ? nested.details : []).map((detail) => jsonObject(detail).reason).filter((reason): reason is string => typeof reason === "string"),
  );
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export function createGeminiBatchTransport(apiKey: string, fetchFn: MediaFetch = fetch): GeminiBatchTransport {
  if (!apiKey || typeof apiKey !== "string") throw new GeminiMissingKeyError();
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const request = async (url: string, init: RequestInit): Promise<unknown> => {
    const response = await fetchFn(url, {
      ...init,
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-goog-api-key": apiKey, ...(init.headers ?? {}) },
    });
    const body = await responseJson(response);
    if (!response.ok) throw providerError(response, body);
    return body;
  };
  return {
    async countTokens(model, input) {
      const { generationConfig: _generationConfig, embedContentConfig: _embedContentConfig, content, ...countInput } = input;
      const payload = content ? { ...countInput, contents: [content] } : countInput;
      const body = await request(`${base}/models/${encodeURIComponent(model)}:countTokens`, { method: "POST", body: JSON.stringify(payload) });
      const root = jsonObject(body);
      const count = root.totalTokens ?? root.total_tokens;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("Gemini countTokens returned no bounded token count");
      return count;
    },
    async submitEmbeddingBatch(model, requests) {
      const body = await request(`${base}/models/${encodeURIComponent(model)}:asyncBatchEmbedContent`, {
        method: "POST",
        body: JSON.stringify({
          batch: {
            displayName: requests[0]?.key ?? "vaporstats-media-embedding",
            inputConfig: {
              requests: {
                requests: requests.map(({ key, request: item }) => ({
                  request: item,
                  metadata: { key },
                })),
              },
            },
          },
        }),
      });
      const root = jsonObject(body);
      const name = root.name ?? jsonObject(root.batch).name ?? jsonObject(root.operation).name;
      if (typeof name !== "string" || !name) throw new Error("Gemini embedding batch submission returned no batch name");
      return { name };
    },
    async pollBatch(name) {
      const response = await fetchFn(`${base}/${name.replace(/^\/+/, "")}`, { headers: { Accept: "application/json", "x-goog-api-key": apiKey } });
      const body = await responseJson(response);
      if (!response.ok) throw providerError(response, body);
      const root = jsonObject(body);
      const metadata = jsonObject(root.metadata);
      const rawState = metadata.state ?? root.state ?? root.status;
      const stateValue = String(
        typeof rawState === "object" ? jsonObject(rawState).name ?? jsonObject(rawState).state ?? jsonObject(rawState).status ?? "" : rawState ?? "",
      ).toUpperCase();
      const responseBody = root.response ?? root.result ?? root.output ?? root.responses ?? root.inlinedResponses;
      const responseRoot = jsonObject(responseBody);
      const inlineResponses = batchInlineResponses(responseBody);
      const inline = jsonObject(inlineResponses[0]);
      const inlineResponse = jsonObject(inline.response ?? inline.output);
      const usage = normalizeUsage(
        root.usageMetadata
          ?? root.usage
          ?? responseRoot.usageMetadata
          ?? responseRoot.usage
          ?? inline.usageMetadata
          ?? inline.usage
          ?? inlineResponse.usageMetadata
          ?? inlineResponse.usage,
      );
      if (!stateValue || /PENDING|RUNNING|QUEUED|PROCESSING|ACTIVE/.test(stateValue)) return { state: "pending" };
      if (/FAIL|CANCEL|EXPIRE|ERROR/.test(stateValue)) return { state: "failed", error: boundedError(jsonObject(root.error).message ?? root.error ?? stateValue), usage, batchState: stateValue };
      if (!/SUCCEED|COMPLETE|DONE/.test(stateValue)) return { state: "pending" };
      const inlineError = inline.error ?? inlineResponse.error;
      if (inlineError) {
        return { state: "failed", error: boundedError(jsonObject(inlineError).message ?? inlineError), usage };
      }
      const output = normalizeBatchOutput(responseBody);
      return { state: "succeeded", output, usage };
    },
  };
}

function normalizeUsage(value: unknown): GeminiBatchUsage | null {
  const root = jsonObject(value);
  if (Object.keys(root).length === 0) return null;
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const candidate = root[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return Math.floor(candidate);
    }
    return undefined;
  };
  return {
    inputTokens: number("inputTokens", "input_token_count", "promptTokenCount"),
    outputTokens: number("outputTokens", "output_token_count", "candidatesTokenCount"),
    thinkingTokens: number("thinkingTokens", "thinking_token_count", "thoughtsTokenCount"),
    promptTokenCount: number("promptTokenCount"),
    candidatesTokenCount: number("candidatesTokenCount"),
    thoughtsTokenCount: number("thoughtsTokenCount"),
  };
}

function batchInlineResponses(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = jsonObject(value);
  if (root.inlinedResponses !== undefined) return batchInlineResponses(root.inlinedResponses);
  if (root.responses !== undefined) return batchInlineResponses(root.responses);
  return [];
}

function normalizeBatchOutput(value: unknown): unknown {
  const inlineResponses = batchInlineResponses(value);
  if (inlineResponses.length > 0) {
    const first = inlineResponses[0];
    if (jsonObject(first).response !== undefined) return normalizeBatchOutput(jsonObject(first).response);
    if (jsonObject(first).output !== undefined) return normalizeBatchOutput(jsonObject(first).output);
    return normalizeBatchOutput(first);
  }
  const root = jsonObject(value);
  if (root.candidates && Array.isArray(root.candidates)) {
    const text = jsonObject(jsonObject(root.candidates[0]).content).parts;
    if (Array.isArray(text)) return text.map((part) => jsonObject(part).text).filter((part): part is string => typeof part === "string").join("");
  }
  return value;
}

function outletFor(value: string): (typeof MEDIA_OUTLETS)[number] | null {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return MEDIA_OUTLETS.find((item) => hostname === item.domain || hostname.endsWith(`.${item.domain}`)) ?? null;
  } catch {
    return null;
  }
}

function cleanLine(value: string): string {
  return value.replace(/[\t ]+/g, " ").replace(/\s+([,.;!?])/g, "$1").trim();
}

function cleanArticle(html: string): { content: string; hash: string } | null {
  let document: Document;
  try { document = parseHTML(html).document as unknown as Document; } catch { return null; }
  for (const node of Array.from(document.querySelectorAll("script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,[aria-label*='ad' i],[class*='ad' i],[id*='ad' i]"))) node.remove();
  let root: Element | null = document.querySelector("article");
  try {
    const readable = new Readability(document).parse() as { content?: string; textContent?: string } | null;
    if (readable?.content) root = parseHTML(`<!doctype html><html><body>${readable.content}</body></html>`).document.body;
    if (!root && readable?.textContent) {
      const text = readable.textContent.split(/\n+/).map(cleanLine).filter(Boolean).join("\n").slice(0, MAX_ARTICLE_CHARS);
      return text.length >= 120 ? { content: text, hash: sha256(text) } : null;
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
  const content = lines.join("\n").slice(0, MAX_ARTICLE_CHARS);
  return content.length >= 120 ? { content, hash: sha256(content) } : null;
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
  return { model: OPENROUTER_TEXT_MODEL, messages, response_format: { type: "json_object" }, max_tokens: maxTokens };
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
      contentHash: row.content_hash,
      context: metadataFor(source),
      extraction: parseExtraction(row.output_json),
    } : null;
  }).filter((item) => item !== null);
  return chatRequest(SYNTHESIS_MAX_OUTPUT_TOKENS, { role: "user", content: `Synthesize the current initial assessments for ${name || `game ${appid}`}. Return JSON only as {"statements":[{"text":"...","sourceUrls":["..."]}],"categories":[{"name":"...","findings":[{"text":"...","sourceUrls":["..."],"contested":true}]}],"prosCons":{"pros":[{"text":"...","sourceUrls":["..."]}],"cons":[...]},"tags":[{"label":"...","sourceUrls":["..."]}],"similarityInputs":{"gameplay":["..."],"storyWorld":["..."]}}. Write flowing, concise, game-first Overview statements. Write every Overview text field as a direct game observation; never mention coverage, critics, reviewers, reviews, outlets, publications, sources, assessments, agreement, consensus, or frequency. Multiple citation URLs communicate repeated support. Include only supported sections named ${MEDIA_CATEGORY_NAMES.join("; ")}; omit unsupported sections. Provide one global pros/cons overview, omit unsupported sides, and do not force neutral characteristics into pros or cons. Every entry must cite every supporting article URL. Tags are concise factual game descriptors and must be derived only from the supplied extraction.traits arrays, never from statements, categories, pros/cons, or summary wording. Cite every current extraction that supports each tag. Normalize semantically equivalent supported trait descriptions to one meaningful label without merging distinct characteristics or inventing missing traits. Preserve disputed traits when a supplied extraction supports them; do not include quality judgments, rankings, scores, reception, popularity, praise, performance, bugs, or technical complaints as tags. Return similarityInputs as the canonical aggregate of all supplied current extraction.contributions and any directly supported mechanics or story/world themes. Use gameplay for mechanics, systems, controls, combat, progression, and player-facing structure; use storyWorld for setting, narrative, characters, factions, and world themes. Keep each item a concise direct game description and omit a dimension when no supported evidence exists. Never put quality, praise, popularity, ratings, reception, criticism, performance, bugs, optimization, framerate, or other technical complaints in similarityInputs. Do not use Overview prose, tags, pros, or cons as similarityInputs. Evidence belongs only to app ${appid}; do not transfer incidental comparisons, DLC, expansion, bundle, or focused edition evidence.\n${JSON.stringify(evidence)}` });
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

type SourceRow = { id: number; appid: number; original_url: string; title: string; outlet: MediaOutlet; author: string | null; published_at: string | null; updated_at: string | null; retrieved_at: string; type: string; hands_on: number | null; affiliation: string | null; platform: string | null; build_context: string | null; normalized_content_hash: string | null; cleanup_version: string | null; processing_content: string | null; processing_input_identity: string | null; processing_run_id: number | null };
const SOURCE_COLUMNS = "id, appid, original_url, title, outlet, author, published_at, updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context, normalized_content_hash, cleanup_version, processing_content, processing_input_identity, processing_run_id";
const COUNTED_OUTPUT_COLUMNS = {
  new: "new_outputs",
  replaced: "replaced_outputs",
  invalidated: "invalidated_outputs",
  skipped: "skipped_outputs",
} as const;

/** Adds `count` outputs with `outcome` to `runId`'s durable output counts. */
async function countOutputs(db: AppDatabase, runId: number, outcome: keyof typeof COUNTED_OUTPUT_COLUMNS, count = 1): Promise<void> {
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
async function runRequestKey(db: AppDatabase, baseKey: string, runId: number): Promise<string> {
  const base = await first<{ run_id: number; status: JobRow["status"]; retained: number }>(db, "SELECT run_id, status, retained FROM media_processing_jobs WHERE request_key = ?", baseKey);
  const unsubmittedHistory = base?.retained === 1 && base.status === "reserved";
  const endedEarlier = base !== null && base.run_id !== runId && (base.status === "failed" || base.status === "stale" || base.status === "refused" || base.status === "uncertain");
  return unsubmittedHistory || endedEarlier ? `${baseKey}:retry:${runId}` : baseKey;
}

/**
 * Records how many active outputs for the run's bounded sources and entities
 * the run kept without producing them. It is a snapshot, so repeated advances
 * of one run do not add to it.
 */
async function recordReusedOutputs(db: AppDatabase, runId: number, sourceIds: readonly number[], entities: readonly number[]): Promise<void> {
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
}

async function outputCounts(db: AppDatabase, runId: number): Promise<MediaProcessingOutputCounts> {
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
type JobStage = "extraction" | "embedding" | "synthesis" | "explanation";
/**
 * A paid-work queue item. `queued` items wait for their provider. `reserved`
 * and `failed` appear only on retained rows, written under the retired
 * lifetime allowance before the queue existed: new work that a provider or
 * validation definitely refuses is `refused`.
 */
type JobStatus = "queued" | "reserved" | "submitted" | "succeeded" | "failed" | "refused" | "uncertain" | "stale";
type JobRow = { id: number; retained: number; run_id: number; stage: JobStage; appid: number; matched_appid: number | null; dimension: SimilarityDimension | null; source_id: number | null; request_key: string; input_identity: string; model: string; config_version: string; max_input_tokens: number; max_output_tokens: number; reserved_microusd: number; charged_microusd: number | null; reservation_active: number; status: JobStatus; provider: PaidProvider; enqueued_at: string; attempt_count: number; provider_batch_id: string | null; output_json: string | null; usage_json: string; error: string | null };
const JOB_COLUMNS = "id, retained, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider, enqueued_at, attempt_count, provider_batch_id, output_json, usage_json, error";
/**
 * Items that wait in the queue for their provider. A retained row is history
 * and never waits: it is never deleted, submitted or returned to the queue,
 * whether or not its input still matches current work, and an authorized
 * run queues that work as an item of its own.
 */
const WAITING = "(status = 'queued' AND retained = 0)";
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
async function enqueueItem(db: AppDatabase, item: QueueInput, now: Date): Promise<boolean> {
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO media_processing_jobs (run_id, stage, appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider, enqueued_at, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 'queued', ?, ?, '{}')",
  ).bind(item.run_id, item.stage, item.appid, item.dimension ?? null, item.source_id, item.request_key, item.input_identity, item.model, item.config_version, item.max_output_tokens, item.provider, now.toISOString()).run();
  return inserted.meta.changes === 1;
}

/**
 * Fetches a source's article, or returns why its outlet must not be contacted
 * again in this run: an access denial, the shared UTC-day attempt cap, or a
 * same-day rate limit. Every request reserves its attempt under the run's pass
 * first; any other failure skips only this source.
 */
async function fetchArticle(db: AppDatabase, source: SourceRow, runId: number, fetchFn: ArticleFetch, clock: () => Date): Promise<string | { outletStop: string } | null> {
  let current = source.original_url;
  const outlet = outletFor(current);
  if (!outlet || outlet.name !== source.outlet) return null;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const reservation = await reserveOutletAttempt(db, { runId, appid: source.appid, outlet: source.outlet, kind: "fetch", url: current, date: clock() });
    if ("stop" in reservation) return { outletStop: reservation.stop };
    let response: Response | string;
    try { response = await fetchFn(current, { redirect: "manual", headers: { Accept: "text/html,application/xhtml+xml" } }); }
    catch (error) {
      await finishOutletAttempt(db, reservation.attemptId, { kind: "failure", statusCode: null, succeeded: false, error: boundedError(error) });
      return null;
    }
    if (typeof response === "string") {
      await finishOutletAttempt(db, reservation.attemptId, { kind: "fetch", statusCode: 200, succeeded: true, error: null });
      return response;
    }
    const isRedirect = response.status >= 300 && response.status < 400;
    await finishOutletAttempt(db, reservation.attemptId, { kind: isRedirect ? "redirect" : "fetch", statusCode: response.status, succeeded: response.ok, error: response.ok ? null : `HTTP ${response.status}` });
    if (response.status === 401 || response.status === 403 || response.status === 429) return { outletStop: `fetch_http_${response.status}` };
    if (isRedirect) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) return null;
      const next = new URL(location, current).toString();
      if (!outletFor(next) || outletFor(next)?.name !== source.outlet) return null;
      current = next;
      continue;
    }
    if (!response.ok) return null;
    return response.text();
  }
  return null;
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
};

function noteReason(advance: QueueAdvance, runId: number, reason: string): void {
  const reasons = advance.reasons.get(runId) ?? new Set<string>();
  reasons.add(reason);
  advance.reasons.set(runId, reasons);
}

/**
 * The mark of an item whose request is in flight. It is written, with the
 * send time and the item's input identity already recorded, in a committed
 * write before the request is sent, so an item found with it after a restart
 * is uncertain: its request may have reached the provider.
 */
const IN_FLIGHT = "submission in progress";
/** The error an item in flight when the application stopped is left with. */
const IN_FLIGHT_AT_STARTUP = "uncertain:in_flight_at_startup";

/** Refuses `job` for its input identity with `reason`, counting it skipped once. */
async function refuseItem(db: AppDatabase, job: JobRow, reason: string, now: Date): Promise<void> {
  await transaction(db, async () => {
    const refused = await db.prepare(`UPDATE media_processing_jobs SET status = 'refused', error = ?, next_attempt_at = NULL, completed_at = ? WHERE id = ? AND ${WAITING} OR (id = ? AND status = 'uncertain' AND error = '${IN_FLIGHT}')`).bind(reason, now.toISOString(), job.id, job.id).run();
    if (refused.meta.changes === 1) await countOutputs(db, job.run_id, "skipped");
  });
}

/** Removes a waiting item whose work turned out to need no provider: it never cost anything. */
async function resolveItemWithoutProvider(db: AppDatabase, job: JobRow): Promise<void> {
  await db.prepare(`DELETE FROM media_processing_jobs WHERE id = ? AND ${WAITING}`).bind(job.id).run();
}

/**
 * Acts on a classified provider outcome that left `job` unsubmitted. A
 * transient outcome keeps it queued with backoff and counts an attempt; a
 * Credit pause or missing configuration pauses its provider and counts
 * nothing; a refusal refuses it for its input identity.
 */
async function holdItem(advance: QueueAdvance, job: JobRow, outcome: Exclude<ProviderOutcome, { class: "success" }>): Promise<void> {
  const { db, now } = advance;
  if (outcome.class === "refusal") {
    await refuseItem(db, job, outcome.reason, now);
    noteReason(advance, job.run_id, outcome.reason === "input_token_cap" ? "input_token_cap" : "provider_refusal");
    return;
  }
  if (outcome.class === "credit_pause" || outcome.class === "missing_configuration") {
    await transaction(db, async () => {
      await db.prepare(`UPDATE media_processing_jobs SET status = 'queued', error = NULL, submitted_at = NULL WHERE id = ? AND status = 'uncertain' AND error = '${IN_FLIGHT}'`).bind(job.id).run();
      await pauseProvider(db, job.provider, outcome.reason, now);
    });
    advance.paused.add(job.provider);
    return;
  }
  // A transient failure, or a free request that may simply be retried.
  const failures = job.attempt_count + 1;
  const retryAt = transientRetryAt(failures, now, outcome.class === "transient" ? outcome.retryAfterMs : null);
  await db.prepare(`UPDATE media_processing_jobs SET status = 'queued', attempt_count = ?, next_attempt_at = ?, error = ?, submitted_at = NULL WHERE id = ? AND (${WAITING} OR (status = 'uncertain' AND error = '${IN_FLIGHT}'))`).bind(failures, retryAt.toISOString(), `transient:${outcome.reason}`, job.id).run();
  noteReason(advance, job.run_id, "transient_provider_failure");
}

/** Counts `request`'s input tokens, or returns the classified failure. A count is free and never uncertain. */
async function countItemTokens(advance: QueueAdvance, model: string, request: GeminiRequest): Promise<number | Exclude<ProviderOutcome, { class: "success" }>> {
  try {
    return await advance.transport!.countTokens(model, request);
  } catch (error) {
    const outcome = classifyGeminiOutcome("count", error);
    return outcome.class === "success" ? { class: "transient", reason: "count_without_result", retryAfterMs: null } : outcome;
  }
}

/**
 * Counts and submits the Gemini embedding batch `request` for `job`. Before
 * the request is sent, the item is durably marked in flight with its send
 * time, so a restart never resends a request that may have been received.
 * Every outcome is classified once and acted on here.
 */
async function sendItem(advance: QueueAdvance, job: JobRow, model: string, request: GeminiRequest, maxInputTokens: number): Promise<void> {
  const { db, now, transport } = advance;
  const counted = await countItemTokens(advance, model, request);
  if (typeof counted !== "number") return holdItem(advance, job, counted);
  if (!Number.isInteger(counted) || counted < 0 || counted > maxInputTokens) {
    return holdItem(advance, job, { class: "refusal", reason: "input_token_cap" });
  }
  const marked = await db.prepare(`UPDATE media_processing_jobs SET status = 'uncertain', error = '${IN_FLIGHT}', max_input_tokens = ?, submitted_at = ? WHERE id = ? AND ${WAITING}`).bind(counted, now.toISOString(), job.id).run();
  if (marked.meta.changes !== 1) return;
  let result: { name: string } | null = null;
  let outcome: ProviderOutcome;
  try {
    result = await transport!.submitEmbeddingBatch!(job.model, [{ key: job.request_key, request }]);
    outcome = classifyGeminiOutcome("submit", null);
  } catch (error) {
    outcome = classifyGeminiOutcome("submit", error);
    if (outcome.class === "uncertain") {
      await db.prepare("UPDATE media_processing_jobs SET error = ? WHERE id = ? AND status = 'uncertain'").bind(boundedError(error, advance.secrets), job.id).run();
      noteReason(advance, job.run_id, "uncertain_submission");
      return;
    }
  }
  if (outcome.class !== "success") return holdItem(advance, job, outcome);
  if (!result?.name) {
    await db.prepare("UPDATE media_processing_jobs SET error = ? WHERE id = ? AND status = 'uncertain'").bind("Gemini submission returned no batch identifier", job.id).run();
    return;
  }
  const update = await db.prepare("UPDATE media_processing_jobs SET status = 'submitted', provider_batch_id = ?, error = NULL WHERE id = ? AND status = 'uncertain' AND provider_batch_id IS NULL").bind(result.name, job.id).run();
  if (update.meta.changes === 1) advance.submitted.set(job.run_id, (advance.submitted.get(job.run_id) ?? 0) + 1);
}

/**
 * Sends `request` for text item `job` as one OpenRouter chat completion.
 * Input over the cap, by a conservative local estimate, is refused unsent.
 * Before sending, the item is recorded in flight with its send time in a
 * committed write; its input identity is already recorded. No write
 * transaction is open while the request is in flight. A fully sent request
 * whose outcome is unknown leaves the item uncertain, never to be resent
 * automatically; every other outcome is classified once and acted on here.
 */
async function sendTextItem(advance: QueueAdvance, job: JobRow, request: OpenRouterChatRequest): Promise<void> {
  const { db, now } = advance;
  const estimated = estimatedInputTokens(request);
  if (estimated > OPENROUTER_MAX_INPUT_TOKENS) return holdItem(advance, job, { class: "refusal", reason: "input_token_cap" });
  const marked = await db.prepare(`UPDATE media_processing_jobs SET status = 'uncertain', error = '${IN_FLIGHT}', max_input_tokens = ?, submitted_at = ? WHERE id = ? AND ${WAITING}`).bind(estimated, now.toISOString(), job.id).run();
  if (marked.meta.changes !== 1) return;
  let completion: OpenRouterCompletion | null = null;
  let outcome: ProviderOutcome;
  try {
    completion = await advance.openRouter!.complete(request);
    outcome = classifyOpenRouterOutcome(null);
  } catch (error) {
    outcome = classifyOpenRouterOutcome(error);
  }
  if (outcome.class === "uncertain") {
    await db.prepare(`UPDATE media_processing_jobs SET error = ? WHERE id = ? AND status = 'uncertain' AND error = '${IN_FLIGHT}'`).bind(`uncertain:${outcome.reason}`, job.id).run();
    noteReason(advance, job.run_id, "uncertain_submission");
    return;
  }
  if (outcome.class !== "success") return holdItem(advance, job, outcome);
  advance.submitted.set(job.run_id, (advance.submitted.get(job.run_id) ?? 0) + 1);
  await settleCompletion(db, job, completion!, now);
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
 * Applies an OpenRouter answer to text item `job` in one short transaction:
 * its cost, token usage, generation id, routed provider and model, then its
 * output under the current-input and stale-write checks. Output the parsers
 * reject is a definite refusal.
 */
function settleCompletion(db: AppDatabase, job: JobRow, completion: OpenRouterCompletion, now: Date): Promise<SettledStatus> {
  return writeTransaction(db, async () => {
    const charge = reportedCharge(completion);
    const usage = { promptTokens: completion.usage.promptTokens, completionTokens: completion.usage.completionTokens };
    await db.prepare("UPDATE media_processing_jobs SET usage_json = ?, charged_microusd = ?, cost_source = ?, generation_id = ?, routed_provider = ?, routed_model = ?, error = NULL, completed_at = ? WHERE id = ?")
      .bind(JSON.stringify(usage), charge.microusd, charge.source, completion.generationId, completion.provider, completion.model, now.toISOString(), job.id).run();
    const status = job.stage === "extraction"
      ? await persistExtraction(db, job, completion.content, now)
      : await persistOverview(db, job, completion.content, now);
    if (status === "refused" || status === "stale") await countOutputs(db, job.run_id, "skipped");
    return status;
  });
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

async function persistExtraction(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "refused"> {
  if (job.source_id === null) return "refused";
  const source = await currentSource(db, job.source_id!);
  if (!source || source.processing_input_identity !== job.input_identity) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    if (source) await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
    return "stale";
  }
  const eligible = await first<{ appid: number }>(
    db,
    `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`,
    source.appid,
  );
  if (!eligible) {
    await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  const parsed = parseExtraction(output);
  if (parsed.contributions.length === 0 && parsed.traits.length === 0 && !parsed.categories && !parsed.similarityInputs) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'refused', error = ?, completed_at = ? WHERE id = ?").bind("invalid_output: no supported contributions", now.toISOString(), job.id).run();
    await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
    return "refused";
  }
  const stored = storedExtractionJson(output, job.input_identity, source.original_url);
  const earlier = await first<{ id: number }>(db, "SELECT id FROM media_article_extractions WHERE source_id = ? LIMIT 1", source.id);
  await countOutputs(db, job.run_id, earlier ? "replaced" : "new");
  await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
  await db.prepare("INSERT OR IGNORE INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(source.id, job.input_identity, source.normalized_content_hash ?? "", CLEANUP_VERSION, job.model, job.config_version, stored, now.toISOString()).run();
  await markContributionChanged(db, source.id, job.run_id);
  await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?").bind(stored, now.toISOString(), job.id).run();
  return "succeeded";
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

async function persistOverview(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "refused"> {
  const eligible = await first<{ appid: number }>(
    db,
    `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`,
    job.appid,
  );
  if (!eligible) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  const evidence = await currentGameEvidence(db, job.appid);
  const { evidenceSources } = evidence;
  if (!synthesisIsCurrent(job, evidence.extractions)) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  const tagEvidence = parseMediaTagEvidence(output, evidenceSources);
  const overview = parseMediaOverview(output, job.appid, evidenceSources);
  if (!overview) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'refused', error = ?, completed_at = ? WHERE id = ?").bind("invalid_output: no cited statements", now.toISOString(), job.id).run();
    return "refused";
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
  await countOutputs(db, job.run_id, earlier ? "replaced" : "new");
  await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(job.appid).run();
  await db.prepare("INSERT OR IGNORE INTO media_game_overviews (appid, input_identity, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(job.appid, job.input_identity, job.model, job.config_version, JSON.stringify(storedOverview), now.toISOString()).run();
  await replaceTagMemberships(db, job.appid, storedOverview, evidence, now);
  await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?").bind(JSON.stringify(storedOverview), now.toISOString(), job.id).run();
  return "succeeded";
}

function decodeVector(value: unknown): Float32Array | null {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
  if (!bytes || bytes.byteLength !== GEMINI_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) return null;
  const copy = bytes.slice();
  const vector = new Float32Array(copy.buffer);
  return vector.every(Number.isFinite) ? vector : null;
}

function encodeVector(values: readonly number[]): Uint8Array {
  const buffer = new ArrayBuffer(values.length * Float32Array.BYTES_PER_ELEMENT);
  new Float32Array(buffer).set(values);
  return new Uint8Array(buffer);
}

function embeddingValues(value: unknown): number[] | null {
  const root = jsonObject(parseJson(value));
  const embedding = jsonObject(root.embedding);
  const raw = Array.isArray(embedding.values)
    ? embedding.values
    : Array.isArray(root.values)
      ? root.values
      : Array.isArray(root.embeddings) && root.embeddings.length > 0
        ? jsonObject(root.embeddings[0]).values
        : null;
  if (
    !Array.isArray(raw)
    || raw.length !== GEMINI_EMBEDDING_DIMENSIONS
    || !raw.every((item) => typeof item === "number" && Number.isFinite(item) && Number.isFinite(Math.fround(item)))
  ) return null;
  return raw;
}

function embeddingOverviewIdentity(job: JobRow): string | null {
  if (job.source_id !== null || !job.dimension) return null;
  const match = new RegExp(`^embedding:${job.appid}:${job.dimension}:([a-f0-9]{64}):${job.input_identity}(?::retry:${job.run_id})?$`).exec(job.request_key);
  return match?.[1] ?? null;
}

async function persistEmbedding(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "refused"> {
  const markStale = async () => {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale" as const;
  };
  const overviewInputIdentity = embeddingOverviewIdentity(job);
  if (!overviewInputIdentity || !job.dimension) return markStale();
  const eligible = await first<{ appid: number }>(
    db,
    `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`,
    job.appid,
  );
  if (!eligible) {
    await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND active = 1").bind(job.appid).run();
    return markStale();
  }
  const overview = await first<{ input_identity: string; output_json: string }>(db, "SELECT input_identity, output_json FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1", job.appid);
  const input = overviewSimilarityInput(overview?.output_json, job.dimension);
  if (!overview || overview.input_identity !== overviewInputIdentity || input.length === 0 || similarityInputIdentity(job.dimension, input) !== job.input_identity) return markStale();
  const values = embeddingValues(output);
  if (!values) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'refused', error = ?, completed_at = ? WHERE id = ?").bind("invalid_output: incompatible vector", now.toISOString(), job.id).run();
    return "refused";
  }
  const vector = encodeVector(values);
  const existing = await first<{ id: number }>(db, "SELECT id FROM media_game_embeddings WHERE appid = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ? ORDER BY id DESC LIMIT 1", job.appid, job.dimension, job.input_identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION);
  const earlier = await first<{ id: number }>(db, "SELECT id FROM media_game_embeddings WHERE appid = ? AND dimension = ? LIMIT 1", job.appid, job.dimension);
  await countOutputs(db, job.run_id, earlier ? "replaced" : "new");
  await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND dimension = ? AND active = 1").bind(job.appid, job.dimension).run();
  if (existing) {
    await db.prepare("UPDATE media_game_embeddings SET overview_input_identity = ?, vector = ?, active = 1 WHERE id = ? AND appid = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ?").bind(overviewInputIdentity, vector, existing.id, job.appid, job.dimension, job.input_identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION).run();
  } else {
    await db.prepare("INSERT INTO media_game_embeddings (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(job.appid, job.dimension, job.input_identity, overviewInputIdentity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION, vector, now.toISOString()).run();
  }
  await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?").bind(JSON.stringify({ dimensions: GEMINI_EMBEDDING_DIMENSIONS, dimension: job.dimension, inputIdentity: job.input_identity, overviewInputIdentity }), now.toISOString(), job.id).run();
  return "succeeded";
}

type SettledStatus = "succeeded" | "refused" | "stale";

/**
 * Settles `job` with its provider `result`, records its cost for reporting,
 * and counts its output, in one transaction, so a restart never leaves a
 * settled job uncounted.
 */
function reconcileJob(db: AppDatabase, job: JobRow, result: GeminiBatchPoll & { state: "succeeded" | "failed" }, now: Date, secrets: readonly (string | undefined)[]): Promise<SettledStatus> {
  return writeTransaction(db, async () => {
    const status = await settleJob(db, job, result, now, secrets);
    if ((status === "refused" || status === "stale") && job.stage !== "explanation") await countOutputs(db, job.run_id, "skipped");
    return status;
  });
}

async function settleJob(db: AppDatabase, job: JobRow, result: GeminiBatchPoll & { state: "succeeded" | "failed" }, now: Date, secrets: readonly (string | undefined)[]): Promise<SettledStatus> {
  const usageJson = result.usage ? JSON.stringify(result.usage) : "{}";
  const charge = settledCharge(job, result.usage ?? null);
  // A retained row keeps its reserved amount and reservation flag as history.
  await db.prepare("UPDATE media_processing_jobs SET usage_json = ?, charged_microusd = ?, cost_source = ?, completed_at = ? WHERE id = ?").bind(usageJson, charge.microusd, charge.source, now.toISOString(), job.id).run();
  if (result.state === "failed") {
    await db.prepare("UPDATE media_processing_jobs SET status = 'refused', error = ? WHERE id = ?").bind(boundedError(result.error, secrets), job.id).run();
    return "refused";
  }
  if (job.stage === "extraction") return persistExtraction(db, job, result.output, now);
  if (job.stage === "embedding") return persistEmbedding(db, job, result.output, now);
  if (job.stage === "explanation") {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  return persistOverview(db, job, result.output, now);
}

/**
 * Returns the item of a batch the provider ended without running it to the
 * queue. A retained row is never returned to the queue: it ends `stale` with
 * its recorded values kept, and an authorized run queues its work anew.
 */
async function returnUnrunBatch(db: AppDatabase, job: JobRow, retry: { attemptCount: number; nextAttemptAt: string | null; error: string | null }, now: Date): Promise<void> {
  if (job.retained === 1) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', error = ?, completed_at = ? WHERE id = ? AND status = 'submitted'").bind(retry.error ?? "provider ended the batch without output", now.toISOString(), job.id).run();
    return;
  }
  await db.prepare("UPDATE media_processing_jobs SET status = 'queued', provider_batch_id = NULL, submitted_at = NULL, attempt_count = ?, next_attempt_at = ?, error = ? WHERE id = ? AND status = 'submitted' AND retained = 0").bind(retry.attemptCount, retry.nextAttemptAt, retry.error, job.id).run();
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
 * error about the batch itself leaves it uncertain. A batch the provider
 * ended for exhausted credit returns its item to the queue with no attempt
 * counted; one it expired or cancelled returns it with backoff, like a
 * transient failure.
 */
async function pollSubmittedJobs(advance: QueueAdvance, jobs: readonly JobRow[]): Promise<SubmittedPollSummary> {
  const { db, now, transport, secrets } = advance;
  const summary: SubmittedPollSummary = { polled: new Set(), succeeded: 0, failed: 0, uncertain: 0 };
  if (!transport) return summary;
  for (const job of jobs) {
    summary.polled.add(job.id);
    if (!job.provider_batch_id) {
      summary.uncertain += 1;
      continue;
    }
    let result: GeminiBatchPoll;
    try {
      result = await transport.pollBatch(job.provider_batch_id);
    } catch (error) {
      const outcome = classifyGeminiOutcome("poll", error);
      if (outcome.class === "credit_pause" || outcome.class === "missing_configuration") {
        await pauseProvider(db, job.provider, outcome.reason, now);
        advance.paused.add(job.provider);
      }
      const status = outcome.class === "uncertain" || outcome.class === "refusal" ? "uncertain" : "submitted";
      await db.prepare("UPDATE media_processing_jobs SET status = ?, error = ? WHERE id = ? AND status = 'submitted'").bind(status, boundedError(error, secrets), job.id).run();
      summary.uncertain += 1;
      continue;
    }
    if (result.state === "pending") {
      summary.uncertain += 1;
      continue;
    }
    if (result.state === "failed") {
      const outcome = classifyGeminiOutcome("poll", new GeminiBatchFailure(boundedError(result.error ?? "batch failed", secrets), result.batchState ?? null));
      if (outcome.class === "credit_pause" || outcome.class === "missing_configuration") {
        // The provider declined the batch for credit or configuration:
        // nothing was produced, so the item waits again, with no attempt
        // counted.
        await transaction(db, async () => {
          await returnUnrunBatch(db, job, { attemptCount: job.attempt_count, nextAttemptAt: null, error: null }, now);
          await pauseProvider(db, job.provider, outcome.reason, now);
        });
        advance.paused.add(job.provider);
        summary.uncertain += 1;
        continue;
      }
      if (outcome.class === "transient") {
        // The provider ended the batch without running it: the item waits
        // again and retries with backoff.
        const failures = job.attempt_count + 1;
        await returnUnrunBatch(db, job, { attemptCount: failures, nextAttemptAt: transientRetryAt(failures, now, null).toISOString(), error: `transient:${outcome.reason}` }, now);
        noteReason(advance, job.run_id, "transient_provider_failure");
        summary.uncertain += 1;
        continue;
      }
    }
    const status = await reconcileJob(db, job, result as GeminiBatchPoll & { state: "succeeded" | "failed" }, now, secrets);
    if (status === "succeeded") summary.succeeded += 1;
    else summary.failed += 1;
  }
  return summary;
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
 * at most the experiment's total article ceiling, each belonging to an
 * eligible entity of the selected games.
 */
async function validatedAffectedSourceIds(db: AppDatabase, selectedGames: readonly number[], value: readonly number[] | undefined): Promise<number[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MEDIA_ARTICLES_TOTAL || !value.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(value).size !== value.length) {
    throw new Error("Affected media sources must be distinct positive ids within the article ceiling");
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

/** The sources of `entities` that processing considers: at most 15 per entity and the experiment total. */
async function boundedSources(db: AppDatabase, entities: readonly number[]): Promise<SourceRow[]> {
  const allSources = await rows<SourceRow>(db, `SELECT ${SOURCE_COLUMNS} FROM media_sources WHERE appid IN (SELECT value FROM json_each(?)) ORDER BY appid, id`, JSON.stringify(entities));
  const sourceCountByGame = new Map<number, number>();
  let boundedSourceCount = 0;
  return allSources.filter((source) => {
    if (boundedSourceCount >= MAX_MEDIA_ARTICLES_TOTAL) return false;
    const count = sourceCountByGame.get(source.appid) ?? 0;
    if (count >= MAX_MEDIA_ARTICLES_PER_GAME) return false;
    sourceCountByGame.set(source.appid, count + 1);
    boundedSourceCount += 1;
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

async function hasPendingExtractions(db: AppDatabase, appid: number): Promise<boolean> {
  return (await first<{ pending: number }>(db, `SELECT 1 AS pending FROM media_processing_jobs WHERE appid = ? AND stage = 'extraction' AND (status = 'submitted' OR ${WAITING}) LIMIT 1`, appid)) !== null;
}

/**
 * Queues an extraction for every source `run` takes. Taking the source and
 * queuing its item is one write; the article is fetched only when the item
 * is submitted, so a waiting item holds no text.
 */
async function enqueueExtractions(advance: QueueAdvance, run: OpenAuthorization, entities: readonly number[]): Promise<void> {
  const { db, now } = advance;
  const runId = run.auth.run_id;
  const affected = new Set(parseAffectedSourceIds(run.auth.affected_source_ids));
  for (const source of await boundedSources(db, entities)) {
    if (!inScope(source, runId, affected)) continue;
    await transaction(db, async () => {
      const current = await currentSource(db, source.id);
      if (!current || !inScope(current, runId, affected)) return;
      const open = await first<{ open: number }>(db, `SELECT 1 AS open FROM media_processing_jobs WHERE run_id = ? AND source_id = ? AND stage = 'extraction' AND (status IN ('submitted', 'uncertain') OR ${WAITING}) LIMIT 1`, runId, current.id);
      if (!open) {
        await enqueueItem(db, { provider: "openrouter", run_id: runId, stage: "extraction", appid: current.appid, source_id: current.id, request_key: `extraction:${current.id}:run:${runId}`, input_identity: `source:${current.id}`, model: OPENROUTER_TEXT_MODEL, config_version: EXTRACTION_CONFIG_VERSION, max_output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS }, now);
      }
      await db.prepare("UPDATE media_sources SET processing_run_id = ?, processing_content = NULL WHERE id = ?").bind(runId, current.id).run();
    });
  }
}

/**
 * Queues Overview and embedding work for the games `runId` may rebuild. An
 * Overview is queued only when its game has no queued or in-flight
 * extraction, and its current contributions differ from those its active
 * Overview was built from, or it has none. A model or configuration version
 * change alone queues nothing.
 */
async function enqueueOverviewWork(advance: QueueAdvance, runId: number, entities: readonly number[]): Promise<void> {
  const { db, now } = advance;
  const scopeGames = [...await rebuildScopeGames(db, runId, entities)].sort((a, b) => a - b);
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
    const requestKey = await runRequestKey(db, `synthesis:${appid}:${identity}`, runId);
    if (await first<{ id: number }>(db, "SELECT id FROM media_processing_jobs WHERE request_key = ?", requestKey)) continue;
    await enqueueItem(db, { provider: "openrouter", run_id: runId, stage: "synthesis", appid, source_id: null, request_key: requestKey, input_identity: identity, model: OPENROUTER_TEXT_MODEL, config_version: SYNTHESIS_CONFIG_VERSION, max_output_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS }, now);
  }
  await enqueueEmbeddings(advance, runId, scopeGames);
}

/** Queues an embedding for each dimension whose `similarityInputs` changed in an active Overview of `scopeGames`. */
async function enqueueEmbeddings(advance: QueueAdvance, runId: number, scopeGames: readonly number[]): Promise<void> {
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
      const requestKey = await runRequestKey(db, `embedding:${overview.appid}:${dimension}:${overview.input_identity}:${identity}`, runId);
      if (await first<{ id: number }>(db, "SELECT id FROM media_processing_jobs WHERE request_key = ?", requestKey)) continue;
      await enqueueItem(db, { provider: "gemini", run_id: runId, stage: "embedding", appid: overview.appid, dimension, source_id: null, request_key: requestKey, input_identity: identity, model: GEMINI_EMBEDDING_MODEL, config_version: GEMINI_EMBEDDING_CONFIG_VERSION, max_output_tokens: EMBEDDING_MAX_OUTPUT_TOKENS }, now);
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
    await resolveItemWithoutProvider(db, job);
    return false;
  }
  const stopped = advance.outletStops.get(source.outlet);
  if (stopped) {
    // The outlet's stop rules hold the item waiting; it keeps its place.
    noteReason(advance, job.run_id, `${source.outlet}:${stopped}`);
    return false;
  }
  const body = await fetchArticle(db, source, job.run_id, advance.articleFetch, advance.clock);
  if (body && typeof body === "object") {
    advance.outletStops.set(source.outlet, body.outletStop);
    noteReason(advance, job.run_id, `${source.outlet}:${body.outletStop}`);
    return true;
  }
  const cleaned = body ? cleanArticle(body) : null;
  if (!cleaned) {
    const reason = body ? "article_unusable" : "article_unreachable";
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
    if (kept) await resolveItemWithoutProvider(db, job);
  });
  if (kept || !identity || !current) return true;
  const knownExtraction = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND input_identity = ? LIMIT 1", source.id, identity);
  if (knownExtraction) {
    await transaction(db, async () => {
      await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
      await db.prepare("UPDATE media_article_extractions SET active = 1 WHERE id = ?").bind(knownExtraction.id).run();
      await markContributionChanged(db, source.id, job.run_id);
      await resolveItemWithoutProvider(db, job);
    });
    return true;
  }
  // The same input in a submitted batch or extracted under another item
  // needs no second request. An uncertain request of the same input does not
  // count: only a correction set takes its source again, to resend it.
  const duplicate = await first<{ id: number }>(db, "SELECT id FROM media_processing_jobs WHERE id <> ? AND stage = 'extraction' AND source_id = ? AND input_identity = ? AND status IN ('submitted', 'succeeded') LIMIT 1", job.id, source.id, identity);
  if (duplicate) {
    await resolveItemWithoutProvider(db, job);
    return true;
  }
  await db.prepare("UPDATE media_processing_jobs SET input_identity = ? WHERE id = ?").bind(identity, job.id).run();
  await sendTextItem(advance, { ...job, input_identity: identity }, makeExtractionRequest(current, cleaned.content));
  return true;
}

/** Submits a selected Overview item while it still describes the game's current contributions. */
async function takeSynthesisTurn(advance: QueueAdvance, job: JobRow): Promise<boolean> {
  const { db } = advance;
  if (!await isEligibleEntity(db, job.appid)) {
    await resolveItemWithoutProvider(db, job);
    return false;
  }
  // New extraction work for the game would change its contributions: the
  // Overview waits for it.
  if (await hasPendingExtractions(db, job.appid)) return false;
  const evidence = await currentGameEvidence(db, job.appid);
  if (evidence.extractions.length === 0 || !synthesisIsCurrent(job, evidence.extractions)) {
    await resolveItemWithoutProvider(db, job);
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
    noteReason(advance, job.run_id, "missing_gemini_embedding_batch");
    return false;
  }
  const overviewInputIdentity = embeddingOverviewIdentity(job);
  const overview = await first<{ input_identity: string; output_json: string }>(db, "SELECT input_identity, output_json FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1", job.appid);
  const input = job.dimension ? overviewSimilarityInput(overview?.output_json, job.dimension) : [];
  if (!await isEligibleEntity(db, job.appid) || !overview || !job.dimension || overview.input_identity !== overviewInputIdentity || input.length === 0 || similarityInputIdentity(job.dimension, input) !== job.input_identity) {
    await resolveItemWithoutProvider(db, job);
    return false;
  }
  await sendItem(advance, job, GEMINI_EMBEDDING_MODEL, makeEmbeddingRequest(input), MAX_EMBEDDING_INPUT_TOKENS);
  return true;
}

async function takeTurn(advance: QueueAdvance, job: JobRow): Promise<boolean> {
  if (job.stage === "extraction") return takeExtractionTurn(advance, job);
  if (job.stage === "synthesis") return takeSynthesisTurn(advance, job);
  if (job.stage === "embedding") return takeEmbeddingTurn(advance, job);
  await resolveItemWithoutProvider(advance.db, job);
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
async function submitQueuedWork(advance: QueueAdvance, probing: Set<PaidProvider>): Promise<void> {
  const { db, now } = advance;
  for (const provider of PAID_PROVIDERS) {
    const configured = provider === "openrouter" ? advance.openRouter !== null : advance.transport !== null;
    if (!configured || advance.paused.has(provider) || advance.remaining[provider] <= 0 || advance.outOfTime()) continue;
    const ready = await rows<JobRow>(
      db,
      `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE provider = ? AND ${WAITING} AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)) ORDER BY julianday(enqueued_at), id`,
      provider,
      now.toISOString(),
    );
    if (ready.length === 0) continue;
    const entityOrder = await rows<{ appid: number }>(
      db,
      `SELECT appid FROM media_processing_jobs WHERE provider = ? AND ${WAITING} GROUP BY appid ORDER BY MIN(julianday(enqueued_at)), appid`,
      provider,
    );
    const byEntity = new Map<number, JobRow[]>();
    for (const job of ready) byEntity.set(job.appid, [...(byEntity.get(job.appid) ?? []), job]);
    const turns: JobRow[] = [];
    if (probing.has(provider)) {
      probing.delete(provider);
      const probe = ready.find((job) => job.stage === "embedding");
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
      if (await takeTurn(advance, job)) {
        advance.remaining[provider] -= 1;
        entityTurns.last.set(job.appid, entityTurns.next);
        entityTurns.next += 1;
      }
    }
    // Only entities that still have work keep their last turn.
    const active = new Set((await rows<{ appid: number }>(db, `SELECT DISTINCT appid FROM media_processing_jobs WHERE provider = ? AND (status = 'submitted' OR ${WAITING})`, provider)).map(({ appid }) => appid));
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
  const runAggregate = await first<{ succeeded: number; failed: number; uncertain: number; pending: number; jobs: number; hard: number; waiting: number }>(
    db,
    `SELECT COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
       COALESCE(SUM(status IN ('failed', 'refused', 'stale')), 0) AS failed,
       COALESCE(SUM(status = 'uncertain'), 0) AS uncertain,
       COALESCE(SUM(status IN ('submitted', 'uncertain') OR ${WAITING}), 0) AS pending,
       COUNT(*) AS jobs,
       COALESCE(SUM(status = 'failed' OR (status = 'refused' AND submitted_at IS NOT NULL)), 0) AS hard,
       COALESCE(SUM(${WAITING}), 0) AS waiting
     FROM media_processing_jobs WHERE run_id = ?`,
    auth.run_id,
  );
  const activeOverview = await rows<{ appid: number }>(db, "SELECT appid FROM media_game_overviews WHERE active = 1 AND appid IN (SELECT value FROM json_each(?))", JSON.stringify(entities));
  const entitySet = new Set(entities);
  const gamesWithSources = [...new Set(sources.filter((source) => entitySet.has(source.appid)).map((source) => source.appid))];
  const coveredGames = new Set(activeOverview.map((row) => row.appid));
  const allCovered = gamesWithSources.every((appid) => coveredGames.has(appid));
  const pending = Number(runAggregate?.pending ?? 0);
  const reasons = [...(advance.reasons.get(auth.run_id) ?? [])];
  if (Number(runAggregate?.waiting ?? 0) > 0) {
    for (const provider of PAID_PROVIDERS) {
      const state = await providerState(db, provider);
      if (state.paused) reasons.push(`provider_paused:${provider}:${state.reason}`);
    }
  }
  const workStop = reasons.some((reason) => reason === "input_token_cap" || reason === "provider_refusal");
  const terminalFailure = pending === 0 && Number(runAggregate?.hard ?? 0) > 0;
  if (!workStop && terminalFailure) reasons.unshift("terminal_failure");
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
    overviewAppids: activeOverview.map((row) => row.appid),
  };
}

/** The queue depth, provider states and cost every summary reports. */
async function queueReport(db: AppDatabase, now: Date): Promise<Pick<MediaProcessingSummary, "queued" | "providers" | "cost">> {
  const queued = {} as MediaProcessingSummary["queued"];
  const providers = {} as MediaProcessingSummary["providers"];
  for (const provider of PAID_PROVIDERS) {
    const count = await first<{ count: number }>(db, `SELECT COUNT(*) AS count FROM media_processing_jobs WHERE provider = ? AND ${WAITING}`, provider);
    queued[provider] = Number(count?.count ?? 0);
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
  };
  // Advances never overlap, so an item still marked in flight was sent by a
  // process that stopped before recording its answer.
  await db.prepare(`UPDATE media_processing_jobs SET error = ? WHERE status = 'uncertain' AND error = '${IN_FLIGHT}'`).bind(IN_FLIGHT_AT_STARTUP).run();
  const probing = new Set(await runDailyCreditCheck(db, now, creditChecks(openRouter)) ?? []);
  for (const provider of PAID_PROVIDERS) if ((await providerState(db, provider)).paused) advance.paused.add(provider);

  const globallySubmitted = await rows<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE status = 'submitted' ORDER BY id`);
  const prePoll = await pollSubmittedJobs(advance, globallySubmitted);
  const authorization = await loadAuthorization(db, options.runId);
  const open = await openAuthorizations(db);
  const entitiesByRun = new Map<number, number[]>();
  for (const run of open) {
    const entities = await eligibleProcessingEntities(db, run.selectedGames);
    entitiesByRun.set(run.auth.run_id, entities);
    await enqueueExtractions(advance, run, entities);
    await enqueueOverviewWork(advance, run.auth.run_id, entities);
  }
  await submitQueuedWork(advance, probing);
  // Stages chain within one advance: text answers settle as they arrive, so
  // their Overview work, and then the embeddings of Overviews built here,
  // are queued and taken in the same advance. Each batch submitted in this
  // advance is polled once.
  const currentPoll: SubmittedPollSummary = { polled: new Set(prePoll.polled), succeeded: 0, failed: 0, uncertain: 0 };
  const pollNewBatches = async () => {
    const submitted = await rows<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE status = 'submitted' ORDER BY id`);
    const polled = await pollSubmittedJobs(advance, submitted.filter((job) => !currentPoll.polled.has(job.id)));
    for (const id of polled.polled) currentPoll.polled.add(id);
    currentPoll.succeeded += polled.succeeded;
    currentPoll.failed += polled.failed;
    currentPoll.uncertain += polled.uncertain;
  };
  for (let stage = 0; stage < 2; stage += 1) {
    await pollNewBatches();
    for (const run of open) await enqueueOverviewWork(advance, run.auth.run_id, entitiesByRun.get(run.auth.run_id)!);
    await submitQueuedWork(advance, probing);
  }
  await pollNewBatches();

  const outcomes = new Map<number, RunOutcome>();
  for (const run of open) outcomes.set(run.auth.run_id, await finishRun(advance, run));
  const report = await queueReport(db, now);
  const target = authorization ? outcomes.get(authorization.auth.run_id) : undefined;
  if (target) return { ...target, ...report };

  const latestJob = await first<{ run_id: number }>(db, "SELECT run_id FROM media_processing_jobs ORDER BY id DESC LIMIT 1");
  const reconciliationRunId = globallySubmitted.at(-1)?.run_id ?? options.runId ?? latestJob?.run_id;
  if (reconciliationRunId === undefined) throw new Error("Media processing authorization not found");
  const unresolved = await first<{ count: number }>(db, `SELECT COUNT(*) AS count FROM media_processing_jobs WHERE status IN ('submitted', 'uncertain') OR ${WAITING}`);
  const recorded = await first<{ stop_reason: string | null }>(db, "SELECT stop_reason FROM media_processing_authorizations WHERE run_id = ?", reconciliationRunId);
  return {
    runId: reconciliationRunId,
    status: transport && Number(unresolved?.count ?? 0) === 0 ? "completed" : "waiting",
    submitted: 0,
    completed: prePoll.succeeded + currentPoll.succeeded,
    outputs: await outputCounts(db, reconciliationRunId),
    stopReasons: (recorded?.stop_reason ?? "").split("; ").filter(Boolean),
    failed: prePoll.failed + currentPoll.failed,
    uncertain: prePoll.uncertain + currentPoll.uncertain,
    overviewAppids: [],
    ...report,
  };
}

/**
 * Runs the daily credit check in a tick that has no paid work to advance, so
 * it runs in the first tick at or after 06:00 UTC whether or not work waits.
 * It records the day and lifts the pauses the check lifts; with no item to
 * probe, the next submission is the probe. Serialized with every other
 * queue write.
 */
export function runIdleDailyCreditCheck(
  db: AppDatabase,
  now: Date,
  options: Pick<MediaProcessingOptions, "openRouter" | "openRouterApiKey" | "openRouterTimeoutMs" | "providerFetch"> = {},
): Promise<void> {
  const next = mediaProcessingQueue
    .catch(() => undefined)
    .then(async () => {
      let openRouter = options.openRouter ?? null;
      if (!openRouter) {
        try { openRouter = createOpenRouterTransport(options.openRouterApiKey, options.providerFetch as OpenRouterFetch | undefined, { timeoutMs: options.openRouterTimeoutMs }); }
        catch { openRouter = null; }
      }
      await runDailyCreditCheck(db, now, creditChecks(openRouter));
    });
  mediaProcessingQueue = next;
  return next;
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

