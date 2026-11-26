# Premise-first Overviews

The private evaluation used the ten active article extractions from the November 25 BG3, Cyberpunk 2077 and Hades II corpus. Four article-version-specific editorial amendments supplied details checked against the original reviews: V and Johnny Silverhand, the setting of Night City, the traveling companions on the Sword Coast, and Melinoë’s objective. The evaluation submitted synthesis only.

The first pass established ordered, individually cited spans. Cyberpunk retained only its opening sentence because generated wording introduced PC qualifications absent from its selected scope. Two Hades II spans combined incompatible scopes. The second pass filtered incidental review wrappers from eligible input text and directed selections to compatible scopes. It retained the evidence but produced long strings of observations. The final pass asked for a short paragraph with one through-line, drafted before splitting it into citation spans.

| Private result | Lead citations and editorial reading |
|---|---|
| Baldur’s Gate 3 · Overview 30 | Three spans, all from GamesRadar+. The opening places the party on the Sword Coast and names two companion stories. The main-quest consequence is supported, although “its main quest is reactive” is redundant beside the example. IGN contributes elsewhere in the brief. |
| Cyberpunk 2077 · Overview 31 | Five spans. IGN supports V, Johnny and Night City. The optional-stories clause cites PC Gamer and IGN. The separate animation-glitch observation cites IGN and Eurogamer. The last sentence uses past tense but leaves the launch timeframe implicit. |
| Hades II · Overview 32 | Five spans, all from Eurogamer’s release follow-up. The lead connects Hecate, Melinoë’s descent to confront Chronos and the mechanics of her magic. The mana and Omega-attack clause cites one article with two supporting observations. |

The final reader audit compared every lead span’s article links with its stored source URLs, verified the active source identity and observation IDs against the private request, and checked that the reader retained the composed order. No final lead span was rejected. The final three Haiku requests cost $0.006578. Across the three passes, nine requests cost $0.019867. No embedding or extraction requests were submitted. Two Hades II embedding jobs were queued on the final copy. Production was untouched.

| Acceptance criterion or media probe | Check |
|---|---|
| Ground premise and play in eligible evidence, retain exact citations and respect scope | `tests/media-observations.test.ts` and final private evidence audit |
| Preserve composed order and citation placement, including clauses within a sentence | `tests/media-sources.test.tsx`, `tests/media-later-pass.test.ts` and private rendered lead audit |
| Preserve queued request versions and bounded retries across restarts | `tests/media-observations.test.ts`, `tests/media-openrouter.test.ts`, `tests/media-paid-work.test.ts`, `tests/media-interruptions.test.ts` |
| Resume, day stops and production-like switch behavior | `tests/media-interruptions.test.ts`, `tests/media-enablement.test.ts` |
| Classifier and outlet boundaries | `tests/media-provider-contract.test.ts`, `tests/media-outlet-contract.test.ts`, `tests/media-shared-limits.test.ts`, `tests/media-boundaries.test.ts` |
| Deletion scope and spec gaps | Empty deleted-file diff against main. Older similarity strings without validated excerpt provenance remain ineligible for the public lead. |
| Item and tick isolation | `tests/media-tick-isolation.test.ts`, `tests/media-interruptions.test.ts` |

## Cyberpunk technical timing

Run 30 refreshed the IGN PC review and Eurogamer review on a private copy. Haiku produced Overview 33. Two v9 extractions and one v18 synthesis cost $0.010314. Both embedding jobs remained queued. The excerpt check matched all 36 saved observations to the fetched articles.

The opening describes V, Night City and quest choices. Animation issues appear in the technical section with an IGN citation and the wording “during review.” The cited animation evidence establishes no launch date. Eurogamer separately reported fewer bugs after testing a patch. Its patch observation and its animation observation were absent from the generated brief.

An offline replay of the saved claims exposed a missed timing qualifier on framerate drops while driving. After extending the classifier, the validator added “during review” to that claim and retained all 21 prose entries and four tags. The resulting private preview uses the revised settlement wording. The original paid output and accounting remain available independently.

Two editorial issues remain. The lead generalizes one reviewer's seven endings in about 45 hours, and the animation sentence repeats the RTX 3080 hardware qualifier. The candidate was held from publication.

| Acceptance criterion | Check |
|---|---|
| Ground launch, patch and review timing in the excerpt describing the issue | `tests/media-observations.test.ts` includes unrelated launch announcements, reversed patch direction, observed crashes, stuck animations and framerate drops. |
| Keep queued requests reproducible and expose accepted timing in the reader | `tests/media-openrouter.test.ts` exercises v8 retries and v9 extraction through the detail API. `tests/media-observations.test.ts` exercises queued v17 settlement. |

## Cyberpunk patch finding and discovery labels

Private Overview 34 retains the cited 45-hour observation. Its technical section gives Eurogamer’s account of fewer bugs after a tested patch its own sentence and citation. IGN’s separate hardware-specific finding mentions the RTX 3080 once. Eurogamer’s idle-animation observation was available and unselected. The replay restored the verified “after a patch” timing on Eurogamer’s observation in the disposable copy before synthesis.

