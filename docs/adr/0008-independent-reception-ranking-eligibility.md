# Separate reception ranking eligibility from the scoring window

VaporStats keeps Current Player Score distinct from Lifetime Approval. Top Rated Now orders eligible full-release games by Current Player Score and requires 250 actual reviews in the rolling 90-day window for global rankings, or 50 for filtered rankings. Top Rated All Time orders eligible full-release games by compatible filtered lifetime Steam approval and applies the same thresholds to lifetime review volume.

The Now eligibility window is independent of the patch-sensitive scoring window. A qualifying update does not reset eligibility, and the first post-update review does not trigger a new admission threshold. Post-update evidence can influence the current estimate while pre-update reviews still count toward eligibility when they fall within the rolling 90-day window. Historical-support weighting does not create additional qualifying reviews.

Requiring the threshold entirely within the post-update scoring window is rejected: it would remove an established game merely for shipping an update, or postpone that removal until its first new review. Permanent eligibility is also rejected: a game leaves Now when its rolling review volume falls below the applicable threshold. This does not erase its last supported score or remove its lifetime eligibility while the All Time requirements remain satisfied.

Score magnitude, evidence strength, and ranking eligibility remain separate concepts. A calculated Current Player Score of 100 remains 100; limited evidence does not impose an additional score penalty. The review sample and historical support describe the strength of that estimate, not certainty.
