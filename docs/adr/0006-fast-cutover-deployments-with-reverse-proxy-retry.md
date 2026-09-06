# Fast-cutover deployments with reverse-proxy retry

**Status:** Accepted

VaporStats achieves zero-perceived-downtime deployments using fast in-place container cutovers paired with reverse-proxy retry buffering, rather than blue/green candidate network swapping.

Blue/green candidate swapping (running a new container alongside the old one, verifying health, and updating network aliases) was evaluated and rejected because VaporStats uses embedded SQLite in WAL mode on a single persistent host with in-process background ingestion. Running two concurrent application containers against the shared SQLite file introduces concurrent database writers, risks transaction contention during the warm-up window, and triggers duplicate background ingestion ticks against Steam's rate-limited APIs unless custom IPC promotion mechanisms are introduced.

Instead, deployments branch based on whether migration files in `migrations/` changed between the active commit and the requested commit:

1. **Zero-migration fast path**: When `git diff --quiet <current> <requested> -- migrations/` confirms no schema changes, the image is built while the existing container serves traffic. Once built, `docker compose up -d --no-build vaporstats` recreates the container in-place (~500ms). Pre-migration snapshots and standalone migration runs are bypassed because the schema is unmodified. If the container fails its healthcheck, rollback restarts the previous image without database manipulation.

2. **Migration-present path**: When schema changes exist, deployment preserves the atomic safety guarantees of ADR 0004. The service is stopped, SQLite database and WAL files are snapshotted, and integrity verification and migrations execute in a single temporary container before starting the new service. On failure, rollback restores the pre-migration snapshot and previous image.

The host Caddy reverse proxy (`/workspace/caddy/Caddyfile`) bridges the brief container recreation window:

```caddyfile
reverse_proxy vaporstats:3000 {
    lb_try_duration 5s
    lb_try_interval 250ms
}
```

During container recreation, Caddy holds incoming HTTP connections and retries upstream requests every 250ms for up to 5 seconds. To end users and Cloudflare edge proxies, requests experience a sub-second latency pause rather than a 502 Bad Gateway error. This eliminates user-visible deployment downtime while preserving SQLite single-writer isolation and keeping deployment automation minimal.
