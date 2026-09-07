# Steam review summary and histogram ingestion constraints

**Ticket:** [#24](https://github.com/phenome/vaporstats/issues/24)  
**Branch:** `research/steam-review-ingestion`  
**Research captured:** 2026-09-06

## Decision summary

- Use the documented Steam Store **User Reviews - Get List** endpoint's `query_summary` as the current review snapshot. Request `num_per_page=0` with an explicit `filter=all`, `language=all`, `purchase_type=all`, `day_range=30`, and `filter_offtopic_activity=1`. This returns the aggregate counts and score without downloading review text, authors, or individual review records.
- Compare `purchase_type=steam` with `purchase_type=all` only when that distinction is needed. `steam` is the documented default, but `all` is the better canonical product snapshot when VaporStats describes sentiment across all Steam review sources. Keep the purchase filter in the stored provenance because the totals are not interchangeable.
- Use `appreviewhistogram/<appid>` for prospective, time-bucketed sentiment and review-bomb event metadata. It is an observed Store interface, not a documented Steamworks contract; parse only the fields observed in the response and retain unknown event type codes rather than treating them as a stable enum.
- Poll each tracked game once per day, distributing the two endpoint requests across the existing UTC fifteen-minute ingestion ticks. Do not scrape individual reviews or paginate cursors. At the current maximum of 1,000 tracked games, the baseline is 2,000 review requests per day, before retries or other Steam calls.
- Normalize daily summaries, monthly rollups, recent daily buckets, and event intervals in SQLite. Do not retain a full histogram JSON snapshot for every daily poll: the live samples were 6.4–16.3 KB decoded per histogram response, so raw snapshots would grow by roughly 2.3–6.0 GB per year for 1,000 games before database overhead.
- Treat HTTP 429, 403, 5xx, invalid JSON, and schema drift as per-game failures. Stop review work for the current tick after a 429, record the failure and next due time, and do not run immediate retries. Preserve the last successful summary and histogram data.

This is a source assessment for ingestion boundaries, not an implementation or a Wayfinder map change.

## Evidence labels

- **Documented fact** — stated in Valve/Steamworks documentation or the Steam Web API Terms.
- **Observation** — behavior or payload observed from a live Steam endpoint on the capture date. An observation is not a promise that Valve will preserve the behavior.
- **Inference** — a conclusion derived from the documented facts and observations; it is labelled so it is not confused with a Valve guarantee.

## 1. Documented review summary endpoint

### Documented facts

- Valve documents `GET store.steampowered.com/appreviews/<appid>?json=1` as **User Reviews - Get List**. The documented `filter` values are `recent`, `updated`, and `all`; `all` is the default and uses helpfulness windows based on `day_range`. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)
- `day_range` is a range from now to *n* days ago, is only applicable to the `all` filter, and has a documented maximum of 365. It controls the helpfulness-window behavior; it is not documented as a complete historical-review export. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)
- `purchase_type` accepts `all`, `non_steam_purchase`, or `steam`; `steam` is the documented default. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)
- `num_per_page` returns up to 20 reviews by default and accepts more reviews up to a documented maximum of 100. Cursor paging is intended for review records. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)
- Valve documents `filter_offtopic_activity` as filtering off-topic reviews, also called “Review Bombs,” by default. Passing `0` includes them. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)
- The first response includes `query_summary` with `num_reviews`, `review_score`, `review_score_desc`, `total_positive`, `total_negative`, and `total_reviews`; `cursor` is for the next page. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)

### Inference for VaporStats

Use an explicit query such as:

```text
https://store.steampowered.com/appreviews/<appid>?json=1&num_per_page=0&filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=1
```

`num_per_page=0` is not described in the parameter table as a special summary mode, so treat the empty review list as an observed behavior rather than a contractual guarantee. If Steam stops honoring zero, cap the request at the smallest supported page and discard individual records; do not page through reviews for this product.

