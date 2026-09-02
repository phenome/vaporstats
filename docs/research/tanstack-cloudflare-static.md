# TanStack Start + Cloudflare Workers: static-first deployment model

**Checked:** 2026-09-02 against the current TanStack Start and Cloudflare Workers documentation and the TanStack Router source tree.

## Decision

Use a hybrid deployment, with static output as the default path and the Worker as a narrow dynamic escape hatch:

1. Build TanStack Start with Vite and `@cloudflare/vite-plugin`, then deploy the generated Worker and client output together with Wrangler.
2. Prerender only concrete, public game URLs whose build-time snapshot is useful. Keep the durable page shell and catalog metadata in those HTML assets.
3. Fetch volatile metrics, prices, and other short-lived values from narrow `/api/*` server routes after hydration. Keep new or not-yet-prerendered game slugs on the Worker until the next catalog build.
4. Rebuild and deploy on a deliberate batch cadence, not on every ingestion tick. A rebuild is the supported way to add or refresh prerendered HTML assets.
5. Treat Cloudflare Workers caching as an optional cache for Worker-generated responses, not as a mechanism that mutates TanStack's uploaded static files.

This is the smallest model that preserves static delivery for durable catalog pages while retaining runtime data and incremental catalog growth. The separation between durable HTML and live API data is an architectural inference from the documented build-time/runtime boundaries, not a TanStack product requirement.

## Evidence and interpretation

The labels below distinguish what the sources state from conclusions for VaporStats:

- **Documented** means stated in an official guide or reference.
- **Source** means verified in the official TanStack Router source tree.
- **Inference** means a deployment conclusion derived from those facts.

### Cloudflare deployment support

**Documented.** TanStack lists Cloudflare Workers as an official hosting partner. Its Cloudflare setup uses Vite, `@cloudflare/vite-plugin`, Wrangler, `main: "@tanstack/react-start/server-entry"`, and `nodejs_compat`. [TanStack hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)

**Documented.** Cloudflare's TanStack Start guide supports both automatic and explicit configuration. Running `wrangler deploy` without a Wrangler configuration can detect TanStack Start and generate configuration with the Worker entry at `.output/server/index.mjs` and static assets at `.output/public`; an existing app can use the Cloudflare Vite plugin and an explicit `main` entry. [Cloudflare TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)

**Documented.** The Cloudflare Vite plugin detects whether a client environment was built and emits a Wrangler configuration whose `assets.directory` points at that client output. An input `assets.directory` is not required merely to enable assets; an `assets` block is still needed when customizing asset routing or adding an assets binding. [Cloudflare Vite plugin: static assets](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/)

### TanStack prerendering and route selection

