# Gameplay tag matches

Evaluation behind [#101](https://github.com/phenome/vaporstats/issues/101) and [ADR 0023](../adr/0023-gameplay-matches-from-steam-community-tags.md).

## Method

The pool was the five published games (Baldur's Gate 3, Warlock: Dungeons & Dragons, Hades II, Cyberpunk 2077, NO LAW) and two reference games from the 2026-11-25 fixed ranking evaluation (Dead Cells, Stray Gods). All inputs were read on 2026-11-28.

- **Live scores** came from the public detail API for the published games and from the fixed ranking evaluation for the reference pairs.
- **Tag overlap** read each game's Steam community tags: the top 20 with vote counts that the catalog stores as `community_tag` Catalog Facet memberships. It kept the tags that describe genre, viewpoint or mechanics, weighted each by its share of the game's top vote count and by its rarity across Steam (the natural logarithm of the total number of Steam games over the number of games with the tag), and took the cosine of the two weighted tag sets.
- **Strongest shared tags** are the tags both games have, ordered by the product of their two weights.

## Results

| Pair | Live gameplay score | Tag overlap | Strongest shared tags |
|---|---|---|---|
| Cyberpunk 2077 – NO LAW | 0.757 | 0.685 | Open World, FPS, RPG |
| Dead Cells – Hades II (reference) | 0.768 | 0.551 | Hack and Slash, Action Roguelike, Roguelike |
| Cyberpunk 2077 – Warlock | not returned | 0.489 | Open World, Exploration, Action |
| NO LAW – Warlock | 0.683 | 0.326 | Open World, Exploration, Action |
| Baldur's Gate 3 – Cyberpunk 2077 | 0.742 | 0.209 | RPG, Character Customization, Adventure |
| Baldur's Gate 3 – NO LAW | 0.697 | 0.163 | RPG, Choices Matter, Adventure |
| Cyberpunk 2077 – Hades II | 0.739 | 0.146 | Action RPG, RPG, Action |
| Hades II – NO LAW | 0.704 | 0.068 | RPG, Action |
| Baldur's Gate 3 – Hades II | 0.740 | 0.063 | RPG |
| Baldur's Gate 3 – Warlock | 0.753 | 0.060 | Adventure, Combat |
| Hades II – Warlock | 0.687 | 0.043 | Action |
| Hades II – Stray Gods (reference) | 0.736 | 0.000 | none |

The live coverage embedding scores sit between 0.68 and 0.77, and the two plausible published pairs lead an implausible one by about 0.01. Tag overlap spreads the same pairs across 0.00–0.69, places the two pairs a player would expect (Cyberpunk 2077 – NO LAW, Dead Cells – Hades II) first, and scores the action roguelike against the musical visual novel at zero. A bar of 0.30 keeps the four highest pairs and drops the rest; it was chosen on these seven games.

## Embedding variants

Three embedding variants were also tried, all on the production embedding model:

- **Tag profile.** An embedding of a short profile built only from the game's genre, viewpoint and mechanics tags compressed the pairs back into 0.74–0.96 and scored Baldur's Gate 3 – Stray Gods at 0.850.
- **Overview text.** An embedding of the published Overview text alone gave 0.55–0.68 with no usable order.
- **Tag profile and Overview text.** The tag profile followed by the Overview text gave 0.72–0.77.

Direct tag overlap needs no provider call, separates the pairs, and names the tags two games share.

## Sources

Prototype source, inputs and report: branch [`prototype/gameplay-tag-match`](https://github.com/phenome/vaporstats/tree/prototype/gameplay-tag-match/scripts/prototypes/gameplay-tag-match). The recorded community tags of the seven games are kept as a test fixture, [`tests/fixtures/recorded-community-tags.json`](../../tests/fixtures/recorded-community-tags.json), and `tests/media-gameplay-tags.test.ts` reproduces every pair's tag overlap score from it with the checked-in gameplay tag table ([`tests/fixtures/gameplay-tag-expected-scores.txt`](../../tests/fixtures/gameplay-tag-expected-scores.txt)). With that table's classification and Steam-wide counts, Dead Cells – Hades II scores 0.589 rather than the prototype's 0.551; every other pair above agrees to three decimals, and no pair changes side of the bar.

The gameplay cases of the [2026-11-25 fixed ranking evaluation](2026-11-25-fixed-ranking.md) (R01 and the gameplay half of R03 and R11) describe the superseded embedding ranking.
