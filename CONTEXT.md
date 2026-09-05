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
