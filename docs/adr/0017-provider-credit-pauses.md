# Provider-side spending authority and Credit pauses

**Status:** Accepted

Supersedes the paid-allowance parts of the governing media operating architecture ([#47](https://github.com/phenome/vaporstats/issues/47#issuecomment-5627349676), "Initial operating envelope" and "Trigger, state and failure boundaries"), the experiment specification ([#51](https://github.com/phenome/vaporstats/issues/51), "Search, source access, and budgets" and the pricing confirmation in "Testing Decisions"), and the [#66](https://github.com/phenome/vaporstats/issues/66) allowance decision, as decided in [#71](https://github.com/phenome/vaporstats/issues/71) and implemented in [#72](https://github.com/phenome/vaporstats/issues/72).

## Context

Paid media work (article extraction, Overview synthesis and embeddings) ran under a nonrenewing US$5 lifetime allowance. Every request first reserved a conservative upper bound, and work was refused once settled charges plus active reservations reached the allowance. A runtime pricing and capability confirmation also had to match before any paid work started. Once the allowance was used, useful work was refused permanently, and unattended ingestion could not continue.

## Decision

**The provider holds spending authority.** VaporStats keeps no internal budget. The spending limit is the credit or billing limit that the maintainer configures with each paid provider: the Google project's Prepay balance and spend cap for Gemini. No code path reserves, sums or compares spend before submitting. The pricing and capability confirmation is no longer a runtime gate; paid work needs only a configured provider key.

**Paid work waits in a durable queue.** The existing paid-job ledger becomes the **Paid-work queue** rather than a separate queue service. Each item carries its entity, stage, input identity, enqueue time, attempt count, next attempt time, provider and status. Article text is fetched only when an extraction item is submitted and is never stored, so waiting work holds no source text. Each tick, every active provider takes items in rounds: entities are ordered by the enqueue time of their oldest waiting item, then by entity, and each contributes its oldest ready item per round. Per-tick submission counts are bounded.

**One classifier per paid provider.** Every provider response is classified once into success, transient, Credit pause, definite refusal, uncertain, or missing configuration, and every submission and poll path acts on that class:

- A **Credit pause** (Gemini HTTP 402 for depleted Prepay credits, or a 429 that reports an exceeded spending cap) pauses the provider with its reason and time. Every queued item of that provider stays queued, with no attempt counted and no failure recorded. Other providers are unaffected. The pause lasts until the next daily credit check.
- A **transient** failure (network failure before the request was sent, timeout responses, 408, 5xx, 429 rate limits, or a batch the provider expired or cancelled without running it) keeps the item queued. It retries at the next tick, then with doubling backoff capped at 24 hours, never before `Retry-After`. It never becomes a failure.
- A **definite refusal** (an invalid request, output that fails validation, or input over the per-request cap) refuses the item for its input identity. Only a request that is itself unacceptable is refused; an error about the project is a configuration pause. Only an authorized correction set re-attempts it, and existing still-supported output stays active.
- An **uncertain** submission (sent, but without an answer) is never resubmitted blindly and is reported in the uncertain count.
- **Missing configuration** pauses the provider with reason `missing_key` while no key is configured, and fails nothing. A project-level error pauses the provider until the next daily credit check and also fails or refuses nothing: a rejected key (`rejected_key`: HTTP 401 or 403, or a 400 that reports an invalid or expired key), a failed project precondition such as billing that is not enabled (`failed_precondition`), or a model the provider no longer serves (`model_unavailable`: HTTP 404 on a token count or submission). A poll error about one batch, such as an unknown batch, leaves that item uncertain.

**A daily credit check resumes paused providers.** It runs in the first ingestion tick at or after 06:00 UTC on each UTC day, recorded by a durable checkpoint, so a restart neither repeats nor skips it and a missed earlier day is never made up. Google documents no endpoint that reports Prepay balance or spend-cap headroom, so the check lifts a Gemini pause and submits the oldest ready embedding item as a probe. Another Credit pause response pauses Gemini again until the next day.

**Cost is reported, never enforced.** Each settled item records its cost and its source. Gemini cost is returned token usage at the documented batch price, marked as estimated. Processing summaries and the tick log report month-to-date (UTC calendar month) and all-time cost per provider, labeled reporting-only, plus the uncertain count.

**Retired accounting is kept as history.** Existing paid-job rows keep their reserved amounts, reservation flags, settled charges and statuses. Retained uncertain jobs stay uncertain, and their reservations do not count as cost. Retained `reserved` rows wait in the queue like new items.

## Consequences

- Useful work is no longer refused for budget reasons. A depleted balance delays work until the maintainer adds credit, and the daily check finds it.
- Spend is bounded only by the provider-side limits, which the maintainer must keep configured. VaporStats reports cost so it can be compared with those limits.
- Corrections and later provider slices enter the same queue under the same Credit pauses; each new provider adds its own classifier and daily check.
