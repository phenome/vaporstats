# Cyberpunk 2077 reception timeline research

This note supplies a compact, source-backed event layer for the rankings page. It separates game lifecycle events, free updates, and the later bundle so an edition launch is not mistaken for a second game release.

## Verified event timeline

| Event | Calendar date to show | First-party evidence and interpretation |
|---|---:|---|
| Initial PC/Steam release | **2020-12-10** | [CD PROJEKT RED: Cyberpunk 2077 is Out Now](https://www.cdprojekt.com/en/media/news/cyberpunk-2077-is-out-now/) says the game is available on PC via GOG, Steam, and Epic Games Store, as well as console platforms. Use this as the initial game release date. Steam's app-details endpoint returned **9 Dec, 2020** when fetched, so that store metadata should not be treated as a UTC instant. |
| Patch 1.5 / Next-Generation Update | **2022-02-15** | [CDPR patch notes](https://www.cyberpunk.net/en/news/41435/patch-1-5-next-generation-update-list-of-changes) are dated 2022-02-15. The matching [Steam announcement](https://steamcommunity.com/games/1091500/announcements/detail/3120434024067857737) says “Patch 1.5 is live!” and describes improvements, fixes, and free DLC. This is a free update, not a new lifecycle release. |
| Edgerunners Update / Patch 1.6 | **2022-09-06** | [CDPR patch notes](https://www.cyberpunk.net/en/news/45280/edgerunners-update-patch-1-6-list-of-changes) say “The Edgerunners Update (Patch 1.6) is live on all platforms!” The [Steam announcement](https://steamcommunity.com/games/1091500/announcements/detail/3356892105055087108) records the same event and date. |
| Free Update 2.0 | **2023-09-21** | [CDPR's Update 2.0 page](https://www.cyberpunk.net/en/news/49060/update-2-0) is dated 2023-09-21. The [Steam announcement](https://steamcommunity.com/games/1091500/announcements/detail/3725096176275686396) calls it a free update to the base game and describes an overhaul of core mechanics. |
| Phantom Liberty expansion | **2023-09-26 advertised release date** | [CDPR's date announcement](https://www.cyberpunk.net/en/news/48265/cyberpunk-2077-phantom-liberty-arrives-on-september-26th) says the expansion arrives on September 26. CDPR's [premiere announcement](https://www.cdprojekt.com/en/media/news/cyberpunk-2077-phantom-liberty-premiere/) says it is available digitally, and the [Steam announcement](https://steamcommunity.com/games/1091500/announcements/detail/3725096176290982673) was published at **2023-09-25 23:04:53Z** and says it is available on Steam. Keep both facts: the announced calendar date is 2023-09-26; the source record is not evidence of a 2023-09-26 00:00 UTC launch. Phantom Liberty is an expansion, not a new Cyberpunk 2077 app lifecycle. |
| Ultimate Edition availability | **2023-12-05** | [CDPR: Ultimate Edition is out now](https://www.cyberpunk.net/en/news/49696/cyberpunk-2077-ultimate-edition-is-out-now) dates availability to 2023-12-05. The [Steam announcement](https://steamcommunity.com/games/1091500/announcements/detail/3873720583808974568), published 2023-11-21, says it includes the base game, free Update 2.0, all free DLC, and Phantom Liberty. Model this as an edition/bundle packaging event, **not** a second base-game lifecycle release or a new release date for Cyberpunk 2077. |
| Optional: free Update 2.1 | **2023-12-05** | [CDPR's corporate release note](https://www.cdprojekt.com/en/media/news/cyberpunk-2077-ultimate-edition-and-update-2-1-available-today/) says Update 2.1 was released that day; the [Steam announcement](https://steamcommunity.com/games/1091500/announcements/detail/3873721309648486252) says “Update 2.1 is now available!” Treat it as a maintenance/update marker alongside the Ultimate Edition packaging event. |

The official sources establish what shipped and when; they do **not** establish that any particular patch caused a change in reception. The chart should show temporal proximity as descriptive context, not as a causal claim.

## Steam review-history evidence

The public [Steam app review histogram](https://store.steampowered.com/appreviewhistogram/1091500?l=english) was available at fetch time and returned success: 1, rollup type: month, and **70** monthly rollups labelled 2020-12 through 2026-09. The derived monthly-count artifact is [cyberpunk-reception-history.json](./cyberpunk-reception-history.json).

The artifact's metric is deliberately named **Monthly Steam review approval**. Each row is an observed monthly bucket:

- **positive** = Steam API recommendations_up.
- **total** = recommendations_up + recommendations_down.
- **approval** = positive / total (stored as a decimal rounded to six places).

This is not Steam's current/all-time review summary and is not a player count or a historical “Current Player Score.” No individual reviews were collected. The request includes the parameter l=english; the endpoint's aggregate population beyond that request parameter is not independently specified, so do not claim that it exactly matches a ranking-page default or another Steam score population. The first and latest calendar buckets are partial relative to the endpoint coverage (2020-12-10 through 2026-09-07), and the latest 2026-09 bucket is still in progress at fetch time. The artifact records fetchedAt and the response coverage for reproducibility.

Observed rows around the main markers (actual endpoint values, not fabricated score points):

| Month | Positive | Total | Approval |
|---|---:|---:|---:|
| 2020-12 | 227,472 | 290,805 | 0.782215 |
| 2022-02 | 7,466 | 9,876 | 0.755974 |
| 2022-03 | 5,293 | 10,435 | 0.507235 |
| 2022-09 | 13,058 | 15,013 | 0.869780 |
| 2022-10 | 12,220 | 13,626 | 0.896815 |
| 2023-09 | 15,504 | 17,942 | 0.864118 |
| 2023-10 | 19,547 | 21,742 | 0.899043 |
| 2023-12 | 14,012 | 15,334 | 0.913786 |
| 2024-01 | 10,317 | 11,097 | 0.929711 |

These values are descriptive: monthly review volume and approval vary substantially, and their movement around an event cannot by itself identify the event as the cause.

## Compact ranking-page chart recommendation

1. Plot the 70 observed monthly approval values as one thin line, with no interpolation across absent buckets. Keep the y-axis labelled “Monthly Steam review approval.”
2. Put a subdued secondary volume encoding (tooltip or short bars) beside the line so a 93% month with 100 reviews is not visually equated with a 93% month with 20,000 reviews. Always expose positive / total in the tooltip.
3. Add neutral vertical event markers/badges for launch, 1.5, 1.6, 2.0, Phantom Liberty, and 2.1. Render Ultimate Edition as a distinct **Edition** marker (or annotation), not as a lifecycle release marker.
4. Use calendar-date markers only for the monthly chart. The Steam-specific preview uses September 25 for Phantom Liberty PC availability, supported by the out-now announcement; retain September 26 separately as the advertised release date. Neither date-only label asserts a midnight-UTC launch.
5. Add a small footnote: “Event timing is contextual; this view does not claim that an update caused reception changes.”

Sources are first-party CDPR/CD PROJEKT RED and Steam pages/API records; the report contains no production changes.
