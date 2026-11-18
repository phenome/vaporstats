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
  post_accept: ["uncertain", "transient"],
  post_send_timeout: ["uncertain"],
};

/**
 * Fixtures whose current class breaks the contract, with the reason. Each
 * is asserted with `test.failing`, so it reports once behavior changes.
 */
const KNOWN_VIOLATIONS: Record<string, string> = {
  "gemini post_accept poll batch failed":
    "A batch Gemini accepted and then ended as BATCH_STATE_FAILED with a generic error is classified as a definite refusal (`batch_failed`), while CONTEXT.md defines an item whose provider accepted it and then failed as uncertain. Needs a spec decision before the classifier changes.",
};

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
    for (const { fixtures } of PROVIDERS) {
      for (const scope of PROVIDER_RESPONSE_SCOPES) expect(Object.keys(fixtures[scope]).length).toBeGreaterThan(0);
    }
    // @ts-expect-error A provider's fixtures without a scope do not compile.
    const missing: ScopedProviderFixtures<OpenRouterReply> = { provider_wide: {}, item_content: {}, pre_send_network: {}, post_accept: {} };
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

// An unrecognized 4xx carries no scope: nothing says whether it concerns the
// item or the provider. Both classifiers currently refuse the item for it,
// which a policy change (pausing instead) would need a spec decision for.
describe("unrecognized 4xx answers (current behavior, pending a spec decision)", () => {
  for (const status of [405, 409, 410, 413, 422]) {
    test(`Gemini submit ${status} is a refusal`, async () => {
      expect(await geminiOutcome({ call: "submit", reply: { status, body: { error: { code: status, message: "Unrecognized" } } } })).toEqual({ class: "refusal", reason: `http_${status}` });
    });
    test(`OpenRouter ${status} is a refusal`, async () => {
      expect(await openRouterOutcome({ status, body: { error: { code: status, message: "Unrecognized" } } })).toEqual({ class: "refusal", reason: `http_${status}` });
    });
  }
});
