# Text generation through OpenRouter chat completions

**Status:** Accepted

Extends [ADR 0017](0017-provider-credit-pauses.md). Supersedes the text-generation model and transport of the media experiment ([#47](https://github.com/phenome/vaporstats/issues/47) "Models", [#51](https://github.com/phenome/vaporstats/issues/51) "Models, reuse, and replacement"), as decided in [#71](https://github.com/phenome/vaporstats/issues/71) and implemented in [#73](https://github.com/phenome/vaporstats/issues/73).

## Context

Article extraction and Overview synthesis ran on `gemini-3.1-flash-lite` through Gemini Batch: each item was submitted as a batch and its result arrived on a later poll. The project selected Claude Haiku 5.5 for text generation. It is reached through OpenRouter, where a batch submission flow is not used. Embeddings stay on Gemini, and existing vectors must stay comparable with new ones.

An ordinary chat completion is answered while the request is open. A request that reached the provider may be charged even when its answer is lost, and a restart can happen at any point of a request. OpenRouter documents no way to look up a request by a client key or to learn its generation id before the answer completes.

## Decision

**One chat completion per item.** Each extraction or synthesis is one `POST /api/v1/chat/completions` request for `anthropic/claude-haiku-5.5`, made with plain `fetch`, asking for JSON output with its output cap as `max_tokens`. The existing parsers validate every answer; output they reject is a definite refusal. Requests run inside the ingestion tick, within the per-tick bound on requests and a bound on elapsed time; items left at a bound keep their place for the next tick. Embeddings stay on `gemini-embedding-2` at 3,072 dimensions through Gemini Batch.

**Request lifecycle.** Before sending, the item is marked in flight, with its input identity and send time, in a committed write. No write transaction is open while a request is in flight. The answer is applied in one short transaction that records the result, `usage.cost` as provider-reported cost (one credit taken as US$1), token usage, the generation id, and the routed provider and model. A request whose outcome is unknown leaves its item **uncertain**: a client timeout, a connection lost after sending, or an item found in flight when an advance starts, since advances never overlap and so only a stopped process leaves one. An uncertain item is reported in the uncertain count and is never resent automatically; a correction set that covers it queues it again. A connection failure before the request was fully sent (DNS, connect, or TLS) is transient. An uncertain extraction does not hold back its game's Overview, which is built from the other current extractions.

**Input cap.** No OpenRouter token count exists for Anthropic models, so input is capped by a conservative local estimate: a request's UTF-8 message bytes divided by three, at most 60,000, well below the 100K-token prompt size up to which the documented price applies. Over the cap is a definite refusal, made before sending.

**One OpenRouter classifier.** Every OpenRouter answer, including the key check, is classified in one place:

| Answer | Class |
|---|---|
| 402 with `limit_source` `openrouter_in_flight_budget` | Transient, honoring `Retry-After` |
| 402 or 403 with `openrouter_key_limit`; 402 with `openrouter_credits` or without a limit source; 403 with `openrouter_guardrail_budget` or `openrouter_workspace_budget` | Credit pause |
| 400; 403 without a budget limit source (moderation or a guardrail's content block) | Definite refusal |
| 408, 429, 5xx | Transient |
| 401 | Configuration pause `invalid_key` |
| 404 | Configuration pause `model_unavailable` |
| No answer after the request was sent | Uncertain |
| No key configured | Configuration pause `missing_key` |

A 200 whose body holds only an `error` object is classified by that error's code.

**Daily key check.** The daily credit check calls `GET /api/v1/key`. Credit remains when `limit_remaining` is null or above zero and no budget, `effective_budget` included, has `remaining_usd` at or below zero; text generation then resumes. Otherwise text generation is paused with the matching reason. A check without a usable answer keeps the current state. Each provider records the check time and its outcome. The account balance is not visible to an inference key, so a key without a limit on an empty balance pauses again at its next request.

**Cutover.** New text work goes only to OpenRouter. A migration moves text items that waited unsubmitted in the Gemini queue to OpenRouter, keeping their enqueue time. Gemini text batches already submitted are polled and applied, or rejected as stale, under the existing rules until none remain. Existing Gemini extractions and Overviews stay active; a model change queues no work, and an Overview may combine extractions made by different models.

## Consequences

- A lost answer costs at most one request and is visible in the uncertain count; resending it is a deliberate correction.
- Text results settle within the tick that sends them, so a game's extractions, Overview and embedding submission can all happen in one tick.
- The local estimate refuses some inputs a real count would accept, mainly long non-Latin articles; such articles are reported as `input_token_cap`.
- OpenRouter's key limit and budgets are the spending authority for text generation, as the Google project's billing is for embeddings.
