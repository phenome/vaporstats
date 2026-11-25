# Private evaluation of article-level coverage briefs

The candidate uses the three published games' run 24 evidence on private SQLite copies. Each text submission used the configured Haiku 5.5 model through the normal paid-work queue. No extraction, embedding or production update was part of this evaluation.

The review checked the original IGN and Eurogamer PC articles against five held Cyberpunk observations. The scoped amendments cover optional quests and dialogue/animation problems in IGN, and Eurogamer's character writing, combat and animation assessments. They belong to the reviewed PC versions. They do not establish that those writers used PC Gamer's Day 0 patch. [IGN PC review](https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review) · [Eurogamer review](https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met)

The first three v12 syntheses cost $0.004035. All three settled. Cyberpunk used multiple outlets across the brief, but zero individual claims retained multiple outlets. Its generated lead combined observations with incompatible explicit qualifiers. The validator correctly withheld those groups, including an otherwise usable pair of IGN and Eurogamer observations about bugs. The only surviving lead statement concerned the Switch 2 image. This result failed the intended editorial check.

The presentation keeps a single article directly accessible. Multiple articles from one outlet share an outlet number, and an article subscript identifies the cited row. Groups of materially distinct editions appear as chapters when the selected details support a split. Similar Games combines the two dimension lists only when they contain the same games in the same order. Older saved Overviews remain readable.

## Final private results

The three initial v13 submissions cost $0.004824. A settlement error occurred after the provider had answered. The corrected settlement path consumed the saved replies after matching the requests and provider receipts. Review of the Cyberpunk result found that only one of the cited articles supported interrupted dialogue. Narrowing the shared observation to broken character animations and rerunning Cyberpunk cost $0.001804. The total across versions was **seven submissions and $0.010663**. Final validation reused the paid replies and existing vectors.

| Game | Surviving lead and topic statements | Article support |
|---|---:|---|
| Cyberpunk 2077 | 11 | Four articles from three outlets. IGN and Eurogamer both support animation glitches interrupting scenes in the reviewed PC version. Vehicles spawning inside one another stays with the Day 0 PC review. The Switch 2 image comparison links to IGN’s separate port review. |
| Hades II | 10 | Three outlets contribute across the brief. Each remark has one supporting article. The PC 1.0 build finding appears separately from Early Access findings. |
| Baldur’s Gate 3 | 9 | The retained statements come from IGN’s Early Access coverage. The reader uses a flat brief. Broader or current-release agreement remains unestablished. |

The final validation held back a claim that surface and underworld runs alternate and a claim that made a possible change to the ending sound certain. These checks cover observed wording failures. Semantic agreement still requires reading the cited evidence. Some display qualifiers remain repetitive, especially when the prose already names the PC or Switch 2 version.

In responsive Chromium at 390 and 1280 CSS pixels, activating a Cyberpunk citation opened the closed IGN group and focused the specific article row.

## Regression coverage

| Criterion or probe | Verification |
|---|---|
| Grouped articles, subscripts, edition chapters and flat briefs | `tests/media-sources.test.tsx`; private Chromium citation check |
| Compact ordered Similar Games links | `tests/media-matches.test.tsx` |
| Clause-level references, qualifier preservation, incompatible scope and strengthened wording | `tests/media-observations.test.ts`, `tests/media-openrouter.test.ts`; private syntheses above |
| Send-once, bounded retries and resume | `tests/media-interruptions.test.ts`, `tests/media-paid-work.test.ts` |
| Response classification, scopes and outlet limits | `tests/media-provider-contract.test.ts`, `tests/media-outlet-contract.test.ts`, `tests/media-shared-limits.test.ts`, `tests/media-boundaries.test.ts` |
| Production-like switch and resume | `tests/media-enablement.test.ts` |
| Deletion scope and spec gaps | Empty deleted-file diff against main. Chapter dates use the earliest publication month of their cited articles. The existing usable-article threshold is unchanged. |
| Item and tick isolation | `tests/media-tick-isolation.test.ts`, `tests/media-interruptions.test.ts` |

All 1,065 repository tests passed. The migration verification originally mocked an obsolete provider response. With the mock returning a clause and its observation IDs, the retained waiting-run upgrade check passed, along with type checking, the production build and output validation.
