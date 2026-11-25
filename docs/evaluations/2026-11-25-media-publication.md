# Three-game media publication evaluation, November 25, 2026

**Publication remains on hold.** The repaired local build restricts publication to the three experiment roots and passes the desktop and mobile-width navigation recheck. The content queue rehearsal used controlled replies. Actual regenerated Haiku output, changed embeddings and the outstanding development examples still require evaluation. The November 18 [scope amendment](https://github.com/phenome/vaporstats/issues/60#issuecomment-6978609666) covers Cyberpunk 2077, Baldur’s Gate 3 and Hades II and defers watchlist operation, source correction tooling and Coverage history.

The evaluation used phenome/vaporstats at `8e4d6e9` and the existing production snapshot dated November 24, written November 25. The reader ran against an immutable copy. The browser used a separate local copy, a production build with ingestion disabled, and the public flag enabled locally. No production settings changed. Fifteen source records and thirteen extractions were present. The four active Haiku Overviews were Cyberpunk 2077 (ID 4), Baldur’s Gate 3 (6), Hades II (8) and Phantom Liberty (9). Cyberpunk used three Gemini extractions and one Haiku extraction. The other three used Haiku extractions.

## Coverage

These twelve probes map observed output to [the coverage criteria](https://github.com/phenome/vaporstats/issues/44). They are not evidence that a previously fixed twelve-case development corpus was run. Stored extractions and article identities support bounded comparisons. Original articles were not exhaustively checked claim by claim.

| Case | Outcome on this snapshot |
|---|---|
| Single-source evidence | Baldur’s Gate 3 Overview 6 cites IGN Early Access source 1. The Early Access qualification appears on several claims. |
| Announcement without hands-on | No announcement example among the fifteen review sources. |
| Preview to release | No preview occurrence or before/after example. Live watchlist operation is deferred for first publication. |
| Contradictory assessments | Cyberpunk includes a contested characterization finding. Opposing article support needs independent checking. |
| Absent categories | Hades II omits technical experience/accessibility and Cyberpunk omits social play. Omission alone does not demonstrate appropriate classification. |
| Base and DLC | Cyberpunk and Phantom Liberty have distinct active Overviews and distinct source IDs. The public reader also exposes the DLC under the local flag. |
| Separately reviewed editions | Cyberpunk source 12 concerns a Switch 2 update. No independent edition output was available to prove separation. |
| Replacement | No controlled before/after case in this snapshot. The processing regression suite was run separately. |
| Product states | BG3 source 1 is Early Access. Hades II sources 8 and 10 span Early Access and 1.0. Attribution across mixed states still needs review. |
| Category placement | **Failed.** BG3 source 1 and Overview 6 put playable classes and races under Social play. The supporting material describes character creation. |
| Discovery tags | **Resolve before publication.** Hades II Overview 8 publishes Multiplayer from source 10. The [cited review](https://www.pcgamer.com/games/action/hades-2-review/) and [publisher’s Steam listing](https://store.steampowered.com/app/1145350/Hades_II/) disagree about the mode. The stored tag presents it without qualification. |
| Citations and distinct outlets | Cyberpunk cites sources 4–6 and uses source 12 for tags. All numbered links on the three pages had matching source rows. Clause-level support and duplicate treatment need further evaluation. |

## Ranking

Both dimensions had current 3,072-component vectors for all four entities. The application reader returned 24 directed pair/dimension results. Independent float32 decoding and cosine calculation reproduced all 24 within 3.8 × 10⁻¹⁵. Candidate identity, score, and dimension were present without generated match prose.

| Case | Outcome on this snapshot |
|---|---|
| Gameplay-only relationship | BG3 → Hades II scored 0.74658 in gameplay. Exclusive semantic support was not established. |
| Story/world-only cross-genre relationship | BG3 → Cyberpunk scored 0.75930 in story/world. Exclusivity and cross-genre interpretation need evidence. |
| Independent dimensions | BG3’s first gameplay match was Hades II and its first story/world match was Cyberpunk. |
| Quality-only candidate | Absent from active corpus. |
| Popularity-only candidate | Absent from active corpus. |
| Technical-problem-only candidate | Absent from active corpus. |
| Self exclusion | Passed for all four entities across both dimensions. |
| Compatibility exclusion | All eight active vectors were compatible. Incompatible vectors were exercised by regression tests. |
| Parent/child and edition isolation | Cyberpunk and Phantom Liberty returned each other as independent entities. No independent edition candidate was present. |
| Accessory and non-playable roots | No live negative candidate. Regression tests cover ineligible vectors. |
| Bounded results | Limit one produced one per dimension and limit zero produced none, for all four entities. |
| Publication gate | With flag off, ordinary reads returned empty and internal reads returned matches. With flag on, every experiment page linked to Phantom Liberty. Following the link rendered its full Overview. |

## Game-page checks

The [navigation criteria](https://github.com/phenome/vaporstats/issues/59) were checked in Chromium at 1280 and 390 CSS pixels. The narrower setting exercised responsive layout without device or touch emulation.

- All three experiment pages loaded by deep URL. Each had one active section on initial load, zero horizontal overflow and no links to missing sections. BG3, Hades II and Cyberpunk had 21, 57 and 54 numbered citation links respectively, all with existing targets. On the mobile-width Counter-Strike 2 page, optional media sections were absent and Reception was active.
- On Cyberpunk, keyboard activation of a numbered citation brought the source row below the sticky navigation at both widths. The two sticky bars met within one pixel. All three hero-card destinations worked. Selecting the 7-day player graph range preserved scroll position at both widths. The media tag and match links navigated within the same document.
- **Scrolled reload needs repair and repeat testing.** Reloading the citation URL returned to scroll position zero on both widths while retaining the fragment. Separately, reloading at 1,500 CSS pixels without a fragment restored 1,500 at mobile width and approximately 623 at desktop width. A desktop citation jump also retained the Overview highlight while the target source was visible. Recheck the highlight against the intended active-section rule.
- Outbound URLs and source labels were inspected. External navigation for every outlet, graph event targets, assistive technology and real mobile hardware were not verified.

The focused similarity, embedding, processing and scroll-margin suites passed 50 tests on this revision. Those tests complement the snapshot cases. Complete the missing fixed examples, resolve the content findings, enforce the three-game activation scope across public readers, and rerun the failed browser checks before enabling publication. Operational evidence for the applicable [activation criteria](https://github.com/phenome/vaporstats/issues/78) remains separate.

## Repair checks on November 25

The three-root publication filter was exercised with the application reader on the same snapshot. With the flag enabled only in the local process, each public root returned four matches: the two other experiment roots in each dimension. Phantom Liberty returned zero public matches. Internal unpublished reads retained the fourth entity. The production flag was separately observed off.

The persisted publication regression covers detail API and SSR, including Sources with the flag off. The catalog regression checks the public tag filter before pagination. Three controlled replacement cases now cover quality-only, popularity-only and technical-complaint-only evidence. In each case an existing two-dimensional result was replaced, its two vectors were retired, and zero new embeddings were submitted. The full embedding test file passed all 15 tests. These cases exercise application handling of controlled provider responses; live model behavior on the missing examples remains unverified.

A second read-only snapshot check exercised all 84 distinct stored tag labels with the local flag off and on. Public reads yielded zero memberships with the flag off and 65 tag/game results with it on, all belonging to the three roots. The same check confirmed public Overview, Sources and match behavior for all four active entities, and internal Overview access to all four.

### Content repair rehearsal

The extraction and synthesis prompts still use Haiku 5.5. They apply the five category definitions at both stages, preserve material build and platform qualifications, and distinguish human multiplayer interactions from character creation and interactions with NPCs. Article cleanup removes the structured “Need to Know” factbox before extraction. The parser retains adjacent reporting. A trait supported by substantive reporting in one review remains eligible.

On a private copy of the November 24 snapshot, the existing queue processed five affected sources with controlled article inputs and manually prepared provider replies. The checks preserved prior generated payloads, job and attempt accounting, and existing vector bytes. These output IDs identify the rehearsal database only.

| Source IDs | Expected change exercised | Fixture Overview ID |
|---|---|---|
| 1, Baldur’s Gate 3 | Put character creation in Gameplay & systems and retain Early Access context. | 10 |
| 12, Cyberpunk 2077 | Qualify four Switch 2 tags and remove controller-specific mappings from the aggregate gameplay vector input. | 11 |
| 10 and 16, Hades II | Remove the Multiplayer and Steam Deck metadata-only tags and classify NPC relationships and hub activities separately. | 12 |
| 15, Phantom Liberty | Remove two factbox-only tags and reclassify NPC interactions. | 13 |

Seven compatible vectors were reused. The eighth was withdrawn and its replacement queued when Cyberpunk’s gameplay input changed. No live replacement vector was obtained. A real provider rerun of this scope would require five article extractions, four syntheses and up to eight changed embeddings before retries. Confirm source access through the existing outlet boundary, inspect the actual regenerated text and citations, and recheck active vectors before lifting the hold.


### Browser repair recheck

The local production build rendered persisted game detail in the initial HTML. Client navigation waited for the existing detail query before restoring scroll. In Chromium at 1280 and 390 CSS pixels, a reload restored the previous 1,500-pixel scroll position. Direct citation fragments, pointer and keyboard activation, and refresh kept the source row visible beneath the sticky bars and selected Sources alone. The row moved eight pixels on citation reload. Both widths had zero horizontal overflow and a one-pixel sticky-bar overlap.

All three cards reached their destinations. Changing to the seven-day range preserved scroll, and a chart milestone opened its article reader. A match opened Hades II in the same document. A sparse game omitted optional sections, a missing game returned 404, and flag-off HTML omitted the synthesized Overview and Matches. This rerun used responsive Chromium sizes, a private snapshot and disabled ingestion.

The final combined working tree passed `bun run verify`: type checks, 1,022 tests across 67 files, all 29 SQLite migrations with retained rows preserved, the production build and output checks.

| Media probe | Evidence from the passing suite |
|---|---|
| Send-once across restart | `media-interruptions.test.ts` and `media-paid-work.test.ts` |
| Resume and shared caps | `media-interruptions.test.ts`, `media-shared-limits.test.ts` and `media-enablement.test.ts` |
| Classifier scopes | `media-provider-contract.test.ts`, `media-outlet-contract.test.ts` and `media-boundaries.test.ts` |
| Switch off and on | Production-like state in `media-enablement.test.ts` |
| Deletion scope | No tracked files deleted in the working-tree diff. |
| Spec gaps | `media-processing.test.ts` exercises the structured facts panel alongside adjacent article evidence and retained build context. |
| Item and tick exception isolation | `media-tick-isolation.test.ts` and throwing-item scenarios in `media-interruptions.test.ts` |

## Live provider run on the private copy

Run 18 used the revised extraction and synthesis configuration, the November 24 snapshot, and the configured provider accounts on November 25. The application scheduler was disabled. All five outlet fetches returned HTTP 200 through the ordinary access controls. OpenRouter reported Haiku 5.5 for each of the five extraction and four synthesis responses.

| Entity | Regenerated extraction | Actual synthesis outcome |
|---|---|---|
| Baldur’s Gate 3 | Source 1 → extraction 14. Classes and races appear under Gameplay & systems with Early Access context. | Refused. The validator found no usable cited statement. No replacement Overview became active. |
| Cyberpunk 2077 | Source 12 → extraction 15. Gameplay similarity inputs omit the Joy-Con mappings. One motion-control trait still relies on surrounding text for its platform qualification. | Refused for the same validation reason. No replacement Overview became active. |
| Hades II | Sources 10 and 16 → extractions 16 and 18. NPC interactions are classified under Story & world. | Overview 10 was accepted. The Multiplayer and Steam Deck tags are gone, but the output still presents “Early Access build” as a game-level discovery tag alongside 1.0 coverage. Its opening statement combines several mechanics behind three citations, although only one extraction supports the complete pre-run equipment list. These findings block publication. |
| Phantom Liberty | Source 15 → extraction 17. The structured factbox and NPC interactions contributed no multiplayer tag or Social play finding. | Overview 11 was accepted. Social play and the metadata-only Single-player and Steam Deck tags are absent. This expansion remains outside the first public scope. |

The refusal message identifies a validation outcome. It does not identify whether syntax, statement structure, wording or citation URLs caused the failure. These were definite refusals, and neither item was sent again. The two accepted Overviews passed structural validation. The content findings above come from inspecting their actual outputs and source extractions, without an exhaustive original-article review.

OpenRouter reported US$0.006761 for five extractions and US$0.019806 for four syntheses, including both refused answers (US$0.026567 total text cost). Four Gemini batch embeddings were submitted for the two accepted Overviews. No model comparison or publication activation was performed.

All four Gemini jobs subsequently settled. Each stored a current 3,072-component vector for Hades II or Phantom Liberty. The ledger estimated US$0.000056 for the embeddings, bringing the combined reported/estimated cost to **US$0.026623**. Run 18 ended with eleven successful jobs, two definite refusals and an empty queue. No article bodies remained pending; the final private database passed its foreign-key check and had zero invalid tag memberships.

Application reads on the saved copy confirmed that only Hades II and Phantom Liberty had active Overviews and that each internally matched the other in both dimensions. With the public scope simulated locally, only Hades II had an Overview and no dimension matches were publicly eligible. Production publication was independently checked off after settlement. The publication hold continues: the two refused syntheses need refusal diagnostics, and the remaining state qualification and compound-citation findings need correction and re-evaluation.

### Diagnosis of the two refused syntheses

Read-only OpenRouter generation lookups recovered the original completion text. The provider reported `stop` / `end_turn` for all four syntheses. Offline replay against the run's active evidence URLs reproduced both refusals and accepted the two control Overviews.

| Job | Original completion | Single-variable replay |
|---|---|---|
| 47, Baldur’s Gate 3 | An extra closing brace ended the top-level object after `tags`. The comma before `similarityInputs` became trailing data at column 6,987. | Removing just that brace yielded valid JSON. Seven of eight statements passed. The eighth contained wording filtered by the existing validator. |
| 48, Cyberpunk 2077 | After normal Markdown-fence removal, an extra closing brace ended the object after `categories`. The comma before `prosCons` became trailing data at column 6,749. | Removing just that brace yielded valid JSON. All seven statements passed. |

The JSON decoder collapses parse errors to null. The Overview validator consequently sees no statements and the ledger emits the same reason used for a structurally valid answer with no surviving citations. The malformed top-level objects explain both whole-answer refusals; citation URLs and wording were held constant in the successful counterfactuals. These checks did not assess the factual support of the recovered claims. No generated answer was resubmitted or activated. Production publication was observed off and no new inference or embedding request was made.

### Strict synthesis rerun

The updated validator classified both original responses (jobs 47 and 48) as `malformed JSON` on offline replay. Separate regression cases cover valid JSON with an invalid root and valid objects with no usable cited statements.

Private run 19 reused the run 18 extractions and requested the v8 strict JSON schema with parameter-compatible routing. Both Haiku 5.5 syntheses succeeded on their first attempt.

| Game | Route | Private Overview | Statements accepted | OpenRouter cost |
|---|---|---|---|---|
| Baldur’s Gate 3 | Azure | 12 | 6 of 6 | US$0.002208 |
| Cyberpunk 2077 | Anthropic | 13 | 19 of 19 | US$0.005184 |

Every citation URL in the 86 generated statements, category findings, pros, cons and tags resolved to active extraction evidence for its own game. This check establishes citation identity. Editorial support for each clause still requires review. The run preserved earlier attempt records and all extraction rows, made zero article refetches, and left four embedding jobs queued on the private copy. Its foreign-key check passed. Production publication was checked off after the run.

The BG3 prose qualifies the six playable classes as Early Access. Its discovery tags still include an unqualified “Single-player” from the sole Early Access extraction. Cyberpunk qualifies its Switch 2 control observations, but some bug claims still read as current. Both Switch 2 tag labels also lose their closing parenthesis during normalization. These findings and the earlier Hades II findings remain open for the publication review.

## Run 22 first-publication decision

**Hold the production switch.** On November 25 the local production build and private run 22 database served the corrected three-game output. A read-only check of the running production container found the earlier build at 8e4d6e9 with v6 Overviews for all three roots, automatic ingestion on, and public synthesis off. The private candidates were BG3 Overview 16 and Cyberpunk Overview 17 (v10) and Hades II Overview 19 (v11). Flipping the deployed flag would expose a different build and different content from this evaluation.

| First-publication criterion | Outcome and remaining work |
|---|---|
| Source support and game attribution | All 62 displayed statement/category references resolved. All five cited article pages opened. Correct the Cyberpunk side-mission observation that takes praise of the endings out of context, then recheck both places it is displayed. [Coverage evaluation](2026-11-25-run22-coverage.md) |
| Fixed evaluation from #44 | The planning ticket explicitly specified the set without assembling it. The evaluation records what ran in all 12 coverage and 12 ranking categories. Several still lack fixed, representative live inputs. Complete those cases and record their outcomes. [#44](https://github.com/phenome/vaporstats/issues/44) |
| Current compatible matches | The three roots have zero active vectors. Six dimension jobs await embeddings. Current public and internal queries returned no pairs, so there is no live cosine score to reproduce. Run the bounded embedding work on the corrected inputs, then test ranking and exclusions. [Match evaluation](2026-11-25-run22-matches.md) |
| Persisted pages and navigation | API, SSR, local flag boundaries, source links, citations, SPA expansion navigation, card destinations, scrolled reload and graph-range scroll were exercised. Card destination and active highlight could disagree. Recheck after correction. Positive match/tag links need representative data; these outputs have neither. [Reader evaluation](2026-11-25-run22-reader.md) |
| Current-input replacement and recovery | Controlled regression coverage includes article replacement, stale completion and preservation of unaffected output. The run 22 copy retained matching paid-attempt, extraction and Overview payloads across reopen and had zero media-table foreign-key violations. A live cutover and in-flight production restart were outside this rerun. |
| Automatic passes and outlets | The snapshot records the three experiment enrollments, seven scheduled runs (six completed and one Tavily account stop), and both initial and later sources. It contains 2, 4 and 5 source rows for BG3, Cyberpunk and Hades II respectively, from five distinct outlets across the roots. GameSpot recorded a 403 stop. |
| Account controls and applicable #78 evidence | Read-only account checks found a capped OpenRouter key with credit and a Tavily Researcher plan with zero pay-as-you-go usage. The queried account did not return an explicit pay-as-you-go limit. The Google project cap was recorded in #78. The production ledger records provider-reported Haiku costs and estimated Gemini embedding costs. An explicit no-overage setting and live restart/credit-pause-and-resumption evidence remain to be documented or demonstrated; the automated restart and stop tests are separate evidence. No account limits were changed and no paid calls were made in this evaluation. [#78](https://github.com/phenome/vaporstats/issues/78) |
| Methodology, scope and activation | The methodology page explains automation, source attribution, revisions, matches by dimension, and tags. The local gate excludes Phantom Liberty. Coverage history, new-release enrollment, watchlist operation, the status command and correction tooling are deferred by the November 18 amendment. #55 and #56 are closed. After the evidence gaps are addressed, deploy the evaluated code with publication off, produce or promote the verified current-input outputs through a reviewed procedure, verify rollback readiness and production readers, then seek authorization to enable the three-root scope. [#60](https://github.com/phenome/vaporstats/issues/60) |

Missing optional tags and unresolved entries in the editorial follow-up document are not independent publication gates. No production configuration, production data, issue state or provider setting was changed by this review.

The final repository verification passed type checking, 1,045 tests, 29 reviewed migrations including retained-row checks, the production build and output checks. The isolated browser tab and local server were closed. Production publication remained off.

## Cyberpunk correction, card navigation and six private embeddings

The source-bound correction preserves PC Gamer's narrower claim that optional character stories can change the ending. Runs 23 and 24 used the paid synthesis queue on a fresh private copy of run 22. The final Cyberpunk Overview (21) retains the same PC Gamer citation and observation reference in its summary and Story & world category. Neither entry assigns the reviewer's praise of the endings to the side missions. [PC Gamer review](https://www.pcgamer.com/cyberpunk-2077-review/)

The earlier count of two waiting Cyberpunk embedding jobs included jobs for a superseded Overview. The run 22 Cyberpunk candidate lacked usable similarity inputs. Three scoped amendments grounded in IGN's tested Switch 2 port supplied first-person combat, the neon-lit city setting and player-controlled quest conversations. The second synthesis incorporated these inputs. Only jobs linked to current Overview identities were sent. [IGN Switch 2 review](https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update)

All six Gemini embedding jobs completed on their first submission. The three roots each have a current 3,072-component gameplay vector and story/world vector. With publication simulated in the private reader, each game returned the other two in each dimension. Independent float32 decoding and cosine calculations reproduced all 12 directed scores to within 7.4 × 10⁻¹⁵. The flag-off public reader returned no matches. The original extraction rows and prior paid attempts were preserved. Haiku reported US$0.001461 for two syntheses. The ledger estimates US$0.000041 for the six embeddings.

The rebuilt application also passed the card recheck on an isolated copy of the run 22 reader data. In Chromium at 1280 and 390 CSS pixels, each of the three hero cards selected only its destination, citation navigation selected Sources and manual scrolling back to the top selected Overview. The reading position determines the highlight after leaving the fragment landing position. [Navigation regression](../../tests/game-section-navigation.test.ts)

Repository verification passed all 1,054 tests, type checking, migration checks, production build and output checks. The [media probe matrix](2026-11-25-observation-replay.md#regression-coverage) identifies the send-once, resume, classifier, activation and exception-isolation tests. No tracked file was deleted. Production publication was verified off after settlement. Current positive scores complete the numerical check for these roots. The remaining fixed evaluation cases and production activation evidence still require verification.

## Decision after the fixed private evaluation

Keep production publication off. All 12 [coverage cases](2026-11-25-fixed-coverage.md) and all 12 [ranking cases](2026-11-25-fixed-ranking.md) now have observed outcomes. In the three-root baseline, all 62 Overview and category entries matched their current source observations and citation URLs. The new semantic comparisons returned reciprocal gameplay and story/world matches grounded in each game’s own evidence. The numerical, negative-evidence, stale-input and entity-isolation checks passed. The edition replay cost $0.013560 and the supplemental semantic/preview replay recorded $0.019661 including estimated embedding cost.

The live disagreement corpus produced no citable pair; a controlled result exercised both citations and the contested marker through the reader. This is a missed optional observation, with no false consensus displayed. Live generation of a disputed entry remains unverified. Technical-test coverage required a pinned private admission and source-verified scope metadata. It exercises partial acceptance and state separation downstream. Automatic watchlist/preview operation is deferred to #79. Neither the supplemental games nor the controlled records belong in the public dataset.

Before enabling the switch, complete the applicable #78 account and recovery evidence, including Tavily no-overage confirmation and the credit-pause/resumption demonstration. The private work supplied separate-process settlement of submitted embedding jobs. Production restart and cutover still need the reviewed snapshot, single-writer deployment, verified current inputs and rollback checks. Validate persisted API and browser behavior against the exact three-root production candidates with publication disabled and a restricted preview. Obtain explicit activation authorization for those candidates.

The current checkout passed type checking, 1,056 tests, migration checks, production build and output checks. The [regression coverage](2026-11-25-observation-replay.md#regression-coverage) maps the media probes to the passing send-once, resume, classifier, switch, deletion, spec-gap and exception-isolation checks. No tracked files were deleted. A read of the running production container confirmed publication disabled.

### Account and deployment preflight

On November 25 the maintainer confirmed that Tavily overage is disabled. The production container reported publication disabled and image 8e4d6e948219511329e4a02c4e0db61f92e51464, matching the remote main branch. The production paid-attempt ledger contained 30 successes, two refusals and one missing-configuration outcome. No attempt recorded a credit pause. The live credit-pause and daily resumption check remains open.

On a disposable copy of the run 24 database, an explicitly seeded OpenRouter key-limit pause survived process exit. At the next simulated daily check a fresh process queried the actual funded key endpoint, persisted credit_remaining and cleared the pause without sending a model request. This verifies recovery from a persisted pause. Provider-originated entry into that pause still requires a real exhausted-key response.
