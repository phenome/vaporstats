import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { runIngestionTick, type IngestionTickOptions } from "../../workers/ingestion";
import { copyTestDatabase, openTestDatabase, type TestDatabase } from "./db";
import type { GeminiBatchPoll, GeminiBatchTransport } from "../../src/lib/media-processing";
import { createOpenRouterTransport, type OpenRouterTransport } from "../../src/lib/media-openrouter";
import { GeminiHttpError, MAX_CLIENT_ERROR_PAUSES, MAX_UNCERTAIN_SENDS } from "../../src/lib/media-paid-providers";
import type { MediaObservation } from "../../src/lib/media-observations";
import { MEDIA_OUTLETS, type MediaPass } from "../../src/lib/media-discovery";

export const CYBERPUNK = 1091500;
export const BALDURS_GATE = 1086940;
export const HADES_II = 1145350;

export const GAME_NAMES: Record<number, string> = {
  [CYBERPUNK]: "Cyberpunk 2077",
  [BALDURS_GATE]: "Baldur's Gate 3",
  [HADES_II]: "Hades II",
};

export function seedApps(native: Database, appids: readonly number[]): void {
  const insert = native.prepare("INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)");
  for (const appid of appids) {
    const name = GAME_NAMES[appid];
    if (!name) throw new Error(`No test game name for ${appid}`);
    insert.run(appid, name, name.toLowerCase().replaceAll(" ", "-"));
  }
}

/** Inserts a completed initial discovery run for `appids` and returns its id. */
export function insertCompletedRun(native: Database, identityKey: string, appids: readonly number[]): number {
  native
    .prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('initial', ?, ?, 'completed')")
    .run(identityKey, JSON.stringify(appids));
  const row = native.query<{ id: number }, []>("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get();
  if (!row) throw new Error("Media discovery run was not created");
  return row.id;
}

/**
 * Inserts a running later-pass discovery run for `appids` and returns its id.
 * Only the daily media run starts a later pass, so tests of its limits create its state directly.
 */
export function insertLaterRun(native: Database, appids: readonly number[]): number {
  native
    .prepare("INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status) VALUES ('later', ?, ?, 'running')")
    .run(`later:${appids.join(",")}:${crypto.randomUUID()}`, JSON.stringify(appids));
  const row = native.query<{ id: number }, []>("SELECT id FROM media_discovery_runs ORDER BY id DESC LIMIT 1").get();
  if (!row) throw new Error("Later media discovery run was not created");
  return row.id;
}

/** Inserts `count` accepted sources for `appid` in `pass`, one URL each on `outlet`'s domain. */
export function insertSources(native: Database, appid: number, pass: MediaPass, count: number, outlet: (typeof MEDIA_OUTLETS)[number] = MEDIA_OUTLETS[0]): void {
  const insert = native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z', 'review')");
  for (let index = 0; index < count; index += 1) {
    insert.run(appid, pass, `https://${outlet.domain}/articles/${appid}-${pass}-seeded-${index}`, `${GAME_NAMES[appid] ?? appid} Review ${index}`, outlet.name);
  }
}

type InlineRequest = { key: string; request: Record<string, unknown> };

/**
 * One scripted paid answer, taken from `ControlledGeminiTransport.nextPolls`
 * in request order. An embedding batch takes it when submitted and reports
 * it when polled, with its Gemini meaning. A text request, which goes to
 * OpenRouter, takes it as the controlled OpenRouter API's reply:
 *
 * - `succeeded`: a chat completion with the scripted output and usage,
 *   charged at Claude Haiku 5.5's listed US$0.10/M input and US$0.50/M
 *   output tokens;
 * - `pending`: no answer, so the client's request times out after sending;
 * - `failed`: a 400 invalid request, a definite refusal;
 * - `http`: an error reply with `status`, carrying it as its error code;
 * - `reply`: this exact OpenRouter reply.
 */
export type ControlledAnswer = GeminiBatchPoll | { state: "http"; status: number } | { state: "reply"; reply: OpenRouterReply };

/** The OpenRouter key the controlled transports use. */
const CONTROLLED_OPENROUTER_KEY = "test-openrouter-key";

/**
 * Deterministic paid-provider transports for tests that advance processing
 * directly. Every paid answer comes from one ordered queue, `nextPolls` (see
 * `ControlledAnswer`). Gemini embedding batches exist only with
 * `{ embeddings: true }` and are named `batches/embed-<n>`. Text requests go
 * through the real OpenRouter transport, `openRouter`, to a controlled
 * OpenRouter API, so every answer is read and classified as in production.
 * Request keys of answered submissions are recorded in `submissions`: an
 * embedding's own key, or `<stage>:chat-<n>` for a text request.
 */
export class ControlledGeminiTransport implements GeminiBatchTransport {
  readonly submissions: string[] = [];
  readonly embeddingSubmissions: string[] = [];
  readonly counts: string[] = [];
  readonly requestBodies: unknown[] = [];
  readonly polls = new Map<string, GeminiBatchPoll>();
  nextPolls: ControlledAnswer[] = [];
  /** Makes the next text request lose its connection after it was sent. */
  throwSubmission = false;
  inspectDuringSubmit: ((requestKey: string) => void | Promise<void>) | undefined;
  beforePoll: ((name: string) => void | Promise<void>) | undefined;
  submitEmbeddingBatch?: (model: string, requests: readonly InlineRequest[]) => Promise<{ name: string }>;
  /** The controlled OpenRouter API behind `openRouter`. */
  readonly openRouterApi = controlledOpenRouterApi();
  /** The real OpenRouter transport for text requests, answered from `nextPolls`. */
  readonly openRouter: OpenRouterTransport = createOpenRouterTransport(CONTROLLED_OPENROUTER_KEY, this.openRouterApi.fetchFn);
  /** Answers a matching text request with this reply instead of taking one from `nextPolls`; set by `refuseRequests`. */
  stopChat: ((request: OpenRouterRequestRecord) => OpenRouterReply | null) | undefined;
  private chats = 0;

  constructor(options: { embeddings?: boolean } = {}) {
    if (options.embeddings) {
      this.submitEmbeddingBatch = async (_model, requests) => {
        const request = requests[0]!;
        this.requestBodies.push(request.request);
        this.embeddingSubmissions.push(request.key);
        this.submissions.push(request.key);
        const name = `batches/embed-${this.embeddingSubmissions.length}`;
        const answer = this.nextPolls.shift() ?? { state: "pending" };
        if (answer.state === "http") throw new GeminiHttpError(answer.status, `HTTP ${answer.status}`);
        if (answer.state === "reply") throw new Error("An OpenRouter reply cannot answer a Gemini embedding batch");
        this.polls.set(name, answer);
        return { name };
      };
    }
    this.openRouterApi.onChat = (request) => this.scriptChat(request);
  }

  async countTokens(model: string, request: Record<string, unknown>): Promise<number> {
    this.counts.push(model + JSON.stringify(request).slice(0, 20));
    return 100;
  }

  /** Queues the controlled OpenRouter API's reply to the text request it just received. */
  private async scriptChat(request: OpenRouterRequestRecord): Promise<void> {
    const stopped = this.stopChat?.(request);
    if (stopped) {
      this.openRouterApi.reply("chat", stopped);
      return;
    }
    this.requestBodies.push(request.body);
    this.chats += 1;
    const key = `${request.stage}:chat-${this.chats}`;
    await this.inspectDuringSubmit?.(key);
    if (this.throwSubmission) {
      this.openRouterApi.reply("chat", { network: "network dropped before the response" });
      return;
    }
    this.submissions.push(key);
    this.openRouterApi.reply("chat", this.chatReply(this.nextPolls.shift() ?? { state: "pending" }, request));
  }

  private chatReply(answer: ControlledAnswer, request: OpenRouterRequestRecord): OpenRouterReply {
    if (answer.state === "reply") return answer.reply;
    if (answer.state === "pending") return { network: "The operation timed out.", name: "TimeoutError" };
    if (answer.state === "failed") return { status: 400, body: { error: { code: 400, message: "Invalid request" } } };
    if (answer.state === "http") return { status: answer.status, body: { error: { code: answer.status, message: `HTTP ${answer.status}` } } };
    const output = resolveChatOutput(answer.output, request);
    const usage = answer.usage
      ? { prompt_tokens: answer.usage.inputTokens ?? 0, completion_tokens: answer.usage.outputTokens ?? 0, cost: ((answer.usage.inputTokens ?? 0) * 0.1 + (answer.usage.outputTokens ?? 0) * 0.5) / 1_000_000 }
      : undefined;
    return {
      status: 200,
      body: {
        id: `gen-${this.chats}`,
        object: "chat.completion",
        model: request.model,
        provider: "Anthropic",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof output === "string" ? output : JSON.stringify(output ?? null) } }],
        ...(usage ? { usage } : {}),
      },
    };
  }

  async pollBatch(name: string): Promise<GeminiBatchPoll> {
    await this.beforePoll?.(name);
    return this.polls.get(name) ?? { state: "pending" };
  }
}

/**
 * Ways a request can be stopped before it produces output. A Gemini request
 * is stopped by its token count: one that fails is transient, one over every
 * input cap is a definite refusal. An OpenRouter text request has no remote
 * token count, so its counterparts are the provider's answers of the same
 * class: a 503 for "token count" and a 400 for "token cap". A real text
 * input cap refusal needs an oversized input, such as `oversizedArticleHtml`.
 */
export const REFUSALS = ["token count", "token cap"] as const;
export type Refusal = (typeof REFUSALS)[number];
/** Refusals that are final for the run; a token count that throws is transient and retried. */
export const DEFINITE_REFUSALS = ["token cap"] as const satisfies readonly Refusal[];

/**
 * Makes `transport` stop every request that `matches` selects with
 * `refusal`, Gemini and OpenRouter alike. Returns how many matching requests
 * were stopped, with `restore()` to answer every request normally again.
 */
export function refuseRequests(
  transport: ControlledGeminiTransport,
  matches: (model: string, request: Record<string, unknown>) => boolean,
  refusal: Refusal,
): (() => number) & { restore(): void } {
  let counted = 0;
  transport.countTokens = async (model, request) => {
    if (!matches(model, request)) return ControlledGeminiTransport.prototype.countTokens.call(transport, model, request);
    counted += 1;
    if (refusal === "token count") throw new Error("token counting unavailable");
    return 1_000_000;
  };
  transport.stopChat = (request) => {
    if (!matches(request.model, request.body as unknown as Record<string, unknown>)) return null;
    counted += 1;
    const status = refusal === "token count" ? 503 : 400;
    return { status, body: { error: { code: status, message: `HTTP ${status}` } } };
  };
  return Object.assign(() => counted, {
    restore() {
      transport.countTokens = ControlledGeminiTransport.prototype.countTokens.bind(transport);
      transport.stopChat = undefined;
    },
  });
}

/**
 * An article whose cleaned text is too large for one text request by the
 * conservative local token estimate: 120,000 characters of CJK text, three
 * UTF-8 bytes each.
 */
export function oversizedArticleHtml(appid: number): string {
  return `<!doctype html><html><body><article><h1>${GAME_NAMES[appid]} Review</h1><p>${"戦闘".repeat(60_000)}</p></article></body></html>`;
}

/**
 * Bodies an outlet can serve with HTTP 200 that hold no root element, so no
 * HTML parser turns them into a document with a body (incident of
 * 2026-11-18). Each must be handled as an unusable article.
 */
export const MALFORMED_ARTICLE_BODIES = {
  "an empty body": "",
  "only whitespace": " \n\t ",
  "plain text": "Moved permanently. Please follow the redirect to continue reading this review.",
  "a JSON document": JSON.stringify({ error: "not found", detail: "The requested review is not available in this region." }),
  "only an HTML comment": "<!-- served by the edge cache -->",
  "binary content": "%PDF-1.7\n\u0000\u0001\u0002 binary stream",
} as const;

/**
 * An outlet answer whose handling throws `message` as soon as its status is
 * read: it stands for any unexpected exception while one item or candidate
 * is handled, which no classifier anticipates.
 */
