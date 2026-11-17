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
  ELIGIBLE_MEDIA_ENTITY_SQL,
  GEMINI_EMBEDDING_CONFIG_VERSION,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL,
} from "./media-similarity";

export const GEMINI_MEDIA_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_BATCH_PRICING_VERSION = "2026-09-13";
export const GEMINI_BATCH_CAPABILITY_VERSION = "gemini-3.1-flash-lite-and-gemini-embedding-2-batch-paid-2026-09-13";
export const GEMINI_BATCH_BILLING_CONFIRMATION = `pricing=${GEMINI_BATCH_PRICING_VERSION};capability=${GEMINI_BATCH_CAPABILITY_VERSION}`;
const EXTRACTION_CONFIG_VERSION = "media-extraction-2026-09-13-v3";
const SYNTHESIS_CONFIG_VERSION = "media-synthesis-2026-09-13-v5";
const CLEANUP_VERSION = "media-cleanup-2026-09-11-v1";
const INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.125;
const OUTPUT_PRICE_MICRO_USD_PER_TOKEN = 0.75;
const EMBEDDING_INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.1;
const LIFETIME_BUDGET_MICRO_USD = 5_000_000;
const EXTRACTION_MAX_OUTPUT_TOKENS = 1_200;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 3_200;
const EMBEDDING_MAX_OUTPUT_TOKENS = 1;
const MAX_INPUT_TOKENS = 24_000;
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
   * a failed token count, a token-cap or allowance refusal, or a failed or
   * stale provider result.
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
  chargedMicrousd: number;
  outstandingReservedMicrousd: number;
  stopReasons: string[];
  failed: number;
  uncertain: number;
  overviewAppids: number[];
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
}

export interface GeminiBatchTransport {
  countTokens(model: string, request: GeminiRequest): Promise<number>;
  submitBatch(model: string, requests: readonly GeminiInlineRequest[]): Promise<{ name: string }>;
  submitEmbeddingBatch?(model: string, requests: readonly GeminiInlineRequest[]): Promise<{ name: string }>;
  pollBatch(name: string): Promise<GeminiBatchPoll>;
}

export type MediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ArticleFetch = (input: string, init?: RequestInit) => Promise<Response | string>;

export interface MediaProcessingOptions {
  runId?: number;
  transport?: GeminiBatchTransport;
  geminiApiKey?: string;
  providerFetch?: MediaFetch;
  articleFetch?: ArticleFetch;
  now?: Date | (() => Date);
  pricingVersion?: string;
  capabilityVersion?: string;
}

class GeminiHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GeminiHttpError";
    this.status = status;
  }
}

function boundedError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join("[redacted]");
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

