# Self-host SQLite on a single Bun process

**Status:** Accepted

VaporStats uses one self-hosted Bun 1.4 process with `bun:sqlite` and a mounted portable SQLite file. Scheduled ingestion runs in-process. The deployment has one writable replica, with Cloudflare-proxied Caddy providing HTTPS and caching. Raw player observations are retained for thirty days: 24-hour charts use raw samples, seven-day charts use UTC-hour aggregates, and thirty-day charts use UTC-six-hour aggregates computed in SQL. Durable daily rollups support ninety-day and all-time charts. The longer raw window trades additional bounded storage for finer recent history without introducing another persisted rollup table.

This accepts a single-process, single-writer operational boundary in exchange for SQLite portability, a direct relational data model, and a small deployment footprint. The project rejects D1 because free-tier usage can expose the service to row-read limits; a KV document redesign because it would replace the relational query model; managed Postgres because its operational and migration weight is unnecessary at the current scale; and networked libSQL because a separate database service adds complexity before scale requires it.

Revisit this decision when traffic, data volume, availability requirements, or ingestion throughput require a different topology.
