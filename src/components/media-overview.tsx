import type { MediaFinding, MediaOverview } from "../lib/media-overview";
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

function CitedFindings({
  findings,
  sources,
  sourceNumbers,
}: {
  findings: MediaFinding[];
  sources: MediaSource[];
  sourceNumbers: Map<string, number>;
}) {
  return findings.map((finding, index) => (
    <p key={`${finding.text}-${index}`}>
      {finding.contested && (
        <span
          data-contested
          className="mr-2 inline-flex border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-zinc-500"
        >
          Contested
        </span>
      )}
      {finding.text}
      <CitationNotes sourceUrls={finding.sourceUrls} sources={sources} sourceNumbers={sourceNumbers} />
    </p>
  ));
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
        <CitedFindings findings={overview.statements} sources={sources} sourceNumbers={sourceNumbers} />
      </div>
      {overview.categories.map((category) => (
        <section key={category.name} aria-labelledby={`media-category-${category.name.replaceAll(/\W+/g, "-").toLowerCase()}`} className="space-y-2 pt-2">
          <h3
            id={`media-category-${category.name.replaceAll(/\W+/g, "-").toLowerCase()}`}
            className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300"
          >
            {category.name}
          </h3>
          <div className="space-y-2 text-sm leading-6 text-zinc-300">
            <CitedFindings findings={category.findings} sources={sources} sourceNumbers={sourceNumbers} />
          </div>
        </section>
      ))}
      {overview.prosCons && (
        <section aria-labelledby="media-pros-cons-title" className="space-y-2 border-t border-zinc-800 pt-3">
          <h3 id="media-pros-cons-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Pros &amp; cons
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {overview.prosCons.pros.length > 0 && (
              <div className="space-y-2 border-l-2 border-emerald-900/70 pl-3 text-sm leading-6 text-zinc-300">
                <h4 className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Pros</h4>
                <CitedFindings findings={overview.prosCons.pros} sources={sources} sourceNumbers={sourceNumbers} />
              </div>
            )}
            {overview.prosCons.cons.length > 0 && (
              <div className="space-y-2 border-l-2 border-red-950 pl-3 text-sm leading-6 text-zinc-300">
                <h4 className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Cons</h4>
                <CitedFindings findings={overview.prosCons.cons} sources={sources} sourceNumbers={sourceNumbers} />
              </div>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