export function throwingResponse(message: string): Response {
  const response = new Response("<!doctype html><html><body></body></html>");
  Object.defineProperty(response, "status", { get() { throw new Error(message); } });
  return response;
}

/** Key-sorted JSON, matching how processing input identities serialize values. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A discovery-stage article page with the metadata discovery parses. */
export function discoveryArticleHtml(
  appid: number,
  title: string,
  options: { date?: string | null; author?: string; affiliation?: string; body?: string } = {},
): string {
  const body = options.body ?? (`${GAME_NAMES[appid]} delivers a substantial playable campaign with detailed systems and memorable encounters. `.repeat(5) + "Builds reward experimentation.");
  const affiliation = options.affiliation ? `<meta name="author_affiliation" content="${options.affiliation}">` : "";
  const published = options.date === null ? "" : `<meta property="article:published_time" content="${options.date ?? "2025-01-01"}">`;
  return `<!doctype html><html><head><meta property="og:title" content="${title}">${published}<meta name="author" content="${options.author ?? "Reviewer"}">${affiliation}</head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
}

/**
 * Controlled Tavily and outlet fetch. Search returns one article per outlet
 * domain: an initial-pass query finds `/articles/<appid>-<domain>`, published
 * 2025-01-01, and a later-pass query finds `/articles/<appid>-<domain>-later`,
 * which is undated. `variants` overrides individual article URLs with a
 * status, body or redirect.
 */
export function discoveryFetch(options: { variants?: Record<string, { status?: number; body?: string; redirect?: string }> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/usage")) return Response.json({ account: { current_plan: "free" }, plan_usage: 1, plan_limit: 100, paygo_usage: 0, paygo_limit: 0, request_id: "usage-1" });
    if (url.endsWith("/search")) {
      const payload = JSON.parse(String(init?.body)) as { include_domains: string[]; query: string };
      const domain = payload.include_domains[0]!;
      const appid = payload.query.includes("Baldur") ? BALDURS_GATE : payload.query.includes("Hades") ? HADES_II : CYBERPUNK;
      const slug = `${appid}-${domain.replaceAll(".", "-")}${payload.query.includes(" revisited") ? "-later" : ""}`;
      return Response.json({ request_id: `search-${domain}`, usage: { credits_used: 1 }, results: [{ url: `https://${domain}/articles/${slug}` }] });
    }
    const variant = options.variants?.[url];
    if (variant?.redirect) return new Response(null, { status: variant.status ?? 302, headers: { location: variant.redirect } });
    if (variant?.body) return new Response(variant.body, { status: variant.status ?? 200 });
    const appid = url.includes(String(BALDURS_GATE)) ? BALDURS_GATE : url.includes(String(HADES_II)) ? HADES_II : CYBERPUNK;
    const outlet = MEDIA_OUTLETS.find((item) => url.includes(item.domain));
    return new Response(discoveryArticleHtml(appid, `${GAME_NAMES[appid]} Review${outlet ? ` - ${outlet.name}` : ""}`, url.endsWith("-later") ? { date: null } : {}));
  };
  return { calls, fetchFn };
}

/** A processing-stage article page with navigation and advertising noise for cleanup. */
export function processingArticleHtml(appid: number): string {
  const name = GAME_NAMES[appid];
  return `<!doctype html><html><head><title>${name} Review</title><script>secret-not-content</script></head><body><nav>Navigation noise</nav><article><h1>${name} Review</h1><p>${name} has a focused campaign with flexible combat and memorable encounters.</p><h2>Qualifications</h2><p>This preview was played on PC during Early Access and does not assess the final release.</p><ul><li>Builds reward experimentation</li><li>Performance varies by platform</li></ul></article><aside class="advertisement">Advertisement noise</aside></body></html>`;
}

export type ChatOutput = (request: OpenRouterRequestRecord) => unknown;

function resolveChatOutput(output: unknown, request: OpenRouterRequestRecord): unknown {
  return typeof output === "function" ? (output as ChatOutput)(request) : output;
}

export function extractionAppid(request: OpenRouterRequestRecord): number {
  const match = request.body.messages[0]?.content.match(/^Analyze the article about Steam app (\d+)\./);
  if (!match) throw new Error("Missing target app in extraction request");
  return Number(match[1]);
}

export function mediaObservation(appid: number, id: string, kind: MediaObservation["kind"], text: string, quote: string, category = kind === "finding" ? "Gameplay & systems" : "") {
  return { id, appid, kind, text, quote, category, qualifiers: [] };
}

const BUILD_QUOTE = "Builds reward experimentation";

export function extractionOutput(options: string | { trait?: string; traitQuote?: string; gameplay?: boolean } = {}) {
  const { trait = "build experimentation", traitQuote = BUILD_QUOTE, gameplay = false } = typeof options === "string" ? { trait: options } : options;
  return (request: OpenRouterRequestRecord) => {
    const appid = extractionAppid(request);
    return { observations: [
      mediaObservation(appid, "combat", "finding", BUILD_QUOTE, BUILD_QUOTE),
      mediaObservation(appid, "build", "tag", trait, traitQuote),
      ...(gameplay ? [mediaObservation(appid, "gameplay", "gameplay", BUILD_QUOTE, BUILD_QUOTE)] : []),
    ] };
  };
}

type SynthesisSource = { sourceIdentity: string; sourceUrl: string; extraction: { observations: Array<MediaObservation & { selectionId: string }> } };

export function synthesisEvidence({ messages }: Pick<OpenRouterRequestRecord["body"], "messages">): SynthesisSource[] {
  const content = messages[0]?.content ?? "";
  if (!content.startsWith("Synthesize the current assessments")) return [];
  return JSON.parse(content.slice(content.lastIndexOf("\n") + 1)) as SynthesisSource[];
}

export function synthesisSelectionId(source: SynthesisSource, observationId: string): string {
  const selectionId = source.extraction.observations.find(({ id }) => id === observationId)?.selectionId;
  if (!selectionId) throw new Error(`Missing selection ID for observation ${observationId} at ${source.sourceUrl}`);
  return selectionId;
}

export function emptySynthesisSelection(sources: readonly SynthesisSource[]) {
  const observations = sources.flatMap(({ extraction }) => extraction.observations);
  const groups = (kind: "finding" | "pro" | "con" | "tag"): string[][] | null =>
    observations.some((observation) => observation.kind === kind) ? [] : null;
  const categories = Object.fromEntries(observations.filter(({ kind }) => kind === "finding").map(({ category }) => [category, []]));
  return { statements: groups("finding"), categories, prosCons: { pros: groups("pro"), cons: groups("con") }, tags: groups("tag") };
}

export function overviewOutput(url: string): ChatOutput {
  return overviewOutputForUrls([url]);
}

export function overviewOutputForUrls(urls: readonly string[], { tags = true }: { tags?: boolean } = {}): ChatOutput {
  return ({ body }) => {
    const evidence = synthesisEvidence(body);
    const sources = evidence.filter(({ sourceUrl }) => urls.includes(sourceUrl));
    const empty = emptySynthesisSelection(evidence);
    const entries = (kind: "finding" | "tag") => {
      const groups = new Map<string, string[]>();
      for (const source of sources) {
        const item = source.extraction.observations.find((observation) => observation.kind === kind);
        if (!item) continue;
        const key = JSON.stringify([item.text, [...item.qualifiers].sort()]);
        const selectionIds = groups.get(key) ?? [];
        selectionIds.push(item.selectionId);
        groups.set(key, selectionIds);
      }
      return [...groups.values()];
    };
    return {
      ...empty,
      statements: empty.statements === null ? null : entries("finding"),
      tags: tags && empty.tags !== null ? entries("tag") : empty.tags,
    };
  };
}

export function legacyExtractionOutput(trait = "build experimentation"): Record<string, unknown> {
  return { contributions: [{ text: "At launch, the combat supports flexible builds", category: "Gameplay & systems" }], traits: [trait], qualifications: ["Early Access", "PC preview"], provenance: [] };
}

function legacyOverviewOutputForUrls(urls: readonly string[]): Record<string, unknown> {
  return {
    statements: [{ text: "The game presents a focused campaign with flexible combat.", sourceUrls: [...urls] }],
    tags: [{ label: "Build experimentation", sourceUrls: [...urls] }],
  };
}

/**
 * The error codes Bun 1.4's `fetch` throws for a TLS failure, each observed
 * against a local TLS server: a self-signed certificate, an expired one, one
 * for another host, an untrusted chain, a leaf without its issuer, and a
 * server that does not speak TLS. The request was never sent.
 */
export const TLS_FAILURE_CODES = [
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
] as const;

/** One answer the controlled Gemini API gives a request: an HTTP reply, or a connection failure. */
export type GeminiReply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { network: string; code?: string };

/** The Gemini request kinds the controlled API serves. */
export type GeminiCall = "count" | "submit" | "poll";

/**
 * A controlled Gemini REST API behind a fetch function, so the real batch
 * transport and its response classification run unchanged. Every request
 * succeeds unless a reply is queued for its kind with `reply`. A submitted
 * batch succeeds on its first poll with an output that fits its stage: an
 * extraction, an Overview citing every article URL in the request, or a
 * 3,072-dimension vector. Usage is fixed per stage so costs are predictable.
 */
export function controlledGeminiApi() {
  const replies: Record<GeminiCall, GeminiReply[]> = { count: [], submit: [], poll: [] };
  const batches = new Map<string, { key: string; stage: string; body: unknown }>();
  /** Request keys of every batch the API accepted, in order. */
  const submitted: string[] = [];
  /** Every request the API received, by kind, including refused ones. */
  const calls: Array<{ kind: GeminiCall; key?: string }> = [];
  const answer = (reply: GeminiReply): Response => {
    if ("network" in reply) throw Object.assign(new Error(reply.network), reply.code ? { code: reply.code } : {});
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json", ...reply.headers } });
  };
  const output = (stage: string, body: unknown) => {
    if (stage === "embedding") {
      return { embedding: { values: Array.from({ length: 3072 }, (_, index) => (index % 7) / 7) }, usageMetadata: { promptTokenCount: 1_000 } };
    }
    const text = stage === "synthesis"
      ? JSON.stringify({ ...legacyOverviewOutputForUrls([...new Set(JSON.stringify(body).match(/https:\/\/[^"\\]+\/articles\/[^"\\]+/g) ?? [])]), similarityInputs: { gameplay: ["Flexible combat builds"] } })
      : JSON.stringify(legacyExtractionOutput());
    return { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100 } };
  };
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith(":countTokens")) {
      calls.push({ kind: "count" });
      const reply = replies.count.shift();
      return reply ? answer(reply) : Response.json({ totalTokens: 100 });
    }
    if (url.endsWith(":batchGenerateContent") || url.endsWith(":asyncBatchEmbedContent")) {
      const body = JSON.parse(String(init?.body)) as { batch: { input_config?: { requests: { requests: Array<{ metadata: { key: string }; request: unknown }> } }; inputConfig?: { requests: { requests: Array<{ metadata: { key: string }; request: unknown }> } } } };
      const item = (body.batch.input_config ?? body.batch.inputConfig)!.requests.requests[0]!;
      calls.push({ kind: "submit", key: item.metadata.key });
      const reply = replies.submit.shift();
      if (reply) return answer(reply);
      const name = `batches/controlled-${batches.size + 1}`;
      batches.set(name, { key: item.metadata.key, stage: item.metadata.key.split(":")[0]!, body: item.request });
      submitted.push(item.metadata.key);
      return Response.json({ name });
    }
    const name = url.slice(url.indexOf("batches/"));
    const batch = batches.get(name);
    calls.push({ kind: "poll", key: batch?.key });
    const reply = replies.poll.shift();
    if (reply) return answer(reply);
    if (!batch) return Response.json({ error: { message: "batch not found" } }, { status: 404 });
    return Response.json({ metadata: { state: "BATCH_STATE_SUCCEEDED" }, response: { inlinedResponses: { inlinedResponses: [{ response: output(batch.stage, batch.body) }] } } });
  };
  return {
    fetchFn,
    submitted,
    calls,
    /** Queues `reply` for the next request of `kind`. */
    reply(kind: GeminiCall, ...queued: GeminiReply[]) { replies[kind].push(...queued); },
    /** Makes the API know batch `name`, accepted before the test began, of `stage`. */
    batch(name: string, stage: "extraction" | "synthesis" | "embedding", body: unknown = {}) { batches.set(name, { key: `${stage}:${name}`, stage, body }); },
    isGeminiRequest: (url: string) => url.startsWith("https://generativelanguage.googleapis.com/"),
  };
}

