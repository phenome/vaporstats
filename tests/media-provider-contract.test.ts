import { describe, expect, test } from "bun:test";
import { createGeminiBatchTransport } from "../src/lib/media-gemini";
import { createOpenRouterTransport } from "../src/lib/media-openrouter";
import { createTavilyTransport } from "../src/lib/media-tavily";
import { classifyGeminiOutcome, classifyOpenRouterOutcome, GeminiBatchFailure, type ProviderOutcome } from "../src/lib/media-paid-providers";
import { createGeminiBatchTransport as processingGeminiTransport, OPENROUTER_TEXT_MODEL } from "../src/lib/media-processing";
import { GEMINI_EMBEDDING_MODEL } from "../src/lib/media-similarity";
import {
  controlledGeminiApi,
  controlledOpenRouterApi,
  GEMINI_SCOPED_FIXTURES,
  OPENROUTER_SCOPED_FIXTURES,
  OPENROUTER_TRUNCATED,
  PROVIDER_RESPONSE_SCOPES,
  type GeminiScopedFixture,
  type OpenRouterReply,
  type ProviderResponseScope,
  type ScopedProviderFixtures,
} from "./support/media";

// The paid-provider classifier contract: every response a provider gives is
// read by its real transport and classified by its one classifier, and the
// class must be one its response scope allows. A provider-wide problem never
// refuses an item, and a request that may have been charged is never resent.

type OutcomeClass = ProviderOutcome["class"];

const ALLOWED: Record<ProviderResponseScope, readonly OutcomeClass[]> = {
  provider_wide: ["credit_pause", "missing_configuration"],
  item_content: ["refusal"],
  pre_send_network: ["transient"],
  post_accept_charged: ["uncertain"],
  ended_unrun: ["transient", "uncertain"],
  post_send_timeout: ["uncertain"],
  provider_transient: ["transient"],
};

/** Scopes a provider may leave empty, because it has no such response. */
const NOT_APPLICABLE: Record<string, readonly ProviderResponseScope[]> = { openrouter: ["ended_unrun"] };

/**
 * Fixtures whose current class breaks the contract, with the reason. Each
 * is asserted with `test.failing`, so it reports once behavior changes.
 */
const KNOWN_VIOLATIONS: Record<string, string> = {};

async function geminiOutcome({ call, reply }: GeminiScopedFixture): Promise<ProviderOutcome> {
  const api = controlledGeminiApi();
  const transport = createGeminiBatchTransport("test-gemini-key", api.fetchFn);
  api.batch("batches/contract", "embedding");
  api.reply(call, reply);
  try {
    if (call === "count") await transport.countTokens(GEMINI_EMBEDDING_MODEL, { content: { parts: [{ text: "Contract" }] } });
    if (call === "submit") await transport.submitEmbeddingBatch!(GEMINI_EMBEDDING_MODEL, [{ key: "embedding:1:contract", request: {} }]);
    if (call === "poll") {
      const result = await transport.pollBatch("batches/contract");
      // As processing does: a batch that ended without output is a GeminiBatchFailure.
      if (result.state === "failed") return classifyGeminiOutcome("poll", new GeminiBatchFailure(result.error ?? "batch failed", result.batchState ?? null));
    }
    return classifyGeminiOutcome(call, null);
  } catch (error) {
    return classifyGeminiOutcome(call, error);
  }
}

async function openRouterOutcome(reply: OpenRouterReply): Promise<ProviderOutcome> {
  const api = controlledOpenRouterApi();
  const transport = createOpenRouterTransport("test-openrouter-key", api.fetchFn, { timeoutMs: 50 });
  api.reply("chat", reply);
  try {
    const answer = await transport.complete({ model: OPENROUTER_TEXT_MODEL, messages: [{ role: "user", content: "Contract" }], response_format: { type: "json_object" }, reasoning: { effort: "low" }, max_tokens: 100 });
    // As processing does: an answer is classified too, since it may have been cut off.
    return classifyOpenRouterOutcome(null, answer);
  } catch (error) {
    return classifyOpenRouterOutcome(error);
  }
}

const PROVIDERS = [
  { name: "gemini", fixtures: GEMINI_SCOPED_FIXTURES as ScopedProviderFixtures<unknown>, outcome: (fixture: unknown) => geminiOutcome(fixture as GeminiScopedFixture) },
  { name: "openrouter", fixtures: OPENROUTER_SCOPED_FIXTURES as ScopedProviderFixtures<unknown>, outcome: (fixture: unknown) => openRouterOutcome(fixture as OpenRouterReply) },
] as const;