function providerError(status: number, body: unknown): GeminiHttpError {
  const root = jsonObject(body);
  const nested = jsonObject(root.error);
  const message = nested.message ?? root.error;
  return new GeminiHttpError(status, typeof message === "string" ? message : `Gemini HTTP ${status}`);
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export function createGeminiBatchTransport(apiKey: string, fetchFn: MediaFetch = fetch): GeminiBatchTransport {
  if (!apiKey || typeof apiKey !== "string") throw new Error("Gemini API key is required");
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const request = async (url: string, init: RequestInit): Promise<unknown> => {
    const response = await fetchFn(url, {
      ...init,
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-goog-api-key": apiKey, ...(init.headers ?? {}) },
    });
    const body = await responseJson(response);
    if (!response.ok) throw providerError(response.status, body);
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
    async submitBatch(model, requests) {
      const body = await request(`${base}/models/${encodeURIComponent(model)}:batchGenerateContent`, {
        method: "POST",
        body: JSON.stringify({
          batch: {
            display_name: requests[0]?.key ?? "vaporstats-media",
            input_config: {
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
      if (typeof name !== "string" || !name) throw new Error("Gemini batch submission returned no batch name");
      return { name };
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
      if (!response.ok) throw providerError(response.status, body);
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
      if (/FAIL|CANCEL|EXPIRE|ERROR/.test(stateValue)) return { state: "failed", error: boundedError(jsonObject(root.error).message ?? root.error ?? stateValue), usage };
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
  return extractionIdentityFor(source, hash, GEMINI_MEDIA_MODEL, EXTRACTION_CONFIG_VERSION, CLEANUP_VERSION);
}

function synthesisIdentity(appid: number, extractions: ExtractionRow[]): string {
  return synthesisIdentityFor(appid, extractions, GEMINI_MEDIA_MODEL, SYNTHESIS_CONFIG_VERSION);
}

function synthesisIdentityFor(appid: number, extractions: ExtractionRow[], model: string, configVersion: string): string {
  return sha256(stableJson({ stage: "synthesis", appid, model, configVersion, extractions: extractions.map((row) => ({ sourceId: row.source_id, inputIdentity: row.input_identity })).sort((a, b) => a.sourceId - b.sourceId) }));
}

function makeExtractionRequest(source: SourceRow, content: string, identity: string): GeminiRequest {
  return {
    contents: [{ role: "user", parts: [{ text: `Analyze only this article about Steam app ${source.appid}. Return JSON only. Keep wording grounded in article evidence. Use these optional category names inside categories and contribution.category: ${MEDIA_CATEGORY_NAMES.join("; ")}. Top-level keys must be categories, contributions, traits, qualifications, provenance, and optional originatingAssessment and similarityInputs. similarityInputs may contain gameplay and storyWorld arrays of direct descriptive evidence about game mechanics or story/world themes. Do not use quality, ratings, popularity, praise, criticism, or technical complaints as similarity inputs. Do not invent unsupported dimensions. Contributions are objects with text and category; traits and qualifications are arrays of strings. Traits must be concise, factual game descriptors sourced only from the article.` }, { text: content }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS },
  };
}

function makeSynthesisRequest(appid: number, name: string, extractions: ExtractionRow[], sources: SourceRow[]): GeminiRequest {
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
  return {
    contents: [{ role: "user", parts: [{ text: `Synthesize the current initial assessments for ${name || `game ${appid}`}. Return JSON only as {"statements":[{"text":"...","sourceUrls":["..."]}],"categories":[{"name":"...","findings":[{"text":"...","sourceUrls":["..."],"contested":true}]}],"prosCons":{"pros":[{"text":"...","sourceUrls":["..."]}],"cons":[...]},"tags":[{"label":"...","sourceUrls":["..."]}],"similarityInputs":{"gameplay":["..."],"storyWorld":["..."]}}. Write flowing, concise, game-first Overview statements. Write every Overview text field as a direct game observation; never mention coverage, critics, reviewers, reviews, outlets, publications, sources, assessments, agreement, consensus, or frequency. Multiple citation URLs communicate repeated support. Include only supported sections named ${MEDIA_CATEGORY_NAMES.join("; ")}; omit unsupported sections. Provide one global pros/cons overview, omit unsupported sides, and do not force neutral characteristics into pros or cons. Every entry must cite every supporting article URL. Tags are concise factual game descriptors and must be derived only from the supplied extraction.traits arrays, never from statements, categories, pros/cons, or summary wording. Cite every current extraction that supports each tag. Normalize semantically equivalent supported trait descriptions to one meaningful label without merging distinct characteristics or inventing missing traits. Preserve disputed traits when a supplied extraction supports them; do not include quality judgments, rankings, scores, reception, popularity, praise, performance, bugs, or technical complaints as tags. Return similarityInputs as the canonical aggregate of all supplied current extraction.contributions and any directly supported mechanics or story/world themes. Use gameplay for mechanics, systems, controls, combat, progression, and player-facing structure; use storyWorld for setting, narrative, characters, factions, and world themes. Keep each item a concise direct game description and omit a dimension when no supported evidence exists. Never put quality, praise, popularity, ratings, reception, criticism, performance, bugs, optimization, framerate, or other technical complaints in similarityInputs. Do not use Overview prose, tags, pros, or cons as similarityInputs. Evidence belongs only to app ${appid}; do not transfer incidental comparisons, DLC, expansion, bundle, or focused edition evidence.\n${JSON.stringify(evidence)}` }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS },
  };
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
 * Records that `runId` definitely refused `requestKey` before submission (the
 * input-token cap or the allowance) and counts it skipped, once. A refused
 * request is final for the run only; a later run whose scope covers it tries
 * it again.
 */
async function refuseRequest(db: AppDatabase, runId: number, requestKey: string): Promise<void> {
  await transaction(db, async () => {
    const refused = await db.prepare("UPDATE media_processing_authorizations SET refused_request_keys = json_insert(refused_request_keys, '$[#]', ?1) WHERE run_id = ?2 AND NOT EXISTS (SELECT 1 FROM json_each(refused_request_keys) WHERE value = ?1)").bind(requestKey, runId).run();
    if (refused.meta.changes === 1) await countOutputs(db, runId, "skipped");
  });
}

async function refusedInRun(db: AppDatabase, runId: number, requestKey: string): Promise<boolean> {
  const refused = await first<{ refused: number }>(db, "SELECT 1 AS refused FROM media_processing_authorizations, json_each(refused_request_keys) WHERE run_id = ? AND value = ?", runId, requestKey);
  return refused !== null;
}

/**
 * The request key `runId` submits the work identified by `baseKey` under. A
 * job that definitely failed, or went stale, in an earlier run is retried
 * under a key of this run's own; one from this run is final for the run.
 */
async function runRequestKey(db: AppDatabase, baseKey: string, runId: number): Promise<string> {
  const base = await first<{ run_id: number; status: JobRow["status"] }>(db, "SELECT run_id, status FROM media_processing_jobs WHERE request_key = ?", baseKey);
  return base && base.run_id !== runId && (base.status === "failed" || base.status === "stale") ? `${baseKey}:retry:${runId}` : baseKey;
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
type JobRow = { id: number; run_id: number; stage: JobStage; appid: number; matched_appid: number | null; dimension: SimilarityDimension | null; source_id: number | null; request_key: string; input_identity: string; model: string; config_version: string; max_input_tokens: number; max_output_tokens: number; reserved_microusd: number; charged_microusd: number | null; reservation_active: number; status: "reserved" | "submitted" | "succeeded" | "failed" | "uncertain" | "stale"; provider_batch_id: string | null; output_json: string | null; usage_json: string; error: string | null };
type ReservationInput = {
  run_id: number;
  stage: JobStage;
  appid: number;
  matched_appid?: number | null;
  dimension?: SimilarityDimension | null;
  source_id: number | null;
  request_key: string;
  input_identity: string;
  model: string;
  config_version: string;
  max_input_tokens: number;
  max_output_tokens: number;
  reserved_microusd: number;
  requireEligibleEntity?: boolean;
};

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
async function reserveJob(db: AppDatabase, job: ReservationInput): Promise<boolean> {
  let allowed = false;
  await transaction(db, async () => {
    if (job.requireEligibleEntity) {
      const eligible = await first<{ appid: number }>(
        db,
        `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`,
        job.appid,
      );
      if (!eligible) return;
    }
    const existing = await first<{ status: JobRow["status"] }>(db, "SELECT status FROM media_processing_jobs WHERE request_key = ?", job.request_key);
    if (existing) {
      allowed = ["reserved", "submitted", "succeeded"].includes(existing.status);
      return;
    }
    const total = await first<{ total: number }>(db, "SELECT COALESCE(SUM(CASE reservation_active WHEN 1 THEN reserved_microusd ELSE COALESCE(charged_microusd, 0) END), 0) AS total FROM media_processing_jobs");
    if (Number(total?.total ?? 0) + job.reserved_microusd > LIFETIME_BUDGET_MICRO_USD) return;
    const inserted = await db.prepare("INSERT INTO media_processing_jobs (run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'reserved', '{}')").bind(job.run_id, job.stage, job.appid, job.matched_appid ?? null, job.dimension ?? null, job.source_id, job.request_key, job.input_identity, job.model, job.config_version, job.max_input_tokens, job.max_output_tokens, job.reserved_microusd).run();
    allowed = inserted.success;
  });
  return allowed;
}

function conservativeCharge(inputTokens: number, outputTokens: number, stage: JobStage = "extraction"): number {
  return stage === "embedding"
    ? Math.ceil(inputTokens * EMBEDDING_INPUT_PRICE_MICRO_USD_PER_TOKEN)
    : Math.ceil(inputTokens * INPUT_PRICE_MICRO_USD_PER_TOKEN + outputTokens * OUTPUT_PRICE_MICRO_USD_PER_TOKEN);
}

function actualCharge(job: JobRow, usage: GeminiBatchUsage | null): number | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? usage.promptTokenCount;
  if (!Number.isFinite(input) || (input ?? -1) < 0) return null;
  if (job.stage === "embedding") return Math.ceil(Number(input) * EMBEDDING_INPUT_PRICE_MICRO_USD_PER_TOKEN);
  const output = usage.outputTokens ?? usage.candidatesTokenCount;
  const thinking = usage.thinkingTokens ?? usage.thoughtsTokenCount ?? 0;
  if (!Number.isFinite(output) || !Number.isFinite(thinking) || (output ?? -1) < 0 || thinking < 0) return null;
  const outputThinking = Math.min(job.max_output_tokens, Number(output) + thinking);
  return Math.ceil(Number(input) * INPUT_PRICE_MICRO_USD_PER_TOKEN + outputThinking * OUTPUT_PRICE_MICRO_USD_PER_TOKEN);
}

function isDefiniteProviderError(error: unknown): boolean {
  return error instanceof GeminiHttpError && [400, 401, 403, 404, 405, 409, 415, 422].includes(error.status);
}

async function submitJob(db: AppDatabase, job: JobRow, request: GeminiRequest, transport: GeminiBatchTransport, secret: string | undefined, now: Date, contentSourceId: number | null): Promise<"submitted" | "failed" | "uncertain"> {
  if (job.stage === "embedding" && !transport.submitEmbeddingBatch) {
    await db.prepare("UPDATE media_processing_jobs SET error = ? WHERE id = ? AND status = 'reserved'").bind("Gemini embedding batch transport is unavailable", job.id).run();
    return "uncertain";
  }
  const marked = await db.prepare("UPDATE media_processing_jobs SET status = 'uncertain', error = ? WHERE id = ? AND status = 'reserved'").bind("submission in progress", job.id).run();
  if (marked.meta.changes !== 1) return "uncertain";
  if (contentSourceId !== null) await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(contentSourceId).run();
  let result: { name: string };
  try {
    if (job.stage === "embedding") {
      if (!transport.submitEmbeddingBatch) throw new Error("Gemini embedding batch transport is unavailable");
      result = await transport.submitEmbeddingBatch(job.model, [{ key: job.request_key, request }]);
    } else {
      result = await transport.submitBatch(job.model, [{ key: job.request_key, request }]);
    }
  } catch (error) {
    const definite = isDefiniteProviderError(error);
    await transaction(db, async () => {
      await db.prepare("UPDATE media_processing_jobs SET status = ?, reservation_active = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'uncertain'").bind(definite ? "failed" : "uncertain", definite ? 0 : 1, boundedError(error, secret), definite ? now.toISOString() : null, job.id).run();
      if (definite) await countOutputs(db, job.run_id, "skipped");
    });
    return definite ? "failed" : "uncertain";
  }
  if (!result?.name) {
    await db.prepare("UPDATE media_processing_jobs SET error = ?, reservation_active = 1 WHERE id = ? AND status = 'uncertain'").bind("Gemini submission returned no batch identifier", job.id).run();
    return "uncertain";
  }
  let submitted = false;
  await transaction(db, async () => {
    const update = await db.prepare("UPDATE media_processing_jobs SET status = 'submitted', provider_batch_id = ?, submitted_at = ?, error = NULL WHERE id = ? AND status = 'uncertain' AND provider_batch_id IS NULL").bind(result.name, now.toISOString(), job.id).run();
    submitted = update.meta.changes === 1;
  });
  return submitted ? "submitted" : "uncertain";
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

async function persistExtraction(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "failed"> {
  if (job.source_id === null) return "failed";
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
    await db.prepare("UPDATE media_processing_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").bind("Gemini extraction returned no supported contributions", now.toISOString(), job.id).run();
    await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
    return "failed";
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

async function persistOverview(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "failed"> {
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
  if (synthesisIdentity(job.appid, evidence.extractions) !== job.input_identity) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  const tagEvidence = parseMediaTagEvidence(output, evidenceSources);
  const overview = parseMediaOverview(output, job.appid, evidenceSources);
  if (!overview) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").bind("Gemini synthesis returned no cited statements", now.toISOString(), job.id).run();
    return "failed";
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

async function persistEmbedding(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "failed"> {
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
    await db.prepare("UPDATE media_processing_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").bind("Gemini embedding returned an incompatible vector", now.toISOString(), job.id).run();
    return "failed";
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

/**
 * Settles `job` with its provider `result` and counts its output, in one
 * transaction, so a restart never leaves a settled job uncounted.
 */
function reconcileJob(db: AppDatabase, job: JobRow, result: GeminiBatchPoll, now: Date, secret: string | undefined): Promise<"succeeded" | "failed" | "stale" | "uncertain"> {
  return writeTransaction(db, async () => {
    const status = await settleJob(db, job, result, now, secret);
    if ((status === "failed" || status === "stale") && job.stage !== "explanation") await countOutputs(db, job.run_id, "skipped");
    return status;
  });
}

async function settleJob(db: AppDatabase, job: JobRow, result: GeminiBatchPoll, now: Date, secret: string | undefined): Promise<"succeeded" | "failed" | "stale" | "uncertain"> {
  if (result.state === "pending") return "uncertain";
  const usageJson = result.usage ? JSON.stringify(result.usage) : "{}";
  const charge = actualCharge(job, result.usage ?? null) ?? job.reserved_microusd;
  await db.prepare("UPDATE media_processing_jobs SET usage_json = ?, charged_microusd = ?, reservation_active = 0 WHERE id = ?").bind(usageJson, charge, job.id).run();
  if (result.state === "failed") {
    await db.prepare("UPDATE media_processing_jobs SET status = 'failed', reservation_active = 0, error = ?, completed_at = ? WHERE id = ?").bind(boundedError(result.error, secret), now.toISOString(), job.id).run();
    if (job.source_id !== null) await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(job.source_id).run();
    return "failed";
  }
  if (job.stage === "extraction") return persistExtraction(db, job, result.output, now);
  if (job.stage === "embedding") return persistEmbedding(db, job, result.output, now);
  if (job.stage === "explanation") {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  return persistOverview(db, job, result.output, now);
}

type SubmittedPollSummary = {
  polled: Set<number>;
  succeeded: number;
  failed: number;
  uncertain: number;
};

async function pollSubmittedJobs(
  db: AppDatabase,
  jobs: readonly JobRow[],
  transport: GeminiBatchTransport,
  now: Date,
  secret: string | undefined,
): Promise<SubmittedPollSummary> {
  const summary: SubmittedPollSummary = { polled: new Set(), succeeded: 0, failed: 0, uncertain: 0 };
  for (const job of jobs) {
    summary.polled.add(job.id);
    if (!job.provider_batch_id) {
      summary.uncertain += 1;
      continue;
    }
    try {
      const result = await transport.pollBatch(job.provider_batch_id);
      if (result.state === "pending") {
        summary.uncertain += 1;
        continue;
      }
      const status = await reconcileJob(db, job, result, now, secret);
      if (status === "succeeded") summary.succeeded += 1;
      else if (status === "failed" || status === "stale") summary.failed += 1;
      else summary.uncertain += 1;
    } catch (error) {
      await db.prepare("UPDATE media_processing_jobs SET error = ? WHERE id = ? AND status = 'submitted'").bind(boundedError(error, secret), job.id).run();
      summary.uncertain += 1;
    }
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

async function budgetTotals(db: AppDatabase): Promise<{ reserved: number; charged: number }> {
  return (await first<{ reserved: number; charged: number }>(db, "SELECT COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE 0 END), 0) AS reserved, COALESCE(SUM(CASE WHEN reservation_active = 0 THEN COALESCE(charged_microusd, 0) ELSE 0 END), 0) AS charged FROM media_processing_jobs")) ?? { reserved: 0, charged: 0 };
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

/** Stop reasons for an unmet precondition of paid work, which no longer apply once it is met. */
const PRECONDITION_STOPS = new Set(["pricing_unconfirmed", "capability_unconfirmed", "missing_gemini_batch_transport"]);

/** The explicit stop reasons a run recorded about its work, without unmet preconditions. */
function recordedWorkStops(stopReason: string | null): string[] {
  return (stopReason ?? "").split("; ").filter((reason) => reason && !PRECONDITION_STOPS.has(reason));
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

const JOB_COLUMNS = "id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error";

/** Embeds the active Overviews of `scopeGames`, the games `runId` may give Overview and embedding work. */
async function scheduleEmbeddings(
  db: AppDatabase,
  runId: number,
  scopeGames: readonly number[],
  transport: GeminiBatchTransport,
  secret: string | undefined,
  now: Date,
): Promise<{ submitted: number; stopReason: string | null }> {
  const overviews = await rows<{ appid: number; input_identity: string; output_json: string }>(
    db,
    "SELECT appid, input_identity, output_json FROM media_game_overviews WHERE active = 1 AND appid IN (SELECT value FROM json_each(?)) ORDER BY appid",
    JSON.stringify(scopeGames),
  );
  let submitted = 0;
  let stopReason: string | null = null;
  for (const overview of overviews) {
    const eligible = await first<{ appid: number }>(db, `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`, overview.appid);
    if (!eligible) {
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
      const priorJob = await first<{ status: JobRow["status"] }>(db, "SELECT status FROM media_processing_jobs WHERE request_key = ?", requestKey);
      if ((priorJob && priorJob.status !== "reserved") || await refusedInRun(db, runId, requestKey)) continue;
      const request = makeEmbeddingRequest(input);
      let tokenCount: number;
      // A token count that throws is transient: the run retries it on its
      // next advance instead of refusing the request.
      try { tokenCount = await transport.countTokens(GEMINI_EMBEDDING_MODEL, request); }
      catch (error) {
        stopReason ??= `count_tokens:${boundedError(error, secret)}`;
        continue;
      }
      if (!Number.isInteger(tokenCount) || tokenCount < 0 || tokenCount > MAX_EMBEDDING_INPUT_TOKENS) {
        await refuseRequest(db, runId, requestKey);
        stopReason ??= "input_token_cap";
        continue;
      }
      const reserved = await reserveJob(db, { run_id: runId, stage: "embedding", appid: overview.appid, source_id: null, request_key: requestKey, input_identity: identity, model: GEMINI_EMBEDDING_MODEL, config_version: GEMINI_EMBEDDING_CONFIG_VERSION, dimension, max_input_tokens: tokenCount, max_output_tokens: EMBEDDING_MAX_OUTPUT_TOKENS, reserved_microusd: conservativeCharge(tokenCount, EMBEDDING_MAX_OUTPUT_TOKENS, "embedding"), requireEligibleEntity: true });
      if (!reserved) {
        const eligible = await first<{ appid: number }>(db, `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`, overview.appid);
        if (eligible) {
          await refuseRequest(db, runId, requestKey);
          stopReason ??= "lifetime_budget";
          break;
        }
        continue;
      }
      const job = await first<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE request_key = ?`, requestKey);
      if (!job || job.status !== "reserved") continue;
      if (await submitJob(db, job, request, transport, secret, now, null) === "submitted") submitted += 1;
    }
    if (stopReason === "lifetime_budget") break;
  }
  return { submitted, stopReason };
}

async function advanceMediaProcessingNow(db: AppDatabase, options: MediaProcessingOptions = {}): Promise<MediaProcessingSummary> {
  const now = isoNow(options.now);
  const clock = () => isoNow(options.now);
  const transport = options.transport ?? (options.geminiApiKey ? createGeminiBatchTransport(options.geminiApiKey, options.providerFetch) : null);
  const globallySubmitted = await rows<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE status = 'submitted' ORDER BY id`);
  const prePoll: SubmittedPollSummary = transport
    ? await pollSubmittedJobs(db, globallySubmitted, transport, now, options.geminiApiKey)
    : { polled: new Set<number>(), succeeded: 0, failed: 0, uncertain: 0 };
  const authorization = await loadAuthorization(db, options.runId, globallySubmitted.map((job) => job.run_id));
  const emptyBudget = await budgetTotals(db);
  if (!authorization) {
    const reconciliationRunId = globallySubmitted.at(-1)?.run_id ?? options.runId;
    if (reconciliationRunId === undefined) throw new Error("Media processing authorization not found");
    const unresolved = await first<{ count: number }>(
      db,
      "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE status IN ('reserved', 'submitted', 'uncertain')",
    );
    const recorded = await first<{ stop_reason: string | null }>(db, "SELECT stop_reason FROM media_processing_authorizations WHERE run_id = ?", reconciliationRunId);
    const reason = transport ? (recorded?.stop_reason ?? "").split("; ").filter(Boolean) : ["missing_gemini_batch_transport"];
    return {
      runId: reconciliationRunId,
      status: transport && Number(unresolved?.count ?? 0) === 0 ? "completed" : "waiting",
      submitted: 0,
      completed: prePoll.succeeded,
      outputs: await outputCounts(db, reconciliationRunId),
      chargedMicrousd: emptyBudget.charged,
      outstandingReservedMicrousd: emptyBudget.reserved,
      stopReasons: reason,
      failed: prePoll.failed,
      uncertain: prePoll.uncertain,
      overviewAppids: [],
    };
  }
  const { auth, selectedGames } = authorization;
  if (!transport) {
    const reasons = ["missing_gemini_batch_transport", ...recordedWorkStops(auth.stop_reason)];
    await db.prepare("UPDATE media_processing_authorizations SET status = 'waiting', stop_reason = ?, updated_at = ? WHERE run_id = ?").bind(reasons.join("; "), now.toISOString(), auth.run_id).run();
    return { runId: auth.run_id, status: "waiting", submitted: 0, completed: prePoll.succeeded, outputs: await outputCounts(db, auth.run_id), chargedMicrousd: emptyBudget.charged, outstandingReservedMicrousd: emptyBudget.reserved, stopReasons: reasons, failed: prePoll.failed, uncertain: prePoll.uncertain, overviewAppids: [] };
  }
  const pricingConfirmed = options.pricingVersion === GEMINI_BATCH_PRICING_VERSION;
  const capabilityConfirmed = options.capabilityVersion === GEMINI_BATCH_CAPABILITY_VERSION;
  if (!pricingConfirmed || !capabilityConfirmed) {
    const reasons = [!pricingConfirmed ? "pricing_unconfirmed" : "capability_unconfirmed", ...recordedWorkStops(auth.stop_reason)];
    await db.prepare("UPDATE media_processing_authorizations SET status = 'waiting', stop_reason = ?, updated_at = ? WHERE run_id = ?").bind(reasons.join("; "), now.toISOString(), auth.run_id).run();
    return { runId: auth.run_id, status: "waiting", submitted: 0, completed: prePoll.succeeded, outputs: await outputCounts(db, auth.run_id), chargedMicrousd: emptyBudget.charged, outstandingReservedMicrousd: emptyBudget.reserved, stopReasons: reasons, failed: prePoll.failed, uncertain: prePoll.uncertain, overviewAppids: [] };
  }
  await transaction(db, async () => {
    await db.prepare("UPDATE media_processing_authorizations SET billing_confirmation = ?, updated_at = ? WHERE run_id = ?").bind(GEMINI_BATCH_BILLING_CONFIRMATION, now.toISOString(), auth.run_id).run();
  });
  const processingEntities = await eligibleProcessingEntities(db, selectedGames);
  const articleFetch = options.articleFetch ?? fetch;
  const allSources = await rows<SourceRow>(db, `SELECT ${SOURCE_COLUMNS} FROM media_sources WHERE appid IN (SELECT value FROM json_each(?)) ORDER BY appid, id`, JSON.stringify(processingEntities));
  const sourceCountByGame = new Map<number, number>();
  let boundedSourceCount = 0;
  const sources = allSources.filter((source) => {
    if (boundedSourceCount >= MAX_MEDIA_ARTICLES_TOTAL) return false;
    const count = sourceCountByGame.get(source.appid) ?? 0;
    if (count >= MAX_MEDIA_ARTICLES_PER_GAME) return false;
    sourceCountByGame.set(source.appid, count + 1);
    boundedSourceCount += 1;
    return true;
  });
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const affectedSourceIds = new Set(parseAffectedSourceIds(auth.affected_source_ids));
  /**
   * A run processes a source that is new to processing, an affected source it
   * has not taken yet, or a source it took whose cleaned text is still
   * retained for pending work. Every other source keeps its outputs without
   * a fetch or paid work.
   */
  const inScope = (source: SourceRow) => source.processing_run_id === null
    || (source.processing_run_id !== auth.run_id && affectedSourceIds.has(source.id))
    || (source.processing_run_id === auth.run_id && source.processing_content !== null);
  let extractionSubmitted = 0;
  let embeddingSubmitted = 0;
  let synthesisSubmitted = 0;
  let stopReason: string | null = null;
  const outletStops = new Map<MediaOutlet, string>();
  /** Why sources were skipped without output in this advance, as `outlet:reason`. */
  const sourceSkips = new Set<string>();
  const discardText = (sourceId: number) => db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(sourceId).run();
  /** Takes a source into this run without output: its text is discarded and it counts as skipped, in one write. */
  const skipSource = (sourceId: number) => transaction(db, async () => {
    await db.prepare("UPDATE media_sources SET processing_run_id = ?, processing_content = NULL WHERE id = ?").bind(auth.run_id, sourceId).run();
    await countOutputs(db, auth.run_id, "skipped");
  });

  for (const source of sources) {
    if (!inScope(source)) continue;
    let content = source.processing_run_id === auth.run_id ? source.processing_content : null;
    let hash = content ? source.normalized_content_hash : null;
    if (!content || !hash) {
      if (outletStops.has(source.outlet)) continue;
      const body = await fetchArticle(db, source, auth.run_id, articleFetch, clock);
      if (body && typeof body === "object") {
        outletStops.set(source.outlet, body.outletStop);
        continue;
      }
      const cleaned = body ? cleanArticle(body) : null;
      if (!cleaned) {
        sourceSkips.add(`${source.outlet}:${body ? "article_unusable" : "article_unreachable"}`);
        await skipSource(source.id);
        source.processing_run_id = auth.run_id;
        continue;
      }
      content = cleaned.content;
      hash = cleaned.hash;
    }
    let identity: string | null = null;
    let kept = false;
    await transaction(db, async () => {
      const current = await currentSource(db, source.id);
      if (!current) return;
      identity = extractionIdentity(current, hash!);
      const prior = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND active = 1 LIMIT 1", source.id);
      // Only changed cleaned content re-extracts. A metadata, model,
      // configuration or cleanup version change keeps the active extraction.
      kept = prior !== null && prior.content_hash === hash;
      if (prior && !kept) {
        const extractions = await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
        const overviews = await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(current.appid).run();
        const embeddings = await db.prepare("UPDATE media_game_embeddings SET active = 0 WHERE appid = ? AND active = 1").bind(current.appid).run();
        await countOutputs(db, auth.run_id, "invalidated", extractions.meta.changes + overviews.meta.changes + embeddings.meta.changes);
        await markContributionChanged(db, source.id, auth.run_id);
      }
      const retained = kept ? null : content;
      // Taking the source and storing or discarding its text is one write, so
      // a restart never leaves a source taken without its outcome.
      await db.prepare("UPDATE media_sources SET normalized_content_hash = ?, cleanup_version = ?, processing_content = ?, processing_input_identity = ?, processing_run_id = ? WHERE id = ?").bind(hash, CLEANUP_VERSION, retained, identity, auth.run_id, source.id).run();
      Object.assign(source, current, { normalized_content_hash: hash, cleanup_version: CLEANUP_VERSION, processing_content: retained, processing_input_identity: identity, processing_run_id: auth.run_id });
    });
    if (kept || !identity) continue;
    const knownExtraction = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND input_identity = ? LIMIT 1", source.id, identity);
    if (knownExtraction) {
      await transaction(db, async () => {
        await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
        await db.prepare("UPDATE media_article_extractions SET active = 1 WHERE id = ?").bind(knownExtraction.id).run();
        await markContributionChanged(db, source.id, auth.run_id);
        await discardText(source.id);
      });
      source.processing_content = null;
      continue;
    }
    // Only an affected source reaches an earlier failure for this input again.
    const requestKey = await runRequestKey(db, `extraction:${source.id}:${identity}`, auth.run_id);
    const priorJob = await first<{ status: JobRow["status"] }>(db, "SELECT status FROM media_processing_jobs WHERE request_key = ?", requestKey);
    source.processing_content = null;
    if (priorJob && priorJob.status !== "reserved") {
      await discardText(source.id);
      continue;
    }
    const request = makeExtractionRequest(source, content, identity);
    let tokenCount: number;
    try { tokenCount = await transport.countTokens(GEMINI_MEDIA_MODEL, request); }
    catch (error) {
      await skipSource(source.id);
      stopReason ??= `count_tokens:${boundedError(error, options.geminiApiKey)}`;
      continue;
    }
    if (!Number.isInteger(tokenCount) || tokenCount < 0 || tokenCount > MAX_INPUT_TOKENS) {
      await skipSource(source.id);
      stopReason ??= "input_token_cap";
      continue;
    }
    const reserved = await reserveJob(db, { run_id: auth.run_id, stage: "extraction", appid: source.appid, source_id: source.id, request_key: requestKey, input_identity: identity, model: GEMINI_MEDIA_MODEL, config_version: EXTRACTION_CONFIG_VERSION, max_input_tokens: tokenCount, max_output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS, reserved_microusd: conservativeCharge(tokenCount, EXTRACTION_MAX_OUTPUT_TOKENS, "extraction"), requireEligibleEntity: true });
    if (!reserved) {
      await skipSource(source.id);
      const eligible = await first<{ appid: number }>(db, `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`, source.appid);
      if (eligible) {
        stopReason ??= "lifetime_budget";
        break;
      }
      continue;
    }
    const job = await first<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE request_key = ?`, requestKey);
    if (!job || job.status !== "reserved") continue;
    if (await submitJob(db, job, request, transport, options.geminiApiKey, now, source.id) === "submitted") extractionSubmitted += 1;
  }

  const submittedJobs = await rows<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE status = 'submitted' ORDER BY id`);
  const currentPoll = await pollSubmittedJobs(
    db,
    submittedJobs.filter((job) => !prePoll.polled.has(job.id)),
    transport,
    now,
    options.geminiApiKey,
  );
  let succeeded = prePoll.succeeded + currentPoll.succeeded;
  let failed = prePoll.failed + currentPoll.failed;
  let uncertain = prePoll.uncertain + currentPoll.uncertain;
  const activeExtractions = await rows<ExtractionRow>(db, "SELECT e.id, e.source_id, e.input_identity, e.content_hash, e.cleanup_version, e.model, e.config_version, e.output_json, e.active FROM media_article_extractions e JOIN media_sources s ON s.id = e.source_id WHERE e.active = 1 AND s.appid IN (SELECT value FROM json_each(?))", JSON.stringify(processingEntities));

  const scopeGames = await rebuildScopeGames(db, auth.run_id, processingEntities);
  const appids = [...new Set(activeExtractions.map((row) => sourceById.get(row.source_id)?.appid).filter((appid): appid is number => typeof appid === "number" && scopeGames.has(appid)))];
  for (const appid of appids) {
    const pendingExtractions = Number((await first<{ count: number }>(
      db,
      "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ? AND appid = ? AND stage = 'extraction' AND status IN ('reserved', 'submitted', 'uncertain')",
      auth.run_id,
      appid,
    ))?.count ?? 0);
    if (pendingExtractions > 0) continue;
    const game = await first<{ name: string }>(db, "SELECT name FROM apps WHERE appid = ?", appid);
    const appSources = sources.filter((source) => source.appid === appid);
    const appExtractions = activeExtractions.filter((row) => sourceById.get(row.source_id)?.appid === appid);
    if (appExtractions.length === 0) continue;
    // An Overview stays current while it was built from exactly the game's
    // current contributions, whatever model or configuration built it.
    const activeOverview = await first<{ input_identity: string; model: string; config_version: string }>(db, "SELECT input_identity, model, config_version FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1", appid);
    if (activeOverview && synthesisIdentityFor(appid, appExtractions, activeOverview.model, activeOverview.config_version) === activeOverview.input_identity) continue;
    const identity = synthesisIdentity(appid, appExtractions);
    const old = await first<{ id: number; output_json: string }>(db, "SELECT id, output_json FROM media_game_overviews WHERE appid = ? AND input_identity = ? ORDER BY id DESC LIMIT 1", appid, identity);
    if (old) {
      await transaction(db, async () => {
        await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(appid).run();
        await db.prepare("UPDATE media_game_overviews SET active = 1 WHERE id = ?").bind(old.id).run();
        await replaceTagMemberships(db, appid, old.output_json, await currentGameEvidence(db, appid), now);
      });
      continue;
    }
    const requestKey = await runRequestKey(db, `synthesis:${appid}:${identity}`, auth.run_id);
    const existing = await first<JobRow>(db, "SELECT id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error FROM media_processing_jobs WHERE request_key = ?", requestKey);
    if ((existing && existing.status !== "reserved") || await refusedInRun(db, auth.run_id, requestKey)) continue;
    const request = makeSynthesisRequest(appid, game?.name ?? "", appExtractions, appSources);
    let tokenCount: number;
    // A token count that throws is transient: the run retries it on its next
    // advance instead of refusing the request.
    try { tokenCount = await transport.countTokens(GEMINI_MEDIA_MODEL, request); }
    catch (error) {
      stopReason ??= `count_tokens:${boundedError(error, options.geminiApiKey)}`;
      continue;
    }
    if (!Number.isInteger(tokenCount) || tokenCount < 0 || tokenCount > MAX_INPUT_TOKENS) {
      await refuseRequest(db, auth.run_id, requestKey);
      stopReason ??= "input_token_cap";
      continue;
    }
    let reserved = true;
    if (!existing) {
      reserved = await reserveJob(db, { run_id: auth.run_id, stage: "synthesis", appid, source_id: null, request_key: requestKey, input_identity: identity, model: GEMINI_MEDIA_MODEL, config_version: SYNTHESIS_CONFIG_VERSION, max_input_tokens: tokenCount, max_output_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS, reserved_microusd: conservativeCharge(tokenCount, SYNTHESIS_MAX_OUTPUT_TOKENS), requireEligibleEntity: true });
    }
    if (!reserved) {
      const eligible = await first<{ appid: number }>(db, `SELECT app.appid FROM apps AS app WHERE app.appid = ? AND ${ELIGIBLE_MEDIA_PROCESSING_ENTITY_SQL}`, appid);
      if (eligible) {
        await refuseRequest(db, auth.run_id, requestKey);
        stopReason ??= "lifetime_budget";
      }
      continue;
    }
    const job = existing ?? await first<JobRow>(db, "SELECT id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error FROM media_processing_jobs WHERE request_key = ?", requestKey);
    if (!job || job.status !== "reserved") continue;
    if (await submitJob(db, job, request, transport, options.geminiApiKey, now, null) === "submitted") synthesisSubmitted += 1;
  }
  const embeddingResult = await scheduleEmbeddings(db, auth.run_id, [...scopeGames], transport, options.geminiApiKey, now);
  embeddingSubmitted += embeddingResult.submitted;
  if (!stopReason && embeddingResult.stopReason) stopReason = embeddingResult.stopReason;

  const aggregate = await first<{ reserved: number; charged: number; succeeded: number; failed: number; uncertain: number }>(db, "SELECT COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE 0 END), 0) AS reserved, COALESCE(SUM(CASE WHEN reservation_active = 0 THEN COALESCE(charged_microusd, 0) ELSE 0 END), 0) AS charged, COALESCE(SUM(status = 'succeeded'), 0) AS succeeded, COALESCE(SUM(status IN ('failed', 'stale')), 0) AS failed, COALESCE(SUM(status = 'uncertain'), 0) AS uncertain FROM media_processing_jobs");
  const runAggregate = await first<{ succeeded: number; failed: number; uncertain: number }>(db, "SELECT COALESCE(SUM(status = 'succeeded'), 0) AS succeeded, COALESCE(SUM(status IN ('failed', 'stale')), 0) AS failed, COALESCE(SUM(status = 'uncertain'), 0) AS uncertain FROM media_processing_jobs WHERE run_id = ?", auth.run_id);
  const currentProcessingEntities = await eligibleProcessingEntities(db, selectedGames);
  const activeOverview = await rows<{ appid: number }>(db, "SELECT appid FROM media_game_overviews WHERE active = 1 AND appid IN (SELECT value FROM json_each(?))", JSON.stringify(currentProcessingEntities));
  const currentEntitySet = new Set(currentProcessingEntities);
  const gamesWithSources = [...new Set(sources.filter((source) => currentEntitySet.has(source.appid)).map((source) => source.appid))];
  const coveredGames = new Set(activeOverview.map((row) => row.appid));
  const allCovered = gamesWithSources.every((appid) => coveredGames.has(appid));
  const pending = Number((await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ? AND status IN ('reserved', 'submitted', 'uncertain')", auth.run_id))?.count ?? 0);
  const hasJobs = Number((await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ?", auth.run_id))?.count ?? 0) > 0;
  const hardFailures = Number((await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ? AND status = 'failed'", auth.run_id))?.count ?? 0);
  const recoverable = stopReason === "pricing_unconfirmed" || stopReason === "capability_unconfirmed" || stopReason === "missing_gemini_batch_transport" || stopReason?.startsWith("count_tokens:") === true;
  const terminalFailure = pending === 0 && hardFailures > 0;
  if (!stopReason && terminalFailure) stopReason = "terminal_failure";
  // Sources deferred by an outlet stop stay in scope; once none remain, the
  // run has done all the work it was authorized for.
  const remainingInScope = sources.some(inScope);
  const status: MediaProcessingSummary["status"] = pending > 0 || (stopReason && recoverable) || (!allCovered && !terminalFailure && !stopReason && remainingInScope) ? (auth.status === "queued" && !hasJobs && sources.length === 0 ? "queued" : "waiting") : terminalFailure ? "stopped" : allCovered || !stopReason ? "completed" : "stopped";
  // While a game is left without an Overview, the run keeps every explicit
  // reason recorded by its earlier advances, except an unmet precondition
  // that this advance has since met.
  const earlierReasons = allCovered ? [] : recordedWorkStops(auth.stop_reason);
  const stopReasons = [...new Set([...(stopReason ? [stopReason] : []), ...[...outletStops].map(([outlet, reason]) => `${outlet}:${reason}`), ...sourceSkips, ...earlierReasons])];
  await transaction(db, async () => {
    await db.prepare("UPDATE media_processing_authorizations SET status = ?, stop_reason = ?, updated_at = ? WHERE run_id = ? AND status <> 'stopped'").bind(status, stopReasons.length > 0 ? stopReasons.join("; ") : null, now.toISOString(), auth.run_id).run();
    // A finished run has no pending work left for text it retained.
    if (status === "completed" || status === "stopped") await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE processing_run_id = ? AND processing_content IS NOT NULL").bind(auth.run_id).run();
  });
  await recordReusedOutputs(db, auth.run_id, sources.map((source) => source.id), currentProcessingEntities);
  return { runId: auth.run_id, status, submitted: extractionSubmitted + embeddingSubmitted + synthesisSubmitted, completed: Number(runAggregate?.succeeded ?? succeeded), outputs: await outputCounts(db, auth.run_id), chargedMicrousd: Number(aggregate?.charged ?? 0), outstandingReservedMicrousd: Number(aggregate?.reserved ?? 0), stopReasons, failed: Number(runAggregate?.failed ?? failed), uncertain: Number(runAggregate?.uncertain ?? uncertain), overviewAppids: activeOverview.map((row) => row.appid) };
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