/** Gemini's reply when the project's Prepay credits are depleted. */
export const GEMINI_PREPAY_DEPLETED: GeminiReply = { status: 402, body: { error: { code: 402, status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted. Please add credits to continue." } } };
/** Gemini's reply when the project reached the spending cap set in its billing settings. */
export const GEMINI_SPEND_CAP: GeminiReply = { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Your project has exceeded its monthly spending cap." } } };
/** Gemini's reply to a rate limit, which is transient. */
export const GEMINI_RATE_LIMIT: GeminiReply = { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } } };
/** Gemini's reply to a request made with an invalid API key. */
export const GEMINI_KEY_INVALID: GeminiReply = { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } } };
/** Gemini's reply when the key's project has no billing enabled for the requested tier. */
export const GEMINI_BILLING_DISABLED: GeminiReply = { status: 400, body: { error: { code: 400, status: "FAILED_PRECONDITION", message: "Billing is not enabled for this project. Enable billing to use the Batch API." } } };
/** Gemini's reply when the requested model is retired or unknown. */
export const GEMINI_MODEL_NOT_FOUND: GeminiReply = { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "models/gemini-3.1-flash-lite is not found for API version v1beta." } } };

/** One answer the controlled OpenRouter API gives a request: an HTTP reply, or a connection failure. */
export type OpenRouterReply =
  /** An HTTP reply whose `body` is sent as JSON, or `raw` as it is. */
  | { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
  | { network: string; code?: string; name?: string }
  /** No answer until the client's request signal aborts it. */
  | { hang: true };

/** The OpenRouter request kinds the controlled API serves. */
export type OpenRouterCall = "chat" | "key";

/** One chat completion the controlled OpenRouter API received. */
export interface OpenRouterRequestRecord {
  /** The stage named in the request's prompt. */
  stage: "extraction" | "synthesis";
  model: string;
  body: { model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown; max_tokens?: number; reasoning?: unknown };
  authorization: string | null;
  /** Article URLs the request cites, for a synthesis. */
  urls: string[];
}

/** The usage the controlled API reports on every successful chat completion: 1,000 input and 100 output tokens at US$0.00015. */
export const OPENROUTER_USAGE = { prompt_tokens: 1_000, completion_tokens: 100, cost: 0.00015 } as const;

/**
 * A controlled OpenRouter REST API behind a fetch function, so the real
 * chat-completion transport and its response classification run unchanged.
 * Every chat completion succeeds unless a reply is queued with `reply`, with
 * an output that fits its stage: an extraction, or an Overview citing every
 * article URL in the request. The key endpoint reports a key with no limit
 * and no budget unless a reply is queued.
 */
export function controlledOpenRouterApi() {
  const replies: Record<OpenRouterCall, OpenRouterReply[]> = { chat: [], key: [] };
  const outputs: { extraction: unknown[]; synthesis: unknown[] } = { extraction: [], synthesis: [] };
  const usages: unknown[] = [];
  /** Every chat completion the API received, including refused ones. */
  const requests: OpenRouterRequestRecord[] = [];
  /** Every request the API received, by kind. */
  const calls: Array<{ kind: OpenRouterCall; stage?: string }> = [];
  const api = {
    /** Runs when a chat completion arrives, before it is answered. */
    onChat: undefined as ((request: OpenRouterRequestRecord) => void | Promise<void>) | undefined,
  };
  const answer = async (reply: OpenRouterReply, signal?: AbortSignal | null): Promise<Response> => {
    if ("hang" in reply) {
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if ("network" in reply) throw Object.assign(new Error(reply.network), reply.code ? { code: reply.code } : {}, reply.name ? { name: reply.name } : {});
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json", ...reply.headers } });
  };
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    if (url === "https://openrouter.ai/api/v1/key") {
      calls.push({ kind: "key" });
      const reply = replies.key.shift();
      return reply ? answer(reply, init?.signal) : Response.json({ data: { label: "test", limit: null, limit_remaining: null, budgets: [], effective_budget: null, usage: 0 } });
    }
    if (url !== "https://openrouter.ai/api/v1/chat/completions") return Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
    const body = JSON.parse(String(init?.body)) as OpenRouterRequestRecord["body"];
    const evidence = synthesisEvidence(body);
    const urls = evidence.map(({ sourceUrl }) => sourceUrl);
    const stage = body.messages[0]?.content.startsWith("Synthesize the current assessments") ? "synthesis" : "extraction";
    const record: OpenRouterRequestRecord = { stage, model: body.model, body, authorization, urls };
    requests.push(record);
    calls.push({ kind: "chat", stage: record.stage });
    await api.onChat?.(record);
    const reply = replies.chat.shift();
    if (reply) return answer(reply, init?.signal);
    const output = resolveChatOutput(outputs[record.stage].shift()
      ?? (record.stage === "synthesis" ? overviewOutputForUrls(urls) : extractionOutput({ gameplay: true })), record);
    return Response.json({
      id: `gen-${requests.length}`,
      object: "chat.completion",
      model: body.model,
      provider: "Anthropic",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof output === "string" ? output : JSON.stringify(output) } }],
      usage: usages.shift() ?? OPENROUTER_USAGE,
    });
  };
  return Object.assign(api, {
    fetchFn,
    requests,
    calls,
    /** Queues `reply` for the next request of `kind`. */
    reply(kind: OpenRouterCall, ...queued: OpenRouterReply[]) { replies[kind].push(...queued); },
    /** Queues the model output of the next successful request of `stage`. */
    output(stage: "extraction" | "synthesis", ...queued: unknown[]) { outputs[stage].push(...queued); },
    /** Queues the `usage` object of the next successful request, in place of `OPENROUTER_USAGE`. */
    usage(...queued: unknown[]) { usages.push(...queued); },
    isOpenRouterRequest: (url: string) => url.startsWith("https://openrouter.ai/"),
  });
}

/**
 * OpenRouter's answer cut off at the output cap, shaped like the first live
 * run's job A (2026-11-18): 1,200 completion tokens, 1,078 of them reasoning,
 * finish reason `length` (native `max_tokens`), and a truncated JSON answer.
 */
export const OPENROUTER_TRUNCATED: OpenRouterReply & { status: number; body: unknown } = {
  status: 200,
  body: {
    id: "gen-truncated",
    object: "chat.completion",
    model: "anthropic/claude-haiku-5.5",
    provider: "Claude Platform on AWS",
    choices: [{ index: 0, finish_reason: "length", native_finish_reason: "max_tokens", message: { role: "assistant", content: "{\"contributions\":[{\"text\":\"The combat" } }],
    usage: { prompt_tokens: 3_081, completion_tokens: 1_200, completion_tokens_details: { reasoning_tokens: 1_078 }, cost: 0.0009 },
  },
};

/** OpenRouter's reply when the API key's credit limit is exhausted, as a 402 or a 403. */
export const openRouterKeyLimit = (status: 402 | 403): OpenRouterReply => ({ status, body: { error: { code: status, message: "Key limit exceeded", metadata: { limit_source: "openrouter_key_limit", remedy_hint: "Raise the key's limit." } } } });
/** OpenRouter's reply when the account balance cannot cover the request. */
export const OPENROUTER_CREDITS: OpenRouterReply = { status: 402, body: { error: { code: 402, message: "Insufficient credits", metadata: { reason: "weight_exceeds_budget", limit_source: "openrouter_credits" } } } };
/** OpenRouter's reply when running and recently completed requests fill the in-flight budget: transient. */
export const OPENROUTER_IN_FLIGHT_BUDGET: OpenRouterReply = { status: 402, headers: { "Retry-After": "3600" }, body: { error: { code: 402, message: "This request would exceed your available credits given your current in-flight requests.", metadata: { reason: "in_flight_budget_exhausted", limit_source: "openrouter_in_flight_budget" } } } };
/** OpenRouter's reply when a guardrail budget is spent. */
export const OPENROUTER_GUARDRAIL_BUDGET: OpenRouterReply = { status: 403, body: { error: { code: 403, message: "Org member budget limit exceeded (weekly limit). $52.00 of $50.00 used.", metadata: { limit_source: "openrouter_guardrail_budget", scope: "member", limit_usd: 50, spend_usd: 52, resets_at: "2026-11-16T00:00:00.000Z" } } } };
/** OpenRouter's reply when a workspace budget is spent. */
export const OPENROUTER_WORKSPACE_BUDGET: OpenRouterReply = { status: 403, body: { error: { code: 403, message: "Workspace budget limit exceeded.", metadata: { limit_source: "openrouter_workspace_budget", scope: "workspace", limit_usd: 10, spend_usd: 10, resets_at: null } } } };
/** OpenRouter's reply when moderation flags the input: a definite refusal. */
export const OPENROUTER_MODERATION: OpenRouterReply = { status: 403, body: { error: { code: 403, message: "Input was flagged", metadata: { reasons: ["violence"], flagged_input: "...", provider_name: "Anthropic", model_slug: "anthropic/claude-haiku-5.5" } } } };
/** OpenRouter's reply when the key lacks permission for the request: a configuration problem, never a refusal. */
export const OPENROUTER_PERMISSION_DENIED: OpenRouterReply = { status: 403, body: { error: { code: 403, message: "This key does not have permission to use this model", metadata: { error_type: "permission_denied" } } } };
/** OpenRouter's reply to an invalid or disabled API key. */
export const OPENROUTER_INVALID_KEY: OpenRouterReply = { status: 401, body: { error: { code: 401, message: "No auth credentials found" } } };

/** One answer the controlled Tavily API gives a search: an HTTP reply, or a connection failure. */
export type TavilyReply = { status: number; body?: unknown } | { network: string };

/**
 * A controlled Tavily search API behind a fetch function. The usage endpoint
 * reports a free plan with `remaining` credits left (100 by default) and no
 * pay-as-you-go allowance unless `plan` or `paygoLimit` say otherwise. Each search returns one article on the searched
 * outlet's domain, `https://<domain>/articles/<appid>-<domain>`, for the
 * catalog entity whose name the query starts with, unless a reply is queued
 * with `reply`. `searches` records each search as `<entity name>@<domain>`.
 */
