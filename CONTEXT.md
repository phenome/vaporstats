# VaporStats

VaporStats presents collected game-market and player-activity data through its website.

## Language

**Internal website API**:
An HTTP endpoint used by VaporStats pages to load site data. It is not a supported interface for third-party integrations or bulk extraction.
_Avoid_: Public API, developer API

## Glossary

**Observation**: One timestamped player/price measurement before aggregation.

**Rollup**: A durable aggregate derived from observations for a defined UTC period.

**Release plan**: A sourced statement of an intended future lifecycle milestone and its expected date or window. It is not evidence that the event occurred.

**Announced**: A game has been publicly revealed. This does not by itself establish a Steam listing, wishlist availability, or a scheduled release date.

**Steam listing**: A game has a public Steam store page. A listing is distinct from wishlist availability, Available on Steam, and any release milestone.

**Wishlist availability**: Steam permits users to add a game to their wishlist. This is distinct from a listing, Available on Steam, and any release milestone.

**Available on Steam**: A sourced Steam availability event. Use original_steam_release_date when Steam supplies it; otherwise retain steam_release_date as a Steam-specific date without calling it first-ever. This is distinct from a listing, wishlist availability, and the Main Released date.

**Main Released date**: The release date Steam presents as a game's primary release date. It is neutral: it does not by itself establish Available on Steam, full release, Left Early Access, or version 1.0.

**Release milestone**: An evidenced event in a game's release lifecycle, such as entering Early Access, Left Early Access, or version 1.0. A generic release date or current state alone does not establish a specific milestone.

**Full release**: A game's release outside Early Access, distinct from Left Early Access and a particular version number such as 1.0.

**Left Early Access**: An evidenced transition out of Early Access. It may be confirmed without a date, and it is not a version 1.0 claim.

**Version 1.0**: A milestone supported by explicit version 1.0 evidence. It is never inferred from the Main Released date, full release, or leaving Early Access.

**Early Access state**: Whether a game is currently in Early Access; this state is distinct from release milestones and dates. An explicit developer store description may establish the state or an undated exit, but not a transition date.

**Imprecise date**: A release date whose source omits part of the calendar detail; omitted components remain unknown rather than being invented.

**Release provenance**: The first-party release field that supplied the Main Released date.

**Activity timestamp**: A timestamp for news, updates, feeds, or transport and cache metadata; it describes activity or delivery, not a release milestone.

**Community icon**:
Steam's 1:1 square application icon, identified by its community icon hash and served from Steam's community CDN. Distinct from store capsule and header art.
_Avoid_: App icon, client icon, avatar

**Low-Quality Image Placeholder (LQIP)**:
A compact, precomputed inline base64 data URL generated from existing header artwork via Bun's native image processing, serving as an interim asset for the Sticky Game Header until a title's Community icon is ingested.
_Avoid_: Blurhash, thumbnail preview, image stub

**Sticky Game Header**:
A persistent, single-line sub-header docked immediately below the primary site navigation that displays core game identity and action links when scrolling past the main game details card.
_Avoid_: Floating bar, sticky title, mini navbar

**Period Peak**:
The highest recorded player count within a specific observation window (e.g. 24 hours, 7 days, 30 days). Distinct from All-Time Peak.

**All-Time Peak**:
The highest recorded player count for an application across all retained raw observations and durable rollups.

**Period Low**:
The lowest non-null recorded player count or price within a specific observation window.

**All-Time Low**:
The lowest recorded price for an application across its entire tracked pricing history.

**Chart Transition State**:
An active revalidation state during which existing period data remains visible with muted presentation while next-period data is fetched, preventing layout collapse.

**Tracking tier**:
A classification assigned to a tracked game (`fast`, `hourly`, `daily`) that governs its observation sampling frequency.
_Avoid_: Priority queue, poll interval, refresh tier

**Fast tier**:
The highest-frequency sampling tier, tracking the top 50 games on a 15-minute cadence.
_Avoid_: High priority, 10m tier, hot games

**Hourly tier**:
The secondary sampling tier, tracking games ranked 51–250 on a 60-minute cadence distributed across 4 quarter-hour slots.
_Avoid_: Medium tier, standard tier

**Daily tier**:
The baseline catalog sampling tier, tracking games ranked 251–1,000 once every 24 hours distributed across 96 quarter-hour slots.
_Avoid_: Low tier, cold tier, background tier

**Current Player Score**:
A 0–100 estimate of current Steam reviewer approval, informed by current and historical player evidence. It is distinct from lifetime approval, a critic quality grade, and catalog rank.
_Avoid_: Living Game Score, meta score, composite rating

**Reception Alignment**:
A game-level comparison of player and critic reception that respects their different scales, populations, and dates. Disagreement alone does not establish reviewer bias.

**Recent Reception**:
A comparison of Steam reviewer approval in the latest four completed weeks with the preceding eight weeks. It is distinct from Current Player Score, catalog rank, and evidence that a patch caused reception to change.

**Historical Player Evidence**:
Player reception preceding the current evidence window, distinct from the reviews within that window. It supplies context for estimating current approval rather than a separate critic contribution.

**Major Update Event**:
A Steam event classified by its publisher as a Major Update. It is a source-selected communication category, not independent proof of patch significance or build deployment.

**Score Anchor**:
The major-update event boundary used to separate current player evidence from earlier reception. It is distinct from the first complete evidence bucket available after that boundary.

**Sentiment History**:
The retained evolution of player reception across a game’s lifetime, including evidence no longer influencing its Current Player Score. Recorded scores and later reconstructions are distinct historical claims.

**Recorded Player Score**:
A Current Player Score calculated from the evidence available at its observation time. Later source corrections do not change what was recorded then.

**Reconstructed Player Score**:
An estimate for an earlier period calculated using information available later. It is distinct from the score recorded at that time.

**Review Population**:
The set of Steam reviews represented by an aggregate, distinguished by source, language, purchase origin, and filtering. Unknown filtering does not establish compatibility with another population.

**Score Evidence Strength**:
The support available for a Current Player Score, including its review sample and historical context. It is distinct from the score itself and from leaderboard eligibility.

**Catalog Rank**:
An ordinal rank assigned to an eligible playable game on global or category leaderboards, gated by minimum evidence thresholds (e.g. 50 reviews for category boards, 250 reviews for global boards).
