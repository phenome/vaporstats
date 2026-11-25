# Offline editorial audit, November 25, 2026

This audit examined all 31 Overview statements on a read-only private copy of the run 19 database. “Supported” means the cited active extraction supports the statement at its stated scope. Original articles were outside the offline review. “Partial” means a clause, attribution, or scope exceeds that evidence. Unknown means the saved evidence cannot settle the claim. Statement numbers follow the stored Overview array. Source IDs identify database rows. The three candidates have active Overview IDs 12, 13, and 10; Phantom Liberty ID 11 is outside this audit.

| Overview | Statement(s) | Cited source IDs | Assessment and scope |
|---|---|---|---|
| BG3 12 | 1 | 1 | Partial: extraction 14 supports turn structure, rules and Faerûn, and lists single-player as a trait. The saved material leaves unclear whether the article establishes a mode or describes the writer playing solo. Early Access explicitly stated. |
| BG3 12 | 2–6 | 1 | Supported by extraction 14, with Early Access explicitly stated. Review covers several hours, not all content; platform unspecified. |
| Cyberpunk 13 | 1 | 4, 6 | Split the clauses and attach their respective citations. Extractions 2 and 4 collectively support the statement. |
| Cyberpunk 13 | 2, 4, 7, 12 | 4 | Supported by extraction 2, as the PC review's assessment. |
| Cyberpunk 13 | 3, 6, 9, 13 | 6 | Supported by extraction 4, as the PC review's assessment. |
| Cyberpunk 13 | 5, 8, 10, 11, 17 | 5 | Supported by extraction 3, as the review's assessment. |
| Cyberpunk 13 | 14–16 | 4, 5, 6 respectively | Partial: each extraction reports the described bugs, but present tense omits the review-time scope; source 6 explicitly identifies launch and a Day 0 patch. Current persistence is unknown. |
| Cyberpunk 13 | 18–19 | 12 | Supported by extraction 15 with explicit Switch 2 scope; control comfort and performance are reviewer observations at review time. |
| Hades II 10 | 1 | 10, 16, 8 | Partial: extraction 16 for source 10 contains the full equipment list as a trait; sources 16 and 8 do not establish the whole list or its pre-run timing. Multiple citations do not independently support every clause. |
| Hades II 10 | 2 | 10, 16 | Partial: source 10 supports flexible weapon, magic and boon combinations and experimentation in PC 1.0; source 16 supports boons, weapons and Hexes. Free combination of every named item is not established. |
| Hades II 10 | 3 | 16, 10 | Split by source: extraction 18 supplies paths and distinct contents; extraction 16 supplies Surface locations. |
| Hades II 10 | 4 | 16, 10 | Split by source: extraction 18 supplies upbringing and necessity; extraction 16 supplies named cast, conversations and consequences. |
| Hades II 10 | 5 | 9, 10 | Split by source, retaining the explicit Early Access and 1.0 scope. Extraction 5 supplies continuity; extraction 16 supplies Surface sound. |
| Hades II 10 | 6 | 10 | Supported by extraction 16, explicitly comparing Early Access and PC 1.0. |

The known BG3 Single-player discovery tag derives from source 1's Early Access extraction and is unqualified at game level; the extraction does not establish that this trait describes the released game. Hades II's Early Access build tag describes a source state rather than the whole game, alongside later coverage. Earlier Hades II Multiplayer and Steam Deck tags based on source 10 are absent from the regenerated output; the previous evaluation identified a conflict over multiplayer and metadata-only support. Cyberpunk's Switch 2 control tags require platform qualification; the prior evaluation records closing parentheses lost during normalization. These observations do not establish correctness of other tags.

If the omitted details are needed, inspect original source 1 for the mode assertion and Early Access context; sources 4–5 for missing build context on their bug claims; and sources 8–10 and 16 for the Hades compound claims, equipment timing, state distinctions and multiplayer evidence. Source 6 already identifies the Day 0 patch, and source 12 already describes the Switch 2 controls. Neither needs a refetch solely to recover that context. A refetch can establish what an article says at retrieval, not prove today's game state. The editorial review covered the Overview statements and selected discovery tags. An extraction can omit details present in the article.

## Offline replay of saved evidence

The retained Overviews predate observation references. Replaying the three original statement arrays against the new reference requirement accepted zero legacy statements verbatim. Their saved URLs alone cannot identify the observations behind each clause.

A separate offline selection exercise proposed each eligible legacy finding independently with its source and observation ID. Through the Overview reader, six BG3 findings, seven Cyberpunk findings and seventeen Hades II findings survived. BG3’s general Single-player tag and Hades II’s historical Early Access build tag stayed out. Cyberpunk retained the explicitly scoped Joy-Con aiming trait. The counts describe machine-checkable support in retained extractions, not original-article verification or a new Haiku response.

The private queue replay reused the nine active article extractions for the three roots. A deterministic local transport returned the eligible saved findings with their observation references. All three synthesis jobs succeeded with the public gate off. Each persisted statement and tag retained its observation references. The extraction rows and all earlier attempts matched the input copy, and the foreign-key check passed. The replay emitted 13 follow-up entries for BG3, 41 for Cyberpunk and 70 for Hades II. These include conservative omissions from older extraction formats. Refreshing a private Markdown copy added all 124 entries once and zero on the second refresh. An additional negative control supplied unsupported wording with a valid reference and each game dropped that wording while retaining supported statements. No outlet or inference endpoint was contacted.

The [living editorial document](media-unsure-entries.md) was refreshed from the positive replay. Deliberately unsupported negative-control claims were confined to a separate private copy.