export function controlledTavilyApi(names: Record<number, string> = GAME_NAMES) {
  const replies: TavilyReply[] = [];
  const searches: string[] = [];
  /** Every search request, as sent. */
  const requests: Array<{ body: unknown }> = [];
  /**
   * `remaining`: free credits the usage endpoint reports; `plan` and
   * `paygoLimit`: the account's plan and pay-as-you-go allowance;
   * `usageCalls`: usage requests received.
   */
  const api = {
    remaining: 100,
    plan: "free",
    paygoLimit: 0,
    usageCalls: 0,
    /**
     * The results of a search that has no queued reply, by its entity, query
     * and outlet domain; when unset or when it returns undefined, the search
     * returns its one default article.
     */
    results: undefined as ((search: { appid: number; query: string; domain: string }) => Array<{ url: string; published_date?: string }> | undefined) | undefined,
  };
  const byLongestName = Object.entries(names).sort(([, a], [, b]) => b.length - a.length);
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "https://api.tavily.com/usage") {
      api.usageCalls += 1;
      return Response.json({ account: { current_plan: api.plan }, plan_usage: 1_000 - api.remaining, plan_limit: 1_000, paygo_usage: 0, paygo_limit: api.paygoLimit });
    }
    if (url !== "https://api.tavily.com/search") return Response.json({ error: "Not Found" }, { status: 404 });
    const payload = JSON.parse(String(init?.body)) as { include_domains: string[]; query: string };
    const domain = payload.include_domains[0]!;
    const entity = byLongestName.find(([, name]) => payload.query.startsWith(`${name} `));
    searches.push(`${entity?.[1] ?? payload.query}@${domain}`);
    requests.push({ body: init?.body });
    const reply = replies.shift();
    if (reply && "network" in reply) throw new Error(reply.network);
    if (reply) return Response.json(reply.body ?? {}, { status: reply.status });
    if (!entity) return Response.json({ results: [], usage: { credits_used: 1 } });
    const results = api.results?.({ appid: Number(entity[0]), query: payload.query, domain });
    if (results) return Response.json({ request_id: `search-${searches.length}`, usage: { credits_used: 1 }, results });
    return Response.json({ request_id: `search-${searches.length}`, usage: { credits_used: 1 }, results: [{ url: `https://${domain}/articles/${entity[0]}-${domain.replaceAll(".", "-")}` }] });
  };
  return Object.assign(api, {
    fetchFn,
    searches,
    requests,
    /** Queues `reply` for the next search. */
    reply(...queued: TavilyReply[]) { replies.push(...queued); },
    isTavilyRequest: (url: string) => url.startsWith("https://api.tavily.com/"),
  });
}

type MediaTickApis = { gemini?: ReturnType<typeof controlledGeminiApi>; openRouter?: ReturnType<typeof controlledOpenRouterApi>; tavily?: ReturnType<typeof controlledTavilyApi> };

/**
 * The tick's fetch: Gemini, OpenRouter and Tavily requests go to their
 * controlled APIs, article pages are served for every outlet URL unless `outlet`
 * answers first, and anything else is unavailable.
 */
