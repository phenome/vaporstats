import type { MediaOverview } from "../lib/media-overview";
import type { MediaSource } from "../lib/media-discovery";

function CitationNotes({
  sourceUrls,
  sources,
  sourceNumbers,
}: {
  sourceUrls: string[];
  sources: MediaSource[];
  sourceNumbers: Map<string, number>;
}) {
  const seen = new Set<number>();
  const notes = sourceUrls.flatMap((url) => {
    const sourceNumber = sourceNumbers.get(url);
    if (!sourceNumber || seen.has(sourceNumber)) return [];
    const source = sources[sourceNumber - 1];
    if (!source) return [];
    seen.add(sourceNumber);
    return [
      <a
        key={sourceNumber}
        href={`#media-source-${sourceNumber}`}
        title={`${source.outlet}: ${source.title}`}
        aria-label={`Source ${sourceNumber}: ${source.title} on ${source.outlet}`}
        className="font-mono text-xs text-orange-400 hover:text-orange-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      >
        [{sourceNumber}]
      </a>,
      " ",
    ];
  });

  return notes.length > 0 ? <span className="ml-1">{notes}</span> : null;
}

export function MediaOverviewSection({
  overview,
  sources,
}: {
  overview: MediaOverview;
  sources: MediaSource[];
}) {
  const sourceNumbers = new Map<string, number>();
  sources.forEach((source, index) => {
    if (!sourceNumbers.has(source.originalUrl)) sourceNumbers.set(source.originalUrl, index + 1);
  });

  return (
    <section id="media-overview" aria-labelledby="media-overview-title" className="min-w-0 space-y-3 scroll-mt-28">
      <div className="border-b border-zinc-800 pb-2">
        <h2 id="media-overview-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Overview
        </h2>
      </div>
      <div className="space-y-3 text-sm leading-6 text-zinc-300">
        {overview.statements.map((statement, statementIndex) => (
          <p key={`${statement.text}-${statementIndex}`}>
            {statement.text}
            <CitationNotes sourceUrls={statement.sourceUrls} sources={sources} sourceNumbers={sourceNumbers} />
          </p>
        ))}
      </div>
    </section>
  );
}
