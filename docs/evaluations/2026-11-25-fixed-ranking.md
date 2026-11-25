# Fixed ranking evaluation

The baseline is the private run 24 SQLite snapshot. The comparison uses current 3,072-component Gemini Embedding 2 vectors. Semantic cases use an internal candidate pool because the first public release exposes only the three experiment roots. Root eligibility and publication were also tested through the public reader on a disposable copy.

| Case | Pair or comparison | Observed result |
| --- | --- | --- |
| R01 Gameplay | Hades II (1145350) and Dead Cells (588650). Compare repeated runs and combat progression. | See supplemental results below. |
| R02 Story/world across genres | Hades II and Stray Gods (1920780). Compare interpretations of Greek mythology across an action roguelike and a roleplaying musical. | See supplemental results below. |
| R03 Independent dimensions and exact scores | All six directed root pairs in both dimensions. | All 12 public scores matched an independent float32 cosine calculation to within 1e-12. Each row contained the dimension, similarity and the matched app’s ID, name and slug. |
| R04 Praise only | Hades II and controlled Cyberpunk replacement praising writing. | No match in either direction. No embedding job created. Hades II still matched BG3. |
| R05 Popularity only | Hades II and controlled Cyberpunk replacement citing audience size. | No match in either direction. No embedding job created. Supported neighbor preserved. |
| R06 Technical problems only | Hades II and controlled Cyberpunk replacement reporting crashes and frame rate. | No match in either direction. No embedding job created. Supported neighbor preserved. |
| R07 Self | BG3, Cyberpunk and Hades II, each as its own candidate. | All lists excluded the input entity and retained other eligible roots. |
| R08 Compatibility and current evidence | BG3 and Cyberpunk with mismatched model, configuration or current Overview identity. | Each controlled change removed the pair in both directions. The compatible BG3/Hades II pair survived. SQLite rejected an invalid vector dimension. |
| R09 Root and child | Cyberpunk and Phantom Liberty. | Private reader preserved the independent child and root identities. Public scope excluded the child. The separately reviewed Skyrim editions also retained separate Overview identities; neither edition submitted an embedding in that replay. |
| R10 Ineligible or accessory entity | BG3 and Cyberpunk with controlled non-playable status or tool relationship. | Reader excluded both directions and retained the eligible Hades II neighbor. |
| R11 Top N | Each root against the other two, separately in each dimension. | Limit zero returned no matches. Limit one returned the highest score in each dimension. |
| R12 Publication gate | All three roots, with Phantom Liberty as the out-of-scope control. | Flag off returned no public matches. Flag on locally returned four per root and excluded the expansion on both sides. Internal reads returned the expansion. |

Reproduce R03–R12 with `bun --no-env-file scripts/evaluations/fixed-media.ts /path/to/run24/check.sqlite`. It makes its own temporary copy and uses scripted provider replies for the three negative-evidence cases. [Reader and queue assertions](../../scripts/evaluations/fixed-media.ts) · [Exact cosine and malformed-vector regressions](../../tests/media-similarity.test.ts)

The edition routing check uses the two real Skyrim Overviews from the separate private normalized-HTML replay. Adding orthogonal controlled vectors to a disposable copy produced the sibling’s distinct app ID with cosine zero in each direction, excluded self and preserved public exclusion. Reproduce with `bun --no-env-file scripts/evaluations/fixed-media.ts /path/to/edition-replay/normalized/check.sqlite editions`. [Edition provenance](2026-11-25-edition-disagreement.md)

### Live semantic comparisons

The paid replay produced current private Overviews 23 (Hades II), 26 (Dead Cells) and 24 (Stray Gods). R01 returned Hades II and Dead Cells reciprocally at **0.768021153384** in gameplay. Their inputs describe repeated combat runs, changing combat builds and progression across encounters. R02 returned Hades II and Stray Gods reciprocally at **0.739893310018** in story/world. Both use mythological gods and figures as characters, while Stray Gods uses branching musical choices and Hades II uses action combat. The original articles support the distinctions. [PC Gamer on Dead Cells](https://www.pcgamer.com/dead-cells-review/) · [PC Gamer on Hades II](https://www.pcgamer.com/games/action/hades-2-review/) · [GamesRadar+ on Stray Gods](https://www.gamesradar.com/stray-gods-the-roleplaying-musical-review/)

In the same Hades II query, Stray Gods scored 0.735792001836 in gameplay and Dead Cells scored 0.713393871022 in story/world. The relative ordering agreed with the two preselected connections. Independent cosine calculations agreed within 1e-12. No universal threshold or exact position is required. Reproduce both reciprocal reads and inspect the underlying dimension inputs with `bun --no-env-file scripts/evaluations/fixed-media.ts /path/to/fixed-live/check.sqlite pairs`.

The first two Dead Cells extractions placed mechanics in category findings and left gameplay similarity empty. The v7 prompt elicited five scoped gameplay observations from PC Gamer. The supplemental run sent eight extractions (five accepted, three refused), five syntheses and six embeddings. Two superseded embedding jobs settled stale. The ledger recorded $0.019623 for Haiku plus $0.000038 estimated for Gemini. This corpus is evaluation data and is outside the production promotion scope.
