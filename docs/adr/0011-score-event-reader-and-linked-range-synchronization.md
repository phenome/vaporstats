# Score Event Reader and linked range synchronization

VaporStats displays publisher announcements, patch notes, and major updates directly on game score charts. Clicking a score event replaces the adjacent Reception card with an in-card Score Event Reader, while graph observation periods are driven by URL search parameters.

## Decision

1. **Score Event Reader**:
   - Clicking a score milestone on the Score History chart transitions the Reception card into the Score Event Reader, featuring article content extracted via Mozilla Readability within a ShadCN `ScrollArea` and an top-right close control (`X`).
   - Content extraction runs on-demand through an internal endpoint (`GET /api/games/:appid/events/:eventId/reader`). The server fetches the Steam event or announcement, cleans and extracts the article text, sanitizes HTML to prevent script injection and tracking pixels, and caches the result with Cloudflare CDN and browser cache headers.
   - If an article cannot be extracted (e.g. anti-bot protections, paywalls, or media-only updates), the reader renders a graceful metadata fallback displaying the event title, category, publication date, and an outbound link to the source.

2. **Linked Range Synchronization**:
   - Player History and Score History synchronize to a shared numeric parameter (`range=[1-5]`) stored in URL search parameters:
     - `1`: `24h`
     - `2`: `7d`
     - `3`: `30d` (default, omitted from the URL)
     - `4`: `90d`
     - `5`: `all`
   - Price History uses an independent parameter (`pricerange=[1-4]`) reflecting price-specific cadence:
     - `1`: `30d`
     - `2`: `6m`
     - `3`: `1y`
     - `4`: `all`
   - Switching `range` while reading an event automatically dismisses the reader if the event's date falls outside the newly selected score graph bounds.

3. **URL State & Navigation**:
   - The active event is tracked in the URL via `?event=<event_id>`.
   - Dismissing the reader (via the `X` button or the `Escape` key) removes `event` from the URL and restores the primary Reception card.
   - On mobile viewports where the reception section sits below the chart, opening an event scrolls smoothly into view and moves focus to the reader. Closing restores focus to the triggering chart element without scrolling back.
