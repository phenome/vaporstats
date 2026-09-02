# Steam data sources and polling limits

**Ticket:** [#8](https://github.com/phenome/vaporstats/issues/8)  
**Branch:** `research/steam-data-sources`  
**Research captured:** 2026-09-02

## Decision summary

- Use Valve's **`IStoreService/GetAppList`** as the catalog index when a valid Web API key and access to the partner host are available. It is the documented catalog endpoint found in this research that supports pagination and incremental filtering by modification time. Start with its default **Game** result set; keep DLC and other application types separate.
- Use **`ISteamUserStats/GetNumberOfCurrentPlayers`** for point-in-time counts of selected game AppIDs. It returns a snapshot, not a history, and its documented response has no sample timestamp; a collector must record its own observation time.
- Do not promise five-minute freshness for the whole playable catalog. SteamDB reports that Steam's count is cached for around five minutes, while Valve documents no five-minute guarantee and no numeric per-method quota. A five-minute sample of a large catalog is both unlikely to produce fresher values and incompatible with the documented 100,000-calls/day Web API Terms cap.
- Build player history by storing VaporStats' own samples. No Valve Web API method surveyed returns historical concurrent-player counts.
- Treat `store.steampowered.com/api/appdetails` as an **undocumented observed interface**, useful for on-demand store metadata and regional prices but not a stable contract. Do not make catalog-wide price sweeps depend on undocumented batching, cache, authentication, or rate-limit behavior.
- Use `last_modified`/`if_modified_since` and `price_change_number` from the documented catalog feed to identify metadata and price candidates. `GetNewsForApp` is a supplementary publisher-news signal, not a complete patch/build signal. Steam-network PICS change notifications are a possible advanced-access path, but are represented here only by SteamKit source evidence and are not a public Valve Web API contract.

This is a source assessment, not an implementation or a Wayfinder map change.

## Evidence labels

- **Documented fact** — stated in Valve/Steamworks documentation or the Steam Web API Terms.
- **Observation** — behavior or payload observed from a live Steam endpoint on the capture date. An observation is not a promise that Valve will preserve the behavior.
- **Inference** — a conclusion derived from the documented facts and observations; it is labelled so it is not confused with a Valve guarantee.

## 1. Playable catalog and identity

### Documented facts

- An App is Steam's main product representation and has a unique App ID. Valve lists application types including **Game**, **Software**, **DLC**, **Video/Series/Episode**, and **Demo**. DLC and demos have separate App IDs linked to a base application. [Valve: Applications](https://partner.steamgames.com/doc/store/application)
- `IStoreService/GetAppList` returns apps available on the Steam Store. The documented request is `GET https://partner.steam-api.com/IStoreService/GetAppList/v1/` with a required `key`. Its table says **Any web API key**; the Web API overview separately says every request to the partner host requires a publisher key, so access should be verified with the intended credential rather than assumed. [Valve: IStoreService](https://partner.steamgames.com/doc/webapi/IStoreService), [Valve: Web API overview](https://partner.steamgames.com/doc/webapi_overview)
- The catalog feed defaults to games. `include_games`, `include_dlc`, `include_software`, `include_videos`, and `include_hardware` control the documented categories. Results are ordered by App ID. `max_results` defaults to 10,000 and is capped at 50,000; continuation uses the last App ID returned. [Valve: IStoreService/GetAppList](https://partner.steamgames.com/doc/webapi/IStoreService#GetAppList)
- Valve explicitly marks `ISteamApps/GetAppList/v2` deprecated because it can no longer scale to the number of Steam items and directs callers to `IStoreService/GetAppList`. [Valve: ISteamApps](https://partner.steamgames.com/doc/webapi/ISteamApps)
- Valve's publisher-only `GetPartnerAppListForWebAPIKey` can filter an owner's apps by `game,application,tool,demo,dlc,music`; its example identifies dedicated servers as `tool`. It cannot enumerate the complete public catalog for an unrelated publisher. [Valve: ISteamApps/GetPartnerAppListForWebAPIKey](https://partner.steamgames.com/doc/webapi/ISteamApps#GetPartnerAppListForWebAPIKey)

### Observations

- A request to the legacy endpoint `https://api.steampowered.com/ISteamApps/GetAppList/v0002/` returned HTTP 404 during this research. This is consistent with the documentation's deprecation notice, but the documented notice—not one live response—is the basis for excluding it.
- A request to the documented partner-host `GetAppList` without a key returned HTTP 403 during this research. This confirms that an unauthenticated catalog sync cannot be assumed.

### Inference for the playable scope

Use the documented Game result set as the initial playable catalog boundary. Keep DLC, demos, software, video, hardware, and tools out of the player-count target unless a later product decision explicitly adds them. The catalog feed's default is a useful filter, but the feed does not by itself establish every edge case in Steam's product taxonomy; retain the App ID and observed type for validation.

## 2. Current players and historical availability

### Documented facts

- `ISteamUserStats/GetNumberOfCurrentPlayers` takes one required `appid` and returns the total number of players currently active in that app on Steam. It does not include players playing while not connected to Steam. [Valve: ISteamUserStats](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers)
- `GetGlobalStatsForGame` has date parameters, but it retrieves publisher game-stat percentages/totals, not concurrent-player history. It is not a substitute for player samples. [Valve: ISteamUserStats](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetGlobalStatsForGame)
- Valve's current-player method documentation does not describe a historical series, daily average, peak series, or a server-side `observed_at` field. The API Terms also provide no accuracy or uninterrupted-service warranty. [Valve: ISteamUserStats](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers), [Steam Web API Terms](https://steamcommunity.com/dev/apiterms)

### Observations

- The public-host request `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=440` returned JSON containing `result: 1` and `player_count: 56994` on 2026-09-02. The response contained no timestamp. The value is an example snapshot, not a durable fact.
- Valve's official [Most Played](https://store.steampowered.com/charts/mostplayed/) page is a top-100 UI chart labeled “By Current Players” and shows current players and peak today. It is a bounded presentation, not a documented bulk-history API.

### Inference

VaporStats must write its own collection timestamp beside each player-count response. Historical availability starts at the first successful collection; no backfill can be promised from Valve's public Web API. A missing/zero/error response must remain distinguishable from a genuine zero, because the endpoint documents a result code and Steam may be unavailable.

## 3. Five-minute caching and practical freshness

### Documented facts

- Valve's Web API response documentation lists HTTP 429 (“Too Many Requests”) as rate limiting, but does not publish a universal numeric interval or per-method quota. [Valve: Error codes and responses](https://partner.steamgames.com/doc/webapi_overview/responses)
- Valve's Web API Terms limit an application to **100,000 calls per day**. The Terms were last updated in July 2010, so this is a documented policy ceiling that may change, not a guarantee about current enforcement or a claim about every Steam protocol. [Steam Web API Terms](https://steamcommunity.com/dev/apiterms)

### Comparator evidence (not a Valve guarantee)

SteamDB's FAQ says it reads concurrent counts directly from Steam's API, updates its top 800 games every five minutes and other games every ten minutes, and cannot update more often because Steam itself caches player counts for around five minutes. This is SteamDB's operational observation and schedule, not Valve documentation or a VaporStats quota. [SteamDB FAQ: player-count peaks](https://steamdb.info/faq/#why-steamdb-s-player-count-peaks-are-higher-than-other-sites)

### Inference

Five-minute polling is a reasonable **freshness floor for a single game's observed value**, not a catalog-wide requirement or guarantee. Polling faster can repeatedly obtain the same cached value, while polling every game at that cadence quickly exceeds the known daily call budget. The value shown to users should carry a collection time and should not be described as live or exact to the second.

## 4. Store metadata, prices, and regional inputs

### Documented facts

- Valve's pricing documentation says partners manage product prices in **37 currencies and 4 region groups**. A missing currency price can make a product unavailable in countries that use that currency. Price changes are reviewed by Valve; pricing changes cannot be scheduled automatically by the partner. [Valve: Pricing](https://partner.steamgames.com/doc/store/pricing)
- `IStoreService/GetAppList` items expose `last_modified`, described as the last time some information or price changed (not all such changes need to be visible in the store), and `price_change_number`, whose change indicates that the item's price **may** have changed. [Valve: IStoreService/GetAppList](https://partner.steamgames.com/doc/webapi/IStoreService#GetAppList)

### Observations: `api/appdetails`

Valve does not list `store.steampowered.com/api/appdetails` in the Steamworks Web API reference. Direct requests nevertheless returned useful JSON:

- [Released paid game, USD](https://store.steampowered.com/api/appdetails?appids=292030&cc=us&l=english) returned `type: "game"`, `steam_appid`, `is_free`, `price_overview` (`currency`, integer `initial`/`final`, discount percent and formatted values), package data, DLC IDs, and `release_date` (`coming_soon` plus a display date).
- [The same game, GBP](https://store.steampowered.com/api/appdetails?appids=292030&cc=gb&l=english&filters=price_overview) returned a GBP price and formatted value, demonstrating that the observed `cc` input changes the regional response.
- [A DLC app](https://store.steampowered.com/api/appdetails?appids=5006530&cc=us&l=english) returned `type: "dlc"` and a `fullgame` object pointing to App ID `292030`, with its own package/pricing/release fields.
- A two-AppID request with `appids=292030,440` returned two keyed objects in one response during this research. Batching, request-size limits, cache behavior, authentication, schema stability, and rate limits are **undocumented**; do not treat this single observation as a batching contract.

### Inference and boundary

Use the documented catalog feed's modification markers to find price candidates, then request store details only for the selected country/currency inputs. Treat price values as current regional observations, not price history. Preserve the returned currency and raw numeric values; do not assume that a formatted string is a canonical monetary representation. A full sweep of every game for every supported country would multiply requests by the number of country/currency inputs and is not justified by a documented Store API contract.

## 5. DLC and related applications

### Documented facts

- DLC may be free or paid, has its own App ID, and is linked to the base application. In Steam's client, DLC appears under the game rather than as a separate top-level game entry. [Valve: DLC](https://partner.steamgames.com/doc/store/application/dlc)
- Valve says DLC is treated as an integral part of the game after ownership and that DLC depots are managed under the base app. This relationship is not evidence that DLC has an independent playable population. [Valve: DLC](https://partner.steamgames.com/doc/store/application/dlc)

### Observation and inference

The live `appdetails` payload shows the base game's `dlc` array and a DLC's `fullgame` parent object. For the initial playable-game scope, model this as a related-app relationship, retain DLC pricing/release metadata, and do not issue player-count requests for DLC App IDs. This keeps DLC discoverable without representing accessory entities as independent playable games.

## 6. Release metadata

### Documented facts

- Valve requires a specific intended release date in Steamworks, but separately lets the publisher choose what players see: exact date, month/year, quarter, year, or “Coming Soon.” The player-facing date is localized, and list ordering uses the last possible date of the displayed range. [Valve: Release dates](https://partner.steamgames.com/doc/store/release_dates)
- The intended date can be changed only until two weeks before it; once the visibility window starts, it cannot be adjusted. [Valve: Release dates](https://partner.steamgames.com/doc/store/release_dates)

### Observation and inference

`appdetails` exposes a public `release_date` object, but its date string is a store-facing value. It must not be presented as the private exact intended date when Steam is showing a month, quarter, year, or “Coming Soon.” For a public release tracker, retain the raw display string and `coming_soon` state; treat date changes as metadata changes discovered through catalog modification polling, not as a guaranteed event stream.

## 7. Change signals and patch history

### Documented signals

1. **Catalog metadata/price:** `last_modified`, `if_modified_since`, and `price_change_number` on `IStoreService/GetAppList` are the strongest documented broad-catalog signal. The feed can return only items modified since a Unix timestamp, and pagination is deterministic by App ID. [Valve: IStoreService/GetAppList](https://partner.steamgames.com/doc/webapi/IStoreService#GetAppList)
2. **Publisher news:** `ISteamNews/GetNewsForApp` is public and accepts `appid`, `count`, `enddate`, `feeds`, and `maxlength`; entries include a Unix `date`, feed, title, URL, and contents. The publisher-only `GetNewsForAppAuthed` can include unreleased games owned by that publisher. News is useful for release notes and announcements but is not a complete build/update log. [Valve: ISteamNews](https://partner.steamgames.com/doc/webapi/ISteamNews)
3. **Publisher build history:** `ISteamApps/GetAppBuilds` returns build history but requires the publisher API key that owns the App ID. It is therefore not a whole-Steam patch source for VaporStats. [Valve: ISteamApps/GetAppBuilds](https://partner.steamgames.com/doc/webapi/ISteamApps#GetAppBuilds)

### Supplementary implementation evidence, not a Valve contract

SteamKit's public source exposes `PICSGetChangesSince`, app/package change numbers, full-update flags, token requests, and `PICSGetProductInfo` callbacks (including metadata-only and pending-response states). This is evidence of a Steam-client-network path used when Valve has no public catalog change API; it is a community library implementation, requires a Steam network session, and should not be treated as a supported anonymous Web API. [SteamKit: SteamApps.cs](https://github.com/SteamRE/SteamKit/blob/master/SteamKit2/SteamKit2/Steam/Handlers/SteamApps/SteamApps.cs), [SteamKit: Callbacks.cs](https://github.com/SteamRE/SteamKit/blob/master/SteamKit2/SteamKit2/Steam/Handlers/SteamApps/Callbacks.cs)

SteamDB's FAQ is comparator evidence only: it says SteamDB relies mostly on Steam's own update system, uses SteamKit, parses store pages when APIs do not expose needed fields, and treats PICS change numbers as global notifications that can include batch changes. It also says its patchnotes RSS is heavily cached and not intended for automatic monitoring. [SteamDB FAQ: data sources](https://steamdb.info/faq/#how-are-we-getting-this-information), [SteamDB FAQ: changenumber](https://steamdb.info/faq/#changenumber), [SteamDB FAQ: RSS](https://steamdb.info/faq/#do-you-have-an-rss-for-game-updates)

### Inference

Use the catalog feed as the broad change detector, then fetch changed records. Use news as an optional explanatory/patch-history input. Do not claim complete patch history for arbitrary apps from the public Web API; build history and private/unreleased data are publisher- or account-scoped, and Steam-client PICS behavior is outside the documented public contract.

## 8. Authentication and operational limits

### Documented facts

- Public Web API methods may be callable without authorization, but other methods require a unique key. User keys require a Steam account and associated domain; publisher keys are tied to a Steamworks publisher group and can have app, permission, and IP-allowlist restrictions. Keys must remain confidential, use HTTPS, and must not be shipped to clients. [Valve: authentication using Web API keys](https://partner.steamgames.com/doc/webapi_overview/auth)
- The public Web API is `api.steampowered.com`; Valve provides `partner.steam-api.com` for secure publisher servers. Valve says the partner host requires a publisher key on every request and warns that 403-generating requests incur strict rate limits for the connecting IP. [Valve: Web API overview](https://partner.steamgames.com/doc/webapi_overview)
- Valve documents HTTP 429 for rate limiting but does not publish a universal per-second, per-minute, or per-endpoint numeric quota. [Valve: Error codes and responses](https://partner.steamgames.com/doc/webapi_overview/responses)
- The Terms' 100,000-call/day limit applies to the Steam Web API as written, but the Terms date from 2010 and Valve reserves the right to change, suspend, or terminate the API. [Steam Web API Terms](https://steamcommunity.com/dev/apiterms)
- `api/appdetails` has no Valve-published authentication or rate-limit documentation. Its observed availability without a key is not an entitlement.
- `ISteamWebAPIUtil/GetSupportedAPIList` can list supported calls; Valve documents that a key is required to receive restricted methods. This is useful for checking the key's current visibility, not for bypassing access controls. [Valve: ISteamWebAPIUtil](https://partner.steamgames.com/doc/webapi/ISteamWebAPIUtil)

### Inference

A catalog-wide public service must treat API-key access, partner-host authorization, 429s, 403s, schema changes, and endpoint withdrawal as normal failure modes. The evidence supports a bounded, budget-aware polling policy; it does not support promising a fixed global cadence or relying on undocumented Store API behavior.

## 9. Polling arithmetic

The calculations below use the Terms' 100,000-call/day figure as a conservative known budget. They are arithmetic scenarios, **not** claims about the actual number of Game apps or an endpoint-specific Valve quota. They also exclude catalog pages, store metadata, news, retries, and failures, so real capacity is lower.

For `N` apps sampled every `T` minutes:

`calls/day = N × (1,440 / T)`

| Current-player cadence | Calls per app/day | Apps fitting 100,000 calls/day (players only) | Minimum interval for N apps |
| --- | ---: | ---: | ---: |
| 5 minutes | 288 | 347 | `0.864 × N` seconds |
| 10 minutes | 144 | 694 | `0.432 × N` seconds |
| 1 hour | 24 | 4,166 | `0.0864 × N` seconds |
| 1 day | 1 | 100,000 | `0.000864 × N` seconds |

Examples:

- 5,000 apps at five-minute cadence: 1,440,000 player calls/day; the budget-only lower bound is **72 minutes** per app to cover all 5,000.
- 10,000 apps at five-minute cadence: 2,880,000 calls/day; the budget-only lower bound is **144 minutes (2.4 hours)** per app.
- 50,000 apps at five-minute cadence: 14,400,000 calls/day; the budget-only lower bound is **12 hours** per app.
- A one-time catalog page fetch costs `ceil(G / 50,000)` requests at the documented maximum page size for `G` returned items. Incremental `if_modified_since` requests can reduce payload and follow-up work, but do not make a five-minute player sweep affordable.
- A scenario of 10,000 games and four regional price inputs is 40,000 observed `appdetails` requests per full price sweep before any retries or other endpoints. This is a scenario only; batching is undocumented and the endpoint has no documented quota.

## 10. Research limits and unresolved validation

- The scalable catalog endpoint requires a key, and the documentation's “any web API key” wording conflicts with the overview's partner-host publisher-key requirement. Before implementation, validate the exact key class and account permission available to VaporStats.
- Valve publishes no numeric endpoint-specific limit for current players and no documented five-minute cache TTL. Maintain explicit 429/403 observations if an implementation is tested; do not convert one test into a universal limit.
- The Store `appdetails` endpoint has no Valve schema or SLA. Revalidate its fields, regional semantics, batching behavior, and access policy before depending on it.
- The public sources surveyed do not provide historical concurrent-player data or a general public build-history feed. Those histories must either be collected prospectively or omitted.
- Steam client/PICS change notifications may reduce polling but require a separate security, account, and availability assessment. This note does not recommend adopting that path as baseline.

## Source register

**Valve/Steam primary sources**

- [Web API overview](https://partner.steamgames.com/doc/webapi_overview)
- [Web API key authentication](https://partner.steamgames.com/doc/webapi_overview/auth)
- [Error codes and responses](https://partner.steamgames.com/doc/webapi_overview/responses)
- [Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms)
- [ISteamApps](https://partner.steamgames.com/doc/webapi/ISteamApps)
- [IStoreService](https://partner.steamgames.com/doc/webapi/IStoreService)
- [ISteamUserStats](https://partner.steamgames.com/doc/webapi/ISteamUserStats)
- [ISteamNews](https://partner.steamgames.com/doc/webapi/ISteamNews)
- [ISteamWebAPIUtil](https://partner.steamgames.com/doc/webapi/ISteamWebAPIUtil)
- [Steam applications](https://partner.steamgames.com/doc/store/application)
- [Steam DLC](https://partner.steamgames.com/doc/store/application/dlc)
- [Steam pricing](https://partner.steamgames.com/doc/store/pricing)
- [Steam release dates](https://partner.steamgames.com/doc/store/release_dates)
- [Steam Most Played UI](https://store.steampowered.com/charts/mostplayed/)
- [Observed current-player response](https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=440)
- [Observed appdetails: game/USD](https://store.steampowered.com/api/appdetails?appids=292030&cc=us&l=english)
- [Observed appdetails: game/GBP filtered](https://store.steampowered.com/api/appdetails?appids=292030&cc=gb&l=english&filters=price_overview)
- [Observed appdetails: DLC](https://store.steampowered.com/api/appdetails?appids=5006530&cc=us&l=english)

**Comparator and implementation evidence**

- [SteamDB FAQ](https://steamdb.info/faq/)
- [SteamKit SteamApps source](https://github.com/SteamRE/SteamKit/blob/master/SteamKit2/SteamKit2/Steam/Handlers/SteamApps/SteamApps.cs)
- [SteamKit callbacks source](https://github.com/SteamRE/SteamKit/blob/master/SteamKit2/SteamKit2/Steam/Handlers/SteamApps/Callbacks.cs)