export function mediaTickFetch(apis: MediaTickApis, fetched: string[] = [], outlet?: (url: string) => Response | undefined): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (apis.gemini?.isGeminiRequest(url)) return apis.gemini.fetchFn(input, init);
    if (apis.openRouter?.isOpenRouterRequest(url)) return apis.openRouter.fetchFn(input, init);
    if (apis.tavily?.isTavilyRequest(url)) return apis.tavily.fetchFn(input, init);
    if (url.includes("/articles/")) {
      fetched.push(url);
      const answer = outlet?.(url);
      if (answer) return answer;
      const appid = [BALDURS_GATE, HADES_II].find((id) => url.includes(String(id))) ?? CYBERPUNK;
      return new Response(processingArticleHtml(appid));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

/** Reads the latest manual authorization from a test fixture. */
export function manualProcessingOutcome(database: TestDatabase) {
  const auth = database.native.query<{ status: string; stop_reason: string | null; skipped_outputs: number }, []>(
    "SELECT status, stop_reason, skipped_outputs FROM media_processing_authorizations ORDER BY run_id DESC LIMIT 1",
  ).get()!;
  return { status: auth.status, stopReasons: (auth.stop_reason ?? "").split("; ").filter(Boolean), skipped: auth.skipped_outputs };
}

/** Options of `runMediaTick`: tick options plus the outlets' controlled answers. */
export type MediaTickOptions = Partial<IngestionTickOptions> & { fetched?: string[]; outlet?: (url: string) => Response | undefined };

/**
 * Runs one ingestion tick at `at` with the controlled provider APIs and
 * outlets, and test keys for Gemini, OpenRouter and Tavily. Automatic media
 * ingestion is enabled unless `mediaAutomaticIngestion` says otherwise, so a
 * tick at or after 06:00 UTC runs that day's daily media run. Without a
 * controlled Tavily API, every search request is unavailable, and the daily
 * media run searches nothing. The tick's daily player
 * cycle is marked done, so it writes no snapshot, and reception artifacts
 * stay inside the temporary database directory.
 */
export function runMediaTick(database: TestDatabase, apis: MediaTickApis, at: string, options: MediaTickOptions = {}) {
  const { fetched, outlet, ...rest } = options;
  const anchorTime = new Date(at);
  const previousDay = new Date(Date.UTC(anchorTime.getUTCFullYear(), anchorTime.getUTCMonth(), anchorTime.getUTCDate() - 1)).toISOString().slice(0, 10);
  database.native.prepare("INSERT INTO checkpoints (key, value) VALUES ('ingestion:last-daily-cycle', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").run(previousDay);
  process.env.RECEPTION_ARTIFACT_DIR = database.directory;
  return runIngestionTick({
    db: database.db,
    anchorTime,
    customFetch: mediaTickFetch(apis, fetched, outlet),
    geminiApiKey: "test-gemini-key",
    openRouterApiKey: "test-openrouter-key",
    tavilyApiKey: "test-tavily-key",
    mediaAutomaticIngestion: true,
    ...rest,
  });
}

/**
 * Records an extraction that Gemini Batch accepted before text generation
 * moved to OpenRouter: `sourceId`'s article was taken by `runId` with input
 * `identity`, and its batch `batch` is still submitted. Returns the job id.
 */
export function insertSubmittedGeminiExtraction(native: Database, options: { runId: number; sourceId: number; batch?: string; identity?: string }): number {
  const identity = options.identity ?? `pre-cutover-extraction-${options.sourceId}`;
  const source = native.query<{ appid: number }, [number]>("SELECT appid FROM media_sources WHERE id = ?").get(options.sourceId);
  if (!source) throw new Error(`No media source ${options.sourceId}`);
  native.prepare("UPDATE media_sources SET processing_run_id = ?, processing_input_identity = ?, normalized_content_hash = ?, cleanup_version = 'media-cleanup-2026-09-11-v1', processing_content = NULL WHERE id = ?")
    .run(options.runId, identity, `pre-cutover-hash-${options.sourceId}`, options.sourceId);
  native.prepare(
    `INSERT INTO media_processing_jobs (run_id, stage, appid, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, status, provider, enqueued_at, provider_batch_id, usage_json, submitted_at)
     VALUES (?, 'extraction', ?, ?, ?, ?, 'gemini-3.1-flash-lite', 'media-extraction-2026-09-13-v3', 100, 1200, 0, 0, 'submitted', 'gemini', '2026-09-10T00:00:00.000Z', ?, '{}', '2026-09-10T00:00:00.000Z')`,
  ).run(options.runId, source.appid, options.sourceId, `extraction:${options.sourceId}:run:${options.runId}`, identity, options.batch ?? "batches/test-1");
  return native.query<{ id: number }, []>("SELECT id FROM media_processing_jobs ORDER BY id DESC LIMIT 1").get()!.id;
}

/**
 * Where a paid provider's response comes from, which bounds the classes it
 * may take (see `tests/media-provider-contract.test.ts`):
 *
 * - `provider_wide`: about the account, key, project or model, never the
 *   item: a Credit pause or a configuration pause, never a refusal;
 * - `item_content`: about the request itself: a definite refusal;
 * - `pre_send_network`: a connection failure before the request was fully
 *   sent: transient;
 * - `post_accept_charged`: the provider accepted a request that may have
 *   been charged, then failed or answered without a result: uncertain, so it
 *   is resent at most `MAX_UNCERTAIN_SENDS` consecutive times (#80);
 * - `ended_unrun`: the provider ended an accepted batch without running it,
 *   or a free poll failed: transient or uncertain, since a retry repeats no
 *   charge;
 * - `post_send_timeout`: sent, with no answer: uncertain;
 * - `provider_transient`: a temporary provider-wide condition (a rate limit,
 *   an in-flight budget, a timeout response, a server error): transient,
 *   never a refusal or a pause.
 */
export const PROVIDER_RESPONSE_SCOPES = ["provider_wide", "item_content", "pre_send_network", "post_accept_charged", "ended_unrun", "post_send_timeout", "provider_transient"] as const;
export type ProviderResponseScope = (typeof PROVIDER_RESPONSE_SCOPES)[number];

/** A provider's fixtures by response scope, each named; omitting a scope fails to compile. */
export type ScopedProviderFixtures<Fixture> = { readonly [Scope in ProviderResponseScope]: Readonly<Record<string, Fixture>> };

/** One Gemini request kind and the controlled API's reply to it. A poll reply is the batch's whole state. */
export interface GeminiScopedFixture {
  call: GeminiCall;
  reply: GeminiReply;
}

const geminiBatch = (state: string, error?: string): GeminiReply => ({ status: 200, body: { metadata: { state }, ...(error ? { error: { message: error } } : {}) } });

/** Gemini responses by scope, through the real batch transport. */
export const GEMINI_SCOPED_FIXTURES: ScopedProviderFixtures<GeminiScopedFixture> = {
  provider_wide: {
    "submit 402 Prepay depleted": { call: "submit", reply: GEMINI_PREPAY_DEPLETED },
    "submit 429 spend cap": { call: "submit", reply: GEMINI_SPEND_CAP },
    "submit 400 API key invalid": { call: "submit", reply: GEMINI_KEY_INVALID },
    "submit 400 billing not enabled": { call: "submit", reply: GEMINI_BILLING_DISABLED },
    "submit 404 model not found": { call: "submit", reply: GEMINI_MODEL_NOT_FOUND },
    "count 404 model not found": { call: "count", reply: GEMINI_MODEL_NOT_FOUND },
    "submit 401": { call: "submit", reply: { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." } } } },
    "submit 403 permission denied": { call: "submit", reply: { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "Generative Language API has not been used in this project." } } } },
    "count 403 permission denied": { call: "count", reply: { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied." } } } },
    "poll 402 Prepay depleted": { call: "poll", reply: GEMINI_PREPAY_DEPLETED },
    "poll batch failed: Prepay depleted": { call: "poll", reply: geminiBatch("BATCH_STATE_FAILED", "Your prepayment credits are depleted.") },
    ...Object.fromEntries([405, 409, 410, 413, 422].map((status) => [`submit ${status} unrecognized`, { call: "submit", reply: { status, body: { error: { code: status, message: "Unrecognized." } } } }])),
  },
  item_content: {
    "submit 400 invalid argument": { call: "submit", reply: { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." } } } },
    "count 400 invalid argument": { call: "count", reply: { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." } } } },
    "poll inline response error": { call: "poll", reply: { status: 200, body: { metadata: { state: "BATCH_STATE_SUCCEEDED" }, response: { inlinedResponses: { inlinedResponses: [{ error: { code: 400, message: "Invalid content." } }] } } } } },
  },
  pre_send_network: Object.fromEntries(["ECONNREFUSED", "ENOTFOUND", ...TLS_FAILURE_CODES].map((code) => [`submit ${code}`, { call: "submit", reply: { network: "connect failed", code } }])),
  post_accept_charged: {
    "poll batch failed after acceptance": { call: "poll", reply: geminiBatch("BATCH_STATE_FAILED", "Internal error encountered.") },
  },
  ended_unrun: {
    "poll batch expired": { call: "poll", reply: geminiBatch("BATCH_STATE_EXPIRED") },
    "poll batch cancelled": { call: "poll", reply: geminiBatch("BATCH_STATE_CANCELLED") },
    "poll 404 batch not found": { call: "poll", reply: { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } } } },
    "poll 500": { call: "poll", reply: { status: 500, body: { error: { code: 500, status: "INTERNAL", message: "Internal error." } } } },
    "poll connection lost": { call: "poll", reply: { network: "socket closed" } },
  },
  post_send_timeout: {
    "submit connection lost after sending": { call: "submit", reply: { network: "socket closed" } },
    "submit ECONNRESET": { call: "submit", reply: { network: "connection reset", code: "ECONNRESET" } },
  },
  provider_transient: {
    "submit 429 rate limit": { call: "submit", reply: GEMINI_RATE_LIMIT },
    "count 429 rate limit": { call: "count", reply: GEMINI_RATE_LIMIT },
    "submit 408": { call: "submit", reply: { status: 408, body: { error: { code: 408, message: "Request timeout." } } } },
    ...Object.fromEntries([500, 502, 503, 504].map((status) => [`submit ${status}`, { call: "submit", reply: { status, body: { error: { code: status, message: "Unavailable." } } } }])),
    "count 503": { call: "count", reply: { status: 503, body: { error: { code: 503, message: "Unavailable." } } } },
  },
};

/** OpenRouter chat-completion answers by scope, through the real OpenRouter transport. */
export const OPENROUTER_SCOPED_FIXTURES: ScopedProviderFixtures<OpenRouterReply> = {
  provider_wide: {
    "402 key limit": openRouterKeyLimit(402),
    "403 key limit": openRouterKeyLimit(403),
    "402 credits": OPENROUTER_CREDITS,
    "402 without a limit source": { status: 402, body: { error: { code: 402, message: "Payment required" } } },
    "403 guardrail budget": OPENROUTER_GUARDRAIL_BUDGET,
    "403 workspace budget": OPENROUTER_WORKSPACE_BUDGET,
    "403 permission denied": OPENROUTER_PERMISSION_DENIED,
    "403 without metadata": { status: 403, body: { error: { code: 403, message: "Forbidden" } } },
    "401 invalid key": OPENROUTER_INVALID_KEY,
    "404 model unavailable": { status: 404, body: { error: { code: 404, message: "No endpoints found for anthropic/claude-haiku-5.5." } } },
    "200 accepted, then 402 credits": { status: 200, body: { error: { code: 402, message: "Insufficient credits", metadata: { limit_source: "openrouter_credits" } } } },
    ...Object.fromEntries([405, 409, 410, 413, 422].map((status) => [`${status} unrecognized`, { status, body: { error: { code: status, message: "Unrecognized" } } }])),
    // The answer was cut off at the output cap: the cap is the project's configuration, not the item's fault.
    "200 cut off at the output cap": OPENROUTER_TRUNCATED,
    "200 cut off at the output cap, reported only as the native finish reason": { status: 200, body: { ...OPENROUTER_TRUNCATED.body as object, choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "max_tokens", message: { role: "assistant", content: "{\"contributions\":[{\"text\":\"The combat" } }] } },
  },
  item_content: {
    "400 invalid request": { status: 400, body: { error: { code: 400, message: "Invalid request" } } },
    "403 moderation": OPENROUTER_MODERATION,
    "403 content policy": { status: 403, body: { error: { code: 403, message: "Blocked", metadata: { error_type: "content_policy_violation" } } } },
    "200 accepted, then 400 on the first choice": { status: 200, body: { id: "gen-1", choices: [{ index: 0, finish_reason: "error", error: { code: 400, message: "Invalid request" } }] } },
  },
  pre_send_network: Object.fromEntries(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", ...TLS_FAILURE_CODES].map((code) => [code, { network: "connect failed", code }])),
  post_accept_charged: {
    "200 accepted, then 502": { status: 200, body: { error: { code: 502, message: "Provider returned error" } } },
    "200 accepted, then 408": { status: 200, body: { error: { code: 408, message: "Provider timed out" } } },
    "200 accepted, finish_reason error without a code": { status: 200, body: { id: "gen-1", choices: [{ index: 0, finish_reason: "error", message: { role: "assistant", content: "" } }] } },
    "200 not JSON": { status: 200, raw: "data: partial" },
    "200 without choices": { status: 200, body: { id: "gen-1" } },
  },
  post_send_timeout: {
    "no answer before the client timeout": { hang: true },
    "connection lost after sending": { network: "socket closed" },
    "ECONNRESET": { network: "connection reset", code: "ECONNRESET" },
    "timeout error": { network: "The operation timed out.", name: "TimeoutError" },
  },
  // OpenRouter has no batches and no free poll: an answer is the request's only outcome.
  ended_unrun: {},
  provider_transient: {
    "402 in-flight budget": OPENROUTER_IN_FLIGHT_BUDGET,
    "408": { status: 408, body: { error: { code: 408, message: "Request timeout" } } },
    "429": { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } },
    ...Object.fromEntries([500, 502, 503, 504].map((status) => [String(status), { status, body: { error: { code: status, message: "Provider unavailable" } } }])),
  },
};

/** The outbound calls an interruption sweep counts and interrupts. */
export const OUTBOUND_KINDS = ["search", "outlet_fetch", "openrouter", "gemini_submit"] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

/** One outbound call, by kind and request identity, with the UTC day it was made. */
export interface OutboundCall {
  kind: OutboundKind;
  /**
   * What makes a request the same request: a search's `<query>@<domain>`, an
   * outlet fetch's `discovery:<url>` or `processing:<url>`, a text request's
   * messages, or an embedding submission's request key.
   */
  identity: string;
  day: string;
  /** For a search or outlet fetch, the outlet's domain. */
  domain?: string;
}

/**
 * The one exception to sending each request at most once (ADR 0020):
 * article text is never retained, so a processing fetch that a restart
 * interrupted before its item was marked in flight is sent again when the
 * item next takes a turn. It is bounded to one extra send per restart that
 * interrupted that fetch. Every other request identity is sent at most once,
 * in the uninterrupted run and in every interrupted one.
 */
export const PROCESSING_FETCH_RESENT_AFTER_RESTART = {
  name: "processing fetch resent after a restart interrupted it (ADR 0020)",
  applies: (call: Pick<OutboundCall, "kind" | "identity">) => call.kind === "outlet_fetch" && call.identity.startsWith("processing:"),
  /** Extra sends allowed per restart that interrupted the fetch. */
  perRestart: 1,
} as const;

/**
 * The resend of uncertain paid work (#80): a paid request whose outcome is
 * unknown, such as one a restart interrupted, is sent again under the queue's
 * backoff, so one OpenRouter request or Gemini submission identity is sent at
 * most `MAX_UNCERTAIN_SENDS` times, never more. Article text is never
 * retained, so each resend of an uncertain extraction fetches its article
 * again: one processing fetch per such resend.
 */
export const UNCERTAIN_PAID_RESEND = {
  name: "paid request resent after an uncertain outcome (#80)",
  applies: (call: Pick<OutboundCall, "kind">) => call.kind === "openrouter" || call.kind === "gemini_submit",
  /** Sends allowed per request identity. */
  maxSends: MAX_UNCERTAIN_SENDS,
  /** Processing fetches of an article allowed per resend of its uncertain extraction. */
  refetchesPerResend: 1,
} as const;

/**
 * The retry of a waiting item whose handling threw (2026-11-18): it backs off
 * and is taken again, so the processing fetch of its article is sent again,
 * at most `MAX_CLIENT_ERROR_PAUSES` times in all, after which it ends
 * `client_error_exhausted`. Each occurrence is counted on its item.
 */
export const THROWING_ITEM_RETRY = {
  name: "processing fetch of an item whose handling threw",
  applies: (call: Pick<OutboundCall, "kind" | "identity">) => call.kind === "outlet_fetch" && call.identity.startsWith("processing:"),
  /** Sends allowed per article in all. */
  maxSends: MAX_CLIENT_ERROR_PAUSES,
} as const;

/** A media world: the controlled providers and outlets one sweep run uses. */
export interface MediaWorld {
  tavily: ReturnType<typeof controlledTavilyApi>;
  openRouter: ReturnType<typeof controlledOpenRouterApi>;
  gemini: ReturnType<typeof controlledGeminiApi>;
  /** Answers an article fetch first; the default article page otherwise. */
  outlet?: (url: string) => Response | undefined;
}

/** A state and a stretch of ticks that `sweepInterruptions` interrupts. */
export interface InterruptionScenario {
  name: string;
  /** Builds the database's state before any tick, such as its catalog. */
  seed(native: Database): void;
  /** A fresh controlled world for each run. */
  world(): MediaWorld;
  /**
   * Uninterrupted ticks that build the state the sweep starts from. They run
   * once, until quiescent, into a template every run copies, so they are not
   * interrupted: they must be ticks another registered scenario sweeps.
   */
  before?: readonly string[];
  /** Tick options for the `before` ticks; `options` by default. */
  beforeOptions?: MediaTickOptions;
  /** The ticks the sweep interrupts, in order, within one UTC day. */
  ticks: readonly string[];
  /** Tick options for every tick, such as `paidSubmissionsPerTick`. */
  options?: MediaTickOptions;
  /**
   * UTC days a run continues after the swept day when a day stop was
   * injected or holds a query, paid work still waits, or a fault falls on a
   * following day.
   */
  days: number;
}

/**
 * Which runs `sweepInterruptions` makes besides the uninterrupted one. Every
 * run, whatever its faults, is checked for the same invariants:
 *
 * - send once: no request identity is sent twice, except under
 *   `PROCESSING_FETCH_RESENT_AFTER_RESTART`, `UNCERTAIN_PAID_RESEND` and
 *   `THROWING_ITEM_RETRY`; a request a fault answered with HTTP 429 never
 *   reached its outlet and is not counted as sent;
 * - every tick that no restart stopped completes and reports no media error,
 *   so an exception while one item is handled stays at that item;
 * - at most one accepted article per entity and query (entity, pass and outlet);
 * - at most 30 attempts per outlet per UTC day, as recorded and as observed;
 * - every query a day-scoped stop held at the end of the swept day completes
 *   on a later day;
 * - every accepted article is extracted, unless its extraction ended
 *   `uncertain_exhausted` (#80: uncertain work is resent at most three times)
 *   or, after its handling threw three times, `client_error_exhausted`.
 */
export interface InterruptionInvariants {
  /**
   * Restart after the k-th swept call of each listed kind: the call reaches
   * its provider or outlet, the process stops before its outcome is recorded,
   * the database is reopened, and ticks continue until quiescent.
   */
  restarts?: readonly OutboundKind[];
  /** An Outlet day stop at the k-th swept outlet fetch: the outlet answers it with HTTP 429. */
  dayStops?: boolean;
  /**
   * Runs that combine an Outlet day stop at a swept outlet fetch with
   * restarts after the first outlet fetch and the first search of the
   * following day, for this many evenly spaced day stops.
   */
  combined?: number;
  /** Sweeps at most this many evenly spaced k per kind; every k by default. */
  sample?: number;
}

/** What one sweep found. `violations` is empty when every invariant held. */
export interface InterruptionReport {
  /** Calls of each kind in the uninterrupted run's swept ticks. */
  baseline: Record<OutboundKind, number>;
  runs: number;
  /** Queries a day-scoped stop held at the end of a swept day, across every run. */
  dayStoppedQueries: number;
  /** Most attempts recorded on one outlet on one UTC day, across every run. */
  peakOutletDayAttempts: number;
  /** Requests a run sent again under `PROCESSING_FETCH_RESENT_AFTER_RESTART`. */
  resentUnderException: string[];
  /** Paid requests, and their articles' processing fetches, a run sent again under `UNCERTAIN_PAID_RESEND`. */
  resentAfterUncertain: string[];
  /** Processing fetches a run sent again under `THROWING_ITEM_RETRY`. */
  retriedAfterItemError: string[];
  violations: string[];
}

const DAY_SCOPED_STOP_REASONS = ["daily_attempt_cap", "search_http_429", "fetch_http_429", "tavily_search_http_429"];
const QUIESCENCE_TICKS = 16;

function addMinutes(at: string, minutes: number): string {
  return new Date(Date.parse(at) + minutes * 60_000).toISOString();
}

function nextDayAt(at: string, days: number, time = "06:00"): string {
  const date = new Date(Date.parse(at));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days)).toISOString().slice(0, 10) + `T${time}:00.000Z`;
}

function sampled(count: number, limit: number | undefined): number[] {
  const all = Array.from({ length: count }, (_, index) => index + 1);
  if (limit === undefined || count <= limit) return all;
  return [...new Set(Array.from({ length: limit }, (_, index) => all[Math.round((index * (count - 1)) / Math.max(1, limit - 1))]!))];
}

/**
 * What a sweep run injects: a restart after, or a 429 to, the k-th call of a
 * kind, counted from the start of the swept ticks or of the following days.
 */
type Fault = { mode: "restart" | "day_stop"; kind: OutboundKind; k: number; phase: "swept" | "following" };

function classifyCall(native: Database, url: string, init?: RequestInit): Omit<OutboundCall, "day"> | null {
  if (url === "https://api.tavily.com/search") {
    const body = JSON.parse(String(init?.body)) as { query: string; include_domains: string[] };
    return { kind: "search", identity: `${body.query}@${body.include_domains[0]}`, domain: body.include_domains[0] };
  }
  if (url === "https://openrouter.ai/api/v1/chat/completions") {
    return { kind: "openrouter", identity: JSON.stringify((JSON.parse(String(init?.body)) as { messages: unknown }).messages) };
  }
  if (url.endsWith(":asyncBatchEmbedContent") || url.endsWith(":batchGenerateContent")) {
    const body = JSON.parse(String(init?.body)) as { batch: { inputConfig?: { requests: { requests: Array<{ metadata: { key: string } }> } }; input_config?: { requests: { requests: Array<{ metadata: { key: string } }> } } } };
    return { kind: "gemini_submit", identity: (body.batch.inputConfig ?? body.batch.input_config)!.requests.requests[0]!.metadata.key };
  }
  if (url.includes("/articles/")) {
    // An article already accepted as a source is fetched for processing;
    // any other is a discovery candidate.
    const source = native.query("SELECT 1 FROM media_sources WHERE original_url = ?1 OR discovery_url = ?1").get(url);
    return { kind: "outlet_fetch", identity: `${source ? "processing" : "discovery"}:${url}`, domain: new URL(url).hostname };
  }
  return null;
}

/** A database and world driven through ticks with every outbound call recorded and `faults` injected. */
function sweepDriver(database: TestDatabase, scenario: InterruptionScenario, world: MediaWorld, faults: readonly Fault[]) {
  const apis = { tavily: world.tavily, openRouter: world.openRouter, gemini: world.gemini };
  const inner = mediaTickFetch(apis, [], world.outlet);
  const calls: OutboundCall[] = [];
  const interrupted: OutboundCall[] = [];
  /** Ticks that no restart stopped but that did not complete cleanly. */
  const unclean: string[] = [];
  let phase: Fault["phase"] | null = null;
  let day = "";
  const counted = new Map<string, number>();
  const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = classifyCall(database.native, String(input), init);
    if (!call) return inner(input, init);
    const recorded = { ...call, day };
    const key = `${phase} ${call.kind}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
    const fault = faults.find((item) => item.phase === phase && item.kind === call.kind && item.k === counted.get(key));
    // A 429 the fault answers never reaches the outlet, so it is not a send.
    if (fault?.mode === "day_stop") return new Response("Too Many Requests", { status: 429 });
    calls.push(recorded);
    if (fault?.mode === "restart") {
      const response = await inner(input, init);
      await response.arrayBuffer().catch(() => undefined);
      interrupted.push(recorded);
      database.reopen();
      throw new Error("process stopped");
    }
    return inner(input, init);
  }) as typeof fetch;
  const tick = async (at: string, options = scenario.options) => {
    day = at.slice(0, 10);
    const before = calls.length;
    const restartsBefore = interrupted.length;
    const result = await runMediaTick(database, apis, at, { ...options, customFetch });
    // A restart stops the tick by design; any other tick must complete, and
    // an exception while one item is handled must not reach the media boundary.
    if (interrupted.length === restartsBefore && (result.status !== "completed" || result.mediaError)) {
      unclean.push(`tick ${at} ended ${result.status}: ${result.error ?? result.mediaError}`);
    }
    return calls.length - before;
  };
  const untilQuiescent = async (from: string, options = scenario.options) => {
    let at = from;
    for (let index = 0; index < QUIESCENCE_TICKS; index += 1) {
      if ((await tick(at, options)) === 0) return;
      at = addMinutes(at, 15);
    }
    throw new Error(`${scenario.name}: still making calls ${QUIESCENCE_TICKS} ticks after ${from}`);
  };
  return {
    calls,
    interrupted,
    unclean,
    tick,
    untilQuiescent,
    enter(next: Fault["phase"]) { phase = next; },
  };
}

/**
 * The state every run of `scenario` starts from: seeded, migrated, and
 * advanced through its `before` ticks until quiescent, with the calls those
 * ticks made. No batch may be left submitted, since each run's world is new.
 */
async function sweepTemplate(scenario: InterruptionScenario): Promise<{ database: TestDatabase; calls: OutboundCall[] }> {
  const database = openTestDatabase("vaporstats-sweep-template-");
  scenario.seed(database.native);
  const driver = sweepDriver(database, scenario, scenario.world(), []);
  const before = scenario.before ?? [];
  for (const at of before) await driver.tick(at, scenario.beforeOptions ?? scenario.options);
  if (before.length > 0) await driver.untilQuiescent(addMinutes(before[before.length - 1]!, 15), scenario.beforeOptions ?? scenario.options);
  if (database.native.query("SELECT 1 FROM media_processing_jobs WHERE status = 'submitted'").get()) throw new Error(`${scenario.name}: a batch is still submitted after the before ticks`);
  return { database, calls: driver.calls };
}

/** One run of `scenario` from its template, with `faults`, checked for every invariant. */
async function sweepRun(template: { database: TestDatabase; calls: OutboundCall[] }, scenario: InterruptionScenario, faults: readonly Fault[], label: string) {
  const database = copyTestDatabase(template.database, "vaporstats-sweep-");
  const violations: string[] = [];
  try {
    const driver = sweepDriver(database, scenario, scenario.world(), faults);
    driver.enter("swept");
    for (const at of scenario.ticks) await driver.tick(at);
    const last = scenario.ticks[scenario.ticks.length - 1]!;
    await driver.untilQuiescent(addMinutes(last, 15));
    const swept = [...driver.calls];
    const stopped = database.native.query<{ id: number; stopped_at: string | null }, []>(`SELECT id, stopped_at FROM media_discovery_progress WHERE status = 'stopped' AND stop_reason IN (${DAY_SCOPED_STOP_REASONS.map((reason) => `'${reason}'`).join(", ")})`).all();
    // The following days exist to reopen what a day stop held (queries and
    // paid work alike), to finish waiting work, and to host following-day
    // faults; with none of these, they would only repeat what the scenario
    // that sweeps those days already checks.
    driver.enter("following");
    const held = stopped.length > 0
      || faults.some((fault) => fault.mode === "day_stop" || fault.phase === "following")
      || database.native.query("SELECT 1 FROM media_processing_jobs WHERE status = 'queued' AND retained = 0").get() !== null;
    const following = held ? scenario.days : 0;
    for (let offset = 1; offset <= following; offset += 1) await driver.untilQuiescent(nextDayAt(last, offset));
    const { native } = database;

    // Send once.
    const allowance = new Map<string, number>();
    for (const call of driver.interrupted) {
      if (PROCESSING_FETCH_RESENT_AFTER_RESTART.applies(call)) allowance.set(`${call.kind} ${call.identity}`, (allowance.get(`${call.kind} ${call.identity}`) ?? 0) + PROCESSING_FETCH_RESENT_AFTER_RESTART.perRestart);
    }
    // Each resend of an uncertain extraction fetches its article once more.
    const refetches = new Map<string, number>();
    for (const { original_url, resends } of database.native.query<{ original_url: string; resends: number }, []>(
      `SELECT s.original_url, COUNT(*) AS resends FROM media_processing_attempts AS a
       JOIN media_processing_jobs AS j ON j.id = a.job_id JOIN media_sources AS s ON s.id = j.source_id
       WHERE j.stage = 'extraction' AND EXISTS (SELECT 1 FROM media_processing_attempts AS p WHERE p.job_id = a.job_id AND p.attempt = a.attempt - 1 AND p.outcome = 'uncertain')
       GROUP BY s.original_url`,
    ).all()) refetches.set(`outlet_fetch processing:${original_url}`, resends * UNCERTAIN_PAID_RESEND.refetchesPerResend);
    // Each later occurrence of an item whose handling threw fetches its article once more.
    const itemRetries = new Map<string, number>();
    for (const { original_url, occurrences } of database.native.query<{ original_url: string; occurrences: number }, []>(
      "SELECT s.original_url, j.client_error_pauses AS occurrences FROM media_processing_jobs AS j JOIN media_sources AS s ON s.id = j.source_id WHERE j.stage = 'extraction' AND j.error LIKE '%item_error%'",
    ).all()) itemRetries.set(`outlet_fetch processing:${original_url}`, Math.max(0, Math.min(occurrences, THROWING_ITEM_RETRY.maxSends) - 1));
    const sent = new Map<string, number>();
    const kindOf = new Map<string, OutboundCall>();
    for (const call of [...template.calls, ...driver.calls]) {
      sent.set(`${call.kind} ${call.identity}`, (sent.get(`${call.kind} ${call.identity}`) ?? 0) + 1);
      kindOf.set(`${call.kind} ${call.identity}`, call);
    }
    const resentUnderException: string[] = [];
    const resentAfterUncertain: string[] = [];
    const retriedAfterItemError: string[] = [];
    for (const [identity, count] of sent) {
      if (UNCERTAIN_PAID_RESEND.applies(kindOf.get(identity)!)) {
        if (count > UNCERTAIN_PAID_RESEND.maxSends) violations.push(`${label}: ${identity.slice(0, 160)} sent ${count} times, at most ${UNCERTAIN_PAID_RESEND.maxSends} allowed`);
        else if (count > 1) resentAfterUncertain.push(`${label}: ${UNCERTAIN_PAID_RESEND.name}: ${identity.slice(0, 160)}`);
        continue;
      }
      const restartAllowance = allowance.get(identity) ?? 0;
      const uncertainAllowance = refetches.get(identity) ?? 0;
      const itemErrorAllowance = itemRetries.get(identity) ?? 0;
      const limit = 1 + restartAllowance + uncertainAllowance + itemErrorAllowance;
      if (count > limit) violations.push(`${label}: ${identity.slice(0, 160)} sent ${count} times, at most ${limit} allowed`);
      else if (count > 1 + uncertainAllowance + itemErrorAllowance) resentUnderException.push(`${label}: ${PROCESSING_FETCH_RESENT_AFTER_RESTART.name}: ${identity}`);
      else if (count > 1 + uncertainAllowance) retriedAfterItemError.push(`${label}: ${THROWING_ITEM_RETRY.name}: ${identity}`);
      else if (count > 1) resentAfterUncertain.push(`${label}: ${UNCERTAIN_PAID_RESEND.name}: ${identity}`);
    }
    // One accepted article per entity and query.
    for (const row of native.query<{ appid: number; pass: string; outlet: string; articles: number }, []>("SELECT appid, pass, outlet, COUNT(*) AS articles FROM media_sources GROUP BY appid, pass, outlet HAVING COUNT(*) > 1").all()) {
      violations.push(`${label}: ${row.articles} articles accepted for ${row.appid} ${row.pass}@${row.outlet}`);
    }
    // At most 30 attempts per outlet per UTC day.
    const recorded = native.query<{ outlet: string; day: string; attempts: number }, []>("SELECT outlet, day, COUNT(*) AS attempts FROM media_discovery_attempts GROUP BY outlet, day").all();
    for (const row of recorded) if (row.attempts > 30) violations.push(`${label}: ${row.attempts} recorded attempts on ${row.outlet} on ${row.day}`);
    const observed = new Map<string, number>();
    for (const call of driver.calls) if (call.domain) observed.set(`${call.domain} ${call.day}`, (observed.get(`${call.domain} ${call.day}`) ?? 0) + 1);
    for (const [key, count] of observed) if (count > 30) violations.push(`${label}: ${count} searches and fetches for ${key}`);
    // Every day-stopped query reopens and completes on a later day.
    for (const { id, stopped_at } of stopped) {
      const stopDay = (stopped_at ?? last).slice(0, 10);
      const row = native.query<{ appid: number; pass: string; outlet: string; status: string; stop_reason: string | null; completed_at: string | null }, [number]>("SELECT appid, pass, outlet, status, stop_reason, completed_at FROM media_discovery_progress WHERE id = ?").get(id);
      if (!row || row.status !== "completed" || !row.completed_at || row.completed_at.slice(0, 10) <= stopDay) {
        violations.push(`${label}: query ${row ? `${row.appid} ${row.pass}@${row.outlet}` : id} day-stopped on ${stopDay} ended ${row?.status ?? "missing"}${row?.stop_reason ? ` (${row.stop_reason})` : ""}`);
      }
    }
    // Every tick that no restart stopped completed with no media error.
    for (const tick of driver.unclean) violations.push(`${label}: ${tick}`);
    // Every accepted article is extracted, unless its extraction ended
    // uncertain_exhausted or, after an item error, client_error_exhausted.
    for (const { original_url } of native.query<{ original_url: string }, []>("SELECT original_url FROM media_sources AS s WHERE NOT EXISTS (SELECT 1 FROM media_article_extractions AS e WHERE e.source_id = s.id AND e.active = 1) AND NOT EXISTS (SELECT 1 FROM media_processing_jobs AS j WHERE j.source_id = s.id AND j.stage = 'extraction' AND j.status IN ('uncertain_exhausted', 'client_error_exhausted'))").all()) {
      violations.push(`${label}: accepted ${original_url} was never extracted`);
    }
    return { swept, violations, resentUnderException, resentAfterUncertain, retriedAfterItemError, dayStopped: stopped.length, peak: Math.max(0, ...recorded.map(({ attempts }) => attempts)) };
  } catch (error) {
    return { swept: [], violations: [`${label}: ${error instanceof Error ? error.message : String(error)}`], resentUnderException: [], resentAfterUncertain: [], retriedAfterItemError: [], dayStopped: 0, peak: 0 };
  } finally {
    database.cleanup();
  }
}

/**
 * Runs `scenario` once uninterrupted, then once per fault that `invariants`
 * selects, each in a copy of one template database, and reports every
 * invariant a run broke. A scenario's world answers every request
 * successfully unless it scripts a failure on purpose, such as an answer
 * that is always lost; otherwise only the injected faults interrupt it.
 */
export async function sweepInterruptions(scenario: InterruptionScenario, invariants: InterruptionInvariants): Promise<InterruptionReport> {
  const template = await sweepTemplate(scenario);
  try {
    const results = [await sweepRun(template, scenario, [], `${scenario.name}, uninterrupted`)];
    const swept = results[0]!.swept;
    const baseline = Object.fromEntries(OUTBOUND_KINDS.map((kind) => [kind, swept.filter((call) => call.kind === kind).length])) as Record<OutboundKind, number>;
    for (const kind of invariants.restarts ?? []) {
      for (const k of sampled(baseline[kind], invariants.sample)) {
        results.push(await sweepRun(template, scenario, [{ mode: "restart", kind, k, phase: "swept" }], `${scenario.name}, restart after ${kind} #${k}`));
      }
    }
    if (invariants.dayStops) {
      for (const k of sampled(baseline.outlet_fetch, invariants.sample)) {
        results.push(await sweepRun(template, scenario, [{ mode: "day_stop", kind: "outlet_fetch", k, phase: "swept" }], `${scenario.name}, day stop at outlet fetch #${k}`));
      }
    }
    for (const k of sampled(baseline.outlet_fetch, invariants.combined ?? 0)) {
      if (!invariants.combined) break;
      results.push(await sweepRun(template, scenario, [
        { mode: "day_stop", kind: "outlet_fetch", k, phase: "swept" },
        { mode: "restart", kind: "outlet_fetch", k: 1, phase: "following" },
        { mode: "restart", kind: "search", k: 1, phase: "following" },
      ], `${scenario.name}, day stop at outlet fetch #${k}, then restarts after the next day's first outlet fetch and first search`));
    }
    return {
      baseline,
      runs: results.length,
      dayStoppedQueries: results.reduce((sum, result) => sum + result.dayStopped, 0),
      peakOutletDayAttempts: Math.max(...results.map((result) => result.peak)),
      resentUnderException: results.flatMap((result) => result.resentUnderException),
      resentAfterUncertain: results.flatMap((result) => result.resentAfterUncertain),
      retriedAfterItemError: results.flatMap((result) => result.retriedAfterItemError),
      violations: results.flatMap((result) => result.violations),
    };
  } finally {
    template.database.cleanup();
  }
}

