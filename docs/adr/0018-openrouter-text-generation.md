# Text generation through OpenRouter chat completions

**Status:** Accepted

Extends [ADR 0017](0017-provider-credit-pauses.md). Supersedes the text-generation model and transport of the media experiment ([#47](https://github.com/phenome/vaporstats/issues/47) "Models", [#51](https://github.com/phenome/vaporstats/issues/51) "Models, reuse, and replacement"), as decided in [#71](https://github.com/phenome/vaporstats/issues/71) and implemented in [#73](https://github.com/phenome/vaporstats/issues/73).

## Context

Article extraction and Overview synthesis ran on `gemini-3.1-flash-lite` through Gemini Batch: each item was submitted as a batch and its result arrived on a later poll. The project selected Claude Haiku 5.5 for text generation. It is reached through OpenRouter, where a batch submission flow is not used. Embeddings stay on Gemini, and existing vectors must stay comparable with new ones.

An ordinary chat completion is answered while the request is open. A request that reached the provider may be charged even when its answer is lost, and a restart can happen at any point of a request. OpenRouter documents no way to look up a request by a client key or to learn its generation id before the answer completes.

## Decision

**One chat completion per item.** Each extraction or synthesis is one `POST /api/v1/chat/completions` request for `anthropic/claude-haiku-5.5`, made with plain `fetch`, asking for JSON output with its output cap as `max_tokens`. The existing parsers validate every answer; output they reject is a definite refusal. Requests run inside the ingestion tick, within the per-tick bound on requests and a bound on elapsed time; items left at a bound keep their place for the next tick. Embeddings stay on `gemini-embedding-2` at 3,072 dimensions through Gemini Batch.

**Request lifecycle.** Before sending, the item is marked in flight, with its input identity and send time, in a committed write. No write transaction is open while a request is in flight. The answer is applied in one short transaction that records the result, `usage.cost` as provider-reported cost (one credit taken as US$1), token usage, the generation id, and the routed provider and model. A request whose outcome is unknown leaves its item **uncertain**: a client timeout, a connection lost after sending, or an item found in flight when an advance starts, since advances never overlap and so only a stopped process leaves one. An uncertain item is reported in the uncertain count and is never resent automatically; a correction set that covers it queues it again. A connection failure before the request was fully sent (DNS, connect, or TLS) is transient. An uncertain extraction does not hold back its game's Overview, which is built from the other current extractions.

**Input cap.** No OpenRouter token count exists for Anthropic models, so input is capped by a conservative local estimate: a request's UTF-8 message bytes divided by three, at most 60,000, well below the 100K-token prompt size up to which the documented price applies. Over the cap is a definite refusal, made before sending and recorded as `input_token_cap`. The cleaned article is never shortened to fit, so no extraction is made from part of an article.

**One OpenRouter classifier.** Every OpenRouter answer, including the key check, is classified in one place:

| Answer | Class |
|---|---|
| 402 with `limit_source` `openrouter_in_flight_budget` | Transient, honoring `Retry-After` |
| 402 or 403 with `openrouter_key_limit`; 402 with `openrouter_credits` or without a limit source; 403 with `openrouter_guardrail_budget` or `openrouter_workspace_budget` | Credit pause |
| 400; 403 with moderation metadata, or with an `error_type` for a content policy, a refusal, or moderation | Definite refusal |
| 403 with `error_type` `permission_denied` | Configuration pause `permission_denied` |
| Any other 403 without a budget limit source | Configuration pause `forbidden` |
| 408, 429, 5xx | Transient |
| 401 | Configuration pause `invalid_key` |
| 404 | Configuration pause `model_unavailable` |
| No answer after the request was sent | Uncertain |
| No key configured | Configuration pause `missing_key` |

OpenRouter answers 200 once a provider has accepted the request, and prompt processing may already be charged. A 200 whose body holds an `error` object, at the top level or on its first choice (which then ends with `finish_reason` `error`), is therefore classified by that error's code, the key check's included, except that a provider failure or timeout (408 or 5xx) after acceptance is uncertain and never resent automatically, as is a 200 whose body is not JSON or holds no choices. Whatever its class, the generation id, token usage and `usage.cost` an answer reports are recorded, and the cost of a retried item's later answer is added to it. OpenRouter uses the same 403 for a guardrail's content block and for a key that lacks permission, so a 403 refuses the item only when its metadata says the content was refused; a configuration problem never refuses an item, and the daily key check lifts its pause.

**Daily key check.** The daily credit check calls `GET /api/v1/key`. Credit remains when `limit_remaining` is null or above zero and no budget, `effective_budget` included, has `remaining_usd` at or below zero; text generation then resumes. Otherwise text generation is paused with the matching reason. A check without a usable answer keeps the current state. Each provider records the check time and its outcome. The account balance is not visible to an inference key, so a key without a limit on an empty balance pauses again at its next request.

**Cutover.** New text work goes only to OpenRouter. A migration moves text items that waited unsubmitted in the Gemini queue to OpenRouter, keeping their enqueue time. Gemini text batches already submitted are polled and applied, or rejected as stale, under the existing rules until none remain. A Gemini text batch that ends without running, because it expired, was cancelled or ran out of credit, returns its item to the queue as OpenRouter work for the text model, under that model's input identity, so its model, cost and Credit pause are OpenRouter's. Existing Gemini extractions and Overviews stay active; a model change queues no work, and an Overview may combine extractions made by different models.

## Consequences

- A lost answer costs at most one request and is visible in the uncertain count; resending it is a deliberate correction.
- Text results settle within the tick that sends them, so a game's extractions, Overview and embedding submission can all happen in one tick.
- The local estimate refuses some inputs a real count would accept, mainly long non-Latin articles; such articles are reported as `input_token_cap`.
- Cleanup used to cut an article's text at 120,000 characters. An article longer than that now has a different content hash, so a run that takes its source again extracts it from its whole text, or refuses it as `input_token_cap`.
- OpenRouter's key limit and budgets are the spending authority for text generation, as the Google project's billing is for embeddings.

## Amendment (2026-11-18): uncertain requests are resent, and unrecognized client errors pause

Decided in [#80](https://github.com/phenome/vaporstats/issues/80); see the amendment of the same date in [ADR 0017](0017-provider-credit-pauses.md).

- A request whose outcome is unknown is no longer held for a correction set. A client timeout, a connection lost after sending, an item found in flight when an advance starts, and a 200 that reports a provider failure or timeout, or holds no JSON or no choices, return the item to the queue under the transient backoff. It ends `uncertain_exhausted` at its third uncertain outcome for one input identity without a success, refusal or stale answer between them (a transient failure or a pause does not end the streak), or at its sixth uncertain outcome across all input identities; only a correction set resends it. Article text is never retained, so each resend of an extraction fetches its article again, counted against the outlet's daily cap.
- Each request is an attempt with its own generation id, routing, token usage and `usage.cost`. An item's cost is the sum of its attempts, and cost reports count each attempt in the month it settled in.
- An uncertain extraction now holds back its game's Overview like any waiting extraction, because it will be resent. The Overview is built once the resend settles, or from the other current extractions once the item ends `uncertain_exhausted`.
- In the classifier table, a 4xx other than 400, 401, 402, 403, 404, 408 and 429, sent or reported after acceptance, is a configuration pause `unrecognized_client_error`, lifted by the daily key check. It never refuses an item. The item that triggered it backs off like a transient failure, and its third such pause for one input identity ends it `client_error_exhausted`, resent only by a correction set.

## Amendment (2026-11-18): reasoning, output caps and cut-off answers

The first live run, on 2026-11-18, showed that Claude Haiku 5.5 reasons by default and that reasoning tokens count against the output cap. One extraction, capped at 1,200 output tokens, spent 1,078 of them reasoning; its answer ended at the cap (finish reason `length`, native `max_tokens`), was cut off mid-JSON, and the item was refused as invalid output. The caps (1,200 for an extraction, 3,200 for an Overview) had been sized for a model that does not reason.

- **Reasoning is set on every text request.** Each request carries OpenRouter's unified `reasoning` parameter as `{ "effort": "low" }`. OpenRouter accepts either an effort or a reasoning `max_tokens`, not both, and counts reasoning and visible output against the request's `max_tokens`. Claude Haiku 5.5 thinks adaptively and by default, at `medium` effort; it does not accept a fixed reasoning budget, and its effort levels run from `low` to `max`, so `low` is the smallest effort it supports. Extraction and synthesis are bounded tasks over supplied text, for which low effort suffices.
- **Each cap guards against a runaway answer; it is not an answer budget.** Cost follows the tokens actually produced, not the cap, so the caps are generous: 8,000 output tokens for an extraction and 16,000 for an Overview, reasoning and answer combined. The first correction sized each cap as a 2,000-token reasoning allowance plus the answer budget of the Gemini era (3,200 for an extraction, 5,200 for an Overview). The run that followed on 2026-11-18 showed those answer budgets too small for Claude Haiku 5.5: five extractions succeeded with no reasoning tokens at low effort, but one extraction needed 1,240 answer tokens, and a four-source Overview was cut off at 5,200 tokens, charged US$0.0032, and paused OpenRouter as `output_truncated`. An item queued under an earlier cap is sent with the current one and records it.
- **Reasoning tokens are recorded.** The stored usage records `usage.completion_tokens_details.reasoning_tokens` as `reasoningTokens` whenever the provider reports it.
- **A cut-off answer is a configuration pause, never a refusal.** In the classifier table, an answer whose finish reason is `length`, or whose native finish reason is `max_tokens`, is a configuration pause `output_truncated`: the cap is the project's configuration, not the item's fault. Its usage and cost are recorded. It is handled like an unrecognized client error: OpenRouter pauses until the daily key check, the item backs off like a transient failure, and the item's count of such pauses is shared with unrecognized client errors, so the third of either, mixed, for one input identity ends it `client_error_exhausted`.
- **Repair.** Migration 0028 returns every OpenRouter extraction refused as invalid output whose recorded completion tokens equal its cap to the Paid-work queue under the 3,200-token cap then current, with its attempts and cost kept, and is sent under the cap current when it is sent, so it is extracted once more without a correction set. A refusal whose answer ended below its cap was complete and stays refused.
