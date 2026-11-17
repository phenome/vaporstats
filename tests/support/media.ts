import type { Database } from "bun:sqlite";
import type { GeminiBatchPoll, GeminiBatchTransport } from "../../src/lib/media-processing";
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
 * Deterministic Gemini batch transport. Each submission takes the next queued
 * poll result (or stays pending). Generate batches are named
 * `batches/test-<n>`; embedding batches exist only with `{ embeddings: true }`
 * and are named `batches/embed-<n>`.
 */
export class ControlledGeminiTransport implements GeminiBatchTransport {
  readonly submissions: string[] = [];
  readonly embeddingSubmissions: string[] = [];
  readonly counts: string[] = [];
  readonly requestBodies: Record<string, unknown>[] = [];
  readonly polls = new Map<string, GeminiBatchPoll>();
  nextPolls: GeminiBatchPoll[] = [];
  throwSubmission = false;
  inspectDuringSubmit: ((requestKey: string) => void | Promise<void>) | undefined;
  beforePoll: ((name: string) => void | Promise<void>) | undefined;
  submitEmbeddingBatch?: (model: string, requests: readonly InlineRequest[]) => Promise<{ name: string }>;

  constructor(options: { embeddings?: boolean } = {}) {
    if (options.embeddings) {
      this.submitEmbeddingBatch = async (_model, requests) => {
        const request = requests[0]!;
        this.requestBodies.push(request.request);
        this.embeddingSubmissions.push(request.key);
        const name = `batches/embed-${this.embeddingSubmissions.length}`;
        this.polls.set(name, this.nextPolls.shift() ?? { state: "pending" });
        return { name };
      };
    }
  }

  async countTokens(model: string, request: Record<string, unknown>): Promise<number> {
    this.counts.push(model + JSON.stringify(request).slice(0, 20));
    return 100;
  }

  async submitBatch(_model: string, requests: readonly InlineRequest[]): Promise<{ name: string }> {
    const request = requests[0]!;
    this.requestBodies.push(request.request);
    await this.inspectDuringSubmit?.(request.key);
    if (this.throwSubmission) throw new Error("network dropped before batch acknowledgement");
    const name = `batches/test-${this.submissions.length + 1}`;
    this.submissions.push(request.key);
    this.polls.set(name, this.nextPolls.shift() ?? { state: "pending" });
    return { name };
  }

  async pollBatch(name: string): Promise<GeminiBatchPoll> {
    await this.beforePoll?.(name);
    return this.polls.get(name) ?? { state: "pending" };
  }
}

/** Ways a request's token count can stop it before submission. */
export const REFUSALS = ["token count", "token cap"] as const;
export type Refusal = (typeof REFUSALS)[number];
/** Refusals that are final for the run; a token count that throws is transient and retried. */
export const DEFINITE_REFUSALS = ["token cap"] as const satisfies readonly Refusal[];

/**
 * Makes `transport` stop every request that `matches` selects with
 * `refusal`: its token count fails, or exceeds every input cap. Returns how
 * many matching requests were counted.
 */
export function refuseRequests(
  transport: ControlledGeminiTransport,
  matches: (model: string, request: Record<string, unknown>) => boolean,
  refusal: Refusal,
): () => number {
  let counted = 0;
  transport.countTokens = async (model, request) => {
    if (!matches(model, request)) return ControlledGeminiTransport.prototype.countTokens.call(transport, model, request);
    counted += 1;
    if (refusal === "token count") throw new Error("token counting unavailable");
    return 1_000_000;
  };
  return () => counted;
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
