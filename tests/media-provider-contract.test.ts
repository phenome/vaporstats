import { describe, expect, test } from "bun:test";
import { createOpenRouterTransport } from "../src/lib/media-openrouter";
import { classifyGeminiOutcome, classifyOpenRouterOutcome, GeminiBatchFailure, type ProviderOutcome } from "../src/lib/media-paid-providers";
import { createGeminiBatchTransport, OPENROUTER_TEXT_MODEL } from "../src/lib/media-processing";
import { GEMINI_EMBEDDING_MODEL } from "../src/lib/media-similarity";
import {
  controlledGeminiApi,
  controlledOpenRouterApi,
  GEMINI_SCOPED_FIXTURES,
  OPENROUTER_SCOPED_FIXTURES,
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
    await transport.complete({ model: OPENROUTER_TEXT_MODEL, messages: [{ role: "user", content: "Contract" }], response_format: { type: "json_object" }, max_tokens: 100 });
    return classifyOpenRouterOutcome(null);
  } catch (error) {
    return classifyOpenRouterOutcome(error);
  }
}

const PROVIDERS = [
  { name: "gemini", fixtures: GEMINI_SCOPED_FIXTURES as ScopedProviderFixtures<unknown>, outcome: (fixture: unknown) => geminiOutcome(fixture as GeminiScopedFixture) },
  { name: "openrouter", fixtures: OPENROUTER_SCOPED_FIXTURES as ScopedProviderFixtures<unknown>, outcome: (fixture: unknown) => openRouterOutcome(fixture as OpenRouterReply) },
] as const;

describe("paid-provider classifier contract", () => {
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
