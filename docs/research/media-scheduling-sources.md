# Historical candidates and article update discovery

Research for [Set fresh-coverage scheduling and historical backfill bounds](https://github.com/phenome/vaporstats/issues/46). Findings are planning evidence, not adopted policy or production implementation. Checked 2026-09-10.

## Older-game candidate sources

- The Game Awards official archives expose historical winners. [2015](https://thegameawards.com/rewind/year-2015) lists The Witcher 3: Wild Hunt as Game of the Year; [2023](https://thegameawards.com/rewind/year-2023) lists Cyberpunk 2077 as Best Ongoing. These support discovery beyond release-year acclaim. Complete historical nominee coverage was not verified.
- [2016](https://thegameawards.com/rewind/year-2016) separately recognizes Blood and Wine. Awards for expansions must not become base-game awards. Candidate selection does not authorize blending their review aggregates.
- [Metacritic's 2015 browse](https://www.metacritic.com/browse/game/all/all/2015/) supports release-year and platform filtering, displays Metascores, and states that titles with fewer than seven critic reviews are excluded. DLC appears alongside games. No official API or automated reuse permission was established.
- [OpenCritic's 2015 browse](https://opencritic.com/browse/all/2015) exposes yearly lists and sorting by score, review count, and recommendation percentage. Expansions also appear. These are current year-filtered lists, not verified snapshots of rankings as they stood at year end. No official API or reuse permission was established.
- [IGDB documentation](https://api-docs.igdb.com/) distinguishes user rating, external critic aggregate, combined rating, and their counts; it also exposes release dates and parent/DLC/expansion relationships. It can help identify candidates but does not substitute for award evidence. Authentication is required. Documentation contains differing commercial-use wording; commercial conditions require clarification before relying on them.

A possible bounded policy is annual top-N candidates from one critic list plus game-directed award winners, deduplicated by exact entity. Selecting N, historical cutoff, and award categories remains a decision. Candidate sources need not become synthesis sources or public scoring features.

## Article update discovery

- [RSS 2.0](https://www.rssboard.org/rss-specification) defines pubDate as publication time and permits stable GUIDs. It does not require old articles to reappear after edits. Channel lastBuildDate is not an item-level revision record.
- [Atom RFC 4287](https://www.rfc-editor.org/rfc/rfc4287.html), sections 4.2.6, 4.2.9 and 4.2.15, separates stable identity, publication and significant-update timestamps. Not every modification must change updated; feed inclusion is not guaranteed.
- The observed [PC Gamer news feed](https://www.pcgamer.com/feeds/articletype/news/) includes separate pubDate and updated fields with differing timestamps. Its [new PC games page](https://www.pcgamer.com/games/new-pc-games-2026/) exposes original publication in 2025 and modification in September 2026. This verifies preserved publication dates, not how often corrections occur or that every edited article returns to the feed.
- The observed [GamesRadar news feed](https://www.gamesradar.com/feeds/articletype/news/) includes pubDate/GUID without the same updated extension. Its [release calendar](https://www.gamesradar.com/video-game-release-dates/) has separate original and modified metadata. These are illustrative news/evergreen samples, not a longitudinal review-feed audit.
- [Sitemap lastmod](https://www.sitemaps.org/protocol.html) can signal page changes; [Google guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) emphasizes accurate modification dates and notes feeds cover recent URLs. Signals are publisher-dependent.
- [HTTP RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) defines ETag/Last-Modified and conditional requests. They save transfer when checking a resource; they do not notify a collector that an unrequested old article changed.

A minimal best-effort policy can inspect all entries in daily discovery responses, including known URLs; refresh known articles when a source update signal changes or an explicit correction is requested. It need not add a weekly article sweep. The explicit tradeoff is missing silent edits to articles absent from discovery surfaces. A page-only dateModified cannot notify ingestion without fetching that page. No reliable correction-frequency estimate or complete update-capture guarantee was established.
