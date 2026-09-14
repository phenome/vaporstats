import type { MediaGameMatch, MediaMatchDimension } from "../lib/media-similarity";
import { AppLink } from "./app-link";

const DIMENSION_LABELS: Record<MediaMatchDimension, string> = {
  gameplay: "Gameplay & systems",
  story_world: "Story & world",
};

function MatchLink({ match, paths }: { match: MediaGameMatch; paths: Readonly<Record<number, string>> }) {
  const path = paths[match.matchedGame.appid];
  return (
    <li className="min-w-0">
      {path ? (
        <AppLink
          href={path}
          className="inline-flex min-w-0 max-w-full break-words border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-orange-400 hover:border-zinc-700 hover:text-orange-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          {match.matchedGame.name}
        </AppLink>
      ) : (
        <span className="inline-flex min-w-0 max-w-full break-words border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-300">
          {match.matchedGame.name}
        </span>
      )}
    </li>
  );
}

export function MediaMatchesSection({
  matches,
  paths = {},
}: {
  matches: MediaGameMatch[];
  paths?: Readonly<Record<number, string>>;
}) {
  const visibleMatches = matches.filter((match) => Object.prototype.hasOwnProperty.call(DIMENSION_LABELS, match.dimension));
  if (visibleMatches.length === 0) return null;

  return (
    <section id="media-matches" aria-labelledby="media-matches-title" className="min-w-0 space-y-4 scroll-mt-28">
      <div className="border-b border-zinc-800 pb-2">
        <h2 id="media-matches-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Media matches
        </h2>
      </div>
      {(Object.keys(DIMENSION_LABELS) as MediaMatchDimension[]).map((dimension) => {
        const dimensionMatches = visibleMatches.filter((match) => match.dimension === dimension);
        if (dimensionMatches.length === 0) return null;
        return (
          <section key={dimension} aria-labelledby={`media-matches-${dimension}`} className="min-w-0 space-y-2">
            <h3 id={`media-matches-${dimension}`} className="font-mono text-sm font-semibold text-zinc-100">
              {DIMENSION_LABELS[dimension]}
            </h3>
            <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
              {dimensionMatches.map((match) => (
                <MatchLink key={`${dimension}-${match.matchedGame.appid}`} match={match} paths={paths} />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

