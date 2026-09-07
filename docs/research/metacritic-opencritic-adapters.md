# Metacritic and OpenCritic ingestion adapters and constraints

**Ticket:** [#25](https://github.com/phenome/vaporstats/issues/25)  
**Branch:** `research/metacritic-opencritic-adapters`  
**Research captured:** 2026-09-06

## Decision summary

- OpenCritic publishes a versioned Swagger/OpenAPI description for a REST API intended for retailers, developers, and other users. The documented game routes are `/game/{id}` and `/game/search?criteria=...`; the live `api.opencritic.com/api/game/...` route currently rejects requests without a RapidAPI key. Use the authorized API, not website scraping, if access and product permission are obtained.
- The OpenCritic game schema contains the fields VaporStats needs (`topCriticScore`, `percentRecommended`, `numReviews`, `tier`) and also a documented `steamId` field. Search results contain an OpenCritic ID, title, and a trigram-distance value. Cache the resulting OpenCritic ID and URL after a verified match rather than searching on every sync.
- OpenCritic's current API listing has explicit attribution, deletion, commercial-use, and non-competing-product conditions. A public quality or review-aggregation product may fall within the competing-product restriction; this is an access/licensing gate, not something to work around with scraping. Obtain written approval and the applicable plan before implementing an OpenCritic adapter for VaporStats.
- Metacritic exposes critic and user scores, but scores are platform-specific and may be absent. The current page-rendering backend returns a product slug plus a platform array; this JSON is an observed internal interface, not a published developer API. Do not make catalog ingestion depend on reverse-engineered backend calls or HTML scraping without a written data license.
- Steam's observed `appdetails` payload can provide a PC Metacritic score and URL for some apps. Treat that URL as the strongest available Metacritic cross-reference when present, then validate title, edition, release year, and PC platform. A Steam AppID cannot be converted deterministically to a Metacritic slug.
- Use a low-frequency critic sync: weekly for recently released or recently matched games, and monthly for mature games if a smaller maintenance budget is needed. Scores can change when reviews are added or corrected, and Metacritic user scores can continue to move, but neither source warrants player-count-style polling.
- Matching is high-confidence only when a source ID/URL is directly tied to the Steam AppID. For title-derived candidates, require agreement on normalized title, release year, platform, and edition/developer evidence; send ambiguous multi-platform, remaster, remake, complete-edition, or DLC cases to a review queue. Never substitute a console score for the PC score of a Steam listing.
- Missing coverage is a normal state. Store no score (rather than zero or a fabricated estimate), retain Steam/player evidence independently, and suppress repeated searches for unresolved indie titles until a later retry window.

This is a source assessment, not an implementation or a Wayfinder map change.

## Evidence labels

- **Documented fact** — stated in an official API specification, terms page, robots.txt, or first-party documentation.
- **Observation** — a response, header, or rendered payload observed from a live endpoint on the capture date. An observation is not a promise that the provider will preserve the interface.
- **Inference** — a project conclusion derived from documented facts and observations; it is labelled so it is not confused with a provider guarantee.

## 1. OpenCritic API contract and live access

### Documented facts

- OpenCritic's published [Swagger/OpenAPI definition](https://api.swaggerhub.com/apis/OpenCritic/OpenCritic-API/1.0.0) describes an API for retailers, developers, and other users. It names `developers@opencritic.com` as the API contact and identifies the [OpenCritic API portal on RapidAPI](https://rapidapi.com/opencritic-opencritic-default/api/opencritic-api) as the access point.
- The documented base host in the specification is `opencritic-api.p.rapidapi.com`. The API paths are `/game/{id}` for a game ID and `/game/search` with required query parameter `criteria`. The older-looking direct form requested for this research is `https://api.opencritic.com/api/game/{id}` and `https://api.opencritic.com/api/game/search?criteria=...`; it reaches an API gateway but is not anonymous.
- `/game/search` returns an array of `{id, name, dist}` objects. `dist` is described as the percentage of trigram matches on the smaller term: `0` is a perfect match, `1` means no overlap, and values below `0.35` are generally close. This is a candidate-ranking signal, not proof of identity.
- `/game/{id}` returns a `Game` object. The schema requires `id` and `name` and documents `url`, `type`, `firstReleaseDate`, `firstReviewDate`, `latestReviewDate`, `createdAt`, `updatedAt`, `Companies`, `Platforms`, and the score fields below.
- `topCriticScore` is the top-critic average and is `-1` when there are not enough reviews for that metric. `percentRecommended` is the percentage of all critics recommending the title and is `-1` when there are not enough reviews. The schema says it should be rounded to the nearest integer for display.
- `numReviews` counts all critic reviews and `numTopCriticReviews` counts top-critic reviews. `medianScore` is the OpenCritic median; `averageScore` is the average of all reviews and is explicitly not the top-critic score shown on opencritic.com.
- `tier` is one of blank, `Weak`, `Fair`, `Strong`, or `Mighty`; blank means there are not enough reviews for that metric. A score of `-1` or a blank tier must remain an absent/insufficient-evidence state, not a numeric zero.
- The `Game` schema documents `steamId` as the Steam ID of the game and types it as a string. When an authorized response supplies it, it is a direct AppID cross-reference rather than a title guess.
- `Platforms` contains platform IDs, names, short names, release dates, and optional display-release ranges. The browse endpoint accepts platform filters such as `pc`, `ps4`, `xb1`, and `switch`, and can sort by score, date, name, review count, or percentage recommended. The enum in this published specification is older than OpenCritic's current site navigation, so a client must not assume that its platform list is exhaustive.
- The review route `/review/game/{id}` returns at most ten reviews per request and supports sorting by score, popularity, blend, or date. A review includes its external URL, adjusted 0–100 score, recommendation indicator, outlet, authors, and platform data. VaporStats does not need individual reviews for a first adapter; aggregate fields are sufficient.

### Observations

- On the capture date, `GET https://api.opencritic.com/api/game/7858` returned HTTP `400` with `{"message":"API key is required. Go to https://rapidapi.com/opencritic-opencritic-default/api/opencritic-api to sign up to use the OpenCritic API."}`. `GET https://api.opencritic.com/api/game/search?criteria=Hades` returned the same response. This confirms the requested route shape exists but does not provide an unauthenticated data feed.
- The same unauthenticated responses included a gateway `ratelimit` header of `"100-in-1sec"`; that header describes the gateway response observed for this request, not the quota assigned to a VaporStats subscription.
- The live [OpenCritic game page](https://opencritic.com/game/463/the-witcher-3-wild-hunt) serialized a game payload containing `percentRecommended: 95.29411764705881`, `numReviews: 180`, `numTopCriticReviews: 152`, `medianScore: 95`, `topCriticScore: 92.53623188405797`, `tier: "Mighty"`, and the title `The Witcher 3: Wild Hunt`. The page is useful as a human-readable observation only; it is not a substitute for the authorized API contract.
- The [OpenCritic robots.txt](https://opencritic.com/robots.txt) observed on the capture date contains `User-agent: *`, a sitemap, and only `Disallow: /profile`. It does not grant a data-reuse license or override the API terms.

### RapidAPI limits and access terms

- The current [OpenCritic API RapidAPI listing](https://rapidapi.com/opencritic-opencritic-default/api/opencritic-api) is marked `FREEMIUM` and requires a RapidAPI subscription/key. Its publicly embedded plan data observed on the capture date listed the free BASIC plan as **25 searches/day**, **200 total requests/day**, and **4 requests/second**. The listed ULTRA plan showed **4,000 searches/day**, **2,000 total requests/day**, and **20 requests/second**; plan prices and limits are provider-controlled and may change.
- The API listing's terms say to credit OpenCritic with a do-follow link on any page using its data; when displaying the Top Critic Average, link to the OpenCritic game page and show the name `OpenCritic` or its full logo nearby. The terms also say not to use OpenCritic data to build another game/review aggregator or expose it through another API, that access may be revoked, and that OpenCritic may require deletion of acquired data within 60 days.
- The same terms require a Commercial/MEGA plan to monetize in any form and require Commercial/MEGA plus credit in an app-store description when publishing an app to an app store. Commercial status does not remove the separate non-competing-product language.
- OpenCritic's [site Terms of Use](https://opencritic.com/terms), effective September 25, 2020, grant only a revocable, non-transferable license for site use, prohibit obtaining materials by means not intentionally made available through the site, and state that protected content is for personal use unless express written permission is obtained. Those terms reinforce using the authorized API rather than scraping the site.

### Inference for VaporStats

The API has enough structure for a bounded adapter after access approval: search a new Steam title once, verify the candidate, persist the OpenCritic ID/URL and source platform, then fetch the game record on a weekly/monthly schedule. The free plan is not a catalog-wide mapping feed: 25 searches/day and 200 total requests/day require a small candidate set and aggressive ID caching. The API terms make written permission a prerequisite for VaporStats's living quality/review product; an adapter must not be built first and licensed later.

## 2. Metacritic scores and platform representation

### Documented facts

Metacritic's public game pages expose separate critic and user areas. The score labels and scales are distinct: critic **Metascore** is 0–100, while user score is 0–10. A user score is not a critic score and should not be silently rescaled into the critic field.

### Observations: current product and score payloads

- The live [Metacritic page for The Witcher 3: Wild Hunt](https://www.metacritic.com/game/the-witcher-3-wild-hunt/) showed a JSON-LD `AggregateRating` with `name: "Metascore"`, `ratingValue: 92`, `bestRating: 100`, `worstRating: 0`, and a review-count value. The page visibly rendered a separate `User score` value of `9.1` out of 10.
- The page's observed backend product request was [this JSON endpoint](https://backend.metacritic.com/games/metacritic/the-witcher-3-wild-hunt/web?componentName=product&componentDisplayName=Product&componentType=Product). It returned a product title and slug, a lead platform, critic summary, and a `platforms` array. For the captured product it returned:
  - PC: score **93**, normalized score `93.4762`, **33** critic reviews;
  - Xbox One: score **91**, normalized score `91.2632`, **13** critic reviews;
  - PlayStation 4: score **92**, normalized score `91.9817`, **80** critic reviews and the lead-platform flag;
  - Nintendo Switch: null score and null review count.
- The observed [critic summary endpoint](https://backend.metacritic.com/reviews/metacritic/critic/games/the-witcher-3-wild-hunt/stats/web?componentName=critic-score-summary&componentDisplayName=Critic+Score+Summary&componentType=MetaScoreSummary) returned a 0–100 score summary. The observed [user summary endpoint](https://backend.metacritic.com/reviews/metacritic/user/games/the-witcher-3-wild-hunt/stats/web?componentName=user-score-summary&componentDisplayName=User+Score+Summary&componentType=UserScoreSummary) returned `score: 9.1`, `max: 10`, and a user review count of `20010` for the lead platform.
- The backend product payload contains a numeric internal product ID, human title, slug, platform records, release date, companies, and taxonomy, but no Steam AppID. The backend endpoints are implementation details discovered from page requests; Metacritic does not publish them as a developer API contract.
- Steam's observed [appdetails payload for AppID 292030](https://store.steampowered.com/api/appdetails?appids=292030&cc=us&l=english) returned the name `The Witcher 3: Wild Hunt - Complete Edition` and:
  ```json
  "metacritic": {
    "score": 93,
    "url": "https://www.metacritic.com/game/pc/the-witcher-3-wild-hunt?ftag=MCD-06-10aaa1f"
  }
  ```
  This is a useful direct PC cross-reference, but `appdetails` itself is an observed Steam Store interface rather than a documented Metacritic integration contract.
- The same Steam payload demonstrates edition ambiguity: Steam names the app `...Complete Edition`, while the linked Metacritic URL uses the base slug `the-witcher-3-wild-hunt`. The current Metacritic site also has a separate [Complete Edition page](https://www.metacritic.com/game/the-witcher-3-wild-hunt-complete-edition/). A slug or title match alone cannot decide whether those records should be merged.
- Coverage is not universal. On the capture date, successful Steam `appdetails` requests for [AppID 2950790](https://store.steampowered.com/api/appdetails?appids=2950790&cc=us&l=english) (`IRON NEST: Heavy Turret Simulator`) and [AppID 2915460](https://store.steampowered.com/api/appdetails?appids=2915460&cc=us&l=english) (`OneShot: World Machine Edition`) contained no `metacritic` object. This is the expected missing-coverage shape: a valid Steam game with no critic cross-reference.

## 3. Metacritic access policy: API, robots.txt, and terms

### Documented facts

- No public Metacritic developer API or terms-sanctioned score feed was identified in the official Metacritic pages reviewed. The site does serve JSON to its own frontend, but the backend URLs above are undocumented internal requests, not a supported integration surface. A private data partnership could change this conclusion and must be checked before implementation.
- The current [Metacritic robots.txt](https://www.metacritic.com/robots.txt) disallows `/search`, `/signup`, `/login`, `/user`, `/jl/`, and selected ad paths for `User-agent: *`. It disallows `/` for several named crawlers, including `GPTBot`, `OAI-SearchBot`, `CCBot`, `SemrushBot`, and others, while listing public sitemaps. Robots directives are crawler instructions, not a license to copy score data.
- Metacritic's footer links to the [Fandom Terms of Use](https://www.fandom.com/terms-of-service-pp1), which identify the Gamespot, Metacritic, TVGuide, ComicVine, and GameFAQs services and show a **Date of Last Revision: August 22, 2025**.
- Those terms prohibit engaging in unauthorized spidering, scraping, data mining, harvesting of Content, or other unauthorized automated means to gather data from or about the Services. They separately prohibit, without express prior written consent, using or copying Content for development of software. The terms permit termination of access for violations.

### Inference for VaporStats

Metacritic scraping, reverse-engineering its internal JSON, or polling page HTML is outside the safe baseline. Use a licensed/sanctioned feed if one becomes available; otherwise consume only a stable, provider-authorized cross-reference such as a Steam payload URL and keep Metacritic data absent where no authorized source exists. Respect robots.txt regardless of whether a requested game page happens to be crawlable.

## 4. Steam AppID, slug, platform, and edition matching

### Documented facts

- Steam uses a numeric AppID for an app; OpenCritic's schema uses its own numeric game ID plus a `steamId` string; Metacritic uses a numeric internal ID and a human-readable slug. None of these identifiers is mathematically derivable from the other.
- The OpenCritic `steamId` field is the preferred mapping key when present in an authorized API response. OpenCritic search `dist` can rank candidates but cannot establish a match by itself.
- A Steam Store `appdetails` response may include a Metacritic URL for the PC release. When present, the URL supplies a source-owned slug and is stronger than generating one from the Steam name. Its absence is not evidence that Metacritic has a page.
- Metacritic's platform array and Steam's PC app identity are separate dimensions. A single Metacritic product can have different scores and review counts for PC, PlayStation, Xbox, and Switch, and a platform can have no score at all.

### Matching policy

1. **Exact source link first.** For Metacritic, prefer the Steam-provided URL and record the source URL/slug, Steam AppID, and `platform=PC`. For OpenCritic, prefer a returned `steamId` equal to the Steam AppID and retain the OpenCritic ID/URL.
2. **Verify the record.** Compare normalized title, release year, and platform. Also compare developer/publisher where available. Keep the original source title and URL so a reviewer can audit the decision.
3. **Keep editions separate by default.** A base game, complete/GOTY edition, remake, remaster, expansion, and DLC are different candidate records. Merge only when the source explicitly identifies the edition as equivalent or a human approves it; do not let a nearby slug silently inherit a score.
4. **Choose PC for Steam.** If a Steam AppID represents a PC release, use the Metacritic PC critic score and a platform-matched OpenCritic query/record where available. Do not use the lead platform's console score merely because it has more reviews, and do not blend console scores into the Steam critic field.
5. **Reject ambiguity.** Equal or near-equal title candidates, year conflicts, platform-only conflicts, sequel/remaster ambiguity, and missing edition evidence remain unresolved. They should not be auto-linked from a fuzzy score.
6. **Persist negative outcomes.** Record that a lookup was attempted and returned no verified coverage, with a retry time. Treat `null`, OpenCritic `-1`, and blank tier as absent evidence, not a low rating.

## 5. VideoGamesCritic and comparable matching patterns

### Observations from VideoGamesCritic

- The live [VideoGamesCritic game page for Steam AppID 292030](https://videogamescritic.com/game/292030) uses the Steam AppID as its route and links to `https://store.steampowered.com/app/292030`. The same page links to [Metacritic's Complete Edition page](https://www.metacritic.com/game/the-witcher-3-wild-hunt-complete-edition/) and displays separate Metacritic critic and user values. This proves a local cross-reference exists for that record; it does not expose the site's ingestion code or a general mapping API.
- The page footer lists its data sources as Steam reviews/patch notes, OpenCritic press scores, and IGDB metadata. The public [methodology](https://videogamescritic.com/methodology) additionally names Metacritic critic and user scores, including per-platform critic scores.
- The methodology's port section states that Steam reviews describe the PC game, that a Switch or last-generation port can be a different product, and that console browse scores use that platform's Metacritic critics, the game's Metacritic player pool, and that platform's store ratings. It says Steam never counts as console evidence and keeps thin port evidence marked as PC ratings rather than pretending it is a console verdict.
- The live [VideoGamesCritic robots.txt](https://videogamescritic.com/robots.txt) allows search indexing but disallows `/api/` and `/stats` for `User-agent: *`, and contains Cloudflare content signals. This is comparator evidence about another service's access boundary, not permission to copy its data.

### Similar service evidence

- The official [IGDB API documentation](https://api-docs.igdb.com/) documents `external_games` records with a `category`, `uid`, `game`, and `url`. Its enum identifies `steam` as category `1`; the `websites` category table identifies Steam as `13`. IGDB can therefore serve as an identity spine for a Steam URL when a project already has approved IGDB access, but the documented fields do not provide a Metacritic/OpenCritic guarantee.
- The practical common pattern is a source-owned identity spine (Steam AppID or IGDB game plus external URL), followed by a verified source URL and platform/edition checks. A fuzzy title result is a candidate queue, not a safe automatic cross-reference.

### Inference

VideoGamesCritic's public page shape is consistent with a precomputed local mapping keyed by Steam AppID and storing source URLs, rather than deriving Metacritic slugs at request time. VaporStats should copy the safe boundary—not the service's unverified implementation assumptions: persist an auditable mapping and keep unresolved candidates out of score calculations. Adding IGDB solely to compensate for missing Metacritic/OpenCritic IDs would add a second paid/credentialed dependency; it is not required for the initial adapter.

## 6. Safe operational envelope

### Cadence

- **Baseline:** one critic-source sync per week for games released or matched within the last 90 days; one sync per month for mature games. If VaporStats needs one simple schedule, weekly is sufficient and avoids a second scheduler.
- **Why not player polling:** critic review counts and aggregates move slowly after launch. OpenCritic documents `latestReviewDate` and notes that `updatedAt` does not necessarily change for every new review; Metacritic scores can change for new or corrected reviews, while user scores can continue to accumulate. Neither needs the 15-minute observation cadence used for player counts.
- **Efficient work:** search only new/unresolved Steam apps, detail-fetch by persisted source ID thereafter, cache successful and negative lookups, and back off on 401/403/429 responses. A weekly schedule must not imply a provider SLA or guaranteed score freshness.

### Confidence tiers

- **High confidence:** OpenCritic `steamId` equals the Steam AppID; or Steam `appdetails.metacritic.url` points to a PC page and returned title/year/edition evidence agrees.
- **Medium confidence:** exact normalized title plus matching release year, PC platform, and matching developer/publisher, with one source URL recorded. Keep this for manual approval before it contributes to a quality blend.
- **Unresolved:** title-only/fuzzy match, conflicting years, multiple editions, sequel/remaster/expansion ambiguity, or console-only coverage. Do not ingest automatically.

### Missing-coverage behavior

- A missing OpenCritic page, OpenCritic `-1`/blank metrics, missing Steam Metacritic object, missing Metacritic platform score, or rejected backend request produces `null` critic-source evidence with provenance, not score `0`.
- Continue showing Steam/player evidence and other product data. Do not backfill a missing critic score from user score, a different platform, a similarly named edition, or a third-party scraper.
- Retry unresolved games at the next monthly window or when a release/metadata change makes a new match plausible. Do not spend daily search quota repeatedly on indie titles without coverage.

## 7. Research limits and unresolved validation

- OpenCritic's published spec documents `steamId`, but an authorized success response was not available without a RapidAPI key during this research. Before implementation, validate the exact key class, plan, attribution, retention, and non-competing-product permission for VaporStats.
- The OpenCritic spec's platform enum is older than the current site navigation. Validate current PC/platform identifiers and whether platform-filtered aggregate scores are returned as expected before storing a platform-specific field.
- Metacritic's internal backend payloads were observed successfully but have no public schema, SLA, authentication contract, or rate limit. Do not ship an adapter against them without written authorization.
- Steam `appdetails` field presence and Metacritic URL format were observed, not promised. Re-check the payload before treating it as a durable cross-reference.
- The exact legal interpretation of OpenCritic's competing-product condition and Fandom's automated-access terms requires provider permission/legal review; this note intentionally does not turn a technical observation into legal advice.
- No source surveyed provides a universal, provider-owned Steam AppID-to-both-platforms mapping. A mapping table must retain provenance and be repairable when titles, editions, or source slugs change.

## Source register

**OpenCritic primary sources**

- [OpenCritic API Swagger/OpenAPI definition](https://api.swaggerhub.com/apis/OpenCritic/OpenCritic-API/1.0.0)
- [OpenCritic API RapidAPI listing, plans, and API-specific terms](https://rapidapi.com/opencritic-opencritic-default/api/opencritic-api)
- [OpenCritic API endpoint observed without a key](https://api.opencritic.com/api/game/7858)
- [OpenCritic game search endpoint observed without a key](https://api.opencritic.com/api/game/search?criteria=Hades)
- [OpenCritic live game page observation](https://opencritic.com/game/463/the-witcher-3-wild-hunt)
- [OpenCritic robots.txt](https://opencritic.com/robots.txt)
- [OpenCritic Terms of Use](https://opencritic.com/terms)

**Metacritic/Fandom primary sources**

- [Metacritic game page](https://www.metacritic.com/game/the-witcher-3-wild-hunt/)
- [Metacritic critic-reviews page](https://www.metacritic.com/game/the-witcher-3-wild-hunt/critic-reviews/)
- [Metacritic user-reviews page](https://www.metacritic.com/game/the-witcher-3-wild-hunt/user-reviews/)
- [Metacritic product JSON observed by its frontend](https://backend.metacritic.com/games/metacritic/the-witcher-3-wild-hunt/web?componentName=product&componentDisplayName=Product&componentType=Product)
- [Metacritic critic summary JSON observed by its frontend](https://backend.metacritic.com/reviews/metacritic/critic/games/the-witcher-3-wild-hunt/stats/web?componentName=critic-score-summary&componentDisplayName=Critic+Score+Summary&componentType=MetaScoreSummary)
- [Metacritic user summary JSON observed by its frontend](https://backend.metacritic.com/reviews/metacritic/user/games/the-witcher-3-wild-hunt/stats/web?componentName=user-score-summary&componentDisplayName=User+Score+Summary&componentType=UserScoreSummary)
- [Metacritic robots.txt](https://www.metacritic.com/robots.txt)
- [Fandom Terms of Use governing Metacritic](https://www.fandom.com/terms-of-service-pp1)

**Steam cross-reference observations**

- [Steam appdetails for AppID 292030](https://store.steampowered.com/api/appdetails?appids=292030&cc=us&l=english)
- [Steam appdetails without Metacritic coverage: AppID 2950790](https://store.steampowered.com/api/appdetails?appids=2950790&cc=us&l=english)
- [Steam appdetails without Metacritic coverage: AppID 2915460](https://store.steampowered.com/api/appdetails?appids=2915460&cc=us&l=english)

**Comparator and identity-spine evidence**

- [VideoGamesCritic game page for Steam AppID 292030](https://videogamescritic.com/game/292030)
- [VideoGamesCritic methodology](https://videogamescritic.com/methodology)
- [VideoGamesCritic robots.txt](https://videogamescritic.com/robots.txt)
- [IGDB API documentation](https://api-docs.igdb.com/)
