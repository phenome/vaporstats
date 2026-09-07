# Elevated player polling tiers and quotas for self-hosted SQLite

**Status:** Accepted

VaporStats previously capped outbound player activity probes at 5,000 requests per UTC day (`DAILY_REQUEST_CAP = 5000`) and limited the high-frequency sampling tier to the top 10 titles. This ceiling was established under Cloudflare D1 to constrain worker subrequests and write quotas. Following migration to a self-hosted single-writer Bun process with local SQLite on SSD (ADR 0002), the D1 write constraints no longer apply. The legacy 5,000 cap caused premature quota exhaustion before noon UTC, creating daily 12-to-13-hour observation blackouts across the catalog and leaving titles near the top-10 boundary (such as Apex Legends) vulnerable to sampling drops.

The project raises `DAILY_REQUEST_CAP` to 80,000 requests per day and `TICK_REQUEST_CAP` to 150 requests per tick. This retains a 20% safety margin under the official Steam Web API limit of 100,000 requests per day while eliminating midday exhaustion and providing bounded burst capacity to clear transient downtime backlogs.

Within the retained ceiling of 1,000 tracked games (`MAX_TRACKED_GAMES = 1000`), polling tiers are expanded:
- **Fast tier**: Top 50 games sampled every 15 minutes (~4,800 requests/day).
- **Hourly tier**: Games ranked 51–250 sampled every 60 minutes across 4 quarter-hour slots (~4,800 requests/day).
- **Daily tier**: Games ranked 251–1,000 sampled once per 24 hours across 96 quarter-hour slots (~750 requests/day).

Steady-state polling consumes ~10,350 requests per day. Tier re-ranking executes hourly and upon scheduler startup so ranking shifts take effect within 60 minutes rather than once per calendar day. In the event of a cap lockout, overdue games advance to their next deterministic slot to prevent midnight backlog stampedes.
