# Direct public critic alignment and streamlined reception presentation

VaporStats compares Current Player Score directly with published public critic aggregates from OpenCritic and Metacritic. It drops speculative launch-window review-time requirements, private API authorization preconditions, and platform-isolation gates.

## Direct alignment

1. **Direct comparison**: Align Current Player Score directly against the published critic aggregate (Metacritic 0–100 or OpenCritic tier). Both sources map to three native directions (Unfavorable, Mixed, Favorable) and produce source-specific alignment labels (`Broadly aligned`, `Players more favorable`, `Critics more favorable`, `Clearly divergent`).
2. **OpenCritic cross-platform aggregates**: Accept OpenCritic's overall score and tier as valid game critic reception. Cross-platform aggregate scope is preserved without disqualifying Steam titles.
3. **Base-game identity verification**: Treat Steam store-linked Metacritic URLs and canonical OpenCritic title and slug matching as sufficient identity verification for base games without requiring explicit edition subtitles.
4. **Streamlined UI presentation**: Keep the visitor-facing reception card focused on the score, review volume, and direct alignment indicator. Omit nested review-time disclaimers, duplicate secondary contrast rows, and auxiliary multi-period trend blocks from the primary card.
