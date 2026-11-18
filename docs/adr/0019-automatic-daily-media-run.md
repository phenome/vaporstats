# Automatic daily media run behind one server switch

**Status:** Accepted

Extends [ADR 0017](0017-provider-credit-pauses.md) and [ADR 0018](0018-openrouter-text-generation.md). Supersedes the manual trigger of the governing media operating architecture ([#47](https://github.com/phenome/vaporstats/issues/47#issuecomment-5627349676), "Initial operating envelope" and "Trigger, state and failure boundaries") and of the experiment specification ([#51](https://github.com/phenome/vaporstats/issues/51), "Runtime, trigger, and persistence"), as decided in [#71](https://github.com/phenome/vaporstats/issues/71) and implemented in [#74](https://github.com/phenome/vaporstats/issues/74).

## Context

Media discovery ran only when a maintainer dispatched the media workflow, which reached the server through the restricted remote command as `media initial <game>`. Each dispatch authorized one discovery run, and each run's paid processing needed its own authorization record. The server could only finish authorized runs. Automatic operation needs discovery to start on a schedule and accepted articles to reach the paid-work queue with no per-run authorization, while production must not start automatic searches or paid work before the maintainer activates it.

## Decision

**One switch, off by default.** The server setting `MEDIA_AUTOMATIC_INGESTION` enables automatic media ingestion only when it is exactly `true`. While it is off, the ingestion tick makes no daily media run, no search, no credit check, no new queue item and no paid submission; it still polls work already submitted to a provider, such as Gemini batches, and applies their results under the stale-write rules. Queued work, due passes and recorded state are kept, so turning the switch on resumes them.

**The daily media run shares the daily credit check's checkpoint.** It happens in the first ingestion tick at or after 06:00 UTC on a UTC day with no recorded check. In order, it records the enrollment start date (once, in the `checkpoints` table, never in a migration) and the enrollments of the experiment games, runs the daily provider credit checks, and starts one scheduled discovery run. The checkpoint and the run are written in one transaction, so a restart neither repeats nor skips the day, and a missed earlier day is never made up. A scheduled discovery run is a discovery run with `origin` `scheduled`, identified by its UTC day; any discovery run still open from an earlier day is closed as superseded, and its unserved queries stay due. Later ticks on the same UTC day resume an interrupted scheduled run but never start searches of their own.

**Regular work needs no authorization.** Accepted sources of enrolled entities that are new to processing enter the paid-work queue in the tick, attributed to the latest scheduled discovery run. An entity's Overview is queued when its current contributions differ from its active Overview's, and its embeddings when its Overview's similarity inputs change. Work that already has a queue item, whatever its outcome, is never queued again automatically: a refused, failed, stale or uncertain item is re-attempted only through a correction set, which remains the only use of processing-authorization records.

**No manual trigger remains; its boundary does.** The media dispatch workflow, the restricted remote command and the server's loopback endpoint keep their validation: the workflow's fixed choices, the remote command's exact forms, and the server's loopback peer, bearer token, JSON content type, 4 KiB body limit and exact keys. None of them supports a media form. Each rejects the retired `media initial` and `media later` forms as retired on its own, the workflow before any SSH connection and the remote command before spawning anything, and the server answers them with 410 and every other internal path with 404, before any database or provider work. No HTTP request performs discovery or paid work. Later slices add the status, watchlist and correction forms to this boundary, with exact validation at every layer.

**The 45-article experiment total is retired.** It was the product of three games and the 15-article ceiling. Each exact entity keeps its own 15-article ceiling across passes; no total across entities applies to discovery, processing or an affected set.

## Consequences

- Deploying the code changes nothing in production until the maintainer sets `MEDIA_AUTOMATIC_INGESTION=true` and restarts the application. The first daily media run then happens at the next 06:00 UTC, or at the first tick when that day's check has not run yet.
- While the switch is off, the daily credit check does not run either, so provider pauses are not lifted until it is turned on.
- Discovery volume is bounded by the per-outlet daily cap, Outlet day stops and Tavily's free credits; work left over stays due for the next daily media run.
