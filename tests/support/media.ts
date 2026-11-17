import type { Database } from "bun:sqlite";
import { runIngestionTick, type IngestionTickOptions } from "../../workers/ingestion";
import type { TestDatabase } from "./db";
import type { GeminiBatchPoll, GeminiBatchTransport } from "../../src/lib/media-processing";
import type { OpenRouterChatRequest, OpenRouterCompletion, OpenRouterTransport } from "../../src/lib/media-openrouter";
import { GeminiHttpError, OpenRouterHttpError } from "../../src/lib/media-paid-providers";
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
 * The trigger cannot authorize a later pass yet, so tests create its state directly.
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
 * Deterministic paid-provider transports for tests that advance processing
 * directly. Every paid answer comes from one ordered queue, `nextPolls`, in
 * the order requests are made: Gemini embedding batches take theirs when
 * submitted and report it when polled, and OpenRouter text requests, served
 * by the `openRouter` companion, take theirs at once. A `pending` answer
 * leaves an embedding batch pending, and makes a text request time out after
 * it was sent. A `failed` answer refuses the request, and an `http` answer
 * makes a text request fail with that status. Scripted usage is charged at
 * Claude Haiku 5.5's listed prices. Request keys of
 * accepted submissions are recorded in `submissions`: an embedding's own key,
 * or `<stage>:chat-<n>` for a text request. Embedding batches exist only with
 * `{ embeddings: true }` and are named `batches/embed-<n>`.
 */
