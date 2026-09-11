import type { MediaSource } from "../lib/media-discovery";
import { formatDateOnly } from "../lib/format";

function SourceDate({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <span>
      {label}: <time dateTime={value}>{formatDateOnly(value)}</time>
    </span>
  );
}

function SourceContext({ source }: { source: MediaSource }) {
  const context = [
    source.affiliation ? `Affiliation: ${source.affiliation}` : null,
    source.platform ? `Platform: ${source.platform}` : null,
    source.buildContext ? `Build context: ${source.buildContext}` : null,
  ].filter((value): value is string => value !== null);
  if (context.length === 0) return null;
  return <p className="mt-2 break-words text-xs text-zinc-400">{context.join(" · ")}</p>;
}

export function MediaSources({ sources }: { sources: MediaSource[] }) {
  if (sources.length === 0) return null;

  return (
    <section id="media-sources" aria-labelledby="media-sources-title" className="min-w-0 space-y-3">
      <div className="flex items-baseline justify-between gap-3 border-b border-zinc-800 pb-2">
        <h2 id="media-sources-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Sources
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </span>
      </div>
      <ol className="grid gap-3 md:grid-cols-2">
        {sources.map((source) => (
          <li key={source.originalUrl} className="min-w-0 border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-xs font-semibold uppercase tracking-wider text-orange-400">{source.outlet}</p>
                <h3 className="mt-1 break-words text-sm font-medium text-zinc-100">{source.title}</h3>
              </div>
              <a
                href={source.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Read ${source.title} on ${source.outlet} (opens in a new tab)`}
                className="shrink-0 font-mono text-xs text-orange-400 hover:text-orange-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              >
                Read ↗
              </a>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
              <span>Type: {source.type}</span>
              {source.handsOn === null ? null : <span>Hands-on: {source.handsOn ? "Yes" : "No"}</span>}
              {source.author ? <span>By: {source.author}</span> : null}
              <SourceDate label="Published" value={source.publishedAt} />
              <SourceDate label="Updated" value={source.updatedAt} />
            </div>
            <SourceContext source={source} />
          </li>
        ))}
      </ol>
    </section>
  );
}
