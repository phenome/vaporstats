# Prototype: grounding the gameplay match on Steam community tags

Throwaway code kept as a primary source. It is not part of the application and this branch is not meant to be merged.

**Question.** If the Gameplay & systems match reads a game's Steam community tags, does the pool come out in an order a player would agree with, and is there a bar below which a game should not be listed?

**Verdict (2026-11-28).** Yes. Rarity-weighted overlap of genre, viewpoint and mechanics tags spreads the pairs across 0.00–0.69, where the live coverage embedding scores sit in 0.68–0.77, and it names the tags two games share. Embedding the tags, alone or with coverage text, compresses the scores again and adds nothing. A bar of 0.30 is a first guess from seven games.

- `prototype.ts` computes every variant and writes `report.html`. Run it with `bun scripts/prototypes/gameplay-tag-match/prototype.ts`; the embedding variants need `GEMINI_API_KEY`.
- `pool.json` holds the inputs: each game's top 20 community tags with vote counts (Steam `IStoreBrowseService/GetItems`), Steam-wide game counts per tag (store search totals), the published Overview text, and the live scores from the public detail API. All were read on 2026-11-28.
- `report.html` is the generated report: open it to switch variants and move the bar.
