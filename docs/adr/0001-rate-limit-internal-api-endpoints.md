# Rate-limit internal API endpoints

VaporStats exposes internal JSON API routes to power its frontend, creating risk of automated scraping and database cost spikes. The project enforces a shared per-IP rate limit of 30 requests per 10 seconds across all `/api/*` routes using Cloudflare Workers Rate Limiting bindings, failing open on binding errors and returning HTTP 429 with `Retry-After: 10`. This protects service availability and query costs without introducing public API management overhead or aggressive shared-IP blocking.
