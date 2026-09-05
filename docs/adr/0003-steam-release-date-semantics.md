# Steam release-date semantics

**Status:** Accepted.

VaporStats treats Steam's first-party API responses as the source for release dates. The model separates dates, states, milestones, and plans so a changed store field cannot rewrite history or imply a stronger claim.

## Decision

### Dates and source precedence

- The canonical **Main Released** date uses API fields in this order: original_release_date, then steam_release_date, then Storefront appdetails.release_date. The winning field is retained as release provenance.
- Steam timestamps become calendar dates in America/Los_Angeles; dates that omit calendar precision remain imprecise. Date normalization uses first-party APIs only, with no HTML or store-browsing fallback.
- Main Released is a neutral display of Steam's primary release date. It does not infer Available on Steam, full release, Left Early Access, or version 1.0.

### Available on Steam

**Available on Steam** is a distinct lifecycle event from a Steam listing, wishlist availability, and Main Released. When Steam supplies original_steam_release_date, that field is the availability date. A later or mutable steam_release_date must not overwrite it or appear as a second arrival. When no original Steam date exists, retain steam_release_date as a Steam-specific source and date, without calling it first-ever. Available on Steam is shown in both the critical overview and the expanded full history.

### Lifecycle evidence

- Early Access is an explicit current state, separate from dated milestones. An explicit developer store description may establish that a game has left Early Access, but it does not establish the transition date. The UI therefore shows a confirmed **Left Early Access** milestone without a date when the exit is evidenced but undated, and full history explains that the transition date is unknown.
- Left Early Access, full release, and **Version 1.0** are separate claims. A full-release record may remain when explicit release_from_early_access_date evidence supports it, but public copy calls the milestone Left Early Access, never Version 1.0. Version 1.0 requires explicit literal version evidence; it is never inferred from a Main Released date, full release, or Early Access state.
- News, update-feed, transport, and cache timestamps do not establish release milestones on their own.

### Plans and presentation

Release plans and every dated revision are retained separately from observed milestones. Passing an expected date does not turn a plan into an occurrence. The game overview shows only critical lifecycle events; full history is collapsed and loaded on expansion, then presents all sourced events (including unknown dates) and retained plan revisions with their sources and uncertainty.

### Collection boundary

Every ingestion path uses the same API-only normalization rules. Patch ingestion and patch-aligned Steam sentiment remain separately scoped under [map #12](https://github.com/phenome/vaporstats/issues/12), and media-derived announcement evidence remains separately scoped under [map #13](https://github.com/phenome/vaporstats/issues/13).

## Evidence

The first-party [StoreBrowse GetItems](https://api.steampowered.com/IStoreBrowseService/GetItems/v1/) and [Storefront appdetails](https://store.steampowered.com/api/appdetails) responses establish the rationale:

- **Adventure (777150):** original_release_date=1548662400 normalizes to 2019-01-28. Its explicit store description says it has left Early Access, but supplies no transition date, so the old inferred Version 1.0 event is removed and Left Early Access is undated.
- **Starwalker (339820):** Storefront's main date is 2018-06-30; StoreBrowse reports original_release=1530342000 (2018-06-30), original_steam_release_date=1419368860 (2014-12-23), and steam_release_date=1788234372 (2026-08-31), while appdetails reports Aug 31, 2026. Main Released remains 2018-06-30, Available on Steam is 2014-12-23, and no Version 1.0 milestone is assigned.
- **Nexus (6420):** Main Released remains 2004-11-05; without an original Steam date, 2007-07-03 is retained as a Steam-specific date rather than described as first-ever.

These cases are why a later mutable Steam date cannot replace original availability and why a neutral Main Released date cannot carry an inferred milestone.