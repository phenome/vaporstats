# Compare D1 and Turso for observation storage

**Ticket:** [#10](https://github.com/phenome/vaporstats/issues/10)  
**Branch:** `research/d1-vs-turso`  
**Research captured:** 2026-09-02

## Decision summary

VaporStats should launch observation storage on **Cloudflare D1 with the Workers Paid plan**: one database, SQL migration files, and indexes that match the observation queries. This is the smallest launch choice because the application already targets Cloudflare Workers and D1 is a native Worker binding; the paid plan starts at $5/month and removes the free plan's daily D1 ceilings. The choice is an inference from the documented product fit and the pre-traction budget, not a claim that D1 is permanently preferred.

The observation cadence remains **undecided**. The examples below deliberately reuse the five-minute scenario from the upstream Steam research; they are bounded cost scenarios, not a polling recommendation. The Steam source note says that the known 100,000-calls/day Terms ceiling makes a five-minute sweep of a large catalog infeasible, and that no catalog-wide five-minute freshness promise should be made. [The upstream Steam data-sources decision](https://github.com/phenome/vaporstats/blob/research/steam-data-sources/docs/research/steam-data-sources.md)

Reconsider the choice when one of these conditions is true:

1. A single observation database is approaching D1's **10 GB hard per-database limit**, because that limit cannot be increased. Partitioning/retention should be considered before the limit is reached; Turso is an alternative when a larger single database is required.
2. A required runtime is not Cloudflare Workers, or the project needs a direct `fetch`-based database client that can be deployed across several edge platforms. Turso's serverless package explicitly targets edge runtimes, including Workers.
3. The primary workload needs sustained write concurrency beyond D1's one-at-a-time database execution model, and the project accepts Turso's separate service, migration, and operational model.
4. A measured regional read-latency requirement cannot be met by D1's primary location or its optional read replication and Sessions API.

These are upgrade or reconsideration triggers, not current requirements.

## Evidence and scope

- **Documented fact** means the statement is on an official Cloudflare or Turso documentation/pricing page.
- **Inference** means a conclusion drawn from those facts and the upstream catalog/polling evidence; it is not a provider guarantee.
- **Scenario** means arithmetic using explicit assumptions. It must not be read as a final observation frequency, game count, API quota, or latency promise.
- Pricing and plan details were checked on 2026-09-02. Provider pricing and limits can change.

The upstream decision establishes the relevant product shape: start with the documented Game result set, collect point-in-time current-player responses, record VaporStats' own observation timestamp, and build history prospectively. The current-player endpoint has no server-provided historical series, so each stored observation is a new row. The upstream note also uses 5,000, 10,000, and 50,000-app scenarios and the documented 50,000-item catalog page maximum.

## Workload bounds from the upstream evidence

For `N` apps sampled every `T` minutes, the upstream note uses:

```text
player calls/day = N × (1,440 / T)
```

For the illustrative `T = 5` minute scenario, assuming one observation row per successful app response and a 30-day month:

| Apps (`N`) | Player calls/day | Observation rows/month (one row per call) | 100,000-call/day comparison |
| ---: | ---: | ---: | --- |
| 5,000 | 1,440,000 | 43,200,000 | 14.4× the documented Terms ceiling |
| 10,000 | 2,880,000 | 86,400,000 | 28.8× the documented Terms ceiling |
| 50,000 | 14,400,000 | 432,000,000 | 144× the documented Terms ceiling |

This is intentionally an upper-bound scenario inherited from the upstream note, not a decision to poll every app every five minutes. It excludes catalog, metadata, news, retries, failures, and any index rows. The upstream note calculates that even 5,000 apps at five minutes would require a budget-only minimum interval of 72 minutes per app to fit 100,000 player calls/day; actual scheduling must also account for the other Steam requests and unknown operational limits.

## Comparison

### Cloudflare Workers compatibility

**Documented facts**

- D1 is queried from a Worker through the native Worker Binding API. The documented flow is to bind a database, prepare statements, execute them, and optionally use batches and typed results. [Cloudflare D1 Worker Binding API](https://developers.cloudflare.com/d1/worker-api/)
- Turso's current TypeScript quickstart describes `@tursodatabase/serverless` as the package for remote Turso databases, including serverless functions and edge runtimes such as Cloudflare Workers. It uses only `fetch` and has zero native dependencies. The same page documents the URL/auth-token connection model. [Turso TypeScript quickstart](https://docs.turso.tech/sdk/ts/quickstart.md)

**Inference**

D1 has the smaller launch surface for a Workers-first service: no separate database client protocol or remote URL/token binding is needed in application code, and Wrangler owns the binding. Turso is technically compatible with Workers, but it remains a separately hosted database reached through its serverless HTTP client. Turso is the better compatibility escape hatch if the runtime boundary later expands beyond Cloudflare; that is not needed for the initial launch.

### Write, query, and database-size limits

| | Cloudflare D1 | Turso Cloud |
| --- | --- | --- |
| Free usage | 5 million rows read/day, 100,000 rows written/day, 500 MB maximum database, 5 GB account storage | 500 million rows read/month, 10 million rows written/month, 5 GB storage, and 100 databases on the Free plan |
| Paid usage relevant to launch | Workers Paid: 25 billion rows read/month included, 50 million rows written/month included, then $0.001/million rows read and $1/million rows written; 5 GB storage included, then $0.75/GB-month; Workers Paid account minimum is $5/month | Developer: $5.99/month month-to-month, 2.5 billion rows read/month, 25 million rows written/month, 9 GB storage; overages are $1/billion read, $1/million written, and $0.75/GB. Scaler: $29/month, 100 billion reads, 100 million writes, 24 GB storage; overages are $0.80/billion read, $0.80/million written, and $0.50/GB |
| Per-database size | 10 GB maximum on Workers Paid; the D1 documentation says this limit cannot be increased. Free maximum is 500 MB. | The current pricing page publishes plan storage quotas and overage rates, but does not state a universal per-database maximum. The CLI supports a configurable `--size-limit`; the selected plan's included storage is not evidence of an unlimited database. |
| Query/runtime ceilings | Workers Paid: 1,000 D1 queries per Worker invocation. D1 also documents 30-second maximum SQL query duration, 100 bound parameters, 100 KB SQL statement length, 2 MB maximum string/BLOB/table-row size, and unlimited rows per table subject to database storage. | The cited Turso pricing and usage pages specify monthly row-read, row-write, and storage quotas. They do not publish a matching per-Worker-invocation query count or a universal SQL statement-size/duration limit. Do not treat an undocumented limit as unlimited. |
| Execution/concurrency | Each individual D1 database is inherently single-threaded and processes queries one at a time; throughput depends on query duration. | Turso Cloud's overview describes the Turso engine as supporting concurrent writes and multi-user access by default, while warning that Turso databases on Turso Cloud are in early preview. The separate Turso Database concurrency documentation explains that the default local configuration has one writer and that MVCC/`BEGIN CONCURRENT` requires conflict handling. |

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Turso pricing](https://turso.tech/pricing), [Turso usage and billing](https://docs.turso.tech/help/usage-and-billing.md), [Turso Cloud overview](https://docs.turso.tech/turso-cloud.md), [Turso concurrent writes](https://docs.turso.tech/tursodb/concurrent-writes.md).

**Inference for the workload:** A D1 database is sufficient for a compact launch schema, but its hard 10 GB ceiling makes storage growth a design boundary. D1's one-at-a-time execution model is a reason to batch ingestion and keep chart queries indexed; it is not a reason to choose a different provider before measured contention exists. Turso offers a wider write-concurrency path in its current Turso engine documentation, but the Cloud overview labels that engine early preview, so this should not be treated as a zero-risk launch advantage.

### Row/read economics for time-series observations

**Documented facts**

- D1 counts rows scanned for reads, not bytes or only rows returned. An unindexed filter can scan a whole table; indexes reduce rows read. D1 counts `INSERT`, `UPDATE`, and `DELETE` rows as writes. A write that changes an indexed column includes an additional written row for the index. [D1 pricing definitions](https://developers.cloudflare.com/d1/platform/pricing/), [D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- Turso likewise measures rows touched during execution. An unindexed lookup can read the whole table; an indexed lookup may touch only matching index entries and rows. `count`, `avg`, `min`, `max`, and `sum` scan every row considered by the aggregate; indexes add write work for affected index entries. [Turso usage and billing](https://docs.turso.tech/help/usage-and-billing.md), [Turso pricing](https://turso.tech/pricing)
- Neither provider's row metric is a byte metric. D1 explicitly says row size and column count do not change row counting; Turso's published billing model similarly uses rows touched plus storage/sync quotas.

**Inference for an observation schema**

Use an indexed access path equivalent to `(appid, observed_at)` for per-game history and latest-value reads. A range chart for one app should constrain both the app and timestamp; a latest-value query should order the timestamp descending with a limit. Aggregate dashboards should bound the time range and app set. A full-table aggregate would scale with all historical observations on both providers and would be a poor default even where the read price is low.

### Latency and geography

**Documented facts**

- Without replication, D1 routes reads and writes to a primary database instance in one location; latency depends on distance to that instance. D1 read replication creates asynchronous read-only copies in multiple Cloudflare regions. Writes still go to the primary. The Sessions API provides sequential consistency for a logical session, and read replicas have no additional D1 charge; row usage is still billed. [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- Turso groups have a primary region. The official CLI documentation says Turso automatically detects the closest region for a new group unless a location is specified. The serverless client is a remote `fetch` client; Turso's embedded replicas serve reads locally from a file, but the docs say embedded replicas are not available in serverless environments without a filesystem. Writes through an embedded replica go to the remote primary. [Turso group creation](https://docs.turso.tech/cli/group/create.md), [Turso TypeScript quickstart](https://docs.turso.tech/sdk/ts/quickstart.md), [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction.md)

**Inference**

For the initial read/write collector, either provider has a single-primary path and no published p95 latency guarantee in the cited documentation. D1's optional global read replication is the simpler later step for a Workers-only service. Turso's local embedded-replica latency benefit does not apply to a stateless Worker without a durable local filesystem, so it should not drive this launch choice. Measure from the actual deployed regions before selecting replication or changing providers for latency.

### Migrations

**Documented facts**

- D1 migrations are numbered SQL files in a `migrations` directory. Wrangler can create, list, and apply them, and records applied migrations in `d1_migrations`; the directory and table are configurable. [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- Turso's official Drizzle guide documents `drizzle-kit generate` and `drizzle-kit migrate` with a Turso dialect and remote URL/auth token. Turso Cloud makes `PRAGMA user_version` read-only and recommends a table such as `_schema_version` for tracking schema versions. [Turso Drizzle](https://docs.turso.tech/sdk/ts/orm/drizzle.md), [Turso Cloud limitations](https://docs.turso.tech/cloud/limitations.md)

**Inference**

D1's Wrangler migration path is the smallest migration mechanism for this Workers application. Turso migrations are straightforward when the project already accepts Drizzle Kit or an equivalent SQL migration runner, but that adds a tool and a deployment credential path. The report does not claim that Turso lacks all native migration tooling; it records only the workflow established by the cited current docs.

### Local development

**Documented facts**

- D1 local development runs through `wrangler dev` with a local-only database and a production-like D1 runtime. Local and remote data are separated by default; `--persist-to` can persist local state. Local migrations and SQL can be run with Wrangler's `--local` flag. [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)
- Turso recommends a local database file with the Turso packages and no server. For a local libSQL server, `turso dev` starts a server; changes are lost when it stops unless a database file is supplied. Connecting to a Turso Cloud database during development counts toward plan usage. [Turso local development](https://docs.turso.tech/local-development.md)

**Inference**

Both provide a low-cost local loop. D1 is more representative of the target Worker binding and Wrangler deployment. Turso has the more portable SQLite-file workflow, but a local file is not the same execution path as a stateless Worker using Turso's remote serverless client; that difference must be covered before a Turso decision.

### Backups and restore

| | Cloudflare D1 | Turso Cloud |
| --- | --- | --- |
| Automatic protection | Time Travel is always on; history and restores have no additional cost. | Backups are created automatically at `COMMIT`. |
| Retention | 30 days on Workers Paid, 7 days on Free. | Free 1 day; Developer 10 days; Scaler 30 days; Pro 90 days. |
| Restore behavior | Restore in place to any minute in the window; it is destructive and cancels in-flight queries. Maximum 10 restores per 10 minutes per database. | PITR creates a new database. The application must switch connection strings/tokens and the old database must be deleted when no longer needed; restore uses database quota and storage. |
| Longer retention | Official D1 docs describe exporting to R2 with Workflows for retention beyond 30 days. | Plan selection provides longer PITR windows; the cited page does not promise an in-place restore. |

Sources: [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Turso PITR](https://docs.turso.tech/features/point-in-time-recovery.md), [Turso pricing](https://turso.tech/pricing).

**Inference:** D1's restore is operationally smaller for a single launch database because the connection identity remains in place, but it requires a careful destructive-restore runbook. Turso's new-database restore provides a natural cutover boundary and longer paid retention options, at the cost of rotating the connection and consuming another database/storage allocation during recovery.

## Bounded cost scenarios

The following table is deliberately mechanical. It assumes exactly one database row written per successful current-player response, a 30-day month, no secondary indexes, no retries/failures, no catalog/store/news requests, no user-facing reads, and storage below the included amount. Real usage is higher: both providers count index work, and Steam calls—not database cost—are already the binding constraint in the five-minute examples.

| Five-minute scenario | D1 observation writes/month | D1 Workers Paid base + write overage | Turso Developer base + write overage | Turso Scaler base + write overage |
| --- | ---: | ---: | ---: | ---: |
| 5,000 apps | 43.2M | **$5.00** (`43.2M <= 50M` included) | **$24.19** (`$5.99 + (43.2M - 25M) × $1/M`) | **$29.00** (`43.2M <= 100M` included) |
| 10,000 apps | 86.4M | **$41.40** (`$5 + 36.4M × $1/M`) | **$67.39** (`$5.99 + 61.4M × $1/M`) | **$29.00** (`86.4M <= 100M` included) |
| 50,000 apps | 432M | **$387.00** (`$5 + 382M × $1/M`) | **$412.99** (`$5.99 + 407M × $1/M`) | **$294.60** (`$29 + 332M × $0.80/M`) |

The table does **not** select five minutes as the cadence. It shows why the cadence, catalog subset, and retention policy must be chosen together. It also shows why a Turso Free plan cannot be treated as a five-minute ingestion target: its 10M monthly write quota would block the 5,000-app scenario before any read or storage usage. D1 Free would hit its 100,000 daily write limit in all three scenarios.

For user-facing analytics, let `Q` be chart queries per month and `K` be rows touched by each indexed, bounded query. The added read volume is `Q × K`; a full-range aggregate can make `K` equal to the entire selected history. D1's paid read allowance is 25B rows/month, then $0.001/M. Turso Developer includes 2.5B rows/month, then $1/B; its Free plan includes 500M. No `Q` or `K` is invented here because product traffic and the final cadence are not decided.

### The approximately $25/month envelope

- **D1:** the Workers Paid minimum is $5/month. Under the narrow 5,000-app/5-minute write-only scenario, the 43.2M baseline rows stay inside D1's 50M included writes, leaving roughly $20 for Worker usage and other project services. The Steam API budget still rules out that sweep; this is not a recommendation to run it.
- **Turso:** Free is $0 but blocks after 10M writes/month. Developer is $5.99/month, but the same 5,000-app/5-minute lower-bound scenario reaches $24.19 before reads, storage overage, or other services. Scaler is $29/month month-to-month, above the envelope (the pricing page also displays $24.92/month when billed yearly, which requires a $299 annual total).
- **Inference:** D1 Paid leaves the most headroom for a bounded, still-undecided launch schedule while keeping the Worker and database in one provider. The budget conclusion depends on actual rows touched and retained, so usage metrics must be reviewed before cadence or scope expands.

## Launch shape and upgrade triggers

**Launch:** use one D1 database, Wrangler SQL migrations, an observations table keyed/indexed by app and observation time, batched ingestion, and bounded time-range queries. Record `observed_at` from VaporStats rather than expecting Steam to provide a historical timestamp. Do not promise catalog-wide five-minute freshness.

**Trigger a measured review when:**

- D1 `size_after`/storage approaches 10 GB, or retention would cross that hard per-database ceiling.
- D1 per-database query queueing or write latency is observed under the selected schedule; first reduce scans, batch writes, and review the schema/indexes. If sustained write concurrency remains the limiting requirement, compare Turso's documented concurrent-write path.
- Global read latency is materially above the product requirement after query/index tuning; evaluate D1 read replication plus Sessions API, then compare Turso's deployment geography if Workers-only replication is insufficient.
- A non-Cloudflare runtime becomes a real requirement; evaluate Turso's fetch-only serverless client and its migration/backup runbook.
- Measured monthly rows read/written, storage, and backup needs no longer fit the selected plan or the approximately $25 envelope.

No final observation frequency is set by this note. The collector must choose it only after the Steam request budget, game subset, freshness requirement, and measured database usage are known.

## Source register

**Upstream project evidence**

- [Steam data sources and polling limits](https://github.com/phenome/vaporstats/blob/research/steam-data-sources/docs/research/steam-data-sources.md)

**Cloudflare official documentation**

- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 Worker Binding API](https://developers.cloudflare.com/d1/worker-api/)
- [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/)

**Turso official documentation and pricing**

- [Turso pricing](https://turso.tech/pricing)
- [Turso TypeScript quickstart](https://docs.turso.tech/sdk/ts/quickstart.md)
- [Turso Cloud overview](https://docs.turso.tech/turso-cloud.md)
- [Turso usage and billing](https://docs.turso.tech/help/usage-and-billing.md)
- [Turso local development](https://docs.turso.tech/local-development.md)
- [Turso point-in-time recovery](https://docs.turso.tech/features/point-in-time-recovery.md)
- [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction.md)
- [Turso group creation and primary location](https://docs.turso.tech/cli/group/create.md)
- [Turso Drizzle integration and migrations](https://docs.turso.tech/sdk/ts/orm/drizzle.md)
- [Turso Cloud limitations](https://docs.turso.tech/cloud/limitations.md)
- [Turso concurrent writes](https://docs.turso.tech/tursodb/concurrent-writes.md)
