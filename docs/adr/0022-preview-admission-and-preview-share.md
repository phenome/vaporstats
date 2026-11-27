# Preview admission and the preview share of outlet and credit allowances

**Status:** Accepted

Amends the preview rules of [#79](https://github.com/phenome/vaporstats/issues/79) under [#71](https://github.com/phenome/vaporstats/issues/71). Extends [ADR 0019](0019-automatic-daily-media-run.md) and [ADR 0020](0020-later-assessment-pass.md).

## Context

VaporStats prioritizes giving every watched upcoming game an Overview. Even short descriptive coverage is enough to start one, so a preview pass should drop an article only when it is clearly not about the exact entity or is unusable or very poor in quality.

A watched upcoming game, Warlock: Dungeons & Dragons (AppID 3714800), received no preview coverage. Two independent causes were verified.

**Scheduling starved previews.** Assessment queries were ordered before preview queries and used each outlet's whole daily attempt cap. The monthly deferral reserved one search credit for every assessment search forecast to the end of the month, although the daily cap lets only a fraction of those be issued in that time. With 902 of the plan's 1,000 monthly credits left, the five due preview searches were refused, and the month's deferral checkpoint held every later preview of the month.

**The classifier rejected a genuine preview.** A GamesRadar+ write-up of a behind-closed-doors, hands-off demo, published 2026-08-26, failed three independent gates for the preview pass:

1. Its title names the game only as "Warlock". The only alias was the full name, which the body contains once, beside seven mentions of "Warlock".
2. Its title also names Baldur's Gate 3, another enrolled root, so the article was treated as cross-family coverage and rejected. Its body names Baldur's Gate 3 twice.
3. Neither its title nor its first 4,000 characters contain "preview" or "early access", and its title has no announcement word. GamesRadar+ marks it as a preview only in its `mrf:tags` metadata (`unindexedFreeform:preview`), the same field that marks its reviews (`articleType:Reviews`).

## Decision

**Subject attribution is one decision, shared by every pass.**

- A root entity whose name has a subtitle separator (a colon, or a spaced hyphen, en dash or em dash) also has the leading part as a *short name*, such as "warlock". A short name is weak: it identifies the entity in a title only when the article body names one of the entity's full aliases at least once; without that confirmation it matches nothing. A short name with fewer than four characters (`MIN_SHORT_NAME_CHARS`), or one equal to a full alias of any loaded entity, is not derived. Full aliases behave as before.
- Another enrolled root family named in the title or lead no longer rejects an article by itself. When more than one family is named, the article's subject is the family that is both named first in the title and named most often in the body. When those disagree, or the body count ties, the subject is ambiguous and the article is rejected. The article is admitted only for its subject: the same article fetched for another family's query is rejected there.
- The explicit multi-game forms still reject: versus, comparison, roundup, ranking and list titles, co-titled "X and Y" previews and reviews, and roundup or comparison framing in the lead or body. A game name that itself contains "and" or "&" does not make a title co-titled.
- Parent and child attribution within a family is unchanged.

Review qualification for the initial and later passes is otherwise unchanged: an article must be a review or an explicit hands-on preview, and announcements are refused.

**A preview pass admits any coverage of its exact entity except what it refuses.** One function, `previewPassRefusal`, lists what a preview pass refuses: a review (left for the released-game flow), patch or update notes and roadmaps, guides and walkthroughs, roundup, list, ranking, comparison and other multi-game pieces, review-related news, and developer-authored pages. An unusable article (`MIN_USABLE_ARTICLE_CHARS`, unchanged) is refused before any of these. The words "preview" or "early access" and an announcement word are no longer required. The article is typed `announcement` when its title has an announcement word and it shows neither hands-on evidence nor its outlet's own preview marker; otherwise `preview` (`previewArticleType`). It is hands-on only on the existing explicit hands-on evidence. An outlet's own preview marker, such as GamesRadar+'s `unindexedFreeform:preview`, is evidence that the article is a preview and never evidence of hands-on.

**Due preview queries run first, within a daily share of each outlet.** In a scheduled run, due preview queries precede assessment queries; each group is still ordered oldest due time first, then by entity. Preview-pass discovery attempts on an outlet (searches, candidate fetches, redirects and failures, counted like the daily cap counts them) are limited to 10% of that outlet's effective daily attempt cap per UTC day, rounded down and at least 1 (`PREVIEW_DAILY_SHARE_PERCENT`): 20 at the production setting of 200, 3 at the default of 30. Outlet access enforces it in `reserveOutletAttempt`, so the scheduled run and the scoped preview replay obey it alike. A preview query that meets the share is held with the day-scoped reason `preview_daily_share`, like an Outlet day stop for that outlet's previews only: it reopens on the next UTC day, and it never stops or delays the outlet's assessment queries in the same run. The overall daily cap, Outlet denials, an outlet's HTTP 429 and Provider stops apply to previews unchanged. A processing fetch of an admitted preview article counts toward the share, because the attempt log records it under its source's pass, but is never held by it, so the processing of assessment articles on the same outlet is never held either.

**Previews have a monthly share of search credits.** Preview searches may use 10% of the Tavily plan limit that the usage endpoint reports for the UTC month (`PREVIEW_MONTHLY_CREDIT_SHARE_PERCENT`; 100 of 1,000). Preview searches served this month are counted from the attempt log with the daily cap's served-attempt rule. While they are below the share, the review reservation never defers previews: each needs only a remaining credit. Once the share is used, the existing rule applies unchanged: previews are deferred when the remaining credits minus the review reservation are fewer than the pending preview queries, the month is recorded as deferred, and previews resume at the first daily media run of the next UTC month, subject to the same check. A deferral recorded for the current month holds previews only once the share is used, so a checkpoint written under the earlier rule holds nothing while previews remain within their share; no migration or data correction is needed. When the usage endpoint reports no plan limit, the share is 0 and the reservation applies from the first preview search. The status projection of the next preview search, which has no usage reading of its own, uses the plan limit the latest scheduled discovery run recorded.

**Warlock: Dungeons & Dragons is published.** AppID 3714800 joins the roots whose media coverage is public behind `MEDIA_OVERVIEW_PUBLIC`.

### Amended acceptance criteria of #79

- **"Review searches take priority over preview searches"** (the Search priority decision of 2026-11-17), including **"every due initial-pass and later-pass query is ordered before every preview query"** and **"No review-pass query ever waits for a preview query"**: replaced by preview-first ordering within the daily preview share. An assessment query never waits for a preview query held by the share, but a preview query served first can use credits or attempts an assessment query would otherwise have used.
- **Deferral**: applies only after the month's preview credit share is used.
- **"A multi-day backlog test shows review passes progressing ahead of preview occurrences"**: the backlog test shows previews first within their daily share and assessment queries served the same day.
- **Admission and qualification, first criterion**: a preview occurrence admits any coverage of the exact entity that `previewPassRefusal` does not refuse; preview, hands-on or announcement wording is no longer required, and "the existing exact-subject rules" now include short names and the subject-family rule above.

## Consequences

- An outlet's first on-subject candidate now completes that outlet for the preview occurrence, since almost any coverage of the entity qualifies. A better candidate later in the same result list is not considered for that occurrence.
- A preview query can be held by the daily share after a few refused candidates and resumes on the next UTC day, unless a newer occurrence supersedes it first.
- Preview discovery never takes more than 10% of an outlet's daily cap, and preview searches take more than 10% of the month's plan credits only when the review reservation leaves room for them. The processing fetches of admitted preview articles come on top of the daily share, one per admitted article.
- A short name can match an unrelated use of the word only when the body also names the entity in full, and a title that leads with another family is still rejected unless that family also dominates the body.
- A deferral checkpoint written before this decision stops holding previews immediately while they are within their share.
