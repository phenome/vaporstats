import type React from "react";

function Question({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-zinc-800 pt-6">
      <h2 id={id} className="text-lg font-semibold text-zinc-100">
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-6 text-zinc-300">{children}</div>
    </section>
  );
}

/**
 * Explains how the media sections of a game page are produced. Game pages
 * link here instead of labelling each summary or match.
 */
export function MediaMethodologyView(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-12 font-sans">
      <header className="space-y-2 border-b border-zinc-800 pb-6">
        <div className="font-mono text-xs uppercase tracking-widest text-zinc-500">VaporStats Methodology</div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">How media coverage works</h1>
        <p className="text-sm text-zinc-400">
          How game pages summarize published coverage and how media matches are found.
        </p>
      </header>

      <Question id="how-overviews-are-written" title="How is a game's Overview written?">
        <p>
          The Overview is written automatically from articles about the game published by six English-language
          gaming outlets: IGN, Eurogamer, GameSpot, PC Gamer, Kotaku, and GamesRadar+.
        </p>
        <p>
          A language model reads each article and records what it says about the game, keeping every observation tied
          to the article it came from. A second automated step combines those observations into the Overview, the
          descriptive categories, the pros and cons, and the Media Discovery Tags. Nobody edits individual
          summaries by hand.
        </p>
        <p>
          The Overview describes what the coverage says. It is not a VaporStats review, and it is separate from the
          Current Player Score and other Steam data on the page.
        </p>
        <p>
          Categories cover Gameplay &amp; systems, Story &amp; world, Visuals &amp; audio, Social play, and Technical
          experience &amp; accessibility. A category appears only when the coverage discusses it, so a missing
          category means the articles did not cover that aspect. It does not mean the game lacks it.
        </p>
        <p>Coverage is available for a small number of games for now.</p>
      </Question>

      <Question id="where-statements-come-from" title="Where does each statement come from?">
        <p>
          Every statement in the Overview, categories, and pros and cons has numbered notes. Each number links to an
          entry under Sources, which names the outlet and article title, the author and dates when they are known,
          and links to the original article. A statement cites the articles that support it.
        </p>
        <p>
          Statements supported by more outlets are listed first. A statement marked Contested groups opposing
          judgments about the same aspect of the game, and its notes cite articles on each side.
        </p>
        <p>
          Sources also show each article's type, such as a review or a preview, and whether its writer played the
          game when the article states it.
        </p>
      </Question>

      <Question id="results-change" title="Results change as coverage changes">
        <p>
          Overviews, tags, and matches are rebuilt from the articles currently attached to a game. When an article
          is added, corrected, or replaced, everything that depends on it is rebuilt, and statements the remaining
          articles no longer support are removed. A later reassessment can change an earlier impression.
        </p>
        <p>The page shows the current result. It does not keep earlier versions of a summary.</p>
      </Question>

      <Question id="media-matches" title="How are media matches found?">
        <p>
          Media matches list other games whose coverage describes similar characteristics. They are grouped in two
          independent dimensions:
        </p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <span className="font-semibold text-zinc-100">Gameplay &amp; systems</span>: what you do in the game and
            how its mechanics work.
          </li>
          <li>
            <span className="font-semibold text-zinc-100">Story &amp; world</span>: setting, characters, and themes.
          </li>
        </ul>
        <p>
          For each dimension, a game's coverage is condensed into short descriptions. These descriptions are turned
          into numeric representations (embeddings) and compared, and the games described most similarly are listed.
          The two dimensions are compared separately, so a shared setting does not imply similar gameplay.
        </p>
        <p>
          Quality judgments, popularity, and technical problems are left out of the comparison. A match describes
          shared characteristics; it does not say how good a game is or predict whether you will enjoy it. No
          outlet made the comparison: read each game's own Overview and Sources to see what its coverage says.
        </p>
        <p>Only games with processed coverage can appear, so lists are short while coverage is limited.</p>
      </Question>

      <Question id="media-discovery-tags" title="What are Media Discovery Tags?">
        <p>
          Media Discovery Tags are short labels for characteristics the coverage supports, such as a style of play.
          Selecting a tag lists other games with the same tag. They come from media coverage and are separate from
          Steam genres, features, and community tags. A tag can remain when coverage disagrees about that
          characteristic; the Overview explains the disagreement.
        </p>
      </Question>
    </div>
  );
}
