# Media change probes

Recurring checks for any change to media discovery, the paid-work queue, provider classification or automatic media ingestion. Implementer and reviewer briefs point here. Run each probe that the change can affect before review; a probe without a passing test is unfinished work.

Every helper named below lives in [`tests/support/media.ts`](../../tests/support/media.ts). Run single test files with `bun test <file>`.

## 1. Send-once across restarts

A restart can happen between any outbound call and the write that records its outcome. No request identity (a search, a discovery or processing fetch, an OpenRouter request, a Gemini submission) is ever sent twice, in an uninterrupted run or an interrupted one. The one exception is the exported constant `PROCESSING_FETCH_RESENT_AFTER_RESTART` (ADR 0020): a processing fetch interrupted before its item was marked in flight is sent again, at most once per restart that interrupted it. A request answered with HTTP 429 by an injected day stop never reached its outlet and is not counted as sent.

- Covered by `sweepInterruptions(scenario, { restarts })` in [`tests/media-interruptions.test.ts`](../../tests/media-interruptions.test.ts). It restarts after the k-th swept call of each kind, for every k (or `sample` evenly spaced k), then ticks until quiescent.
- Every run of every scenario, whatever its faults, is checked for every invariant of probes 1 and 2.
- A scenario's `before` ticks run once into a template database that every run copies, so they are never interrupted; they must be ticks another registered scenario sweeps, which the test asserts.
- A change that adds an outbound call, or a new stage or pass that sends one, registers a scenario in `SCENARIOS` that reaches it, with the expected baseline call counts.
- A new kind of outbound call extends `OUTBOUND_KINDS` and the sweep's call classifier, rather than adding a test outside the sweep.

## 2. Resume invariants

A query or run resumed after a restart or an Outlet day stop keeps every per-query and per-day rule: one accepted article per entity and query, at most 30 attempts per outlet per UTC day (every pass, stage and run counts), and every day-stopped query reopens on a later day while processing fetches continue.

- Covered by `sweepInterruptions(scenario, { dayStops, combined })`. `dayStops` answers the k-th swept outlet fetch with HTTP 429 and resumes over the scenario's following `days`; `combined` adds runs that also restart after the next day's first outlet fetch and first search. `experimentWorld` returns three candidates per query, so a candidate that would qualify remains after a stop.
- The "near IGN's daily attempt cap" scenario seeds 25 of IGN's 30 attempts on the swept day, so the cap engages under restarts and day stops; it asserts that the recorded peak is exactly 30.
- `tests/media-enablement.test.ts` covers the resume of production's capped Hades II queries, which had already admitted an article: they resume without a new search and admit no second article.
- A change to how a query, pass or run resumes registers the resume path as a scenario. Assert the invariant on the resumed path, not only on a fresh run.

## 3. Classifier scopes

Each paid provider classifies every response in one classifier (CODING_STANDARDS.md, "Classify each external-response class in one place"). The class must fit the response's scope:

| Scope | Allowed classes |
|---|---|
| `provider_wide` | Credit pause, configuration pause; never a refusal |
| `item_content` | Definite refusal |
| `pre_send_network` | Transient |
| `post_accept_charged` | Uncertain: accepted and possibly charged, so never resent |
| `ended_unrun` | Transient or uncertain: a batch the provider ended without running it, or a failed free poll |
| `post_send_timeout` | Uncertain |
| `provider_transient` | Transient: a rate limit, an in-flight budget, a timeout response or a server error; never a refusal or a pause |

- Covered by [`tests/media-provider-contract.test.ts`](../../tests/media-provider-contract.test.ts) over `GEMINI_SCOPED_FIXTURES` and `OPENROUTER_SCOPED_FIXTURES`. Their type, `ScopedProviderFixtures`, does not compile when a scope is missing.
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
- Open gaps currently recorded in tests:
  - A Gemini batch that the provider accepted and then ended as `BATCH_STATE_FAILED` with a generic error is a definite refusal, while CONTEXT.md defines an item that its provider accepted and then failed as uncertain (`KNOWN_VIOLATIONS`, tracked in #80).
  - An unrecognized 4xx (such as 405, 409, 410, 413 or 422) is a definite refusal for both paid providers. This is an open decision tracked in #80; the contract test's "unrecognized 4xx answers" suite pins the current behavior so that #80 changes it deliberately, and does not endorse it.