### Regression coverage

| Criterion or repository probe | Verification |
|---|---|
| Observation identity, material scope, claim citations and partial acceptance | [Observation pipeline and queue cases](../../tests/media-observations.test.ts) |
| Existing extraction evidence, uncertain traits and Day 0 patch | [Legacy evidence cases](../../tests/media-legacy-observations.test.ts) |
| Queued work across a contract upgrade and stale build labels | [Upgrade regressions](../../tests/media-observation-upgrade.test.ts) |
| Stable follow-up entries, human amendments and build inclusion | [Editorial refresh and bundle cases](../../tests/media-editorial.test.ts) |
| Displayed tag punctuation, API and public gate | [Processing](../../tests/media-processing.test.ts) and [publication readers](../../tests/media-publication.test.ts) |
| Send-once and resume | [Interruption sweep](../../tests/media-interruptions.test.ts) and [paid-work retries](../../tests/media-paid-work.test.ts) |
| Provider and outlet classification | [Provider contract](../../tests/media-provider-contract.test.ts), [outlet contract](../../tests/media-outlet-contract.test.ts), [shared limits](../../tests/media-shared-limits.test.ts) and [boundary checks](../../tests/media-boundaries.test.ts) |
| Production-like switch behavior | [Enablement suite](../../tests/media-enablement.test.ts) |
| Deletion scope and specification gaps | Empty file-deletion diff. The private replay records the limits of older, article-level evidence and the stricter requirements on future output. |
| Exception isolation | [Tick isolation](../../tests/media-tick-isolation.test.ts) and [interruption sweep](../../tests/media-interruptions.test.ts) |

### Paid Haiku synthesis on the same evidence

Run 20 used a fresh private copy of the run 19 database and the nine saved extractions used for the offline replay. OpenRouter served three strict-schema requests for Claude Haiku 5.5. All returned valid JSON on the first attempt. The queue accepted two Overviews. Total reported cost was US$0.006254. Production publication was verified off before and after the run.

| Game | Top-level statements accepted | Outcome | Cost |
|---|---|---|---|
| Baldur’s Gate 3 | 0 of 7 | All seven proposed statements referenced gameplay or story/world similarity observations. Eight eligible finding observations were also supplied. The queue recorded a definite refusal. | US$0.001663 |
| Cyberpunk 2077 | 3 of 3 | The saved bug claim carries PC and Day 0 patch qualifiers. The Switch 2 aiming tag retained its source. Two proposed pros and one con referenced the wrong observation kind and were omitted. | US$0.001876 |
| Hades II | 6 of 6 | All retained statements carry Early Access scope. Two proposed category findings from the 1.0 review failed the wording check, leaving the saved result reliant on Early Access coverage. | US$0.002715 |

Every retained citation resolved to the referenced observation in the supplied evidence for its game. The prior attempts and extracted articles matched the input database. SQLite integrity and foreign-key checks passed. The living document gained ten questions and a repeat refresh added zero. This run exercised live synthesis on saved extractions. It used no article refetches or embedding submissions and did not exercise live extraction.

### Paid Haiku synthesis with eligible IDs per section

Private run 21 reused the same nine saved extractions as run 20. OpenRouter served three strict-schema Haiku 5.5 synthesis requests for US$0.001917 total. The queue accepted all three Overviews on the first attempt. Production publication was verified off after the run.

| Game | Eligible findings | Top-level statements accepted | Cost | Saved scope |
|---|---:|---:|---:|---|
| Baldur’s Gate 3 | 6 | 6 of 6 | US$0.000447 | All six carry Early Access scope. The request excluded two of the eight prior findings under the display wording rule. |
| Cyberpunk 2077 | 7 | 6 of 6 | US$0.000653 | The bug statement retains PC and Day 0 patch scope. Haiku did not select the eligible Switch 2 aiming tag. |
| Hades II | 17 | 17 of 17 | US$0.000817 | All statements describe Early Access. Two full-release findings were excluded under the display wording rule. |

The previous BG3 request exposed findings and similarity observations together. Each of the seven proposed top-level statements cited similarity evidence (four gameplay, three story/world). The queue requires at least one top-level statement supported by a finding. The new request restricts selections per section and resolves selected IDs to stored wording, qualifiers, and citations. This run measured synthesis over saved extractions. It made no article fetches or embedding submissions.

All 58 saved entries (29 top-level statements and 29 category findings) retained the URLs of their selected observations. SQLite integrity and foreign-key checks passed. Earlier processing attempts and all extraction rows matched the input database. Refreshing the living editorial document twice added zero questions.

### Hades II single-review attribution

Private run 22 reused the four active Hades II extractions from run 21. The previous wording filter rejected the word “reviewer” in two findings from PC Gamer. The revised filter accepts individual attribution and records the matched expression for collective support language separately from a length failure. The three archived run 21 requests retained their original selection ID mappings when replayed under their recorded configuration.

Haiku 5.5 selected all 19 eligible findings in one synthesis attempt costing US$0.001176. All 19 were saved. Both previously excluded observations appeared in the top-level statements and Gameplay & systems with their original citation. The combat and build finding identifies the PC 1.0 version. The crafting finding attributes the slow opening to the writer’s experience in both Early Access and 1.0. [PC Gamer review](https://www.pcgamer.com/games/action/hades-2-review/)

The saved result had zero wording omissions and 68 existing editorial questions. Refreshing the living document added zero questions. Extraction rows and prior processing attempts matched run 21. The only provider submission was Hades II synthesis. Production publication was verified off before and after the run.
