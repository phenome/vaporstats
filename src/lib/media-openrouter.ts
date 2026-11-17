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

export interface OpenRouterChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  response_format: { type: "json_object" };
  max_tokens: number;
}

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
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    /** `usage.cost`: the amount charged, in credits. */
    cost: number | null;
  };
}

export interface OpenRouterTransport {
  /** Sends one chat completion. Throws an `OpenRouterHttpError` for an error answer. */
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

function errorFrom(response: Response, body: Record<string, unknown>): OpenRouterHttpError {
  const error = object(body.error);
  const code = typeof error.code === "number" && Number.isInteger(error.code) && error.code >= 400 ? error.code : null;
  const status = response.ok ? code ?? 502 : response.status;
  const metadata = object(error.metadata);
  return new OpenRouterHttpError(status, {
    limitSource: text(metadata.limit_source),
    errorType: text(metadata.error_type),
    // OpenRouter's moderation errors list why the input was flagged.
    moderated: Array.isArray(metadata.reasons) || metadata.flagged_input !== undefined,
    retryAfterMs: retryAfterMs(response),
  });
}

/**
 * Reads a whole answer. A failure while reading propagates: the request was
 * sent, so its outcome is unknown. A body that is not JSON is read as empty.
 */
async function answer(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  try { return object(JSON.parse(body)); } catch { return {}; }
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
      // A 200 can still carry only an error, when the provider failed after
      // OpenRouter sent its headers.
      if (!response.ok || (body.error !== undefined && body.choices === undefined)) throw errorFrom(response, body);
      const choice = object(Array.isArray(body.choices) ? body.choices[0] : null);
      const usage = object(body.usage);
      return {
        generationId: text(body.id),
        model: text(body.model),
        provider: text(body.provider),
        content: typeof object(choice.message).content === "string" ? object(choice.message).content as string : null,
        usage: { promptTokens: count(usage.prompt_tokens), completionTokens: count(usage.completion_tokens), cost: count(usage.cost) },
      };
    },
    async currentKey() {
      const response = await fetchFn(`${OPENROUTER_API_BASE}/key`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const body = await answer(response);
      if (!response.ok) throw errorFrom(response, body);
      return body.data ?? null;
    },
  };
}
