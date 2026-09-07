# Steam patch classification signals

**Question:** Can VaporStats cheaply classify a shipped major update versus a minor update or hotfix from Steam data, without manual curation or an LLM significance classifier?

**Observation date:** 2026-09-07 UTC. Evidence below is from official Steamworks documentation and public first-party Steam responses. This is research only; it does not define an ingestion contract.

## Decision summary

- **Conditional yes for Steam's own publisher-selected event category.** The public Store News Hub exposes an `event_type` field. In live samples, the Store UI and the same response mapped `14` to **MAJOR UPDATE**, `12` to **SMALL UPDATE / PATCH NOTES**, and `13` to **REGULAR UPDATE**. One batched request can retrieve several events.
- **No for objective patch significance.** Steam's category is chosen by the publisher for communication and visibility; it is not a measured build-size, feature-count, or hotfix signal. An unannounced build has no event to classify, and a publisher can choose a category that does not match an external definition of “major.”
- `ISteamNews/GetNewsForApp` is cheap and official, but it does not return `event_type`, schedule fields, build IDs, or a documented category/tag enumeration. Its `tags` field is present only on some live items and is not category truth.
- Treat the Store News Hub path as an **optional, source-classified signal with an undocumented-contract risk**, not as a stable official API. Persist the raw category and timestamps, and use `unknown` when the event cannot be resolved.

## Official Steamworks contract

### Public news API

Steam's [ISteamNews documentation](https://partner.steamgames.com/doc/webapi/ISteamNews) defines:

```text
GET https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/
  ?appid=<uint32>
  &maxlength=<uint32>
  &enddate=<unix timestamp>
  &count=<uint32>
  &feeds=<comma-separated feed names>
```

`appid` is required. `maxlength=0` requests full content; a positive value requests a bounded blurb. `enddate` is documented as retrieving posts earlier than a Unix timestamp. `count` defaults to 20. `feeds` limits feed names. The current v2 page documents no `event_type`, `tags`, cursor, offset, schedule, or build parameter. The publisher-only `GetNewsForAppAuthed` variant can expose unreleased-app news, but requires a publisher key and a secure server.

