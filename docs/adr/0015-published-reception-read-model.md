# Publish disposable reception values before serving catalog standings

**Status:** Accepted

VaporStats derives catalog reception standings and Monthly Score Comparisons into compact SQLite publications. Visitors read the last complete publication rather than loading catalog-wide review buckets and events. This separates bounded derivation work from request volume while retaining the existing SQLite database and single-writer ingestion lifecycle; it does not introduce a separate database, job framework, or browser cache authority.

## Evidence and derived values

Recorded player-score observations remain immutable, including their counts, formula versions, source identities, evidence intervals, and timestamps. Source bucket corrections revise source evidence, not prior recorded scores. Publication current and monthly values are disposable derivations that may be replaced or rebuilt from retained evidence. Publishing, resuming, or advancing the clock does not append review responses or player-score observations.

A build's `evaluated_at` is the common cutoff for evaluating that publication's eligibility and month cutoffs. Build start, progress, and completion times describe processing. None is a new source observation or evidence-freshness timestamp. Responses retain actual source/evidence times, including the original evidence time behind formula recalculations. [ADR 0014](0014-observed-evidence-and-lifetime-confidence.md) continues to define observed-evidence scoring, Confidence score, formula versioning, and recalculation provenance.

## Bounded publication and readiness

The scheduled single-writer ingestion lifecycle refreshes publications after source work. Source and relevant catalog mutations increment durable global and per-app revisions, including corrected counts with unchanged observation times, source interpretation changes, lifecycle changes, and facet changes. Identical source updates do not invalidate values. Deletion revisions remain as tombstones without foreign keys that would prevent normal application deletion. Rolling-90-day eligibility is also reevaluated as time passes, even without a new provider response; collection-time eligibility is not permanent.

Builds freeze an app-ID upper bound, process keyset batches of at most 32 apps, persist progress, and yield between batches. Catalog-only apps need no raw-history evaluation. Unchanged, unexpired current values and compatible monthly derivations can be reused. Projection version, source revision, history identity, and evaluation deadlines determine whether reuse remains valid. These bounds avoid replacing request-time scanning with an all-catalog evidence array in scheduled work.

A staging build is not readable as a publication. Interrupted staging resumes when its source watermark is unchanged. Source mutations during staging may supersede it and start a fresh evaluation rather than publish mixed evidence. The final pointer transition checks the source watermark transactionally. The prior complete build remains readable until the replacement is complete, and cleanup preserves history referenced by either published or staging builds.

Startup completes the initial source-only publication before opening the HTTP listener and then enabling ingestion. Schema migrations create structure only: they neither fetch providers nor seed source or projection observations. Missing or incompatible publications produce a non-cacheable unavailable response, not an empty catalog or an old-reader fallback. HTTP requests, cache misses, navigation, and filter changes never build publications. Candidate readiness does not require provider credentials or a separate host-dispatcher update.

## Standings remain query-specific

[ADR 0008](0008-independent-reception-ranking-eligibility.md) continues to define full-release scope and independent Now eligibility: 250 actual rolling-90-day reviews globally or 50 in filtered groups. All Time uses compatible lifetime review counts with the same thresholds and the Confidence score defined in ADR 0014. Formulae, whole-interval selection, source compatibility, missing values, and deterministic ties are unchanged.

Publications store per-game current inputs and per-game/type/month-cutoff values, never historical rank snapshots or every possible facet ranking. Requested standings are calculated over compact values for the currently eligible filtered group. Metadata/count/page/comparison reads use a coherent publication view; heavyweight game-card hydration follows pagination. Current ties use qualifying review counts; historical All Time ties use the historical lifetime sample, while historical Now ties retain the current qualifying count.

Covering indexes keep full-release scope checks and numeric aggregates off payload-bearing application and publication rows. Scope and cohort queries carry scalar values; metric, population, recalculation, and game-card payloads are hydrated only for the selected page or comparison target. The serialized writer runs [SQLite's bounded `PRAGMA optimize`](https://www.sqlite.org/lang_analyze.html#periodically_run_pragma_optimize_) after completed or unchanged publication work, including startup, so useful planner statistics are available before visitors read the publication.

[ADR 0009](0009-retrospective-player-score-history.md) remains authoritative for historical claims: the recorded observation available at the cutoff wins, reconstruction is allowed only when that observation is missing and retained evidence supports it, and unsupported history stays missing. Reconstruction retains its later supporting source observation and formula/recalculation provenance. Comparisons do not claim that today's cohort was eligible at a historical cutoff. Formula boundaries and graph gaps remain visible.

The browser continues to use TanStack Query's query-key cache and lifecycle state, with the existing five-minute stale time and versioned reception payload identity. Publication metadata is not a second manual client revalidation model.

## Consequences

Publication adds derived storage, invalidation bookkeeping, and startup readiness work. Readers can temporarily serve an older complete evaluation while a replacement is staged, so evaluation age and evidence age are distinct. Source changes can require staging to restart. In return, expensive evidence derivation is bounded and independent of traffic, complete generations change atomically, and retained source history remains available to rebuild disposable values. This decision makes no latency or memory claim beyond those architectural bounds; deployment measurements establish operational performance.
