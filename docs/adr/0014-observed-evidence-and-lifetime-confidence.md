# Preserve weekly review evidence and separate approval from ranking confidence

**Status:** Accepted

This decision supersedes ADR 0008's raw-approval ordering for Top Rated All Time. Its review-volume gates, full-release requirements, and separation of Now eligibility from patch-sensitive scoring remain unchanged. ADR 0009's immutable recorded history and reconstruction provenance remain applicable.

## Whole review evidence

Steam supplies daily, weekly, and monthly histogram intervals. VaporStats retains each supported interval at its actual granularity, including a weekly interval's original weekday. Seven-day aggregates are not split into invented daily observations or assigned to a calendar month that they cross.

Evidence selection uses whole, complete, non-overlapping intervals from one compatible population. Every available complete calendar month's interval must remain covered before maximizing total duration and preferring finer evidence. Fine intervals replace it only when they cover the entire interval; extra weekly coverage outside the month cannot compensate for a gap inside it. Daily intervals cannot straddle valid UTC weekly boundaries. Partial daily coverage therefore cannot displace a whole week unless an overlapping coarse alternative is selected. An interval crossing a scoring or update boundary cannot be prorated into that window. Missing intervals remain missing, not zero-review observations. Weekly evidence is retained when no lossless replacement exists.

## Current Player Score

`steam-player-v2` estimates approval using actual observed evidence rather than a synthetic neutral review. Current scoring-window reviews have full weight. Compatible, non-overlapping historical evidence contributes its observed approval with an effective review count capped at 20 and never larger than its actual review count:

`score = 100 × (current_positive + historical_effective × historical_approval) / (current_total + historical_effective)`

Without usable historical evidence, the score is the proportion of positive current reviews. Three positive reviews out of three therefore support a score of 100, not 87.5. They do not establish strong evidence, ranking eligibility, or certainty. Current raw-approval uncertainty is reported separately with its sample; critic reception does not contribute to this calculation.

A missing or zero-review current sample without usable support does not create an estimate. When collection or supporting evidence stops, the last supported score remains available. Review-volume gates continue to count actual reviews, not effective historical weight.

## Formula cutover and historical claims

Recorded player-score rows are immutable. The single-writer ingestion process recalculates retained, valid `steam-player-v1` inputs in bounded batches, appending `steam-player-v2` observations rather than updating old rows. The current-score pointer is the resumable progress marker; no separate queue is required. A tick considers at most 5,000 legacy current observations, committed in transactions of at most 100 upgrades. Larger catalogs resume on later ticks.

A recalculation records its calculation time, prior observation identifier, and prior formula version. Its review counts, source timestamps, scoring window, and source population remain those of its supporting evidence. It is not a fresh Steam response and must not refresh the reported review-evidence age, including ranking list and comparison metadata. Both game-detail and monthly Now comparison graphs separate formula versions instead of connecting them into an apparent change in reviewer opinion; isolated points remain visible. Unsupported retained inputs keep their previous estimate until collection supplies valid evidence.

New Steam collection can append a current-version score even when its aggregate counts are unchanged from an older formula. Recollection is still necessary to recover weekly evidence that was not previously retained; a formula recalculation cannot manufacture that history. Schema migrations preserve existing evidence and score rows and do not fetch or seed observations.

Historical comparisons continue to prefer the recorded score available at their cutoff. Later recalculations are not backdated, and reconstructed estimates remain distinct from recorded observations.

## Deployment cache identity

Reception request URLs and TanStack Query keys include the reception payload version. Version 2 separates the new formula metadata and confidence-ranking shape from previously cached JSON responses. Both ranking views and score summary/history requests use this identity; unsupported explicit versions are rejected without caching the error. This does not change the five-minute query stale time or introduce a manual revalidation state model. It avoids requiring a deployment-time CDN purge or interpreting an older approval payload as a confidence score.

## Top Rated All Time

All Time ranks eligible games by **Confidence score**, the lower endpoint of the two-sided 95% Wilson interval for compatible filtered lifetime Steam approval. The score remains on a 0–100 scale. Raw **Lifetime Approval** and the qualifying review count remain visible separately; a confidence bound is never labelled as the observed approval percentage.

The same ranking measure orders current standings and historical monthly comparisons. Ranking eligibility still requires 250 actual lifetime reviews globally or 50 in a filtered group. Now continues to order by Current Player Score and uses actual rolling-90-day review volume for eligibility.

This trades raw-percentage ordering for a more conservative comparison of differently sized review samples. A larger, strongly positive sample can outrank a small perfect sample. The Wilson model does not remove selection bias, establish review authenticity, or measure the probability that a game is good. It describes sampling uncertainty in reviewer approval, not game quality.

## Rejected alternatives

- Treating missing historical storage as evidence that historical reviews do not exist.
- Splitting weekly totals across dates or combining overlapping granularity totals.
- Penalizing the Current Player Score merely because the sample is small, or disguising uncertainty as negative reception.
- Using a confidence bound as the displayed Lifetime Approval percentage.
- Rewriting old player-score observations or backdating a new formula calculation to the original source observation.
- Fetching every title synchronously at deployment or coupling observation ingestion to schema migrations.