The [Web API overview](https://partner.steamgames.com/doc/webapi_overview) identifies `api.steampowered.com` as the public host and shows `GetNewsForApp` as its example query. The [Steam Web API Terms](https://steamcommunity.com/dev/apiterms) state that the API is free but limit an application to 100,000 calls per day. The overview documents stricter IP throttling for invalid requests to the partner host, but neither source documents an endpoint-specific per-minute quota for `GetNewsForApp`.

### Events and Announcements categories

Steam's [Events and Announcements Tools](https://partner.steamgames.com/doc/marketing/event_tools) says the publisher selects a category/subcategory, which controls where and how an event appears. It names three update levels: Patch Notes, Regular Updates, and Major Updates. It also documents staged visibility and optional start/end dates.

- [Major Update](https://partner.steamgames.com/doc/marketing/event_tools/type_majorupdate): intended for a game's biggest updates; may receive Store, Community, Library/What's New, Downloads (when linked to a latest build), and Update Visibility Round exposure. A rich title/description and cover image are required; build association is supported.
- [Small Update / Patch Notes](https://partner.steamgames.com/doc/marketing/event_tools/type_patchnotes): intended to tell players what changed in a build, including changes many players may not care about. The documentation explicitly connects patch notes to every new Steam build. Patch notes intentionally avoid high-visibility Library What's New and Store placements; they appear in Downloads, compact News Hub/library detail views, and the latest-notes link on the Store. Build association is only for current/future builds.
- [Visibility exceptions](https://partner.steamgames.com/doc/marketing/event_tools/visibility): patch notes are excluded from high-visibility Library homepage and Store locations but remain in chronological library detail.

Steam's [update guidance](https://partner.steamgames.com/doc/store/updates) distinguishes small bug fixes/patches from major content such as new content, modes, or features. That is prose guidance, not machine-readable significance metadata.

The event documentation also matters for dates: a post can be published ahead of a configured start, some visibility can be staged, and Steam says the first time an event is visible is used as its post-time for “seen” algorithms rather than the configured start. Start times cannot be published or moved into the past, while end dates can be edited. Therefore, a news/event timestamp is not independently verified as the time a playable build shipped.

## Live official API observations

### GetNewsForApp shape and pagination

Request (no key):

```text
GET https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=3&maxlength=0
```

Response status was `200`. The top-level `appnews` contained `appid=730`, `newsitems` (3 returned), and `count=1755` (total matching items, not returned length). The first item was a Counter-Strike 2 community update with `date=1787614760` (`2026-08-24T23:39:20Z`). Observed item keys were:

```text
gid, title, url, is_external_url, author, contents,
feedlabel, date, feedname, feed_type, appid, tags
```

`count` is a page-size control in practice: omitted `count` returned 20, `count=100` returned 100, and `count=2000` returned all 1755 for this app at observation time. There is no cursor or offset in the response. `feeds=steam_community_announcements` reduced the observed matching total to 442; without it, the first 100 results included PC Gamer, GamingOnLinux, and PCGamesN items alongside Steam community announcements.

For the same app, `enddate=1786575047` included an item at exactly that timestamp, while `enddate=1786575046` excluded it. Equal timestamps exist in the feed (two items were observed at each of `1676890105` and `1775082945`), so timestamp-only incremental pagination needs a tie-breaker and overlap/deduplication. The documented “earlier than” wording does not provide a unique cursor contract.

`maxlength=50` returned a 53-character blurb including `...`; `maxlength=200` returned 203 characters including `...`; `maxlength=0` returned full BBCode-like content. This makes a small-title/feed poll inexpensive, but fetching full bodies for every item is not.

Live `tags` examples included `patchnotes`, `workshop`, `hide_store`, `hide_library_overview`, `hide_library_detail`, and moderation tags. A patch-note item commonly had `tags=["patchnotes", ...]`, but tags were absent from many announcements and are not an official category enumeration. A Store News Hub item that was visibly a **NEWS** event also carried `patchnotes`/`workshop` tags in one sample; tags must not be used as the major/minor classifier.

### API GID is not the event GID

A community announcement item from the API had `gid=1841579228676851` and an external-post URL. That URL returned `302` to:

```text
https://steamcommunity.com/ogg/730/announcements/detail/717913919982667305
```

The canonical announcement-body GID (`717913919982667305`) is distinct from the Store event GID (`717913919982667304`). Another regular-update API item similarly resolved to an announcement-body GID ending in `...509`, while its Store event GID ended in `...508`. Do not join the API `gid` directly to a Store event object.

## First-party Store News Hub event data

The public Store News Hub page is:

```text
https://store.steampowered.com/news/app/<appid>
```

For `appid=730`, the HTML included a `data-initialevents` JSON attribute. The decoded object had `documents` (405) and 50 event models. For `appid=3285220` (ASHWAKE), it had 45 event models. This is a useful discovery surface, but one page's event-model count is not a documented promise of complete historical coverage. The CS2 HTML response measured about 554 KB and its embedded initial-event JSON about 330 KB, so polling the whole page is materially heavier than a small news poll.

A decoded event model contains fields including:

```text
gid, clan_steamid, event_name, event_type, appid,
rtime32_start_time, rtime32_end_time, published, hidden,
rtime32_visibility_start, rtime32_visibility_end,
rtime32_last_modified, rtime_created,
build_id, build_branch, announcement_body
```

`announcement_body` includes its own `gid`, `posttime`, `updatetime`, `tags`, and body content. `build_id` is only useful when the publisher links an event to a build: the sampled CS2 events had `build_id=0` and an empty branch, while ASHWAKE's sampled major and patch events had build IDs. A build ID in this response still does not supply a public build-release timestamp.

### Batched event request

The Store page/client uses this first-party but undocumented request shape:

```text
GET https://store.steampowered.com/events/ajaxgetbatchedpartnerevent/
  ?announcement_gids=<comma-separated announcement-body GIDs>
  &lang_list=0
  &origin=https:%2F%2Fstore.steampowered.com
```

For example, one request with the ASHWAKE announcement-body GIDs `717914553706349073,717915187566347671` returned status `200`, `{"success":1}`, and two event objects:

| Event GID | `event_type` | Name | AppID | Start (Unix) | Announcement `posttime` | `build_id` |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `717914553706349072` | `14` | Early Access 0.3 Major Update Patch Notes | 3285220 | 1788175200 | 1788175254 | 25035082 |
| `717915187566347670` | `12` | Early Access 0.3.1 Small Patch Notes | 3285220 | 1788742440 | 1788742472 | 25158882 |

The corresponding Store event pages displayed **TYPE MAJOR UPDATE** and **TYPE SMALL UPDATE / PATCH NOTES** respectively:

- [ASHWAKE 0.3](https://store.steampowered.com/news/app/3285220/view/717914553706349072)
- [ASHWAKE 0.3.1](https://store.steampowered.com/news/app/3285220/view/717915187566347670)

A second bounded check on Counter-Strike 2 returned these event models and UI labels:

- `event_type=13`, [Season 5, Armory, and More](https://store.steampowered.com/news/app/730/view/701021228894257508): **TYPE REGULAR UPDATE**.
- `event_type=12`, [Counter-Strike 2 Update](https://store.steampowered.com/news/app/730/view/717913919982667304): **TYPE SMALL UPDATE / PATCH NOTES**.

Thus the live first-party mapping observed here is `14 = Major Update`, `13 = Regular Update`, `12 = Small Update / Patch Notes`. Official Steamworks documentation names the categories but does **not** document these numeric enum values or this endpoint, so this mapping must be treated as an observed/brittle client contract rather than an official API guarantee. No numeric mapping is inferred from tags.

### How an unattended poll could obtain IDs

There are two bounded paths:

1. **News-first:** poll the official `GetNewsForApp` with a small `count`, `maxlength`, and `feeds=steam_community_announcements`; follow each new item's external-post URL (one redirect) to obtain the canonical announcement-body GID; batch those IDs in one Store request. This minimizes work when most apps have no new post, but it adds a redirect per candidate and has API timestamp-pagination caveats.
2. **Store-page-first:** fetch `/news/app/<appid>` and parse `data-initialevents`, which already contains `announcement_body.gid`, `event_type`, schedule fields, and build association. This avoids redirect joins but is a substantially larger HTML request and lacks a documented historical/pagination contract.

The batched endpoint itself accepts multiple IDs in one call in the observed request. Valve documents neither a maximum ID count, response-size limit, retention period, pagination cursor, nor rate limit for it.

## Dates, announcements, and shipping

Three live examples show why fields must remain separate:

| App/event | `rtime32_start_time` | `announcement_body.posttime` | `updatetime` | UI “POSTED” |
| --- | --- | --- | --- | --- |
| CS2 small patch | `2026-08-24T23:41:00Z` | `2026-08-24T23:39:20Z` | `2026-08-24T23:41:11Z` | Aug 24 20:41 -03 |
| CS2 regular update | `2026-07-08T22:50:00Z` | `2026-07-08T22:50:43Z` | `2026-07-08T22:50:43Z` | Jul 8 19:50 -03 |
| ASHWAKE major update | `2026-08-31T11:20:00Z` | `2026-08-31T11:20:54Z` | `2026-08-31T11:20:54Z` | Aug 31 08:20 -03 |

The displayed minute matched the configured event start in these samples, while announcement `posttime` differed. `rtime32_end_time` is also an event visibility/end field, not a build shipment marker. The official event docs explicitly distinguish start, visibility/post-time, and editable end dates. `build_id` can corroborate that a publisher linked a build, but there is no public build-release timestamp here. None of these fields independently verifies when the playable update shipped.

## Coverage and limitations

- **Coverage:** only events/announcements that are publicly visible and represented by the Store News Hub or `GetNewsForApp` can be observed. A build without a news post is invisible to this signal. The API mixes external feeds unless filtered. The Store page's initial event model count and the batched endpoint's retention/max-ID behavior are undocumented.
- **Classification semantics:** `event_type=14` is evidence that the publisher selected Steam's Major Update category. It is not proof of a large depot diff or a particular feature magnitude. `event_type=12` is evidence of Patch Notes, not proof that the update was a hotfix; Steam's own docs say patch notes can describe any build. `event_type=13` is Regular Update, not necessarily minor.
- **Tags:** `patchnotes` is useful as a supporting hint in `GetNewsForApp`, but tag presence is inconsistent and tags include visibility/moderation/workshop metadata. Tags cannot replace `event_type`.
- **Dates:** announcement publication, configured start/end, visibility, last modification, and optional build association are distinct. None is independently a verified shipped-build timestamp.
- **Reliability:** the numeric event mapping and batched endpoint are first-party live behavior, not documented API contract. They can change without notice and should be monitored or feature-gated. The official API terms also permit Valve to change or terminate API access and provide data “as is.”

## Conclusion for issue #32

A cheap implementation can report **Steam source category** when it can resolve a public Store event: Major Update (`14` observed), Regular Update (`13` observed), or Small Update/Patch Notes (`12` observed), with an explicit `unknown` state and raw evidence retained. This is sufficient only if the product accepts Steam's publisher-selected category as the distinction.

A cheap, deterministic implementation cannot honestly claim to classify **actual major shipped updates versus minor/hotfixes** across Steam. There is no official machine-readable significance field, no guaranteed event for every shipped build, and no public build-diff/ship-time signal in the relevant responses. Without manual/LLM review, the safe wording is “Steam-labeled event category,” not “verified major patch.”