describe("paid-provider classifier contract", () => {
  test("media processing re-exports the Gemini Batch transport", () => {
    expect(processingGeminiTransport).toBe(createGeminiBatchTransport);
  });

  test("every provider has fixtures for every response scope", () => {
    for (const { name, fixtures } of PROVIDERS) {
      for (const scope of PROVIDER_RESPONSE_SCOPES) {
        if (NOT_APPLICABLE[name]?.includes(scope)) expect(Object.keys(fixtures[scope])).toEqual([]);
        else expect(Object.keys(fixtures[scope]).length).toBeGreaterThan(0);
      }
    }
    // @ts-expect-error A provider's fixtures without a scope do not compile.
    const missing: ScopedProviderFixtures<OpenRouterReply> = { provider_wide: {}, item_content: {}, pre_send_network: {}, post_accept_charged: {}, ended_unrun: {}, post_send_timeout: {} };
    expect(missing).toBeDefined();
  });

  for (const { name, fixtures, outcome } of PROVIDERS) {
    for (const scope of PROVIDER_RESPONSE_SCOPES) {
      for (const [label, fixture] of Object.entries(fixtures[scope])) {
        const id = `${name} ${scope} ${label}`;
        const known = KNOWN_VIOLATIONS[id];
        const run = known ? test.failing : test;
        run(`${id} is ${ALLOWED[scope].join(" or ")}${known ? ` (known violation: ${known})` : ""}`, async () => {
          expect(ALLOWED[scope]).toContain((await outcome(fixture)).class);
        });
      }
    }
  }

  test("every known violation names a registered fixture", () => {
    const ids = PROVIDERS.flatMap(({ name, fixtures }) => PROVIDER_RESPONSE_SCOPES.flatMap((scope) => Object.keys(fixtures[scope]).map((label) => `${name} ${scope} ${label}`)));
    for (const id of Object.keys(KNOWN_VIOLATIONS)) expect(ids).toContain(id);
  });
});

// Decided in #80 (2026-11-18): a 4xx the provider's classifier does not
// recognize is a configuration problem on the project side. It pauses that
// provider with `unrecognized_client_error` until the next daily check, and
// never refuses an item.
describe("unrecognized 4xx answers pause the provider", () => {
  const paused: ProviderOutcome = { class: "missing_configuration", reason: "unrecognized_client_error" };
  for (const status of [405, 409, 410, 413, 422]) {
    test(`Gemini submit ${status} pauses Gemini and refuses nothing`, async () => {
      expect(await geminiOutcome({ call: "submit", reply: { status, body: { error: { code: status, message: "Unrecognized" } } } })).toEqual(paused);
    });
    test(`Gemini count ${status} pauses Gemini and refuses nothing`, async () => {
      expect(await geminiOutcome({ call: "count", reply: { status, body: { error: { code: status, message: "Unrecognized" } } } })).toEqual(paused);
    });
    test(`OpenRouter ${status} pauses OpenRouter and refuses nothing`, async () => {
      expect(await openRouterOutcome({ status, body: { error: { code: status, message: "Unrecognized" } } })).toEqual(paused);
    });
    test(`OpenRouter 200 accepted, then ${status}, pauses OpenRouter and refuses nothing`, async () => {
      expect(await openRouterOutcome({ status: 200, body: { error: { code: status, message: "Unrecognized" } } })).toEqual(paused);
    });
  }
});

// The first live run (2026-11-18): an answer cut off at the output cap is a
// configuration problem on the project side, never an item refusal. It pauses
// OpenRouter with `output_truncated`, like an unrecognized client error.
describe("an answer cut off at the output cap pauses OpenRouter", () => {
  const paused: ProviderOutcome = { class: "missing_configuration", reason: "output_truncated" };
  test("finish reason length pauses with output_truncated and refuses nothing", async () => {
    expect(await openRouterOutcome(OPENROUTER_TRUNCATED)).toEqual(paused);
  });
  test("native finish reason max_tokens pauses with output_truncated and refuses nothing", async () => {
    expect(await openRouterOutcome(OPENROUTER_SCOPED_FIXTURES.provider_wide["200 cut off at the output cap, reported only as the native finish reason"]!)).toEqual(paused);
  });
  test("a complete answer that ends with stop is a success", async () => {
    expect(await openRouterOutcome({ status: 200, body: { id: "gen-1", choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "end_turn", message: { role: "assistant", content: "{}" } }] } })).toEqual({ class: "success" });
  });
});

