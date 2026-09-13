import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { AppDatabase } from "./db";
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
import {
  GEMINI_EMBEDDING_CONFIG_VERSION,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL,
} from "./media-similarity";

export const GEMINI_MEDIA_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_BATCH_PRICING_VERSION = "2026-09-13";
export const GEMINI_BATCH_CAPABILITY_VERSION = "gemini-3.1-flash-lite-and-gemini-embedding-2-batch-paid-2026-09-13";
export const GEMINI_BATCH_BILLING_CONFIRMATION = `pricing=${GEMINI_BATCH_PRICING_VERSION};capability=${GEMINI_BATCH_CAPABILITY_VERSION}`;
const EXTRACTION_CONFIG_VERSION = "media-extraction-2026-09-13-v3";
const SYNTHESIS_CONFIG_VERSION = "media-synthesis-2026-09-13-v4";
const EXPLANATION_CONFIG_VERSION = "media-explanation-2026-09-13-v1";
const CLEANUP_VERSION = "media-cleanup-2026-09-11-v1";
const INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.125;
const OUTPUT_PRICE_MICRO_USD_PER_TOKEN = 0.75;
const EMBEDDING_INPUT_PRICE_MICRO_USD_PER_TOKEN = 0.1;
const LIFETIME_BUDGET_MICRO_USD = 5_000_000;
const EXTRACTION_MAX_OUTPUT_TOKENS = 1_200;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 3_200;
const EXPLANATION_MAX_OUTPUT_TOKENS = 600;
const EMBEDDING_MAX_OUTPUT_TOKENS = 1;
const MAX_INPUT_TOKENS = 24_000;
const MAX_EMBEDDING_INPUT_TOKENS = 8_192;
const MAX_ARTICLE_CHARS = 120_000;
const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS_PER_OUTLET_DAY = 30;
const MAX_ERROR_LENGTH = 256;
const MAX_SIMILARITY_EXPLANATIONS = 100;
const SIMILARITY_DIMENSIONS = ["gameplay", "story_world"] as const;
type SimilarityDimension = (typeof SIMILARITY_DIMENSIONS)[number];
const SIMILARITY_EXCLUDED_LANGUAGE = /\b(?:quality|rating|ratings|score|scores|popular(?:ity)?|prais(?:e|ed|ing)|critic(?:ism|isms|al)?|criticized|criticism|complaint|complaints|performance|bug(?:s)?|technical|technically|optimization|optimisation|framerate|frame rate|stutter(?:ing)?|crash(?:es|ed)?|awful|excellent|great|bad|good|poor|enjoy(?:ment|able)?|fun)\b/i;

export interface MediaProcessingSummary {
  runId: number;
  status: "queued" | "waiting" | "completed" | "stopped";
  submitted: number;
  completed: number;
  reused: number;
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

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
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

async function transaction(db: AppDatabase, work: () => Promise<void>): Promise<void> {
  await db.exec("BEGIN IMMEDIATE");
  try {
    await work();
    await db.exec("COMMIT");
  } catch (error) {
    try { await db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
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
  return sha256(stableJson({ stage: "synthesis", appid, model: GEMINI_MEDIA_MODEL, configVersion: SYNTHESIS_CONFIG_VERSION, extractions: extractions.map((row) => ({ sourceId: row.source_id, inputIdentity: row.input_identity })).sort((a, b) => a.sourceId - b.sourceId) }));
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
    contents: [{ role: "user", parts: [{ text: `Synthesize the current initial assessments for ${name || `game ${appid}`}. Return JSON only as {"statements":[{"text":"...","sourceUrls":["..."]}],"categories":[{"name":"...","findings":[{"text":"...","sourceUrls":["..."],"contested":true}]}],"prosCons":{"pros":[{"text":"...","sourceUrls":["..."]}],"cons":[...]},"tags":[{"label":"...","sourceUrls":["..."]}]}. Write flowing, concise, game-first Overview statements. Write every text field as a direct game observation; never mention coverage, critics, reviewers, reviews, outlets, publications, sources, assessments, agreement, consensus, or frequency. Multiple citation URLs communicate repeated support. Include only supported sections named ${MEDIA_CATEGORY_NAMES.join("; ")}; omit unsupported sections. Provide one global pros/cons overview, omit unsupported sides, and do not force neutral characteristics into pros or cons. Every entry must cite every supporting article URL. Tags are concise factual game descriptors and must be derived only from the supplied extraction.traits arrays, never from statements, categories, pros/cons, or summary wording. Cite every current extraction that supports each tag. Normalize semantically equivalent supported trait descriptions to one meaningful label without merging distinct characteristics or inventing missing traits. Preserve disputed traits when a supplied extraction supports them; do not include quality judgments, rankings, scores, reception, performance, bugs, or other technical complaints as tags. Order findings by distinct supporting outlets, counting an outlet once and treating identical content or matching explicit originatingAssessment values as one assessment. More than one article from one outlet is not repeated cross-outlet support. Group genuinely opposing judgments on the same facet into one qualified contested entry with both sides cited; leave compatible different observations separate. Preserve material writer, preview, announcement, platform, build, and unknown-context distinctions. Do not infer consensus, identity, edition, features, or quality from missing coverage. Evidence belongs only to app ${appid}; do not transfer incidental comparisons, DLC, expansion, bundle, or focused edition evidence.\n${JSON.stringify(evidence)}` }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS },
  };
}

const CATEGORY_NAMES = new Set<string>(MEDIA_CATEGORY_NAMES);

type Contribution = { text: string; category?: string; sourceIdentity: string };
type SimilarityInputs = { gameplay: string[]; storyWorld: string[] };
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
  return strings(value).filter((item) => !SIMILARITY_EXCLUDED_LANGUAGE.test(item));
}

function parseSimilarityInputs(value: unknown): SimilarityInputs | undefined {
  const root = jsonObject(value);
  const gameplay = similarityStrings(root.gameplay);
  const storyWorld = similarityStrings(root.storyWorld);
  return gameplay.length > 0 || storyWorld.length > 0 ? { gameplay, storyWorld } : undefined;
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

type AuthorizationRow = { run_id: number; status: string; stop_reason: string | null; billing_confirmation: string | null };

type SourceRow = { id: number; appid: number; original_url: string; title: string; outlet: MediaOutlet; author: string | null; published_at: string | null; updated_at: string | null; retrieved_at: string; type: string; hands_on: number | null; affiliation: string | null; platform: string | null; build_context: string | null; normalized_content_hash: string | null; cleanup_version: string | null; processing_content: string | null; processing_input_identity: string | null };
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
};

async function recordAttempt(db: AppDatabase, source: SourceRow, runId: number, date: Date, kind: "fetch" | "redirect" | "failure", url: string, statusCode: number | null, succeeded: boolean, error: string | null): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, status_code, succeeded, error, attempted_at) VALUES (?, ?, 'initial', ?, ?, ?, ?, ?, ?, ?)").bind(source.appid, source.outlet, dayKey(date), kind, url, statusCode, succeeded ? 1 : 0, error, date.toISOString()),
    db.prepare("UPDATE media_discovery_runs SET attempt_count = attempt_count + 1 WHERE id = ?").bind(runId),
  ]);
}

