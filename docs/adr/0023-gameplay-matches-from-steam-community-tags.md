# Gameplay matches from Steam community tags

**Status:** Accepted

Specified in [#101](https://github.com/phenome/vaporstats/issues/101). Changes the Gameplay & systems dimension of Similar Games; Story & world is unchanged. Evaluation: [2026-11-28 gameplay tag matches](../evaluations/2026-11-28-gameplay-tag-matches.md).

## Context

Similar Games lists games that are not similar in how they play. On the Warlock: Dungeons & Dragons page, Gameplay & systems listed Hades II, a run-based action roguelike, beside a third-person action-adventure. Two causes were measured on the five published games on 2026-11-28:

- **Every page listed the top three of the other four games.** There was no minimum score, so three quarters of the pool always appeared.
- **The gameplay scores did not separate the games.** Each game's gameplay dimension was an embedding of the sentences its coverage happened to contain. Every pair scored between 0.68 and 0.76, and the two plausible pairs (Cyberpunk 2077 – NO LAW 0.757, Baldur's Gate 3 – Warlock 0.753) led Baldur's Gate 3 – Hades II (0.740) by about 0.01. The fixed ranking evaluation of 2026-11-25 showed the same thing: Hades II – Stray Gods, an action roguelike against a musical visual novel, scored 0.736 in gameplay.

The catalog already stores each game's top Steam community tags with vote counts as `community_tag` Catalog Facet memberships. Players apply those tags to describe the game itself, independently of which outlets reviewed it and which sentences their articles contain.

## Decision

**Gameplay & systems matches come from the direct overlap of gameplay tags.**

- **Gameplay tags.** A checked-in table, `STEAM_GAMEPLAY_TAGS` in `src/lib/steam-gameplay-tags.ts`, classifies Steam community tags by tag ID as `genre`, `viewpoint` or `mechanics`, and records each tag's Steam-wide game count and the total number of games (`STEAM_GAMES_TOTAL`) on its snapshot date (`STEAM_GAMEPLAY_TAGS_SNAPSHOT_DATE`). A tag outside the table never counts. Themes, moods, art styles, player counts, content descriptors and assessments are outside it.
- **Weight.** A game's gameplay tag weighs `(votes ÷ the game's highest community tag vote count) × ln(total games ÷ games with the tag)`. The highest vote count is taken over all of the game's community tags, gameplay or not. A membership with no recorded vote count is ignored.
- **Score.** The cosine of the two games' weighted gameplay tags. A game with no weighted gameplay tag has no gameplay matches and is never a gameplay candidate.
- **Bar.** A candidate is listed only when its score is at least `GAMEPLAY_MATCH_BAR`, 0.30. A game with no candidate at that bar has no Gameplay & systems list.
- **Shared tags.** Each gameplay match carries up to `GAMEPLAY_SHARED_TAG_LIMIT` (three) tags both games have, ordered by the product of their two weights, named from the Catalog Facet dictionary. The game page and the DLC/expansion page show them beside the matched game.
- **Scope.** Both games need an active Overview, so only games with processed coverage appear. Self, ineligible, non-playable, accessory and unpublished entities stay excluded, child entities keep their parent rule, results are ordered by score and then AppID, limits apply per dimension, and a read never creates a job or spends. The reader no longer reads gameplay embeddings.

The scoring lives in pure functions in `src/lib/media-gameplay-tags.ts`; `getMediaGameMatches` reads the memberships and applies them.

**Direct overlap instead of embedding the tags.** A prototype also embedded the tags with the production embedding model. A profile built only from the tags compressed the pairs back into 0.74–0.96 and scored Baldur's Gate 3 – Stray Gods at 0.850; the tag profile followed by the Overview text gave 0.72–0.77. An embedding places any two descriptions of games close together, which is the compression the change set out to remove. Direct overlap needs no provider call, spreads the pairs across 0.00–0.69, and names the tags that produced the score, so a reader can judge a match.

## Consequences

- Among the five published games, Baldur's Gate 3 and Hades II list no gameplay match. Lists grow as coverage reaches more games with overlapping tags.
- Steam returns only a game's top 20 tags. A tag missing from a game's list is not evidence that the game lacks it, so the score uses only shared positive overlap, and no hard gate on disagreeing tags is applied.
- The bar was chosen on seven games. It is one named constant so it can be recalibrated as the pool grows.
- The tag table and its Steam-wide counts are a dated snapshot. Someone must refresh it, and reclassify any new tags, as Steam's catalog changes; nothing refreshes it automatically.
- Gameplay matches no longer derive from coverage. Steam community tags reflect player voting, so a game whose tags differ from its coverage is matched by its tags.
- Gameplay similarity inputs are still extracted and gameplay embeddings are still produced and stored. A separate change under the media probes retires that work, so the tag-based match can be reverted without paid reprocessing.
- The gameplay cases of the 2026-11-25 fixed ranking evaluation describe the superseded embedding ranking.