describe("Tavily response scopes", () => {
  const searchFixtures = {
    authorization: { statuses: [401, 403], progress: "queued", action: "break_run" },
    day_limit: { statuses: [429], progress: "stopped", action: "stop_searches" },
    unserved: { statuses: [302, 400, 402, 404, 422, 432, 500, 503], progress: "queued", action: "stop_searches" },
  } as const;

  for (const [scope, { statuses, progress, action }] of Object.entries(searchFixtures)) {
    for (const status of statuses) {
      test(`search ${scope} HTTP ${status} produces a Provider stop`, async () => {
        const transport = createTavilyTransport("test-key", async (url, init) => {
          expect(url).toBe("https://api.tavily.com/search");
          expect(init?.redirect).toBe("manual");
          return new Response(null, { status });
        });
        expect(await transport.search("a review", "ign.com")).toEqual({
          class: "provider_stop", reason: `tavily_search_http_${status}`, progress, action,
          attempt: { kind: "search", statusCode: status, succeeded: false, error: `HTTP ${status}` },
        });
      });
    }
  }

  test("search network failure produces a Provider stop and redacts the key", async () => {
    const transport = createTavilyTransport("test-key", async () => { throw new Error("Connection failed for test-key"); });
    expect(await transport.search("a review", "ign.com")).toEqual({
      class: "provider_stop", reason: "tavily_search_error", progress: "queued", action: "stop_searches",
      attempt: { kind: "search", statusCode: null, succeeded: false, error: "Connection failed for [redacted]" },
    });
  });

  test("a network error reading a successful search response leaves the query unserved", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("connection lost")); },
    }));
    const transport = createTavilyTransport("test-key", async () => response);
    expect(await transport.search("a review", "ign.com")).toEqual({
      class: "provider_stop", reason: "tavily_search_error", progress: "queued", action: "stop_searches",
      attempt: { kind: "search", statusCode: null, succeeded: false, error: "connection lost" },
    });
  });

  test("a served search returns its payload and successful attempt", async () => {
    const body = { results: [{ url: "https://ign.com/review" }], usage: { credits: 1 } };
    const transport = createTavilyTransport("test-key", async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ query: "a review", include_domains: ["ign.com"], include_usage: true });
      return Response.json(body);
    });
    expect(await transport.search("a review", "ign.com")).toEqual({
      class: "success", body, attempt: { kind: "search", statusCode: 200, succeeded: true, error: null },
    });
  });

  test("a valid empty search result is successful", async () => {
    const body = { results: [] };
    const transport = createTavilyTransport("test-key", async () => Response.json(body));
    expect(await transport.search("a review", "ign.com")).toEqual({
      class: "success", body, attempt: { kind: "search", statusCode: 200, succeeded: true, error: null },
    });
  });

  test("malformed usage JSON fails a successful response and preserves HTTP rejection handling", async () => {
    const usage = (status: number) => createTavilyTransport("test-key", async () => new Response("{", { status })).usage();
    expect(await usage(200)).toEqual({ stop: "tavily_usage_error", details: null });
    expect((await usage(432)).stop).toBe("tavily_account_not_free");
  });

  const freeUsage = { account: { current_plan: "free" }, plan_usage: 5, plan_limit: 100, paygo_usage: 0 };
  const usageFixtures = [
    { label: "valid free credit", body: freeUsage, status: 200, stop: null },
    { label: "rejected HTTP response", body: freeUsage, status: 432, stop: "tavily_free_credits_unavailable" },
    { label: "paid account", body: { ...freeUsage, account: { current_plan: "paid" } }, status: 200, stop: "tavily_account_not_free" },
    { label: "exhausted credit", body: { ...freeUsage, plan_usage: 100 }, status: 200, stop: "tavily_credits_exhausted" },
    { label: "missing free credit details", body: { account: { current_plan: "free" } }, status: 200, stop: "tavily_free_credits_unavailable" },
  ] as const;
  for (const { label, body, status, stop } of usageFixtures) {
    test(`usage classifies ${label}`, async () => {
      const transport = createTavilyTransport("test-key", async (url) => {
        expect(url).toBe("https://api.tavily.com/usage");
        return Response.json(body, { status });
      });
      expect((await transport.usage()).stop).toBe(stop);
    });
  }

  test("usage classifies a network failure and a missing key", async () => {
    const transport = createTavilyTransport("test-key", async () => { throw new Error("network failure"); });
    expect(await transport.usage()).toEqual({ stop: "tavily_usage_error", details: null });
    expect(await createTavilyTransport(undefined, async () => { throw new Error("unexpected request"); }).usage())
      .toEqual({ stop: "tavily_missing_key", details: null });
  });
});

test("Gemini rejects malformed successful JSON and preserves malformed HTTP error status", async () => {
  const transport = (status: number) => createGeminiBatchTransport("test-key", async () => new Response("{", { status }));
  await expect(transport(200).countTokens(GEMINI_EMBEDDING_MODEL, {})).rejects.toBeInstanceOf(SyntaxError);
  await expect(transport(200).submitEmbeddingBatch!(GEMINI_EMBEDDING_MODEL, [])).rejects.toBeInstanceOf(SyntaxError);
  await expect(transport(200).pollBatch("batches/test")).rejects.toBeInstanceOf(SyntaxError);
  await expect(transport(429).pollBatch("batches/test")).rejects.toMatchObject({ status: 429 });
});
