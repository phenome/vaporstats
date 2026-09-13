import type { MediaGameMatch, MediaMatchCitation, MediaMatchDimension } from "../lib/media-similarity";
import { getCanonicalGamePath } from "../lib/slug";
import { AppLink } from "./app-link";

const DIMENSION_LABELS: Record<MediaMatchDimension, string> = {
  gameplay: "Gameplay & systems",
  story_world: "Story & world",
};

function CitationList({
  label,
  citations,
}: {
  label: string;
  citations: MediaMatchCitation[];
}) {
  if (citations.length === 0) return null;
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</h4>
      <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
        {citations.map((citation) => {
          const context = [
            citation.type ? `Type: ${citation.type}` : null,
            citation.handsOn == null ? null : `Hands-on: ${citation.handsOn ? "Yes" : "No"}`,
            citation.platform ? `Platform: ${citation.platform}` : null,
            citation.buildContext ? `Build context: ${citation.buildContext}` : null,
          ].filter((value): value is string => value !== null);
          return (
            <li key={citation.originalUrl} className="min-w-0 border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-mono text-xs font-semibold uppercase tracking-wider text-orange-400">
                    {citation.outlet}
                  </p>
                  <p className="mt-1 break-words text-sm text-zinc-200">{citation.title}</p>
                </div>
                <a
                  href={citation.originalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Read ${citation.title} on ${citation.outlet} (opens in a new tab)`}
                  className="shrink-0 font-mono text-xs text-orange-400 hover:text-orange-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                >
                  Read ↗
                </a>
              </div>
              {context.length > 0 && <p className="mt-2 break-words text-xs text-zinc-400">{context.join(" · ")}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MatchCard({ match }: { match: MediaGameMatch }) {
  return (
    <article className="min-w-0 space-y-4 border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="min-w-0 space-y-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-violet-300">Shared trait</p>
        <h3 className="break-words text-base font-semibold text-zinc-100">{match.trait}</h3>
        <p className="break-words text-sm leading-relaxed text-zinc-300">{match.explanation}</p>
        <AppLink
          href={getCanonicalGamePath(match.matchedGame.appid, match.matchedGame.name)}
          className="inline-flex max-w-full break-words text-sm text-orange-400 hover:text-orange-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          {match.matchedGame.name}
        </AppLink>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <CitationList label="Sources for this game" citations={match.currentSources} />
        <CitationList label={`Sources for ${match.matchedGame.name}`} citations={match.matchedSources} />
      </div>
    </article>
  );
}

export function MediaMatchesSection({ matches }: { matches: MediaGameMatch[] }) {
  const visibleMatches = matches.filter((match) => Object.prototype.hasOwnProperty.call(DIMENSION_LABELS, match.dimension));
  if (visibleMatches.length === 0) return null;

  return (
    <section id="media-matches" aria-labelledby="media-matches-title" className="min-w-0 space-y-4 scroll-mt-28">
      <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-zinc-800 pb-2">
        <h2 id="media-matches-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Media matches
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          {visibleMatches.length} {visibleMatches.length === 1 ? "match" : "matches"}
        </span>
      </div>
      {(Object.keys(DIMENSION_LABELS) as MediaMatchDimension[]).map((dimension) => {
        const dimensionMatches = visibleMatches.filter((match) => match.dimension === dimension);
        if (dimensionMatches.length === 0) return null;
        return (
          <div key={dimension} className="min-w-0 space-y-3">
            <h3 className="font-mono text-sm font-semibold text-zinc-100">{DIMENSION_LABELS[dimension]}</h3>
            <div className="grid min-w-0 gap-3">{dimensionMatches.map((match) => <MatchCard key={match.matchedGame.appid} match={match} />)}</div>
          </div>
        );
      })}
    </section>
  );
}
