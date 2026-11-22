# Media change probes

Recurring checks for any change to media discovery, the paid-work queue, provider classification or automatic media ingestion. Implementer and reviewer briefs point here. Run each probe that the change can affect before review; a probe without a passing test is unfinished work.

Every helper named below lives in [`tests/support/media.ts`](../../tests/support/media.ts). Run single test files with `bun test <file>`.

## 1. Send-once across restarts

A restart can happen between any outbound call and the write that records its outcome. No request identity (a search, a discovery or processing fetch, an OpenRouter request, a Gemini submission) is ever sent twice, in an uninterrupted run or an interrupted one, except under three exported constants:

- `PROCESSING_FETCH_RESENT_AFTER_RESTART` (ADR 0020): a processing fetch interrupted before its item was marked in flight is sent again, at most once per restart that interrupted it.
- `UNCERTAIN_PAID_RESEND` (#80, ADRs 0017 and 0018, amended 2026-11-18): a paid request whose outcome is unknown, such as one a restart interrupted, is resent under the queue's backoff, so one OpenRouter request or Gemini submission identity is sent at most three times, never more. Each resend of an uncertain extraction fetches its article once more.
- `THROWING_ITEM_RETRY` (2026-11-18): a waiting item whose handling threw an unexpected exception backs off and is taken again, so the processing fetch of its article is sent at most three times in all; the third occurrence ends it `client_error_exhausted`.

Two further send-again cases are bounded outside the sweep, because the sweep's world never answers with them. Each sends one OpenRouter request identity, and for an extraction fetches its article, at most three times:

- A cut-off answer (finish reason `length` or `max_tokens`) pauses OpenRouter and backs its item off; the item is sent again after the pause lifts, and its third cut-off answer ends it `client_error_exhausted`. Covered by "an answer cut off at the output cap" in [`tests/media-paid-work.test.ts`](../../tests/media-paid-work.test.ts).
- An unrecognized client error pauses its provider and backs its item off; the item is sent again after the pause lifts, and its third such pause ends it `client_error_exhausted`. Cut-off answers and unrecognized client errors share one count. Covered by "an unrecognized client error tied to one item" in the same file.

A request answered with HTTP 429 by an injected day stop never reached its outlet and is not counted as sent.

- Covered by `sweepInterruptions(scenario, { restarts })` in [`tests/media-interruptions.test.ts`](../../tests/media-interruptions.test.ts). It restarts after the k-th swept call of each kind, for every k (or `sample` evenly spaced k), then ticks until quiescent.
- Every run of every scenario, whatever its faults, is checked for every invariant of probes 1 and 2. Every accepted article must end extracted, unless its extraction ended `uncertain_exhausted`, or `client_error_exhausted` after its handling threw three times.
- A scenario that restarts during paid requests must show resends under `UNCERTAIN_PAID_RESEND`, so the sweep observes them at all.
- The "an extraction whose answer is always lost" scenario resends one extraction until it ends `uncertain_exhausted`, so the three-send limit itself is swept: a fourth send of that identity is a violation.
- A scenario's `before` ticks run once into a template database that every run copies, so they are never interrupted; they must be ticks another registered scenario sweeps, which the test asserts.
- A change that adds an outbound call, or a new stage or pass that sends one, registers a scenario in `SCENARIOS` that reaches it, with the expected baseline call counts.
- A new kind of outbound call extends `OUTBOUND_KINDS` and the sweep's call classifier, rather than adding a test outside the sweep.
- Every tick of every run that no restart stopped must complete with no media error. The "an extraction whose handling always throws" scenario sweeps an item whose handling throws at every processing fetch (probe 7).

## 2. Resume invariants

A query or run resumed after a restart or an Outlet day stop keeps every per-query and per-day rule: one accepted article per entity and query, at most 30 attempts per outlet per UTC day (every pass, stage and run counts), and every day-stopped query reopens on a later day while processing fetches continue.

- Covered by `sweepInterruptions(scenario, { dayStops, combined })`. `dayStops` answers the k-th swept outlet fetch with HTTP 429 and resumes over the scenario's following `days`; `combined` adds runs that also restart after the next day's first outlet fetch and first search. `experimentWorld` returns three candidates per query, so a candidate that would qualify remains after a stop.
- The "near IGN's daily attempt cap" scenario seeds 25 of IGN's 30 attempts on the swept day, so the cap engages under restarts and day stops; it asserts that the recorded peak is exactly 30.
- `tests/media-enablement.test.ts` covers the resume of production's capped Hades II queries, which had already admitted an article: they resume without a new search and admit no second article.
- A change to how a query, pass or run resumes registers the resume path as a scenario. Assert the invariant on the resumed path, not only on a fresh run.

## 3. Classifier scopes

Each external response class has one classifier (CODING_STANDARDS.md, "Classify each external-response class in one place"). The class must fit the response's scope:

| Scope | Allowed classes |
|---|---|
| `provider_wide` | Credit pause, configuration pause (an unrecognized 4xx and an answer cut off at the output cap included); never a refusal |
| `item_content` | Definite refusal |
| `pre_send_network` | Transient |
| `post_accept_charged` | Uncertain: accepted and possibly charged, so resent at most three consecutive times |
| `ended_unrun` | Transient or uncertain: a batch the provider ended without running it, or a failed free poll |
| `post_send_timeout` | Uncertain |
| `provider_transient` | Transient: a rate limit, an in-flight budget, a timeout response or a server error; never a refusal or a pause |

- Covered by [`tests/media-provider-contract.test.ts`](../../tests/media-provider-contract.test.ts) over `GEMINI_SCOPED_FIXTURES` and `OPENROUTER_SCOPED_FIXTURES`. Their type, `ScopedProviderFixtures`, does not compile when a scope is missing.
- Tavily's `/usage` and `/search` scopes are covered in the same contract test. Every non-2xx search response and network failure produces a Provider stop. [Shared limits](../../tests/media-shared-limits.test.ts) verifies the query stays due and the attempt leaves the Outlet's daily allowance intact.
- [Outlet article response scopes](../../tests/media-outlet-contract.test.ts) cover denials, day stops, same-Outlet redirects, the redirect limit, and throwing responses through `fetchOutletArticle`. The [static guard](../../tests/media-boundaries.test.ts) checks production callers for bypasses of Outlet access and Tavily classification.
- A new response class or status code adds a fixture under its scope. A new provider exports its own scoped fixtures and joins `PROVIDERS` in the contract test.
- A fixture that breaks the contract is listed in `KNOWN_VIOLATIONS` with its reason and needs a spec decision; do not change its class in an unrelated change.

## 4. Switch off and on from the production-like state

Production holds state that fresh test databases do not: retained Gemini jobs, Outlet denials, day-capped queries from earlier months, processed and discovered-only sources, and no enrollments.

- `seedProductionLike(native)` reproduces the production media state of 2026-11-18. [`tests/media-enablement.test.ts`](../../tests/media-enablement.test.ts) asserts that three days with the switch off make no provider call and change no media row, and lists the searches, queued items and Overviews of days 1–3 with the switch on.
- A change to discovery, queueing, enrollment or the daily media run updates the expected days in that test and states in its comment why each day changed. A change that alters production state moves `seedProductionLike` forward and records the new date.

## 5. Scope of deletions

Retiring a feature removes its entry forms and keeps the boundary they ran through (CODING_STANDARDS.md, "Retiring a feature keeps its boundary"). Deleting a file, route, workflow or module is in scope only when the ticket names it, and never while an open ticket builds on it.

- Check: `git diff --stat --diff-filter=D <base>` lists every deleted file. Each one is named by the ticket, and no open ticket builds on it.
- A reviewer reports any other deletion as a defect.

## 6. Spec gaps

A rule the specification does not settle is a gap, not a design choice (CODING_STANDARDS.md, "Narrowing a requirement is a defect").

- Put the choice behind one named function or constant, and list it first in the change description.
- Record a known mismatch between code and specification as a known failure (`test.failing`, `knownFailure`, or `KNOWN_VIOLATIONS`) with its reason, rather than asserting the current behavior as correct.
- Open gaps currently recorded in tests: none. #80 settled the two earlier ones on 2026-11-18: a Gemini batch that failed after acceptance is uncertain, and an unrecognized 4xx pauses its provider with `unrecognized_client_error`.
- Open gap, not recorded in tests (2026-11-18): the usable-article threshold. An article is usable when its cleaned text has at least 120 characters (`MIN_USABLE_ARTICLE_CHARS` alongside `parseArticleDocument` in [article-document.ts](../../src/lib/article-document.ts), shared by discovery and processing). The first live run sent an article whose text was a few hundred tokens of mostly non-review content (job B, a 642-token prompt), and its complete answer was legitimately empty. Refusing such an article before sending would need a substantially higher bound or a different measure of a usable review, which the specification does not settle. The shared threshold preserves the current 120-character bound.

## 7. Exceptions stay at their item and at the media boundary

On 2026-11-18 an article with no root element made every ingestion tick throw before it recorded anything: the item looped silently, the queue behind it never moved, and the tick's later non-media work never ran. An unexpected exception must stay where it happened:

- Fetched content no parser can turn into a document (an empty or whitespace body, plain text, JSON, a lone comment, binary content) is an unusable article, in discovery and in processing alike. Every parse of fetched HTML goes through `parseArticleDocument`. Covered by `MALFORMED_ARTICLE_BODIES` in [`tests/media-tick-isolation.test.ts`](../../tests/media-tick-isolation.test.ts).
- An exception while one paid-work item is taken or polled, or one discovery candidate is handled, is caught at that item's boundary: it is recorded with a bounded reason, the outlet attempt ends with an outcome, and the advance's other items progress. A waiting item backs off and its third occurrence ends it `client_error_exhausted`; an item in flight or submitted becomes uncertain; a candidate is skipped. Covered by `throwingResponse` in the same test file and by the "an extraction whose handling always throws" sweep scenario.
- An exception that reaches the media part of a tick is logged as a `media_error` and the tick completes, with every non-media part reported. Covered in the same test file.
- A change that adds an item or candidate loop, or a stage of the media part, wraps it at the same boundaries and extends these tests.