**Documented.** `tanstackStart({ prerender: { enabled: true } })` generates static HTML during the build. `autoStaticPathsDiscovery` defaults to enabled, and `crawlLinks` defaults to enabled. The static-prerendering guide says automatic discovery excludes routes with path parameters, layout routes, and routes without components (including API routes). A dynamic route can still be rendered when a concrete URL is discovered through link crawling. Explicit `pages` entries provide concrete paths and per-page output options. [TanStack static prerendering](https://tanstack.com/start/latest/docs/framework/react/guide/static-prerendering)

**Source.** The route-generation plugin starts with `/`, excludes non-path/layout routes, excludes route paths containing `$`, and excludes route nodes without a component. [Official `prerender-routes-plugin.ts`](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/start-router-plugin/generator-plugins/prerender-routes-plugin.ts)

**Source.** The prerender implementation merges configured pages with discovered paths, requests each path from the built Start server, writes the response into the client output directory, and optionally queues links found in the returned HTML. Its output path logic defaults to a folder `index.html` layout (`/games/foo/index.html` for a `/games/foo` page). [Official `prerender.ts`](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/prerender.ts)

**Documented.** Cloudflare's default HTML handling is `auto-trailing-slash`: folder index files are served with a trailing slash and a request without the slash is redirected. `force-trailing-slash` and `drop-trailing-slash` are available when a different convention is required. [Cloudflare HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)

**Inference.** With the default output and HTML handling, a concrete `/games/elden-ring` page is best treated as `/games/elden-ring/` and is served from its generated `index.html`. A not-yet-generated slug has no matching asset and therefore falls through to the Worker, provided no SPA/404 fallback is configured.

### Static assets versus Worker/server routes

**Documented.** Cloudflare deploys Worker code and static assets as one unit. By default, a request matching an uploaded static asset is served without invoking Worker code; a request with no matching asset invokes the Worker when a Worker script is present. `assets.run_worker_first` can instead run the Worker first for every request (`true`) or for selected patterns. [Cloudflare static assets](https://developers.cloudflare.com/workers/static-assets/) and [Worker script routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)

**Documented.** `assets.not_found_handling` can alter unmatched-asset behavior to a SPA `index.html` fallback or a custom `404.html`. With the navigation-prefers-asset-serving behavior enabled by a compatibility date of 2025-04-01 or later, navigation requests can avoid invoking the Worker when `not_found_handling` is configured; a client-side `fetch()` to an API path still invokes the Worker. Cloudflare recommends selective `run_worker_first` when a callback, authentication check, or API path must reach Worker code. [Cloudflare SSG routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)

**Inference.** Keep the normal TanStack Start Worker path available for SSR and server routes. Do not turn on `run_worker_first: true` for a static-first deployment, because that causes every request—including static assets—to enter the Worker. If `run_worker_first` or a fallback is added later, explicitly reserve `/api/*` (and any authentication/callback paths) for Worker-first handling.

**Documented.** TanStack server routes live beside application routes in `src/routes`, expose raw HTTP handlers, and are handled by the Start server. Routes without a component are API routes and are excluded from automatic static path discovery. Server functions are same-origin RPC intended for the Start application; server routes are the documented choice for externally callable HTTP APIs. [TanStack server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes) and [TanStack server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)

**Inference.** A route such as `/api/games/$slug/metrics` is a good Worker-only boundary for live metrics. A client request to that URL reaches the Start server route; a request to a prerendered `/games/<slug>/` page reaches the static asset first. The route naming and data split are VaporStats design choices.

### Caching

**Documented.** Static asset responses receive `Cache-Control: public, max-age=0, must-revalidate`, an `ETag`, and `CF-Cache-Status` by default. Fingerprinted assets can receive a longer immutable policy using a `_headers` file. `_headers` applies to static asset responses, not responses generated by Worker code; SSR and API handlers must set their own response headers. [Cloudflare static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)

**Source-backed inference.** The TanStack prerenderer reads the prerender response body and writes that HTML to the client output directory; it does not copy response headers into an asset metadata file. Treat TanStack route `headers()` examples as runtime SSR/API guidance, not as proof that a prerendered HTML asset receives those cache directives. Configure static-asset headers through Cloudflare's `_headers` mechanism (or Worker-first handling when transformation is required). [TanStack `prerender.ts`](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/prerender.ts) and [Cloudflare Vite plugin static assets](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/)

**Documented.** Cloudflare Workers Caching is separate from the in-Worker Cache API. With `cache.enabled: true` (Wrangler 4.69.0 or later), Cloudflare checks the cache before invoking the Worker; a cache miss runs the Worker and can store its response when its headers permit caching. Only `GET` and `HEAD` are cached. Standard `Cache-Control` directives, including `stale-while-revalidate`, control freshness. The Worker version is part of the cache key by default, so a new deployment starts with separate cache entries unless `cross_version_cache` is enabled. [Workers Cache](https://developers.cloudflare.com/workers/cache/), [Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)

**Inference.** Cache live API responses only when their data is safe to share and the TTL matches the freshness need. Set explicit headers on metrics/price responses; do not rely on heuristic freshness for changing data. Keep personalized or sensitive responses private/no-store. If a write or ingestion event needs immediate invalidation, Cloudflare supports tag/path-prefix purges for Workers Caching. [Cloudflare purge API](https://developers.cloudflare.com/workers/cache/purge/)

### Rebuilds, growth, and incremental generation

**Source.** TanStack's prerenderer materializes HTML into the client output directory during a build. The source has no runtime step that writes new HTML assets after deployment. [Official `prerender.ts`](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/prerender.ts)

**Documented.** Static server functions are experimental. During prerendering they execute at build time and write a result as a static JSON file; after hydration, client calls fetch that generated JSON asset. [TanStack static server functions](https://tanstack.com/start/latest/docs/framework/react/guide/static-server-functions)

**Documented, with a scope limitation.** TanStack has an ISR guide describing a standards-based pattern: set `Cache-Control` headers, let a CDN cache a response, and purge or revalidate it when content changes. Its on-demand example calls the Cloudflare cache purge API. The guide does not describe a TanStack runtime that regenerates and uploads new prerendered HTML assets. [TanStack ISR guide](https://tanstack.com/start/latest/docs/framework/react/guide/isr)

**Source.** The current Start configuration schema exposes `pages` plus top-level prerender settings (`enabled`, filtering, crawling, retries, and related options); it does not expose the `prerender.routes` field used by examples in the ISR guide. Use the current static-prerendering configuration and verify the installed package version before copying ISR examples. [Official Start schema](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/schema.ts)

**Conclusion.** There are three distinct mechanisms:

| Mechanism | What it provides | What it does not provide |
| --- | --- | --- |
| TanStack static prerendering | Build-time HTML for concrete pages; link crawling; explicit `pages` entries | Rebuildless creation or mutation of static HTML after deploy |
| TanStack static server functions (experimental) | Build-time JSON assets for marked server functions | On-demand regeneration of those JSON assets |
| Cloudflare Workers Caching + HTTP headers | Cached Worker responses, expiry/revalidation, and purge hooks | A new file in TanStack's static asset directory or a framework-native ISR artifact pipeline |

**Inference.** For a growing catalog, maintain a build-time list of public slugs and prerender in batches. New slugs can temporarily use Worker SSR or a client-rendered shell plus API data, then become static assets at the next build/deploy. Updating a static snapshot requires a new build/deploy; ingestion should therefore publish on a controlled cadence rather than on every tick.

Cloudflare currently documents a limit of 20,000 static-asset files per Worker version on the Free plan and 100,000 on the Paid plan, with a 25 MiB per-file limit. A catalog strategy should monitor that ceiling and keep volatile, high-cardinality data out of per-page HTML where possible. [Cloudflare platform limits](https://developers.cloudflare.com/workers/platform/limits/)

## Smallest supported operating model

| Request class | First delivery path | Freshness/update path |
| --- | --- | --- |
| Durable public game page with a known slug | Prerendered HTML asset under `.output/public`; static asset routing bypasses Worker code | Batch rebuild/deploy when metadata or page content changes |
| New or not-yet-prerendered game slug | Start Worker SSR, if the application keeps that route dynamic | Add slug to the next prerender build; optionally cache the Worker response with an explicit TTL |
| Live player metrics, prices, or deals | `/api/*` Start server route invoked by the Worker; client fetch after hydration | Refresh at the selected polling cadence; optionally use short shared caching and purge on authoritative updates |
| Fingerprinted JS/CSS/images | Static assets served from Cloudflare's asset store/CDN | Long immutable cache policy via `_headers` where appropriate |
| Authenticated/personalized content | Worker/server route, not a public static asset | Private/no-store response policy |

This model uses only documented TanStack and Cloudflare primitives. It does not claim native TanStack ISR or on-demand static-page generation.

## Primary sources

- [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)
- [TanStack static prerendering](https://tanstack.com/start/latest/docs/framework/react/guide/static-prerendering)
- [TanStack server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)
- [TanStack server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)
- [TanStack static server functions](https://tanstack.com/start/latest/docs/framework/react/guide/static-server-functions)
- [TanStack ISR guide](https://tanstack.com/start/latest/docs/framework/react/guide/isr)
- [TanStack prerender source](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/prerender.ts)
- [TanStack prerender route discovery source](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/start-router-plugin/generator-plugins/prerender-routes-plugin.ts)
- [TanStack Start configuration schema](https://github.com/TanStack/router/blob/37877da166fe4ce055c7b85e138b6681ebd7e8b4/packages/start-plugin-core/src/schema.ts)
- [Cloudflare TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
- [Cloudflare static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Vite plugin static assets](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/)
- [Cloudflare Worker script routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Cloudflare SSG routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- [Cloudflare HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)
- [Cloudflare static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Cloudflare Workers Cache](https://developers.cloudflare.com/workers/cache/)
- [Cloudflare Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
- [Cloudflare Workers cache purge](https://developers.cloudflare.com/workers/cache/purge/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
