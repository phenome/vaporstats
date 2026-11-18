# Later assessment pass in the daily media run

**Status:** Accepted

Extends [ADR 0019](0019-automatic-daily-media-run.md). Implements the later pass of [#71](https://github.com/phenome/vaporstats/issues/71) as specified in [#75](https://github.com/phenome/vaporstats/issues/75), which carries over the later-pass selection decision of 2026-11-16 from [#68](https://github.com/phenome/vaporstats/issues/68).

## Context

Each enrolled entity gets one initial and one later assessment pass. The later pass collects later assessments from outlets already represented in the initial pass. It is scheduled automatically, shares the per-outlet daily cap, Tavily's free credits and the 15-article ceiling with the initial pass, and must compete with it fairly.

## Decision

**One scheduled run serves every due pass.** The daily media run starts one scheduled discovery run per UTC day. That run takes every pass due at its start, initial and later alike, oldest due time first and then by entity, and each pass across the outlets in roster order. A pass's queries stop when the day's free credits or an outlet's daily cap run out, and the pass stays due with its due time, so it comes first in the next daily media run. A run resumed after a restart serves the passes that were due at its start, so a pass that becomes due during a run waits for the next daily media run. Each query and each outlet attempt records the pass it serves.

**Due times come from recorded facts.** An entity's initial pass is due from its root's enrollment. Its initial discovery has finished when every outlet's initial query has completed or met an Outlet denial; a query held by a day-scoped stop, kept by a Provider stop or never issued is unfinished. Each query records when it completed, by the run's clock. The later pass is due from the latest completion or denial of those queries. For an entity enrolled for any reason other than `experiment`, it is due no earlier than the start of the UTC day 90 days after its Main Released date, under ADR 0003 precedence. An entity without that date waits.

**Selection follows the 2026-11-16 decision.** The later pass asks only the outlets with an accepted initial article for the entity. Its one query per entity and outlet is `<entity name> review revisited`, restricted to the outlet's domain like the initial pass's `<entity name> review preview`, and it is never reformulated. A candidate already among the entity's sources, by its URL or its discovery URL, is not fetched. A fetched article must pass the existing exact-subject and article-type rules, and then:

- its entity must have an accepted initial article from the same outlet;
- its canonical URL and discovery URL must be new to its entity;
- if it is dated, it must be published after each of that outlet's dated initial articles for the entity. An undated initial article imposes no constraint;
- if it is undated, it qualifies otherwise and keeps an unknown date.

Under the decision of 2026-11-17 recorded on #75, an outlet whose initial article for the entity is undated still has later articles collected, dated or not, under the same URL, exact-subject and article-type rules. The order between such an initial article and a later one stays unknown and is never inferred.

Like the initial pass, each query admits at most one article per entity: a review before a preview, the earliest dated first, and undated last.

**Both passes feed results.** Processing, synthesis, the Overview's evidence map, Sources, citations and tag results read sources from both passes. Synthesis receives each article's pass and treats a missing publication date as unknown. A same-outlet later article counts toward its outlet's support once, so it never adds an outlet endorsement. Sources list dated articles by publication date and undated articles after them, never placed in time by their retrieval. The synthesis configuration version changes with this wording; under the rule of [#67](https://github.com/phenome/vaporstats/issues/67), that change alone queues no work.

## Consequences

- A newly enrolled game's later pass follows its initial pass by at least 90 days of release age; the experiment games' later passes follow their initial discovery at the next daily media run.
- An outlet with no accepted initial article for an entity is never asked in its later pass, and an outlet denied after its initial article stays denied.
- The scheduled run's `pass` column keeps its `initial` default because the run serves both passes; per-query and per-attempt records carry the pass.
- A search interrupted by a restart may have been served, so it is not repeated, and that entity's later article from that outlet is not collected.