function experimentArticleUrl(appid: number, domain: string, suffix = ""): string {
  return `https://${domain}/articles/${appid}-${domain.replaceAll(".", "-")}${suffix}`;
}

/**
 * The experiment games' media world. Each initial-pass search on an
 * outlet finds three candidates: a preview published 2026-10-01
 * (`<initial URL>-preview`), the initial review published 2026-11-10, which
 * the query prefers, and a second preview published 2026-10-15
 * (`-preview-again`). Every later-pass search finds three later reviews,
 * `<initial URL>-revisited` published 2026-11-19, `-revisited-again`
 * published 2026-11-21 and `-revisited-late` published 2026-11-25; the
 * earliest is preferred. Every article has its own text, and every provider
 * answers successfully. Three candidates per query leave a candidate that
 * would qualify after a day stop held the query between fetches.
 */
export function experimentWorld(): MediaWorld {
  const tavily = controlledTavilyApi();
  tavily.results = ({ appid, query, domain }) => {
    const suffixes = query.endsWith(" review revisited") ? ["-revisited", "-revisited-again", "-revisited-late"] : ["-preview", "", "-preview-again"];
    return suffixes.map((suffix) => ({ url: experimentArticleUrl(appid, domain, suffix) }));
  };
  const pages = new Map<string, string>();
  for (const appid of [CYBERPUNK, BALDURS_GATE, HADES_II]) {
    for (const outlet of MEDIA_OUTLETS) {
      const body = (when: string) => `${GAME_NAMES[appid]} offers a substantial playable campaign with detailed systems, as ${outlet.name}'s ${when} assessment describes at length. `.repeat(5) + "Builds reward experimentation.";
      const page = (suffix: string, title: string, date: string, when: string) =>
        pages.set(experimentArticleUrl(appid, outlet.domain, suffix), discoveryArticleHtml(appid, `${GAME_NAMES[appid]} ${title}`, { date, author: `${outlet.name} critic`, body: body(when) }));
      page("-preview", "Hands-on Preview", "2026-10-01T00:00:00.000Z", "preview");
      page("-preview-again", "Hands-on Preview Again", "2026-10-15T00:00:00.000Z", "second preview");
      page("", "Review", "2026-11-10T00:00:00.000Z", "first");
      page("-revisited", "Review Revisited", "2026-11-19T00:00:00.000Z", "second");
      page("-revisited-again", "Review Revisited Again", "2026-11-21T00:00:00.000Z", "third");
      page("-revisited-late", "Review Revisited Late", "2026-11-25T00:00:00.000Z", "fourth");
    }
  }
  return {
    tavily,
    openRouter: controlledOpenRouterApi(),
    gemini: controlledGeminiApi(),
    outlet: (url) => {
      const html = pages.get(url);
      return html === undefined ? undefined : new Response(html);
    },
  };
}