/** One scripted paid answer: a Gemini batch result, or an HTTP error status for a text request. */
export type ControlledAnswer = GeminiBatchPoll | { state: "http"; status: number };

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
  /** The controlled OpenRouter transport for text requests, answered from `nextPolls`. */
  readonly openRouter: OpenRouterTransport;
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
        this.polls.set(name, answer);
        return { name };
      };
    }
    this.openRouter = {
      complete: (request) => this.complete(request),
      currentKey: async () => ({ limit: null, limit_remaining: null, budgets: [], effective_budget: null }),
    };
  }

  async countTokens(model: string, request: Record<string, unknown>): Promise<number> {
    this.counts.push(model + JSON.stringify(request).slice(0, 20));
    return 100;
  }

  private async complete(request: OpenRouterChatRequest): Promise<OpenRouterCompletion> {
    const stage = JSON.stringify(request.messages).includes("sourceUrl") ? "synthesis" : "extraction";
    this.requestBodies.push(request);
    this.chats += 1;
    const key = `${stage}:chat-${this.chats}`;
    await this.inspectDuringSubmit?.(key);
    if (this.throwSubmission) throw new Error("network dropped before the response");
    this.submissions.push(key);
    const result = this.nextPolls.shift() ?? { state: "pending" };
    if (result.state === "pending") throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    if (result.state === "failed") throw new OpenRouterHttpError(400);
    if (result.state === "http") throw new OpenRouterHttpError(result.status);
    return {
      generationId: `gen-${this.chats}`,
      model: request.model,
      provider: "Anthropic",
      content: typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null),
      // Usage, when scripted, is charged at Claude Haiku 5.5's listed US$0.10/M input and US$0.50/M output tokens.
      usage: {
        promptTokens: result.usage?.inputTokens ?? null,
        completionTokens: result.usage?.outputTokens ?? null,
        cost: result.usage ? ((result.usage.inputTokens ?? 0) * 0.1 + (result.usage.outputTokens ?? 0) * 0.5) / 1_000_000 : null,
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
  const complete = transport.openRouter.complete;
  transport.openRouter.complete = async (request) => {
    if (!matches(request.model, request as unknown as Record<string, unknown>)) return complete(request);
    counted += 1;
    throw new OpenRouterHttpError(refusal === "token count" ? 503 : 400);
  };
  return Object.assign(() => counted, {
    restore() {
      transport.countTokens = ControlledGeminiTransport.prototype.countTokens.bind(transport);
      transport.openRouter.complete = complete;
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
  options: { date?: string; author?: string; affiliation?: string; body?: string } = {},
): string {
  const body = options.body ?? `${GAME_NAMES[appid]} delivers a substantial playable campaign with detailed systems and memorable encounters. `.repeat(5);
  const affiliation = options.affiliation ? `<meta name="author_affiliation" content="${options.affiliation}">` : "";
  return `<!doctype html><html><head><meta property="og:title" content="${title}"><meta property="article:published_time" content="${options.date ?? "2025-01-01"}"><meta name="author" content="${options.author ?? "Reviewer"}">${affiliation}</head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
}

/**
 * Controlled Tavily and outlet fetch. Search returns one article per outlet
 * domain; `variants` overrides individual article URLs with a status, body
 * or redirect.
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
      const slug = `${appid}-${domain.replaceAll(".", "-")}`;
      return Response.json({ request_id: `search-${domain}`, usage: { credits_used: 1 }, results: [{ url: `https://${domain}/articles/${slug}` }] });
    }
    const variant = options.variants?.[url];
    if (variant?.redirect) return new Response(null, { status: variant.status ?? 302, headers: { location: variant.redirect } });
    if (variant?.body) return new Response(variant.body, { status: variant.status ?? 200 });
    const appid = url.includes(String(BALDURS_GATE)) ? BALDURS_GATE : url.includes(String(HADES_II)) ? HADES_II : CYBERPUNK;
    const outlet = MEDIA_OUTLETS.find((item) => url.includes(item.domain));
    return new Response(discoveryArticleHtml(appid, `${GAME_NAMES[appid]} Review${outlet ? ` - ${outlet.name}` : ""}`));
  };
  return { calls, fetchFn };
}

/** A processing-stage article page with navigation and advertising noise for cleanup. */
export function processingArticleHtml(appid: number): string {
  const name = GAME_NAMES[appid];
  return `<!doctype html><html><head><title>${name} Review</title><script>secret-not-content</script></head><body><nav>Navigation noise</nav><article><h1>${name} Review</h1><p>${name} has a focused campaign with flexible combat and memorable encounters.</p><h2>Qualifications</h2><p>This preview was played on PC during Early Access and does not assess the final release.</p><ul><li>Builds reward experimentation</li><li>Performance varies by platform</li></ul></article><aside class="advertisement">Advertisement noise</aside></body></html>`;
}

export function extractionOutput(trait = "build experimentation"): Record<string, unknown> {
  return { contributions: [{ text: "The combat supports flexible builds", category: "Gameplay & systems" }], traits: [trait], qualifications: ["Early Access", "PC preview"], provenance: [] };
}

export function overviewOutput(url: string): Record<string, unknown> {
  return {
    statements: [{ text: "The game presents a focused campaign with flexible combat, with the preview's Early Access and PC qualification retained.", sourceUrls: [url] }],
    tags: [{ label: "Build.Experimentation", sourceUrls: [url] }],
  };
}

export function overviewOutputForUrls(urls: readonly string[]): Record<string, unknown> {
  return {
    statements: [{ text: "The game presents a focused campaign with flexible combat.", sourceUrls: [...urls] }],
    tags: [{ label: "Build experimentation", sourceUrls: [...urls] }],
  };
}

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
      ? JSON.stringify({ ...overviewOutputForUrls([...new Set(JSON.stringify(body).match(/https:\/\/[^"\\]+\/articles\/[^"\\]+/g) ?? [])]), similarityInputs: { gameplay: ["Flexible combat builds"] } })
      : JSON.stringify(extractionOutput());
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
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { network: string; code?: string; name?: string }
  /** No answer until the client's request signal aborts it. */
  | { hang: true };

/** The OpenRouter request kinds the controlled API serves. */
export type OpenRouterCall = "chat" | "key";

/** One chat completion the controlled OpenRouter API received. */
export interface OpenRouterRequestRecord {
  /** `extraction` or `synthesis`, by whether the request cites article URLs. */
  stage: "extraction" | "synthesis";
  model: string;
  body: { model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown; max_tokens?: number };
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
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json", ...reply.headers } });
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
    const urls = [...new Set(JSON.stringify(body.messages).match(/https:\/\/[^"\\]+\/articles\/[^"\\]+/g) ?? [])];
    const record: OpenRouterRequestRecord = { stage: urls.length > 0 ? "synthesis" : "extraction", model: body.model, body, authorization, urls };
    requests.push(record);
    calls.push({ kind: "chat", stage: record.stage });
    await api.onChat?.(record);
    const reply = replies.chat.shift();
    if (reply) return answer(reply, init?.signal);
    const output = outputs[record.stage].shift()
      ?? (record.stage === "synthesis" ? { ...overviewOutputForUrls(urls), similarityInputs: { gameplay: ["Flexible combat builds"] } } : extractionOutput());
    return Response.json({
      id: `gen-${requests.length}`,
      object: "chat.completion",
      model: body.model,
      provider: "Anthropic",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof output === "string" ? output : JSON.stringify(output) } }],
      usage: OPENROUTER_USAGE,
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
    isOpenRouterRequest: (url: string) => url.startsWith("https://openrouter.ai/"),
  });
}

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
/** OpenRouter's reply to an invalid or disabled API key. */
export const OPENROUTER_INVALID_KEY: OpenRouterReply = { status: 401, body: { error: { code: 401, message: "No auth credentials found" } } };

type MediaTickApis = { gemini?: ReturnType<typeof controlledGeminiApi>; openRouter?: ReturnType<typeof controlledOpenRouterApi> };

/**
 * The tick's fetch: Gemini and OpenRouter requests go to their controlled
 * APIs, article pages are served for every outlet URL unless `outlet`
 * answers first, and anything else is unavailable.
 */
export function mediaTickFetch(apis: MediaTickApis, fetched: string[] = [], outlet?: (url: string) => Response | undefined): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (apis.gemini?.isGeminiRequest(url)) return apis.gemini.fetchFn(input, init);
    if (apis.openRouter?.isOpenRouterRequest(url)) return apis.openRouter.fetchFn(input, init);
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

/** Options of `runMediaTick`: tick options plus the outlets' controlled answers. */
export type MediaTickOptions = Partial<IngestionTickOptions> & { fetched?: string[]; outlet?: (url: string) => Response | undefined };

/**
 * Runs one ingestion tick at `at` with the controlled provider APIs and
 * outlets, and test keys for Gemini and OpenRouter. The tick's daily player
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