async function fetchArticle(db: AppDatabase, source: SourceRow, runId: number, fetchFn: ArticleFetch, clock: () => Date): Promise<string | null> {
  let current = source.original_url;
  const outlet = outletFor(current);
  if (!outlet || outlet.name !== source.outlet) return null;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const now = clock();
    const count = await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE outlet = ? AND pass = 'initial' AND day = ?", source.outlet, dayKey(now));
    if (Number(count?.count ?? 0) >= MAX_ATTEMPTS_PER_OUTLET_DAY) return null;
    let response: Response | string;
    try { response = await fetchFn(current, { redirect: "manual", headers: { Accept: "text/html,application/xhtml+xml" } }); }
    catch (error) { await recordAttempt(db, source, runId, now, "failure", current, null, false, boundedError(error)); return null; }
    if (typeof response === "string") {
      await recordAttempt(db, source, runId, now, "fetch", current, 200, true, null);
      return response;
    }
    const isRedirect = response.status >= 300 && response.status < 400;
    await recordAttempt(db, source, runId, now, isRedirect ? "redirect" : "fetch", current, response.status, response.ok, response.ok ? null : `HTTP ${response.status}`);
    if (response.status === 401 || response.status === 403 || response.status === 429) return null;
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
    await db.prepare("UPDATE media_processing_jobs SET status = ?, reservation_active = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'uncertain'").bind(definite ? "failed" : "uncertain", definite ? 0 : 1, boundedError(error, secret), definite ? now.toISOString() : null, job.id).run();
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
  return first<SourceRow>(db, "SELECT id, appid, original_url, title, outlet, author, published_at, updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context, normalized_content_hash, cleanup_version, processing_content, processing_input_identity FROM media_sources WHERE id = ?", sourceId);
}

function similarityInputFor(extraction: StoredExtraction, dimension: SimilarityDimension): string[] {
  return extraction.similarityInputs?.[dimension === "gameplay" ? "gameplay" : "storyWorld"] ?? [];
}

function similarityInputIdentity(dimension: SimilarityDimension, input: readonly string[]): string {
  return sha256(stableJson({
    stage: "embedding",
    dimension,
    input: [...input],
    model: GEMINI_EMBEDDING_MODEL,
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    configVersion: GEMINI_EMBEDDING_CONFIG_VERSION,
  }));
}

async function invalidateSimilarityDimension(db: AppDatabase, sourceId: number, appid: number, dimension: SimilarityDimension): Promise<void> {
  await db.prepare("UPDATE media_article_embeddings SET active = 0 WHERE source_id = ? AND dimension = ? AND active = 1").bind(sourceId, dimension).run();
  await db.prepare("UPDATE media_game_matches SET active = 0 WHERE dimension = ? AND (appid = ? OR matched_appid = ?) AND active = 1").bind(dimension, appid, appid).run();
}