/** The SHA-256 of `value`'s key-sorted JSON: how processing records an input identity. */
function recordedIdentity(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** The URL of `appid`'s `index`-th initial candidate on `domain` that production recorded without admitting it. */
export function productionCandidateUrl(appid: number, domain: string, index: number): string {
  return experimentArticleUrl(appid, domain, `-candidate-${index}`);
}

type ProductionProgress = { appid: number; outlet: string; status: "completed" | "stopped"; stopReason?: string; index: number; candidates: number; searched: boolean; stoppedAt?: string; source?: number };

/**
 * Reproduces the production media state, read-only, as checked on
 * 2026-11-18, before automatic media ingestion was switched on. The
 * production values are its sources, initial progress, Outlet denials,
 * Overviews, retained Gemini jobs, completed authorizations, and the
 * absence of enrollments and media checkpoints.
 *
 * Production recorded values the check did not read; this seed fills them
 * in and the test state does not depend on them otherwise:
 * - the seven authorized runs' games and days (run 2 Baldur's Gate 3 and
 *   run 3 Hades II on 2026-09-11, run 4 Cyberpunk 2077 on 2026-09-13, the
 *   others Cyberpunk 2077 corrections);
 * - candidate URLs: an admitted source is its query's first candidate, at
 *   the URL `experimentWorld` serves as that outlet's initial review; every
 *   other candidate is `productionCandidateUrl`, which the controlled
 *   outlets answer with a qualifying, undated review;
 * - one fetch attempt answered 403 per GameSpot denial, at its stop time,
 *   and no other September attempt, since none counts on a later day;
 * - publication dates (2025-01-01) and article bodies.
 *
 * Cyberpunk 2077's three sources carry the identities processing recorded
 * under Gemini text generation: four extractions (source 4 extracted twice,
 * its first extraction inactive), two Overviews built from them (the first
 * inactive), and two stale syntheses. Production has no embedding job, so
 * no vector is seeded; the active Overview has similarity inputs, so the
 * first automatic run queues Cyberpunk 2077's embeddings.
 */
export function seedProductionLike(native: Database): void {
  seedApps(native, [CYBERPUNK, BALDURS_GATE, HADES_II]);
  const gemini = "gemini-3.1-flash-lite";
  const extractionConfig = "media-extraction-2026-09-13-v3";
  const synthesisConfig = "media-synthesis-2026-09-13-v2";
  const cleanup = "media-cleanup-2026-09-11-v1";
  const runs: Array<[number, number, string]> = [
    [1, CYBERPUNK, "2026-09-10"], [2, BALDURS_GATE, "2026-09-11"], [3, HADES_II, "2026-09-11"], [4, CYBERPUNK, "2026-09-13"],
    [5, CYBERPUNK, "2026-09-14"], [6, CYBERPUNK, "2026-09-15"], [7, CYBERPUNK, "2026-09-16"],
  ];
  for (const [id, appid, day] of runs) {
    native.prepare("INSERT INTO media_discovery_runs (id, pass, identity_key, selected_games, status, origin, started_at, finished_at, created_at) VALUES (?, 'initial', ?, ?, 'completed', 'authorized', ?, ?, ?)")
      .run(id, `initial:${appid}:run-${id}`, JSON.stringify([appid]), `${day}T00:00:00.000Z`, `${day}T23:00:00.000Z`, `${day} 00:00:00`);
    native.prepare("INSERT INTO media_processing_authorizations (run_id, status, billing_confirmation, authorized_at, updated_at) VALUES (?, 'completed', 'confirmed', ?, ?)").run(id, `${day} 00:00:00`, `${day} 23:00:00`);
  }
  const runOf: Record<number, number> = { [BALDURS_GATE]: 2, [HADES_II]: 3, [CYBERPUNK]: 4 };
  const sources: Array<[number, number, string]> = [
    [1, BALDURS_GATE, "IGN"], [3, BALDURS_GATE, "GamesRadar+"], [4, CYBERPUNK, "IGN"], [5, CYBERPUNK, "Eurogamer"], [6, CYBERPUNK, "PC Gamer"],
    [8, HADES_II, "IGN"], [9, HADES_II, "Eurogamer"], [10, HADES_II, "PC Gamer"], [11, HADES_II, "Kotaku"],
  ];
  const domainOf = (outlet: string) => MEDIA_OUTLETS.find(({ name }) => name === outlet)!.domain;
  for (const [id, appid, outlet] of sources) {
    const url = experimentArticleUrl(appid, domainOf(outlet));
    native.prepare("INSERT INTO media_sources (id, appid, pass, original_url, discovery_url, title, outlet, author, published_at, retrieved_at, type) VALUES (?, ?, 'initial', ?, ?, ?, ?, ?, '2025-01-01T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'review')")
      .run(id, appid, url, url, `${GAME_NAMES[appid]} Review`, outlet, `${outlet} critic`);
  }
  const H2 = HADES_II;
  const BG3 = BALDURS_GATE;
  const CP = CYBERPUNK;
  const cap = { status: "stopped", stopReason: "daily_attempt_cap", stoppedAt: "2026-09-11T03:47:12.000Z" } as const;
  const progress: ProductionProgress[] = [
    { appid: BG3, outlet: "Eurogamer", status: "completed", index: 0, candidates: 0, searched: true },
    { appid: BG3, outlet: "GameSpot", status: "stopped", stopReason: "fetch_http_403", index: 2, candidates: 10, searched: true, stoppedAt: "2026-09-11T03:47:12.000Z" },
    { appid: BG3, outlet: "GamesRadar+", status: "completed", index: 10, candidates: 10, searched: true, source: 3 },
    { appid: BG3, outlet: "IGN", status: "completed", index: 10, candidates: 10, searched: true, source: 1 },
    { appid: BG3, outlet: "Kotaku", status: "completed", index: 10, candidates: 10, searched: true },
    { appid: BG3, outlet: "PC Gamer", status: "completed", index: 0, candidates: 0, searched: true },
    { appid: CP, outlet: "Eurogamer", status: "completed", index: 10, candidates: 10, searched: true, source: 5 },
    { appid: CP, outlet: "GameSpot", status: "stopped", stopReason: "fetch_http_403", index: 1, candidates: 10, searched: true, stoppedAt: "2026-09-13T21:24:01.000Z" },
    { appid: CP, outlet: "GamesRadar+", status: "completed", index: 10, candidates: 10, searched: true },
    { appid: CP, outlet: "IGN", status: "completed", index: 10, candidates: 10, searched: true, source: 4 },
    { appid: CP, outlet: "Kotaku", status: "completed", index: 10, candidates: 10, searched: true },
    { appid: CP, outlet: "PC Gamer", status: "completed", index: 10, candidates: 10, searched: true, source: 6 },
    { appid: H2, outlet: "Eurogamer", status: "completed", index: 10, candidates: 10, searched: true, source: 9 },
    { appid: H2, outlet: "GameSpot", status: "stopped", stopReason: "fetch_http_403", index: 1, candidates: 10, searched: true, stoppedAt: "2026-09-11T03:47:12.000Z" },
    { appid: H2, outlet: "GamesRadar+", ...cap, index: 0, candidates: 0, searched: false },
    { appid: H2, outlet: "IGN", ...cap, index: 6, candidates: 10, searched: true, source: 8 },
    { appid: H2, outlet: "Kotaku", ...cap, index: 7, candidates: 10, searched: true, source: 11 },
    { appid: H2, outlet: "PC Gamer", ...cap, index: 4, candidates: 10, searched: true, source: 10 },
  ];
  for (const row of progress) {
    const domain = domainOf(row.outlet);
    const urls = Array.from({ length: row.candidates }, (_, index) => (index === 0 && row.source !== undefined ? experimentArticleUrl(row.appid, domain) : productionCandidateUrl(row.appid, domain, index)));
    const searchedAt = row.searched ? (row.stoppedAt ?? `${runs.find(([id]) => id === runOf[row.appid])![2]}T03:00:00.000Z`) : null;
    native.prepare("INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, status, query_attempted_at, candidate_urls, candidate_index, stop_reason, stopped_at, completed_at) VALUES (?, ?, 'initial', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runOf[row.appid]!, row.appid, row.outlet, row.status, searchedAt, JSON.stringify(urls.map((url) => ({ url, publishedDate: null }))), row.index, row.stopReason ?? null, row.stoppedAt ?? null, row.status === "completed" ? searchedAt : null);
    if (row.stopReason === "fetch_http_403") {
      native.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, status_code, succeeded, error, attempted_at) VALUES (?, ?, 'initial', ?, 'fetch', ?, 403, 0, 'HTTP 403', ?)")
        .run(row.appid, row.outlet, row.stoppedAt!.slice(0, 10), urls[row.index - 1]!, row.stoppedAt!);
    }
  }

  // Cyberpunk 2077's processing under Gemini text generation.
  const job = native.prepare(
    `INSERT INTO media_processing_jobs (run_id, stage, appid, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider, enqueued_at, retained, cost_source, provider_batch_id, usage_json, submitted_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100000, ?, 500, ?, 0, ?, 'gemini', ?, 1, ?, ?, '{}', ?, ?)`,
  );
  const extract = (sourceId: number, runId: number, body: string, active: boolean) => {
    const source = native.query<Record<string, unknown>, [number]>("SELECT * FROM media_sources WHERE id = ?").get(sourceId)!;
    const hash = recordedIdentity({ content: body });
    const metadata = { appid: source.appid, originalUrl: source.original_url, title: source.title, outlet: source.outlet, author: source.author, publishedAt: source.published_at, updatedAt: source.updated_at, type: source.type, handsOn: source.hands_on, affiliation: source.affiliation, platform: source.platform, buildContext: source.build_context };
    const identity = recordedIdentity({ stage: "extraction", hash, cleanupVersion: cleanup, model: gemini, configVersion: extractionConfig, metadata });
    native.prepare("UPDATE media_sources SET normalized_content_hash = ?, cleanup_version = ?, processing_input_identity = ?, processing_run_id = ?, contribution_run_id = ? WHERE id = ?").run(hash, cleanup, identity, runId, runId, sourceId);
    const output = { ...legacyExtractionOutput(), contributions: [{ text: "The combat supports flexible builds", category: "Gameplay & systems", sourceIdentity: identity }], provenance: [{ sourceIdentity: identity, sourceUrl: source.original_url }] };
    if (active) native.prepare("UPDATE media_article_extractions SET active = 0 WHERE source_id = ?").run(sourceId);
    native.prepare("INSERT INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourceId, identity, hash, cleanup, gemini, extractionConfig, JSON.stringify(output), active ? 1 : 0, `2026-09-1${runId}T12:00:00.000Z`);
    job.run(runId, "extraction", CP, sourceId, `extraction:${sourceId}:run:${runId}`, identity, gemini, extractionConfig, 1200, 120, "succeeded", `2026-09-1${runId}T10:00:00.000Z`, "estimated", `batches/extraction-${sourceId}-${runId}`, `2026-09-1${runId}T10:01:00.000Z`, `2026-09-1${runId}T12:00:00.000Z`);
    return { sourceId, identity };
  };
  const overview = (runId: number, extractions: Array<{ sourceId: number; identity: string }>, active: boolean) => {
    const identity = recordedIdentity({ stage: "synthesis", appid: CP, model: gemini, configVersion: synthesisConfig, extractions: extractions.map(({ sourceId, identity: inputIdentity }) => ({ sourceId, inputIdentity })).sort((a, b) => a.sourceId - b.sourceId) });
    const urls = extractions.map(({ sourceId }) => native.query<{ original_url: string }, [number]>("SELECT original_url FROM media_sources WHERE id = ?").get(sourceId)!.original_url);
    native.prepare("INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(CP, identity, gemini, synthesisConfig, JSON.stringify({ ...legacyOverviewOutputForUrls(urls), similarityInputs: { gameplay: ["Open-world action role-playing with flexible builds"], storyWorld: ["A dense neon megacity shaped by corporate power"] } }), active ? 1 : 0, `2026-09-1${runId}T13:00:00.000Z`);
    job.run(runId, "synthesis", CP, null, `synthesis:${CP}:${identity}`, identity, gemini, synthesisConfig, 2400, 240, "succeeded", `2026-09-1${runId}T12:30:00.000Z`, "estimated", `batches/synthesis-${runId}`, `2026-09-1${runId}T12:31:00.000Z`, `2026-09-1${runId}T13:00:00.000Z`);
  };
  const first = [extract(4, 4, "first IGN text", true), extract(5, 4, "Eurogamer text", true), extract(6, 4, "PC Gamer text", true)];
  overview(4, first, false);
  // A correction set re-extracted source 4's changed text and rebuilt the Overview.
  overview(5, [extract(4, 5, "corrected IGN text", true), first[1]!, first[2]!], true);
  // Two later corrections' syntheses went stale before their batches were applied.
  for (const runId of [6, 7]) {
    job.run(runId, "synthesis", CP, null, `synthesis:${CP}:stale-${runId}`, `stale-synthesis-${runId}`, gemini, synthesisConfig, 2400, null, "stale", `2026-09-1${runId}T12:30:00.000Z`, "unknown", `batches/synthesis-${runId}`, `2026-09-1${runId}T12:31:00.000Z`, `2026-09-1${runId}T13:00:00.000Z`);
  }
}

/**
 * Adds to `seedProductionLike` the extraction refusals of the first live run
 * on 2026-11-18, under the scheduled discovery run of that day (run 8). Both
 * were sent to Claude Haiku 5.5 with the 1,200-token cap that reasoning
 * starved, and refused as `invalid_output: no supported contributions`:
 * - job A, Baldur's Gate 3's IGN source 1: 1,200 completion tokens, the whole
 *   cap, finish reason `length`; its answer was cut off. US$0.0009.
 * - job B, Baldur's Gate 3's GamesRadar+ source 3: 911 completion tokens and
 *   finish reason `stop`; its complete answer was legitimately empty.
 * Usage recorded before reasoning tokens were stored has none. Returns the
 * two job ids.
 */
export function seedFirstLiveRunRefusals(native: Database): { truncated: number; complete: number } {
  native.prepare("INSERT INTO media_discovery_runs (id, pass, identity_key, selected_games, status, origin, started_at, finished_at, created_at) VALUES (8, 'initial', 'scheduled:2026-11-18', ?, 'completed', 'scheduled', '2026-11-18T06:00:00.000Z', '2026-11-18T06:20:00.000Z', '2026-11-18 06:00:00')")
    .run(JSON.stringify([CYBERPUNK, BALDURS_GATE, HADES_II]));
  const refused = (sourceId: number, generation: string, usage: { promptTokens: number; completionTokens: number }, charged: number) => {
    const identity = recordedIdentity({ live: "2026-11-18", sourceId });
    native.prepare("UPDATE media_sources SET processing_input_identity = ?, processing_run_id = 8 WHERE id = ?").run(identity, sourceId);
    const id = Number(native.prepare(
      `INSERT INTO media_processing_jobs (run_id, stage, appid, source_id, request_key, input_identity, model, config_version, max_input_tokens, max_output_tokens, reserved_microusd, charged_microusd, reservation_active, status, provider, enqueued_at, attempt_count, retained, cost_source, generation_id, routed_provider, routed_model, usage_json, error, submitted_at, completed_at)
       VALUES (8, 'extraction', ?, ?, ?, ?, 'anthropic/claude-haiku-5.5', 'media-extraction-2026-09-13-v3', 1500, 1200, 0, ?, 0, 'refused', 'openrouter', '2026-11-18T06:05:00.000Z', 0, 0, 'provider_reported', ?, 'Claude Platform on AWS', 'anthropic/claude-haiku-5.5', ?, 'invalid_output: no supported contributions', '2026-11-18T06:10:00.000Z', '2026-11-18T06:10:30.000Z')`,
    ).run(BALDURS_GATE, sourceId, `extraction:${sourceId}:run:8`, identity, charged, generation, JSON.stringify(usage)).lastInsertRowid);
    native.prepare("INSERT INTO media_processing_attempts (job_id, attempt, provider, input_identity, sent_at, outcome, generation_id, routed_provider, routed_model, usage_json, charged_microusd, cost_source, settled_at, error) VALUES (?, 1, 'openrouter', ?, '2026-11-18T06:10:00.000Z', 'refused', ?, 'Claude Platform on AWS', 'anthropic/claude-haiku-5.5', ?, ?, 'provider_reported', '2026-11-18T06:10:30.000Z', NULL)")
      .run(id, identity, generation, JSON.stringify(usage), charged);
    return id;
  };
  return {
    truncated: refused(1, "gen-live-a", { promptTokens: 3_081, completionTokens: 1_200 }, 900),
    complete: refused(3, "gen-live-b", { promptTokens: 642, completionTokens: 911 }, 500),
  };
}
