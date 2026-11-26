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