async function persistExtraction(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "failed"> {
  if (job.source_id === null) return "failed";
  let status: "succeeded" | "stale" | "failed" = "failed";
  await transaction(db, async () => {
    const source = await currentSource(db, job.source_id!);
    if (!source || source.processing_input_identity !== job.input_identity) {
      await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
      if (source) await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
      const stillSupported = source?.normalized_content_hash
        ? extractionIdentityFor(source, source.normalized_content_hash, job.model, job.config_version, source.cleanup_version ?? CLEANUP_VERSION) === job.input_identity
        : false;
      if (!stillSupported) await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(job.appid).run();
      status = "stale";
      return;
    }
    const parsed = parseExtraction(output);
    if (parsed.contributions.length === 0 && parsed.traits.length === 0 && !parsed.categories && !parsed.similarityInputs) {
      await db.prepare("UPDATE media_processing_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").bind("Gemini extraction returned no supported contributions", now.toISOString(), job.id).run();
      await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
      return;
    }
    const previous = await first<{ output_json: string; input_identity: string }>(db, "SELECT output_json, input_identity FROM media_article_extractions WHERE source_id = ? AND active = 1 LIMIT 1", source.id);
    const previousExtraction = previous ? parseExtraction(previous.output_json) : undefined;
    for (const dimension of SIMILARITY_DIMENSIONS) {
      if (JSON.stringify(similarityInputFor(previousExtraction ?? { contributions: [], traits: [], qualifications: [], provenance: [] }, dimension)) !== JSON.stringify(similarityInputFor(parsed, dimension))) continue;
      if (previous && previous.input_identity !== job.input_identity) {
        await db.prepare("UPDATE media_article_embeddings SET extraction_input_identity = ? WHERE source_id = ? AND dimension = ? AND input_identity = ?").bind(job.input_identity, source.id, dimension, similarityInputIdentity(dimension, similarityInputFor(parsed, dimension))).run();
      }
    }
    if (previous) {
      for (const dimension of SIMILARITY_DIMENSIONS) {
        if (JSON.stringify(similarityInputFor(previousExtraction!, dimension)) !== JSON.stringify(similarityInputFor(parsed, dimension))) {
          await invalidateSimilarityDimension(db, source.id, source.appid, dimension);
        }
      }
    }
    const stored = storedExtractionJson(output, job.input_identity, source.original_url);
    await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
    await db.prepare("INSERT OR IGNORE INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(source.id, job.input_identity, source.normalized_content_hash ?? "", CLEANUP_VERSION, job.model, job.config_version, stored, now.toISOString()).run();
    await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?").bind(stored, now.toISOString(), job.id).run();
    status = "succeeded";
  });
  return status;
}

async function persistOverview(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "failed"> {
  let status: "succeeded" | "stale" | "failed" = "failed";
  await transaction(db, async () => {
    const sources = await rows<SourceRow>(db, "SELECT id, appid, original_url, title, outlet, author, published_at, updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context, normalized_content_hash, cleanup_version, processing_content, processing_input_identity FROM media_sources WHERE appid = ? AND pass = 'initial'", job.appid);
    const extractions = await rows<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id IN (SELECT id FROM media_sources WHERE appid = ? AND pass = 'initial') AND active = 1", job.appid);
    if (synthesisIdentity(job.appid, extractions) !== job.input_identity) {
      await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
      status = "stale";
      return;
    }
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const sourceByUrl = new Map(sources.map((source) => [source.original_url, source]));
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
    const tagEvidence = parseMediaTagEvidence(output, evidenceSources);
    const overview = parseMediaOverview(output, job.appid, evidenceSources);
    if (!overview) {
      await db.prepare("UPDATE media_processing_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").bind("Gemini synthesis returned no cited statements", now.toISOString(), job.id).run();
      return;
    }
    const storedOverview = {
      ...overview,
      tags: tagEvidence.map(({ tag, sourceUrls }) => ({ ...tag, sourceUrls })),
    };
    await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(job.appid).run();
    await db.prepare("INSERT OR IGNORE INTO media_game_overviews (appid, input_identity, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(job.appid, job.input_identity, job.model, job.config_version, JSON.stringify(storedOverview), now.toISOString()).run();
    await db.prepare("DELETE FROM media_tag_memberships WHERE appid = ?").bind(job.appid).run();
    const extractionBySourceId = new Map(extractions.map((extraction) => [extraction.source_id, extraction]));
    for (const { tag, sourceUrls } of tagEvidence) {
      for (const sourceUrl of sourceUrls) {
        const source = sourceByUrl.get(sourceUrl);
        const extraction = source ? extractionBySourceId.get(source.id) : undefined;
        if (!source || !extraction) continue;
        await db.prepare("INSERT OR IGNORE INTO media_tag_memberships (appid, tag_slug, tag_label, source_id, extraction_input_identity, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(job.appid, tag.slug, tag.label, source.id, extraction.input_identity, now.toISOString()).run();
      }
    }
    await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?").bind(JSON.stringify(storedOverview), now.toISOString(), job.id).run();
    status = "succeeded";
  });
  return status;
}

type EmbeddingRow = {
  id: number;
  source_id: number;
  appid: number;
  original_url: string;
  title: string;
  type: string;
  hands_on: number | null;
  platform: string | null;
  build_context: string | null;
  dimension: SimilarityDimension;
  input_identity: string;
  extraction_input_identity: string;
  model: string;
  dimensions: number;
  config_version: string;
  vector: unknown;
};

type SimilarityCandidate = {
  dimension: SimilarityDimension;
  appid: number;
  matchedAppid: number;
  similarity: number;
  current: EmbeddingRow[];
  matched: EmbeddingRow[];
  inputIdentity: string;
};

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
  if (!Array.isArray(raw) || raw.length !== GEMINI_EMBEDDING_DIMENSIONS || !raw.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return raw;
}

function cosine(left: Float32Array, right: Float32Array): number | null {
  if (left.length !== GEMINI_EMBEDDING_DIMENSIONS || right.length !== GEMINI_EMBEDDING_DIMENSIONS) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  const result = dot / denominator;
  return Number.isFinite(result) && denominator > 0 ? result : null;
}

async function similarityCandidates(db: AppDatabase, selectedGames: readonly number[]): Promise<SimilarityCandidate[]> {
  const candidates: SimilarityCandidate[] = [];
  const selected = new Set(selectedGames);
  const comparableGames = Object.values(MEDIA_GAME_CHOICES);
  for (const dimension of SIMILARITY_DIMENSIONS) {
    const embeddingRows = await rows<EmbeddingRow>(db, `SELECT e.id, e.source_id, s.appid, s.original_url, s.title, s.type, s.hands_on, s.platform, s.build_context, e.dimension, e.input_identity, e.extraction_input_identity, e.model, e.dimensions, e.config_version, e.vector
      FROM media_article_embeddings AS e
      JOIN media_sources AS s ON s.id = e.source_id
      JOIN media_article_extractions AS x ON x.source_id = e.source_id AND x.active = 1 AND x.input_identity = e.extraction_input_identity
      WHERE e.active = 1 AND e.dimension = ? AND e.model = ? AND e.dimensions = ? AND e.config_version = ?
        AND s.appid IN (SELECT value FROM json_each(?))
      ORDER BY s.appid, e.source_id, e.id`, dimension, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION, JSON.stringify(comparableGames));
    const usable = embeddingRows.filter((row) => decodeVector(row.vector) !== null);
    const byPair = new Map<string, { dimension: SimilarityDimension; appid: number; matchedAppid: number; similarity: number; current: Map<number, EmbeddingRow>; matched: Map<number, EmbeddingRow> }>();
    for (let leftIndex = 0; leftIndex < usable.length; leftIndex += 1) {
      const left = usable[leftIndex]!;
      const leftVector = decodeVector(left.vector);
      if (!leftVector) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < usable.length; rightIndex += 1) {
        const right = usable[rightIndex]!;
        if (left.appid === right.appid || (!selected.has(left.appid) && !selected.has(right.appid))) continue;
        const rightVector = decodeVector(right.vector);
        if (!rightVector) continue;
        const similarity = cosine(leftVector, rightVector);
        if (similarity === null) continue;
        const current = left.appid < right.appid ? left : right;
        const matched = left.appid < right.appid ? right : left;
        const key = `${dimension}:${current.appid}:${matched.appid}`;
        const group = byPair.get(key) ?? {
          dimension,
          appid: current.appid,
          matchedAppid: matched.appid,
          similarity,
          current: new Map<number, EmbeddingRow>(),
          matched: new Map<number, EmbeddingRow>(),
        };
        group.similarity = Math.max(group.similarity, similarity);
        group.current.set(current.source_id, current);
        group.matched.set(matched.source_id, matched);
        byPair.set(key, group);
      }
    }
    for (const group of byPair.values()) {
      const current = [...group.current.values()].sort((left, right) => left.source_id - right.source_id);
      const matched = [...group.matched.values()].sort((left, right) => left.source_id - right.source_id);
      const inputIdentity = sha256(stableJson({
        stage: "explanation",
        dimension,
        appid: group.appid,
        matchedAppid: group.matchedAppid,
        current: current.map((row) => ({ sourceId: row.source_id, extractionInputIdentity: row.extraction_input_identity, vectorInputIdentity: row.input_identity })),
        matched: matched.map((row) => ({ sourceId: row.source_id, extractionInputIdentity: row.extraction_input_identity, vectorInputIdentity: row.input_identity })),
        model: GEMINI_MEDIA_MODEL,
        configVersion: EXPLANATION_CONFIG_VERSION,
      }));
      candidates.push({ ...group, current, matched, inputIdentity });
    }
  }
  return candidates.sort((left, right) => left.inputIdentity.localeCompare(right.inputIdentity));
}

function makeEmbeddingRequest(input: readonly string[]): GeminiRequest {
  return {
    model: `models/${GEMINI_EMBEDDING_MODEL}`,
    content: { parts: [{ text: input.join("\n") }] },
    embedContentConfig: { outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS },
  };
}

function makeExplanationRequest(candidate: SimilarityCandidate, games: ReadonlyMap<number, string>, extractions: ReadonlyMap<number, ExtractionRow>): GeminiRequest {
  const sourcePayload = (row: EmbeddingRow) => ({
    appid: row.appid,
    sourceId: row.source_id,
    url: row.original_url,
    title: row.title,
    type: row.type,
    handsOn: row.hands_on,
    platform: row.platform,
    buildContext: row.build_context,
    extraction: parseExtraction(extractions.get(row.source_id)?.output_json ?? {}),
  });
  return {
    contents: [{ role: "user", parts: [{ text: `Return JSON only as {"supported":true,"dimension":"gameplay|story_world","trait":"specific shared trait","explanation":"direct explanation","currentSourceUrls":["..."],"matchedSourceUrls":["..."]}. Compare exact games ${games.get(candidate.appid) ?? candidate.appid} and ${games.get(candidate.matchedAppid) ?? candidate.matchedAppid}. The matching dimension is ${candidate.dimension}. Name one specific shared gameplay/system or story/world trait grounded in both article evidence. Preserve material preview, announcement, hands-on, platform, and build qualifications in the explanation; do not present reported or previewed evidence as a released-game observation. Do not discuss quality, ratings, popularity, praise, criticism, technical complaints, overall equivalence, or predicted enjoyment. Set supported false when evidence does not support a concrete shared trait. Cite at least one URL for each game.` }, { text: JSON.stringify({ current: candidate.current.map(sourcePayload), matched: candidate.matched.map(sourcePayload) }) }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: EXPLANATION_MAX_OUTPUT_TOKENS },
  };
}

async function persistEmbedding(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "failed"> {
  if (job.source_id === null || !job.dimension) return "failed";
  const extraction = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND active = 1 LIMIT 1", job.source_id);
  if (!extraction) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  const input = similarityInputFor(parseExtraction(extraction.output_json), job.dimension);
  if (similarityInputIdentity(job.dimension, input) !== job.input_identity) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  const values = embeddingValues(output);
  if (!values) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").bind("Gemini embedding returned an incompatible vector", now.toISOString(), job.id).run();
    return "failed";
  }
  const source = await currentSource(db, job.source_id);
  if (!source) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  await transaction(db, async () => {
    await db.prepare("UPDATE media_article_embeddings SET active = 0 WHERE source_id = ? AND dimension = ? AND active = 1").bind(job.source_id, job.dimension).run();
    await db.prepare("INSERT OR IGNORE INTO media_article_embeddings (source_id, dimension, input_identity, extraction_input_identity, model, dimensions, config_version, vector, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(job.source_id, job.dimension, job.input_identity, extraction.input_identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION, encodeVector(values), now.toISOString()).run();
    await db.prepare("UPDATE media_article_embeddings SET extraction_input_identity = ?, model = ?, dimensions = ?, config_version = ?, vector = ?, active = 1 WHERE source_id = ? AND dimension = ? AND input_identity = ?").bind(extraction.input_identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION, encodeVector(values), job.source_id, job.dimension, job.input_identity).run();
    await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?").bind(JSON.stringify({ dimensions: GEMINI_EMBEDDING_DIMENSIONS }), now.toISOString(), job.id).run();
  });
  return "succeeded";
}

async function persistExplanation(db: AppDatabase, job: JobRow, output: unknown, now: Date): Promise<"succeeded" | "stale" | "failed"> {
  if (!job.dimension || job.matched_appid === null) return "failed";
  const candidate = (await similarityCandidates(db, [job.appid, job.matched_appid])).find((item) => item.dimension === job.dimension && item.appid === job.appid && item.matchedAppid === job.matched_appid && item.inputIdentity === job.input_identity);
  if (!candidate) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'stale', completed_at = ? WHERE id = ?").bind(now.toISOString(), job.id).run();
    return "stale";
  }
  const root = jsonObject(parseJson(output));
  const supported = root.supported === true;
  const dimension = root.dimension;
  const trait = typeof root.trait === "string" ? cleanLine(root.trait).slice(0, 300) : "";
  const explanation = typeof root.explanation === "string" ? cleanLine(root.explanation).slice(0, 2_000) : "";
  const currentUrls = new Set(strings(root.currentSourceUrls ?? root.currentCitationUrls));
  const matchedUrls = new Set(strings(root.matchedSourceUrls ?? root.matchedCitationUrls));
  const currentSources = candidate.current.filter((source) => currentUrls.has(source.original_url));
  const matchedSources = candidate.matched.filter((source) => matchedUrls.has(source.original_url));
  if (dimension !== job.dimension || !supported || !trait || !explanation || currentSources.length === 0 || matchedSources.length === 0) {
    await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, completed_at = ? WHERE id = ?").bind(JSON.stringify({ supported: false, dimension: job.dimension }), now.toISOString(), job.id).run();
    return "succeeded";
  }
  await transaction(db, async () => {
    await db.prepare("UPDATE media_game_matches SET active = 0 WHERE appid = ? AND matched_appid = ? AND dimension = ? AND active = 1").bind(candidate.appid, candidate.matchedAppid, candidate.dimension).run();
    await db.prepare("INSERT OR IGNORE INTO media_game_matches (appid, matched_appid, dimension, trait, explanation, similarity, current_source_ids, matched_source_ids, current_extraction_identities, matched_extraction_identities, current_vector_identities, matched_vector_identities, input_identity, model, config_version, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(candidate.appid, candidate.matchedAppid, candidate.dimension, trait, explanation, candidate.similarity, JSON.stringify(currentSources.map((source) => source.source_id)), JSON.stringify(matchedSources.map((source) => source.source_id)), JSON.stringify(currentSources.map((source) => source.extraction_input_identity)), JSON.stringify(matchedSources.map((source) => source.extraction_input_identity)), JSON.stringify(currentSources.map((source) => source.input_identity)), JSON.stringify(matchedSources.map((source) => source.input_identity)), candidate.inputIdentity, GEMINI_MEDIA_MODEL, EXPLANATION_CONFIG_VERSION, now.toISOString()).run();
    await db.prepare("UPDATE media_game_matches SET trait = ?, explanation = ?, similarity = ?, active = 1 WHERE appid = ? AND matched_appid = ? AND dimension = ? AND input_identity = ?").bind(trait, explanation, candidate.similarity, candidate.appid, candidate.matchedAppid, candidate.dimension, candidate.inputIdentity).run();
    await db.prepare("UPDATE media_processing_jobs SET status = 'succeeded', output_json = ?, error = NULL, completed_at = ? WHERE id = ?").bind(JSON.stringify({ supported: true, dimension: candidate.dimension, trait, explanation, currentSourceUrls: [...currentUrls], matchedSourceUrls: [...matchedUrls] }), now.toISOString(), job.id).run();
  });
  return "succeeded";
}

async function reconcileJob(db: AppDatabase, job: JobRow, result: GeminiBatchPoll, now: Date, secret: string | undefined): Promise<"succeeded" | "failed" | "stale" | "uncertain"> {
  if (result.state === "pending") return "uncertain";
  const usageJson = result.usage ? JSON.stringify(result.usage) : "{}";
  const charge = actualCharge(job, result.usage ?? null);
  await db.prepare("UPDATE media_processing_jobs SET usage_json = ?, charged_microusd = COALESCE(?, charged_microusd), reservation_active = CASE WHEN ? IS NULL THEN reservation_active ELSE 0 END WHERE id = ?").bind(usageJson, charge, charge, job.id).run();
  if (result.state === "failed") {
    await db.prepare("UPDATE media_processing_jobs SET status = 'failed', reservation_active = CASE WHEN ? IS NULL THEN reservation_active ELSE 0 END, error = ?, completed_at = ? WHERE id = ?").bind(charge, boundedError(result.error, secret), now.toISOString(), job.id).run();
    if (job.source_id !== null) await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(job.source_id).run();
    return "failed";
  }
  if (job.stage === "extraction") return persistExtraction(db, job, result.output, now);
  if (job.stage === "embedding") return persistEmbedding(db, job, result.output, now);
  if (job.stage === "explanation") return persistExplanation(db, job, result.output, now);
  return persistOverview(db, job, result.output, now);
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

async function budgetTotals(db: AppDatabase): Promise<{ reserved: number; charged: number }> {
  return (await first<{ reserved: number; charged: number }>(db, "SELECT COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE 0 END), 0) AS reserved, COALESCE(SUM(CASE WHEN reservation_active = 0 THEN COALESCE(charged_microusd, 0) ELSE 0 END), 0) AS charged FROM media_processing_jobs")) ?? { reserved: 0, charged: 0 };
}

async function loadAuthorization(db: AppDatabase, runId?: number): Promise<{ auth: AuthorizationRow; selectedGames: number[] }> {
  const auth = runId === undefined
    ? await first<AuthorizationRow & { selected_games: string }>(db, "SELECT a.run_id, a.status, a.stop_reason, a.billing_confirmation, r.selected_games FROM media_processing_authorizations a JOIN media_discovery_runs r ON r.id = a.run_id WHERE a.status IN ('queued', 'waiting') AND r.status NOT IN ('queued', 'running') ORDER BY a.run_id DESC LIMIT 1")
    : await first<AuthorizationRow & { selected_games: string }>(db, "SELECT a.run_id, a.status, a.stop_reason, a.billing_confirmation, r.selected_games FROM media_processing_authorizations a JOIN media_discovery_runs r ON r.id = a.run_id WHERE a.run_id = ? AND r.status NOT IN ('queued', 'running')", runId);
  if (!auth) throw new Error("Media processing authorization not found");
  return { auth, selectedGames: parseSelectedGames(auth.selected_games) };
}

async function authorizeMediaProcessingNow(db: AppDatabase, runId: number): Promise<{ runId: number; status: string }> {
  if (!Number.isInteger(runId) || runId <= 0) throw new Error("runId must be a positive integer");
  const run = await first<{ id: number; selected_games: string; status: string }>(db, "SELECT id, selected_games, status FROM media_discovery_runs WHERE id = ?", runId);
  if (!run) throw new Error("Media discovery run not found");
  if (run.status === "queued" || run.status === "running") throw new Error("Media discovery run is still running");
  parseSelectedGames(run.selected_games);
  await transaction(db, async () => {
    await db.prepare("INSERT OR IGNORE INTO media_processing_authorizations (run_id, status) VALUES (?, 'queued')").bind(runId).run();
    await db.prepare("UPDATE media_processing_authorizations SET updated_at = CURRENT_TIMESTAMP WHERE run_id = ?").bind(runId).run();
  });
  const result = await first<{ status: string }>(db, "SELECT status FROM media_processing_authorizations WHERE run_id = ?", runId);
  return { runId, status: result?.status ?? "queued" };
}

let mediaProcessingQueue: Promise<unknown> = Promise.resolve();

export function authorizeMediaProcessing(db: AppDatabase, runId: number): Promise<{ runId: number; status: string }> {
  const next = mediaProcessingQueue
    .catch(() => undefined)
    .then(() => authorizeMediaProcessingNow(db, runId));
  mediaProcessingQueue = next;
  return next;
}

const JOB_COLUMNS = "id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error";

async function scheduleEmbeddings(
  db: AppDatabase,
  runId: number,
  selectedGames: readonly number[],
  transport: GeminiBatchTransport,
  secret: string | undefined,
  now: Date,
): Promise<{ submitted: number; reused: number; stopReason: string | null }> {
  const extractions = await rows<ExtractionRow>(db, "SELECT e.id, e.source_id, e.input_identity, e.content_hash, e.cleanup_version, e.model, e.config_version, e.output_json, e.active FROM media_article_extractions e JOIN media_sources s ON s.id = e.source_id WHERE e.active = 1 AND s.appid IN (SELECT value FROM json_each(?))", JSON.stringify(selectedGames));
  let submitted = 0;
  let reused = 0;
  let stopReason: string | null = null;
  for (const extraction of extractions) {
    const source = await currentSource(db, extraction.source_id);
    if (!source) continue;
    const parsed = parseExtraction(extraction.output_json);
    for (const dimension of SIMILARITY_DIMENSIONS) {
      const input = similarityInputFor(parsed, dimension);
      const identity = similarityInputIdentity(dimension, input);
      const existing = await first<{ id: number; vector: unknown }>(db, "SELECT id, vector FROM media_article_embeddings WHERE source_id = ? AND dimension = ? AND input_identity = ? AND model = ? AND dimensions = ? AND config_version = ? LIMIT 1", extraction.source_id, dimension, identity, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_CONFIG_VERSION);
      if (input.length === 0) {
        await invalidateSimilarityDimension(db, extraction.source_id, source.appid, dimension);
        continue;
      }
      if (existing && decodeVector(existing.vector)) {
        await transaction(db, async () => {
          await db.prepare("UPDATE media_article_embeddings SET active = 0 WHERE source_id = ? AND dimension = ? AND active = 1").bind(extraction.source_id, dimension).run();
          await db.prepare("UPDATE media_article_embeddings SET extraction_input_identity = ?, active = 1 WHERE id = ?").bind(extraction.input_identity, existing.id).run();
        });
        reused += 1;
        continue;
      }
      await db.prepare("UPDATE media_article_embeddings SET active = 0 WHERE source_id = ? AND dimension = ? AND active = 1").bind(extraction.source_id, dimension).run();
      const requestKey = `embedding:${extraction.source_id}:${dimension}:${identity}`;
      const priorJob = await first<{ status: JobRow["status"] }>(db, "SELECT status FROM media_processing_jobs WHERE request_key = ?", requestKey);
      if (priorJob && priorJob.status !== "reserved") continue;
      const request = makeEmbeddingRequest(input);
      let tokenCount: number;
      try { tokenCount = await transport.countTokens(GEMINI_EMBEDDING_MODEL, request); }
      catch (error) { stopReason ??= `count_tokens:${boundedError(error, secret)}`; continue; }
      if (!Number.isInteger(tokenCount) || tokenCount < 0 || tokenCount > MAX_EMBEDDING_INPUT_TOKENS) {
        stopReason ??= "input_token_cap";
        continue;
      }
      if (!await reserveJob(db, { run_id: runId, stage: "embedding", appid: source.appid, source_id: extraction.source_id, request_key: requestKey, input_identity: identity, model: GEMINI_EMBEDDING_MODEL, config_version: GEMINI_EMBEDDING_CONFIG_VERSION, dimension, max_input_tokens: tokenCount, max_output_tokens: EMBEDDING_MAX_OUTPUT_TOKENS, reserved_microusd: conservativeCharge(tokenCount, EMBEDDING_MAX_OUTPUT_TOKENS, "embedding") })) {
        stopReason ??= "lifetime_budget";
        break;
      }
      const job = await first<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE request_key = ?`, requestKey);
      if (!job || job.status !== "reserved") continue;
      if (await submitJob(db, job, request, transport, secret, now, null) === "submitted") submitted += 1;
    }
  }
  return { submitted, reused, stopReason };
}

async function scheduleExplanations(
  db: AppDatabase,
  runId: number,
  selectedGames: readonly number[],
  transport: GeminiBatchTransport,
  secret: string | undefined,
  now: Date,
): Promise<{ submitted: number; reused: number; stopReason: string | null }> {
  const candidates = (await similarityCandidates(db, selectedGames)).slice(0, MAX_SIMILARITY_EXPLANATIONS);
  const candidateIdentities = new Set(candidates.map((candidate) => candidate.inputIdentity));
  const activeMatches = await rows<{ id: number; input_identity: string }>(db, "SELECT id, input_identity FROM media_game_matches WHERE active = 1 AND (appid IN (SELECT value FROM json_each(?)) OR matched_appid IN (SELECT value FROM json_each(?)))", JSON.stringify(selectedGames), JSON.stringify(selectedGames));
  for (const match of activeMatches) {
    if (!candidateIdentities.has(match.input_identity)) {
      await db.prepare("UPDATE media_game_matches SET active = 0 WHERE id = ?").bind(match.id).run();
    }
  }
  const candidateAppids = [...new Set(candidates.flatMap((candidate) => [candidate.appid, candidate.matchedAppid]))];
  const games = new Map((await rows<{ appid: number; name: string }>(db, "SELECT appid, name FROM apps WHERE appid IN (SELECT value FROM json_each(?))", JSON.stringify(candidateAppids))).map((game) => [game.appid, game.name]));
  const extractionRows = await rows<ExtractionRow>(db, "SELECT e.id, e.source_id, e.input_identity, e.content_hash, e.cleanup_version, e.model, e.config_version, e.output_json, e.active FROM media_article_extractions e JOIN media_sources s ON s.id = e.source_id WHERE e.active = 1 AND s.appid IN (SELECT value FROM json_each(?))", JSON.stringify(candidateAppids));
  const extractions = new Map(extractionRows.map((row) => [row.source_id, row]));
  let submitted = 0;
  let reused = 0;
  let stopReason: string | null = null;
  for (const candidate of candidates) {
    const old = await first<{ id: number }>(db, "SELECT id FROM media_game_matches WHERE appid = ? AND matched_appid = ? AND dimension = ? AND input_identity = ? ORDER BY id DESC LIMIT 1", candidate.appid, candidate.matchedAppid, candidate.dimension, candidate.inputIdentity);
    if (old) {
      await db.prepare("UPDATE media_game_matches SET active = 1 WHERE id = ?").bind(old.id).run();
      reused += 1;
      continue;
    }
    const requestKey = `explanation:${candidate.appid}:${candidate.matchedAppid}:${candidate.dimension}:${candidate.inputIdentity}`;
    const prior = await first<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE request_key = ?`, requestKey);
    if (prior && prior.status !== "reserved") continue;
    const request = makeExplanationRequest(candidate, games, extractions);
    let tokenCount: number;
    try { tokenCount = await transport.countTokens(GEMINI_MEDIA_MODEL, request); }
    catch (error) { stopReason ??= `count_tokens:${boundedError(error, secret)}`; continue; }
    if (!Number.isInteger(tokenCount) || tokenCount < 0 || tokenCount > MAX_INPUT_TOKENS) {
      stopReason ??= "input_token_cap";
      continue;
    }
    if (!prior && !await reserveJob(db, { run_id: runId, stage: "explanation", appid: candidate.appid, matched_appid: candidate.matchedAppid, dimension: candidate.dimension, source_id: null, request_key: requestKey, input_identity: candidate.inputIdentity, model: GEMINI_MEDIA_MODEL, config_version: EXPLANATION_CONFIG_VERSION, max_input_tokens: tokenCount, max_output_tokens: EXPLANATION_MAX_OUTPUT_TOKENS, reserved_microusd: conservativeCharge(tokenCount, EXPLANATION_MAX_OUTPUT_TOKENS) })) {
      stopReason ??= "lifetime_budget";
      break;
    }
    const job = prior ?? await first<JobRow>(db, `SELECT ${JOB_COLUMNS} FROM media_processing_jobs WHERE request_key = ?`, requestKey);
    if (!job || job.status !== "reserved") continue;
    if (await submitJob(db, job, request, transport, secret, now, null) === "submitted") submitted += 1;
  }
  return { submitted, reused, stopReason };
}

async function advanceMediaProcessingNow(db: AppDatabase, options: MediaProcessingOptions = {}): Promise<MediaProcessingSummary> {
  const { auth, selectedGames } = await loadAuthorization(db, options.runId);
  const now = isoNow(options.now);
  const clock = () => isoNow(options.now);
  const transport = options.transport ?? (options.geminiApiKey ? createGeminiBatchTransport(options.geminiApiKey, options.providerFetch) : null);
  const emptyBudget = await budgetTotals(db);
  if (!transport) {
    const reason = "missing_gemini_batch_transport";
    await db.prepare("UPDATE media_processing_authorizations SET status = 'waiting', stop_reason = ?, updated_at = ? WHERE run_id = ?").bind(reason, now.toISOString(), auth.run_id).run();
    return { runId: auth.run_id, status: "waiting", submitted: 0, completed: 0, reused: 0, chargedMicrousd: emptyBudget.charged, outstandingReservedMicrousd: emptyBudget.reserved, stopReasons: [reason], failed: 0, uncertain: 0, overviewAppids: [] };
  }
  const pricingConfirmed = options.pricingVersion === GEMINI_BATCH_PRICING_VERSION;
  const capabilityConfirmed = options.capabilityVersion === GEMINI_BATCH_CAPABILITY_VERSION;
  if (!pricingConfirmed || !capabilityConfirmed) {
    const reason = !pricingConfirmed ? "pricing_unconfirmed" : "capability_unconfirmed";
    await db.prepare("UPDATE media_processing_authorizations SET status = 'waiting', stop_reason = ?, updated_at = ? WHERE run_id = ?").bind(reason, now.toISOString(), auth.run_id).run();
    return { runId: auth.run_id, status: "waiting", submitted: 0, completed: 0, reused: 0, chargedMicrousd: emptyBudget.charged, outstandingReservedMicrousd: emptyBudget.reserved, stopReasons: [reason], failed: 0, uncertain: 0, overviewAppids: [] };
  }
  await transaction(db, async () => {
    await db.prepare("UPDATE media_processing_authorizations SET billing_confirmation = ?, updated_at = ? WHERE run_id = ?").bind(GEMINI_BATCH_BILLING_CONFIRMATION, now.toISOString(), auth.run_id).run();
  });
  const articleFetch = options.articleFetch ?? fetch;
  const allSources = await rows<SourceRow>(db, `SELECT id, appid, original_url, title, outlet, author, published_at, updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context, normalized_content_hash, cleanup_version, processing_content, processing_input_identity FROM media_sources WHERE pass = 'initial' AND appid IN (SELECT value FROM json_each(?)) ORDER BY appid, id`, JSON.stringify(selectedGames));
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
  let extractionSubmitted = 0;
  let embeddingSubmitted = 0;
  let synthesisSubmitted = 0;
  let reused = 0;
  let stopReason: string | null = null;

  for (const source of sources) {
    const cachedIdentity = source.processing_input_identity && source.cleanup_version === CLEANUP_VERSION && source.normalized_content_hash
      ? extractionIdentity(source, source.normalized_content_hash)
      : null;
    const sameRunJob = cachedIdentity
      ? await first<{ status: JobRow["status"] }>(db, "SELECT status FROM media_processing_jobs WHERE run_id = ? AND source_id = ? AND input_identity = ? ORDER BY id DESC LIMIT 1", auth.run_id, source.id, cachedIdentity)
      : null;
    let content: string | null = sameRunJob?.status === "reserved" ? source.processing_content : null;
    let hash: string | null = sameRunJob?.status === "reserved" ? source.normalized_content_hash : null;
    let identity: string | null = sameRunJob?.status === "reserved" ? cachedIdentity : null;
    if (sameRunJob && sameRunJob.status !== "reserved") {
      reused += 1;
      continue;
    }
    if (!content) {
      const body = await fetchArticle(db, source, auth.run_id, articleFetch, clock);
      const cleaned = body ? cleanArticle(body) : null;
      if (!cleaned) continue;
      content = cleaned.content;
      hash = cleaned.hash;
    }
    if (!hash || !content) continue;
    await transaction(db, async () => {
      const current = await currentSource(db, source.id);
      if (!current) return;
      identity = extractionIdentity(current, hash!);
      const prior = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND active = 1 LIMIT 1", source.id);
      const priorStillSupported = prior
        ? prior.content_hash === hash
          && extractionIdentityFor(current, hash!, prior.model, prior.config_version, prior.cleanup_version) === prior.input_identity
        : false;
      if (prior && !priorStillSupported) {
        await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
        await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(current.appid).run();
      }
      await db.prepare("UPDATE media_sources SET normalized_content_hash = ?, cleanup_version = ?, processing_content = ?, processing_input_identity = ? WHERE id = ?").bind(hash, CLEANUP_VERSION, content, identity, source.id).run();
      Object.assign(source, current, { normalized_content_hash: hash, cleanup_version: CLEANUP_VERSION, processing_content: content, processing_input_identity: identity });
    });
    if (!identity) continue;
    const knownExtraction = await first<ExtractionRow>(db, "SELECT id, source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active FROM media_article_extractions WHERE source_id = ? AND input_identity = ? LIMIT 1", source.id, identity);
    if (knownExtraction) {
      await transaction(db, async () => {
        await db.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ? AND active = 1").bind(source.id).run();
        await db.prepare("UPDATE media_article_extractions SET active = 1 WHERE id = ?").bind(knownExtraction.id).run();
        await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
      });
      reused += 1;
      continue;
    }
    const requestKey = `extraction:${source.id}:${identity}`;
    const priorJob = await first<{ status: JobRow["status"] }>(db, "SELECT status FROM media_processing_jobs WHERE request_key = ?", requestKey);
    if (priorJob && priorJob.status !== "reserved") {
      await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
      reused += 1;
      continue;
    }
    const request = makeExtractionRequest(source, content, identity);
    let tokenCount: number;
    try { tokenCount = await transport.countTokens(GEMINI_MEDIA_MODEL, request); }
    catch (error) { stopReason ??= `count_tokens:${boundedError(error, options.geminiApiKey)}`; continue; }
    if (!Number.isInteger(tokenCount) || tokenCount < 0 || tokenCount > MAX_INPUT_TOKENS) {
      await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
      stopReason ??= "input_token_cap";
      continue;
    }
    if (!await reserveJob(db, { run_id: auth.run_id, stage: "extraction", appid: source.appid, source_id: source.id, request_key: requestKey, input_identity: identity, model: GEMINI_MEDIA_MODEL, config_version: EXTRACTION_CONFIG_VERSION, max_input_tokens: tokenCount, max_output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS, reserved_microusd: conservativeCharge(tokenCount, EXTRACTION_MAX_OUTPUT_TOKENS) })) {
      await db.prepare("UPDATE media_sources SET processing_content = NULL WHERE id = ?").bind(source.id).run();
      stopReason ??= "lifetime_budget";
      break;
    }
    const job = await first<JobRow>(db, "SELECT id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error FROM media_processing_jobs WHERE request_key = ?", requestKey);
    if (!job || job.status !== "reserved") continue;
    if (await submitJob(db, job, request, transport, options.geminiApiKey, now, source.id) === "submitted") extractionSubmitted += 1;
  }

  const submittedJobs = await rows<JobRow>(db, "SELECT id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error FROM media_processing_jobs WHERE status = 'submitted' AND (appid IN (SELECT value FROM json_each(?)) OR matched_appid IN (SELECT value FROM json_each(?))) ORDER BY id", JSON.stringify(selectedGames), JSON.stringify(selectedGames));
  let succeeded = 0;
  let failed = 0;
  let uncertain = 0;
  for (const job of submittedJobs) {
    if (!job.provider_batch_id) { uncertain += 1; continue; }
    try {
      const result = await transport.pollBatch(job.provider_batch_id);
      if (result.state === "pending") { uncertain += 1; continue; }
      const status = await reconcileJob(db, job, result, now, options.geminiApiKey);
      if (status === "succeeded") succeeded += 1;
      else if (status === "failed" || status === "stale") failed += 1;
      else uncertain += 1;
    } catch (error) {
      await db.prepare("UPDATE media_processing_jobs SET error = ? WHERE id = ? AND status = 'submitted'").bind(boundedError(error, options.geminiApiKey), job.id).run();
      uncertain += 1;
    }
  }

  const activeExtractions = await rows<ExtractionRow>(db, "SELECT e.id, e.source_id, e.input_identity, e.content_hash, e.cleanup_version, e.model, e.config_version, e.output_json, e.active FROM media_article_extractions e JOIN media_sources s ON s.id = e.source_id WHERE e.active = 1 AND s.pass = 'initial' AND s.appid IN (SELECT value FROM json_each(?))", JSON.stringify(selectedGames));
  const embeddingResult = await scheduleEmbeddings(db, auth.run_id, selectedGames, transport, options.geminiApiKey, now);
  embeddingSubmitted += embeddingResult.submitted;
  reused += embeddingResult.reused;
  if (!stopReason && embeddingResult.stopReason) stopReason = embeddingResult.stopReason;
  const appids = [...new Set(activeExtractions.map((row) => sourceById.get(row.source_id)?.appid).filter((appid): appid is number => typeof appid === "number"))];
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
    const identity = synthesisIdentity(appid, appExtractions);
    const old = await first<{ input_identity: string; id: number; active: number }>(db, "SELECT input_identity, id, active FROM media_game_overviews WHERE appid = ? AND input_identity = ? ORDER BY id DESC LIMIT 1", appid, identity);
    if (old) {
      await transaction(db, async () => {
        await db.prepare("UPDATE media_game_overviews SET active = 0 WHERE appid = ? AND active = 1").bind(appid).run();
        await db.prepare("UPDATE media_game_overviews SET active = 1 WHERE id = ?").bind(old.id).run();
      });
      reused += 1;
      continue;
    }
    const requestKey = `synthesis:${appid}:${identity}`;
    const existing = await first<JobRow>(db, "SELECT id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error FROM media_processing_jobs WHERE request_key = ?", requestKey);
    if (existing && existing.status !== "reserved") {
      reused += 1;
      continue;
    }
    const request = makeSynthesisRequest(appid, game?.name ?? "", appExtractions, appSources);
    let tokenCount: number;
    try { tokenCount = await transport.countTokens(GEMINI_MEDIA_MODEL, request); }
    catch (error) { stopReason ??= `count_tokens:${boundedError(error, options.geminiApiKey)}`; continue; }
    if (!Number.isInteger(tokenCount) || tokenCount < 0 || tokenCount > MAX_INPUT_TOKENS) { stopReason ??= "input_token_cap"; continue; }
    if (!existing && !await reserveJob(db, { run_id: auth.run_id, stage: "synthesis", appid, source_id: null, request_key: requestKey, input_identity: identity, model: GEMINI_MEDIA_MODEL, config_version: SYNTHESIS_CONFIG_VERSION, max_input_tokens: tokenCount, max_output_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS, reserved_microusd: conservativeCharge(tokenCount, SYNTHESIS_MAX_OUTPUT_TOKENS) })) { stopReason ??= "lifetime_budget"; continue; }
    const job = existing ?? await first<JobRow>(db, "SELECT id, run_id, stage, appid, matched_appid, dimension, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider_batch_id, output_json, usage_json, error FROM media_processing_jobs WHERE request_key = ?", requestKey);
    if (!job || job.status !== "reserved") continue;
    if (await submitJob(db, job, request, transport, options.geminiApiKey, now, null) === "submitted") synthesisSubmitted += 1;
  }
  const explanationResult = await scheduleExplanations(db, auth.run_id, selectedGames, transport, options.geminiApiKey, now);
  synthesisSubmitted += explanationResult.submitted;
  reused += explanationResult.reused;
  if (!stopReason && explanationResult.stopReason) stopReason = explanationResult.stopReason;

  const aggregate = await first<{ reserved: number; charged: number; succeeded: number; failed: number; uncertain: number }>(db, "SELECT COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE 0 END), 0) AS reserved, COALESCE(SUM(CASE WHEN reservation_active = 0 THEN COALESCE(charged_microusd, 0) ELSE 0 END), 0) AS charged, COALESCE(SUM(status = 'succeeded'), 0) AS succeeded, COALESCE(SUM(status IN ('failed', 'stale')), 0) AS failed, COALESCE(SUM(status = 'uncertain'), 0) AS uncertain FROM media_processing_jobs");
  const runAggregate = await first<{ succeeded: number; failed: number; uncertain: number }>(db, "SELECT COALESCE(SUM(status = 'succeeded'), 0) AS succeeded, COALESCE(SUM(status IN ('failed', 'stale')), 0) AS failed, COALESCE(SUM(status = 'uncertain'), 0) AS uncertain FROM media_processing_jobs WHERE run_id = ?", auth.run_id);
  const activeOverview = await rows<{ appid: number }>(db, "SELECT appid FROM media_game_overviews WHERE active = 1 AND appid IN (SELECT value FROM json_each(?))", JSON.stringify(selectedGames));
  const gamesWithSources = [...new Set(sources.map((source) => source.appid))];
  const coveredGames = new Set(activeOverview.map((row) => row.appid));
  const allCovered = gamesWithSources.every((appid) => coveredGames.has(appid));
  const pending = Number((await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ? AND status IN ('reserved', 'submitted')", auth.run_id))?.count ?? 0);
  const hasJobs = Number((await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ?", auth.run_id))?.count ?? 0) > 0;
  const hardFailures = Number((await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ? AND status = 'failed'", auth.run_id))?.count ?? 0);
  const recoverable = stopReason === "pricing_unconfirmed" || stopReason === "capability_unconfirmed" || stopReason === "missing_gemini_batch_transport" || stopReason?.startsWith("count_tokens:") === true;
  const terminalFailure = pending === 0 && hardFailures > 0;
  if (!stopReason && terminalFailure) stopReason = "terminal_failure";
  const status: MediaProcessingSummary["status"] = pending > 0 || (stopReason && recoverable) || (!allCovered && !terminalFailure && !stopReason) ? (auth.status === "queued" && !hasJobs && sources.length === 0 ? "queued" : "waiting") : terminalFailure ? "stopped" : allCovered ? "completed" : "stopped";
  await db.prepare("UPDATE media_processing_authorizations SET status = ?, stop_reason = ?, updated_at = ? WHERE run_id = ? AND status <> 'stopped'").bind(status, stopReason, now.toISOString(), auth.run_id).run();
  const stopReasons = stopReason ? [stopReason] : [];
  return { runId: auth.run_id, status, submitted: extractionSubmitted + embeddingSubmitted + synthesisSubmitted, completed: Number(runAggregate?.succeeded ?? succeeded), reused, chargedMicrousd: Number(aggregate?.charged ?? 0), outstandingReservedMicrousd: Number(aggregate?.reserved ?? 0), stopReasons, failed: Number(runAggregate?.failed ?? failed), uncertain: Number(runAggregate?.uncertain ?? uncertain), overviewAppids: activeOverview.map((row) => row.appid) };
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

