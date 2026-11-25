import { OpenRouterHttpError, OpenRouterMissingKeyError } from "./media-paid-providers";

/**
 * OpenRouter's REST API, called with plain `fetch`: ordinary chat completions
 * (`POST /api/v1/chat/completions`) and the current-key endpoint
 * (`GET /api/v1/key`). The transport only carries requests and answers;
 * `classifyOpenRouterOutcome` and `classifyOpenRouterKeyCheck` decide what
 * every answer means.
 */
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/** How long one chat completion may take before its outcome becomes unknown. */
export const DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS = 120_000;

/**
 * OpenRouter's unified reasoning setting: an effort level, which OpenRouter
 * maps to the model's own. Reasoning tokens count against `max_tokens`.
 */
export interface OpenRouterReasoning {
  effort: "low" | "medium" | "high";
}

export type OpenRouterChatRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  reasoning: OpenRouterReasoning;
  /** The output cap, reasoning and answer combined. */
  max_tokens: number;
} & (
  | { response_format: { type: "json_object" }; provider?: never }
  | {
    response_format: {
      type: "json_schema";
      json_schema: { name: string; strict: true; schema: Record<string, unknown> };
    };
    provider: { require_parameters: true };
  }
);

/** The parts of a chat-completion answer that processing records. */
export interface OpenRouterCompletion {
  /** The generation id (`id`). */
  generationId: string | null;
  /** The model that served the request, as OpenRouter reports it. */
  model: string | null;
  /** The provider OpenRouter routed the request to. */
  provider: string | null;
  /** The first choice's message content, or null when it has none. */
  content: string | null;
  /** The first choice's normalized `finish_reason`, such as `stop` or `length`. */
  finishReason: string | null;
  /** The first choice's `native_finish_reason`, as the routed provider reported it, such as `max_tokens`. */
  nativeFinishReason: string | null;
  usage: {
    promptTokens: number | null;
    /** Reasoning and answer tokens combined. */
    completionTokens: number | null;
    /** `usage.completion_tokens_details.reasoning_tokens`: the part of `completionTokens` spent reasoning. */
    reasoningTokens: number | null;
    /** `usage.cost`: the amount charged, in credits. */
    cost: number | null;
  };
}

export interface OpenRouterTransport {
  /**
   * Sends one chat completion. Throws an `OpenRouterHttpError` for an error
   * answer, carrying whatever generation id and usage the answer reported.
   */
  complete(request: OpenRouterChatRequest): Promise<OpenRouterCompletion>;
  /** Returns the `data` object of `GET /api/v1/key`. */
  currentKey(): Promise<unknown>;
}

export type OpenRouterFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** The generation id, routing, content and usage an answer reports. */
function completionFrom(body: Record<string, unknown>): OpenRouterCompletion {
  const choice = object(Array.isArray(body.choices) ? body.choices[0] : null);
  const content = object(choice.message).content;
  const usage = object(body.usage);
  return {
    generationId: text(body.id),
    model: text(body.model),
    provider: text(body.provider),
    content: typeof content === "string" ? content : null,
    finishReason: text(choice.finish_reason),
    nativeFinishReason: text(choice.native_finish_reason),
    usage: {
      promptTokens: count(usage.prompt_tokens),
      completionTokens: count(usage.completion_tokens),
      reasoningTokens: count(object(usage.completion_tokens_details).reasoning_tokens),
      cost: count(usage.cost),
    },
  };
}

/**
 * The error answer of `response`: its HTTP error status, or for a 200 the
 * code of `failure`, the error the body reports. A 200 without such a code
 * keeps status 200: it was accepted and carries no answer.
 */
function errorFrom(response: Response, body: Record<string, unknown>, failure: unknown = body.error): OpenRouterHttpError {
  const error = object(failure);
  const code = typeof error.code === "number" && Number.isInteger(error.code) && error.code >= 400 ? error.code : null;
  const status = response.ok ? code ?? response.status : response.status;
  const metadata = object(error.metadata);
  return new OpenRouterHttpError(status, {
    limitSource: text(metadata.limit_source),
    errorType: text(metadata.error_type),
    // OpenRouter's moderation errors list why the input was flagged.
    moderated: Array.isArray(metadata.reasons) || metadata.flagged_input !== undefined,
    retryAfterMs: retryAfterMs(response),
    accepted: response.ok,
    answer: body.id !== undefined || body.usage !== undefined ? completionFrom(body) : null,
  });
}

/**
 * Reads a whole answer. A failure while reading propagates: the request was
 * sent, so its outcome is unknown. A body that is not a JSON object is null.
 */
async function answer(response: Response): Promise<Record<string, unknown> | null> {
  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The error a 200 reports instead of an answer: a top-level `error`, or one
 * on the first choice, which then ends with `finish_reason` `error`.
 * `undefined` when the body reports none.
 */
function acceptedFailure(body: Record<string, unknown>): unknown {
  if (body.error !== undefined) return body.error;
  const choice = object(Array.isArray(body.choices) ? body.choices[0] : null);
  if (choice.error !== undefined) return choice.error;
  return choice.finish_reason === "error" ? {} : undefined;
}

export function createOpenRouterTransport(
  apiKey: string | undefined,
  fetchFn: OpenRouterFetch = fetch,
  options: { timeoutMs?: number } = {},
): OpenRouterTransport {
  if (!apiKey || typeof apiKey !== "string") throw new OpenRouterMissingKeyError();
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS;
  const headers = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
  return {
    async complete(request) {
      const response = await fetchFn(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await answer(response);
      if (!response.ok) throw errorFrom(response, body ?? {});
      // OpenRouter sends a 200 once a provider accepted the request. The
      // provider can still fail after that, so a 200 may carry only an error,
      // or no answer at all.
      if (body === null) throw errorFrom(response, {}, null);
      const failure = acceptedFailure(body);
      if (failure !== undefined) throw errorFrom(response, body, failure);
      if (!Array.isArray(body.choices)) throw errorFrom(response, body, null);
      return completionFrom(body);
    },
    async currentKey() {
      const response = await fetchFn(`${OPENROUTER_API_BASE}/key`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const body = await answer(response);
      if (!response.ok || body?.error !== undefined) throw errorFrom(response, body ?? {});
      return body?.data ?? null;
    },
  };
}