The four discovery labels were Open world, First-person perspective, Three life paths and Joy-Con support (Switch 2). First-person perspective is the trait supported by the selected tag observation. All 22 rendered citation links resolved. One Haiku synthesis cost $0.004433418. Extraction and embedding sends were both zero. The run made no production changes.

## Model-authored discovery labels

Private Cyberpunk Overview 35 used one Haiku v20 synthesis with the same stored evidence. The request included the original tag observations. Haiku selected the observations and supplied the wording for each label. The suggested phrase “Selectable character backgrounds” was absent from the request.

| Model response, also saved and rendered | Supporting observation |
|---|---|
| Open-world urban map | A single, unrestricted open urban map |
| First-person perspective | A first-person perspective |
| Starting background choice | Choosing a life path sets the character’s background and early events |
| Joy-Con mouse aiming on Switch 2 | Joy-Con mouse-style aiming on Switch 2 |

The call cost $0.003538854. All 23 rendered citation links resolved. The cited 45-hour observation remained in Gameplay & systems. Eurogamer’s patch finding and IGN’s RTX 3080 example were available but absent from the new prose. Overview 34 retains those findings. No extraction, embedding or publication occurred during this comparison.

## Controller capability labels across three games

Three private v21 syntheses used the existing article extractions. Cyberpunk had four eligible tag observations, Baldur’s Gate 3 had one, and Hades II had one. Haiku selected all six. No new extraction or embedding requests were sent.

| Game | Saved discovery labels | Rendered citation links verified |
|---|---|---:|
| Cyberpunk 2077 | Open-world city map · First-person perspective · Starting background choice · Joy-Con aiming | 26 |
| Baldur’s Gate 3 | Branching main story | 12 |
| Hades II | Roguelike | 15 |

Haiku supplied “Joy-Con aiming on Switch 2” with the IGN port review as evidence. Replaying the identical response offline through revised v21 settlement removed the redundant native platform suffix from the discovery label. The source observation still identifies the mouse-style aiming feature and its Switch 2 scope. The three paid syntheses cost $0.008647848 in total. The previews stayed private.

## Reusable discovery tags from older articles

Three v22 private syntheses reused the three-game corpus. Article-linked legacy traits and eligible gameplay findings entered tag selection. One eligible observation can support multiple distinct labels. The Hades II request included the Eurogamer finding about choosing the next room from doors whose icons show a god’s gift or resource reward. The schema allowed that finding as a reference for both route choice and reward preview tags.

| Game | Saved tags | Private result |
|---|---:|---|
| Cyberpunk 2077 | 11 | The response included a launch-bug tag and a rendering tag supported only by a resolution benchmark. Offline replay of the same response rejected both. “Open urban map” and “Open-world action RPG” still overlap. |
| Baldur’s Gate 3 | 10 | Seven tags including turn-based combat retained the Early Access qualification. Three came from release coverage. |
| Hades II | 7 | The model selected Greek mythology, run rewards and crafting, among others. It passed over both door-related labels and the tarot-card upgrade trait. The broad “Roguelike” observation supports only part of the combined random-upgrades-and-rewards label. |

All three calls together cost $0.010135026. All saved tags had active source references and their slugs matched the persisted memberships. The separate route and reward labels are covered through the queue, database and reader in the controlled regression. They did not appear together in the live output. No publication occurred.

## Sequential discovery label evaluation

Five private Haiku syntheses used the existing evidence. Each selection was reviewed before the next paid call. Total provider cost was $0.017917416. No article refetch, embedding submission or production publication took place.

| Call | Game and contract | Result that informed the next decision |
|---|---|---|
| 1 | Hades II, v23 | Split 2D and Action and shortened Crafting and Greek mythology. Selected generic character conversations and omitted room choice and reward information. |
| 2 | Hades II, v24 | Added tarot-card upgrades and pre-run loadouts. Missed room reward previews and conflated two routes with a branching plot. |
| 3 | Baldur’s Gate 3, v25 | Putting tag selection first produced concise mechanics without incidental Early Access suffixes. The class count explicitly tied to Early Access was omitted. Offline normalization shortened the cited ruleset to D&D 5th Edition. |
| 4 | Cyberpunk 2077, v25 | Included Open world, Starting background choice and Joy-Con aiming. Phone-call quests is still unusually narrow and the futuristic and cyberpunk setting labels overlap. |
| 5 | Hades II, v25 | Selected Branching routes and Room reward previews separately, plus 2D, Action, Greek mythology, Tarot-card upgrades and Pre-run loadouts. Crafting was absent. The model again inferred a branching main plot from distinct playable routes, requiring an evidence check at settlement. |

Offline replay of Hades II’s fifth reply kept both route tags and rejected “Branching main story” because its reference established physical routes. Final saved label counts were 11 for Hades II, 10 for Baldur’s Gate 3 and 12 for Cyberpunk 2077. Each label retained its article references and matched its catalog membership.
