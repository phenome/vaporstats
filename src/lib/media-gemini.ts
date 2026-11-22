import { GeminiHttpError, GeminiMissingKeyError } from "./media-paid-providers";

export type GeminiRequest = Record<string, unknown>;
export type GeminiInlineRequest = { key: string; request: GeminiRequest };

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

export type GeminiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

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
  if (response.ok) return response.json();
  throw providerError(response, await response.json().catch(() => ({})));
}

export function createGeminiBatchTransport(apiKey: string, fetchFn: GeminiFetch = fetch): GeminiBatchTransport {
  if (!apiKey || typeof apiKey !== "string") throw new GeminiMissingKeyError();
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const request = async (url: string, init: RequestInit): Promise<unknown> => {
    const response = await fetchFn(url, {
      ...init,
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-goog-api-key": apiKey, ...(init.headers ?? {}) },
    });
    return responseJson(response);
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
      if (/FAIL|CANCEL|EXPIRE|ERROR/.test(stateValue)) {
        const message = jsonObject(root.error).message ?? root.error ?? stateValue;
        return { state: "failed", error: typeof message === "string" ? message : String(message), usage, batchState: stateValue };
      }
      if (!/SUCCEED|COMPLETE|DONE/.test(stateValue)) return { state: "pending" };
      const inlineError = inline.error ?? inlineResponse.error;
      if (inlineError) {
        const message = jsonObject(inlineError).message ?? inlineError;
        return { state: "failed", error: typeof message === "string" ? message : String(message), usage };
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
