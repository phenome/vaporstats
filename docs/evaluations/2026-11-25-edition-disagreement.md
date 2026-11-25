# Skyrim edition attribution and Hades II disagreement

The current reader kept the Skyrim editions separate in two Haiku-generated Overviews from normalized outlet HTML. For Hades II, the outlet reviews disagree about combat feel, but no live pair of findings survived extraction. A controlled selection preserved both sides and their citations through the current reader.

## Replay setup

Two private copies of run 24 each assigned local run ID 25 to the same four pinned URLs. The original Skyrim catalog entry was absent from the snapshot and was added to each copy for the evaluation. The two Skyrim apps were enrolled as independent roots. Other Hades II extractions and its existing Overview were made inactive in the copies to isolate the two launch reviews. Discovery and edition matching were bypassed by pinning the source-to-app mapping.

Processing used `advanceMediaProcessing` with the normal SQLite queues and `anthropic/claude-haiku-5.5`. Each OpenRouter request used the run 24 SSH credential forward. The first pass supplied untouched response HTML. The second used the freshly fetched editorial subtree, `#article-body` for PC Gamer and GamesRadar+ and `.entry-content` for Kotaku, to reconstruct minimal HTML in memory before handing it to the normal cleaner. For the original Skyrim, the second pass used the more specific build context “original 2011 PC release” and corrected the archive page date supplied as metadata to March 25, 2024. For Hades II it explicitly used “PC full release 1.0.”

Five extraction requests and two synthesis requests reached OpenRouter across both copies. The recorded total was 13,560 micro-USD ($0.01356). No embedding was submitted. Article bodies and extraction prompts were not retained. Local evidence is indexed by `/tmp/vaporstats-offline-audit/edition-disagreement-path` and includes job logs, content hashes, stored observations, and reader output.

## Pinned source outcomes

| App | Source and local ID | Untouched HTML | Normalized HTML |
| --- | --- | --- | --- |
| Original Skyrim `72850` | `18` · [PC Gamer's archived 2011 review](https://www.pcgamer.com/the-elder-scrolls-v-skyrim-review/) | HTTP 200. Job `80` received 16 observations with numeric app IDs. The validator refused the output with no supported contributions, primarily because the supplied scope did not occur in the excerpts or source context. | Job `80` stored extraction `19` with 13 observations. Job `84` generated Overview `22`. |
| Skyrim Special Edition `489830` | `19` · [GamesRadar+'s 2016 Special Edition review](https://www.gamesradar.com/skyrim-special-edition-review/) | HTTP 200. Job `81` hit a cleanup exception accessing `firstElementChild` and entered backoff before a provider request. | Job `81` stored extraction `20` with seven observations. Job `85` generated Overview `23`. |
| Hades II `1145350` | `20` · [GamesRadar+'s full-release review](https://www.gamesradar.com/games/roguelike/hades-2-review-2025/) | HTTP 200. Job `83` hit the same cleanup exception and entered backoff before a provider request. | Job `83` returned observations, but none passed the scope check. No extraction was activated. |
| Hades II `1145350` | `11` · [Kotaku's full-release review](https://kotaku.com/hades-ii-the-kotaku-review-2000628064) | HTTP 200. Job `82` ended `article_unusable` before a provider request. | Job `82` stored extraction `21` with two observations, a protagonist detail and a tag. There were no accepted findings. |

The Skyrim source assignment follows the distinct [original Skyrim Steam entry](https://store.steampowered.com/app/72850/) and [Special Edition Steam entry](https://store.steampowered.com/app/489830/). Extraction used `media-extraction-2026-11-25-v5`. Synthesis used `media-synthesis-2026-11-25-v11`.

| Source ID | Cleaned content SHA-256 for normalized replay | Extraction input identity |
| --- | --- | --- |
| `18` | `ae0e47c1a2fe204d1ef6b3ad519fc5524922a1ac53c77cb97a86f8179d08353d` | `36d424388bd5b61dc9d4fe5c8a3bae76cd15139d920ba1069225fff155c127b3` |
| `19` | `808b62d351f88299247c9367f00c9a6a7522c5ab1d1312880ac4f141efbed58f` | `4b368bddac035ccfbfbf82e7a3548c2bcaf7f3e55330941a2bc79cb6dc22a416` |
| `20` | `457a03c68aa9b40264e99e4f1db06f6c9e01686140c2410b7d6835adda24fef3` | `60476989bb868a01f2b4099c3b0f7a2a2bd4c240c48ac49b6f8e2e791bd3dc1d` |
| `11` | `43fc40888cadb317aa96a2da2c75d04c9c612dbadad6e0f93bf36156e8410f9e` | `cae104c287267a607012af9d2b5887a0dcf77c45f2be925d89a2f942f49a0a26` |

## Reader checks

| Case | Check and observed result |
| --- | --- |
| Original and Special Edition each contribute only to their own app | `getMediaOverview(db, appid, { includeUnpublished: true })` returned eight cited display rows for each app, counting statements, category findings and pros and cons. Every citation in original Skyrim pointed to PC Gamer. Every citation in Special Edition pointed to GamesRadar+. |
| Cross-edition isolation when stored citations are mixed | Within a rolled-back transaction for each app, a sibling-only statement disappeared from the reader and a mixed statement retained only its own app's URL. |
| Hades II release disagreement, live | Both reviewers played the PC launch build. GamesRadar+ praises the thrill and skill expression of moment-to-moment combat. Kotaku sees value in the tactical design but finds the immediate actions less satisfying than in the first game. The disagreement concerns combat feel. The Kotaku author reports about 30 hours without finishing the full story. The isolated queue refused the synthesis locally before a provider call because it had no citable statements. The reader returned no Overview for the pair. [GamesRadar+](https://www.gamesradar.com/games/roguelike/hades-2-review-2025/), [Kotaku](https://kotaku.com/hades-ii-the-kotaku-review-2000628064) |
| Hades II release disagreement, controlled | Two source-derived paraphrases used the real URLs and distinct fixture observation identities under the same PC 1.0 qualifier. `validateSynthesisSelections` accepted one contested category finding with both references and rejected a non-contested merge of the same observations. Changing one qualifier to PC Early Access caused the contested row to be dropped. The live reader preserved the contested flag and both URLs when given the validated fixture in a rolled-back transaction. |

The replay exhausted the five-extraction allowance before the cleanup and app ID fixes could be evaluated. Production-path extraction for these sources and a live Hades II disagreement remain open.