The canonical VaporStats summary should use `purchase_type=all` and `language=all` so that the stored total represents all review sources and languages. A `steam` query is useful as a separately labelled comparison, not as a silent replacement for the canonical value. Keep `filter_offtopic_activity=1` so the summary follows Steam's default score treatment; use `0` only for diagnostics or an explicitly different product view.

## 2. Live query summary observations

### Observations

- On 2026-09-06, a `num_per_page=0` request for App ID 440 returned HTTP 200, `success: 1`, `reviews: []`, `cursor: "*"`, and a 195-byte decoded JSON body. The summary was `total_positive: 21073`, `total_negative: 6393`, `total_reviews: 27466`, `review_score: 6`, and `review_score_desc: "Mostly Positive"`. [Observed App ID 440 summary](https://store.steampowered.com/appreviews/440?json=1&num_per_page=0)
- The explicit all-language App ID 440 query with `filter=all`, `purchase_type=steam`, `day_range=30`, and `filter_offtopic_activity=1` returned HTTP 200, an empty review list, and `38,863` positive, `8,939` negative, `47,802` total reviews with `review_score_desc: "Very Positive"`. [Observed App ID 440, Steam purchases](https://store.steampowered.com/appreviews/440?json=1&num_per_page=0&filter=all&language=all&purchase_type=steam&day_range=30&filter_offtopic_activity=1)
- The corresponding `purchase_type=all` query returned HTTP 200 and `1,137,880` positive, `112,074` negative, `1,249,954` total reviews with `review_score_desc: "Very Positive"`. [Observed App ID 440, all purchase sources](https://store.steampowered.com/appreviews/440?json=1&num_per_page=0&filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=1)
- For App ID 292030 with all languages and purchase sources, `filter_offtopic_activity=1` returned `858,179` positive, `28,812` negative, and `886,991` total reviews. Passing `filter_offtopic_activity=0` returned `863,228` positive, `34,524` negative, and `897,752` total reviews. Both responses returned HTTP 200, `review_score: 9`, and `"Overwhelmingly Positive"`. [Filtered summary](https://store.steampowered.com/appreviews/292030?json=1&num_per_page=0&filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=1), [Unfiltered summary](https://store.steampowered.com/appreviews/292030?json=1&num_per_page=0&filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=0)
- The same App ID 292030 filtered summary was 206 decoded bytes and returned `Cache-Control: private,max-age=600`; no `ETag` was observed. The endpoint's returned `Date` header and the endpoint's period boundaries are server metadata, not VaporStats observation timestamps.

### Inference

The summary is a compact, low-risk source for current aggregate sentiment. Store the collection timestamp locally because the response does not provide a VaporStats observation time. Store the complete filter tuple with the counts; otherwise an English-only/default Steam-purchase result can be mistaken for an all-source score. The difference between the App ID 292030 filtered and unfiltered totals confirms that off-topic filtering changes the aggregate and must not be silently mixed.

## 3. Histogram response and review-bomb periods

### Observations

- On 2026-09-06, `https://store.steampowered.com/appreviewhistogram/440` returned HTTP 200 and 16,293 decoded bytes. Its top-level keys were `success`, `results`, `count_all_reviews`, and `expand_graph`. `results` contained `start_date: 1287100800`, `end_date: 1788739200`, empty `weeks`, 192 `rollups`, `rollup_type: "month"`, and 30 `recent` entries. Each observed bucket had `date`, `recommendations_up`, and `recommendations_down`. [Observed App ID 440 histogram](https://store.steampowered.com/appreviewhistogram/440)
- Across live requests for App IDs 440, 730, 292030, 578080, and 1245620, all responses returned HTTP 200 in 216–258 ms and exposed the same bucket fields. Decoded response sizes ranged from 6,408 to 16,293 bytes. In this sample, `weeks` was empty and `rollup_type` was `month`; these are observations, not a fixed schema promise.
- The App ID 292030 histogram returned `start_date: 1431907200`, `end_date: 1788739200`, 137 monthly rollups, 30 recent entries, `count_all_reviews: false`, and `expand_graph: true`. It also returned one top-level `past_events` entry: `{"type":0,"start_date":1646265600,"end_date":1647475200}`. [Observed App ID 292030 histogram](https://store.steampowered.com/appreviewhistogram/292030)
- The histogram response has no Valve-published method page in the Steamworks Web API reference. Community reverse-engineering examples describe the endpoint and the `rollups`/`recent` shape, but do not turn it into a supported API contract. [Community schema example](https://qiita.com/itito/items/e1c47d812c8a1cb5437b)

### Documented facts

- Valve says review-bomb periods unrelated to the product can be bucketed and, for off-topic bombs, removed from the overall score. Valve also says users can identify the bucketed period; it does not publish the `appreviewhistogram` JSON schema or the meaning of its numeric `past_events.type` values. [Valve: Review Bombing](https://partner.steamgames.com/doc/store/reviews)
- Valve's documented review API names off-topic review filtering but does not document `past_events`, `start_date`, `end_date`, `rollups`, `recent`, or `recommendations_up`/`recommendations_down`. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)

### Inference

Treat `past_events` as optional opaque event metadata. Persist each event's raw numeric type and endpoint-provided start/end epoch seconds; do not hard-code `type: 0` as an enum value without a separate validation source. Use `recommendations_up` and `recommendations_down` as time-bucketed positive/negative counts, but label the source as the observed histogram interface. The histogram is suitable for patch-adjacent sentiment analysis only when VaporStats joins bucket dates to independently established patch or lifecycle facts; it does not establish that a review surge was caused by a patch.

## 4. Request volume, latency, caching, and rate limits

### Documented facts

- Valve documents HTTP 429 as “Too Many Requests” and describes it as rate limiting. The same response documentation says 401 and 403 are access failures where retrying will not help, and 503 means the service is unavailable or too busy. [Valve: Web API error codes](https://partner.steamgames.com/doc/webapi_overview/responses)
- The Steam Web API Terms limit an application to 100,000 calls per day. The Terms page says it was last updated in July 2010; this is a policy ceiling, not an endpoint-specific throughput guarantee or a promise that enforcement is uniform across Store interfaces. [Steam Web API Terms](https://steamcommunity.com/dev/apiterms)
- Valve publishes no numeric per-second, per-minute, or per-endpoint quota for `appreviews`, and no quota or SLA for `appreviewhistogram`. [Valve: Web API error codes](https://partner.steamgames.com/doc/webapi_overview/responses), [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)

### Observations

- The live review-summary requests above returned 200 in 253–417 ms and the live histogram sample returned 200 in 216–258 ms. These are single-client observations, not capacity measurements.
- Review-summary responses advertised `private,max-age=600`; histogram responses did not advertise `Cache-Control` in the sampled responses. No sampled response included `Retry-After`, and no request in this bounded probe returned HTTP 429. This does not establish that 429 cannot occur.

### Polling arithmetic

For `N` tracked games, one summary and one histogram request per game per day costs:

`review calls/day = 2 × N`

At the existing `MAX_TRACKED_GAMES = 1,000`, that is 2,000 review calls/day. VaporStats' current player collector separately caps player requests at 80,000/day and 150 per fifteen-minute tick; the Terms' 100,000-call figure also leaves no guaranteed allowance for prices, catalog, discovery, retries, or future endpoints. [VaporStats player limits](https://github.com/phenome/vaporstats/blob/research/steam-review-ingestion/src/lib/player.ts)

### Inference

Use a local cache keyed by App ID, endpoint, and filter tuple. A daily due time is the primary guard; the Store summary's ten-minute private cache is only a secondary reduction in duplicate work, and the histogram needs a VaporStats-owned cache because no cache directive was observed. Start with one review request at a time (or another deliberately small concurrency) rather than reusing the player collector's six-connection pool; increase only after observing sustained success without 429s. A 429 should end review work for that tick, not trigger a retry loop.

## 5. Integration with the UTC fifteen-minute ingestion tick

### Documented facts

- `workers/ingestion.ts` registers one UTC `*/15 * * * *` cron and prevents concurrent process-wide ticks. Each tick already runs bounded player collection, daily discovery/rollups, optional hourly prices, and catalog refresh. [VaporStats ingestion scheduler](https://github.com/phenome/vaporstats/blob/research/steam-review-ingestion/workers/ingestion.ts)
- `tracked_games` uses deterministic fifteen-minute slots. Daily player work is distributed over 96 UTC slots using `appid % 96`; player collection advances a game's due time after both success and ordinary failure. [VaporStats player cadence](https://github.com/phenome/vaporstats/blob/research/steam-review-ingestion/src/lib/player.ts)

### Inference

Add review work as a bounded stage of the existing tick, with its own due timestamp/checkpoint and its own daily request counter. Do not reuse `player_daily_requests` or let review calls consume the player collector's `alreadyAttemptedInTick` budget: those counters describe player requests and discovery admission. Assign each tracked game a deterministic review slot (the same 96-slot distribution is sufficient) and advance the review due time after success or failure.

With 1,000 games, evenly distributing two calls per game gives about 21 review calls per tick. Keep a hard per-tick review cap so overdue work cannot turn one tick into an unbounded sweep. On a 429, stop the review stage for that tick and move remaining games to a later due time; on a network/5xx failure, preserve the last good row and advance with bounded backoff. Commit a game's summary, histogram buckets, and event intervals atomically after its responses, and keep review failures isolated so one malformed response does not abort player, price, or catalog work.

Do not call either endpoint on every fifteen-minute tick. A 15-minute scheduler is an execution opportunity; the review cadence is daily and prospective.

## 6. SQLite storage footprint and retention

### Documented facts

- The current schema stores high-frequency player observations separately and rolls them into one durable row per App ID and UTC date in `player_rollups`. This establishes a project pattern of retaining compact aggregates rather than unbounded raw request payloads. [VaporStats player rollup migration](https://github.com/phenome/vaporstats/blob/research/steam-review-ingestion/migrations/0003_player_rollups.sql)
- Live `appreviews` summary bodies were approximately 0.2 KB decoded. Live histogram bodies were 6.4–16.3 KB decoded across five App IDs; compressed transfer sizes were smaller but are not a useful SQLite retention estimate.

### Inference

Use compact tables along these lines rather than a JSON blob per poll:

- `review_summaries`: one row per App ID, UTC observation date, and filter tuple, with `total_positive`, `total_negative`, `total_reviews`, `review_score`, `review_score_desc`, and `observed_at`.
- `review_histogram_buckets`: one row per App ID, bucket kind (`month` or `recent`), and bucket start epoch, with positive/negative counts and `observed_at`. Upsert existing bucket keys because Steam can revise historical counts after moderation.
- `review_histogram_events`: one row per App ID and endpoint event interval, retaining the raw numeric type and start/end epoch seconds. Upsert by App ID, type, start, and end.

Keep daily summary history for at least the product's supported review-trend window; a one-year window is a bounded default if no longer retention requirement exists. Retain normalized histogram buckets for their full returned range because the endpoint already supplies historical rollups, and retain event intervals while their referenced bucket range is retained. Do not store review text, SteamIDs, cursors, or individual review rows for this ticket.

A raw-snapshot design would write approximately 1,000 summary-plus-histogram pairs × 6.6–16.5 KB × 365 days for 1,000 games, or about 2.4–6.0 GB/year using the sampled decoded sizes. Normalization avoids duplicating the same historical monthly series on every daily poll; the actual SQLite size still depends on schema and index overhead and must be measured after implementation.

## 7. Operational boundaries and failure handling

### Documented facts

- Valve's review API response identifies `success` and exposes the query summary only on the first request; it is not a promise that every HTTP 200 body is valid for ingestion. [Valve: User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)
- Valve's error documentation distinguishes access errors (401/403), rate limits (429), service unavailability (503), and other server failures. [Valve: Web API error codes](https://partner.steamgames.com/doc/webapi_overview/responses)
- Valve's Terms prohibit using the Web API in ways that degrade Steam or its games' operation or performance. Valve separately says requests containing Web API keys should use HTTPS and keys must not be distributed to clients. [Steam Web API Terms](https://steamcommunity.com/dev/apiterms), [Valve: Web API key authentication](https://partner.steamgames.com/doc/webapi_overview/auth)

### Inference

The collector should validate App ID, HTTP status, JSON parseability, `success`, and required numeric fields before a database write. Treat missing optional histogram arrays as empty, but treat a changed type for required bucket fields as a schema-drift failure. Keep requests server-side and use HTTPS; no review endpoint credential belongs in the client.

The collector should expose per-tick attempted/succeeded/failed/rate-limited counts and the last successful timestamp, while retaining the previous good snapshot on failure. This is enough operational signal for a bounded daily job; no individual review retry or text ingestion is justified by this ticket.

## 8. Research limits and unresolved validation

- `appreviewhistogram` is not documented in the Steamworks Web API reference. Its `past_events` type codes, cache behavior, quota, retention, and schema stability require ongoing observation; the baseline must be able to disable this source without corrupting summary data.
- `num_per_page=0` produced an empty review list and query summary in the captured requests, but Valve's parameter table documents the 20/100 review-page sizes rather than a zero-page contract. Keep a compatibility fallback that discards any returned review records rather than paging them.
- The 100,000-call/day Terms limit is broad, old (last updated July 2010), and not an endpoint-specific quota. Keep a project budget below it with explicit headroom for existing player, catalog, price, discovery, and retry traffic; do not infer a safe burst rate from the measured 216–417 ms latencies.
- The live probe produced no 429, so it does not identify the threshold that triggers rate limiting. Treat 429 as expected control flow and preserve bounded backoff state for future measurements.
- The histogram's bucket counts are time-bucketed sentiment, not proof of causation. Establish patch dates from an independent release-fact source before presenting a patch/sentiment relationship.

## Source register

**Valve/Steam primary sources**

- [User Reviews - Get List](https://partner.steamgames.com/doc/store/getreviews)
- [Review Bombing and User Reviews](https://partner.steamgames.com/doc/store/reviews)
- [Web API overview](https://partner.steamgames.com/doc/webapi_overview)
- [Web API error codes and responses](https://partner.steamgames.com/doc/webapi_overview/responses)
- [Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms)
- [Observed App ID 440 summary](https://store.steampowered.com/appreviews/440?json=1&num_per_page=0)
- [Observed App ID 440, Steam purchase summary](https://store.steampowered.com/appreviews/440?json=1&num_per_page=0&filter=all&language=all&purchase_type=steam&day_range=30&filter_offtopic_activity=1)
- [Observed App ID 440, all-source summary](https://store.steampowered.com/appreviews/440?json=1&num_per_page=0&filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=1)
- [Observed App ID 292030, filtered summary](https://store.steampowered.com/appreviews/292030?json=1&num_per_page=0&filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=1)
- [Observed App ID 292030, unfiltered summary](https://store.steampowered.com/appreviews/292030?json=1&num_per_page=0&filter=all&language=all&purchase_type=all&day_range=30&filter_offtopic_activity=0)
- [Observed App ID 440 histogram](https://store.steampowered.com/appreviewhistogram/440)
- [Observed App ID 292030 histogram](https://store.steampowered.com/appreviewhistogram/292030)

**VaporStats implementation context**

- [Ingestion scheduler](https://github.com/phenome/vaporstats/blob/research/steam-review-ingestion/workers/ingestion.ts)
- [Player cadence and request limits](https://github.com/phenome/vaporstats/blob/research/steam-review-ingestion/src/lib/player.ts)
- [Player rollup migration](https://github.com/phenome/vaporstats/blob/research/steam-review-ingestion/migrations/0003_player_rollups.sql)

**Comparator and implementation evidence**

- [Community histogram schema example](https://qiita.com/itito/items/e1c47d812c8a1cb5437b)
