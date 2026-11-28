import { useEffect, useRef } from "react";
import type { MediaSource } from "../lib/media-discovery";
import { getMediaSourceReferences, type MediaSourceReference } from "./media-source-references";

function formatSourceCounts(items: MediaSourceReference[]): string {
  const videos = items.filter((item) => item.isVideo).length;
  const articles = items.length - videos;
  return [
    articles && `${articles} ${articles === 1 ? "article" : "articles"}`,
    videos && `${videos} ${videos === 1 ? "video" : "videos"}`,
  ].filter(Boolean).join(" and ");
}

function SourceRow({
  item,
  showOutlet,
}: {
  item: MediaSourceReference;
  showOutlet: boolean;
}) {
  const { source, id, number, suffix, isVideo } = item;
  const developerInterview = isVideo && source.outlet === "GameSpot" && source.affiliation;
  return (
    <div
      id={id}
      tabIndex={-1}
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-1 py-1.5 text-xs target:bg-orange-950/40 focus:bg-orange-950/40 focus:outline focus:outline-orange-500/60"
    >
      <span className="w-6 shrink-0 font-mono text-zinc-400">{number}{suffix && <sub>{suffix}</sub>}</span>
      {showOutlet && <strong className="min-w-20 text-zinc-200">{source.outlet}</strong>}
      <a
        href={source.originalUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={isVideo
          ? `Watch ${source.title} from ${source.outlet} on YouTube (opens in a new tab)`
          : `Read ${source.title} on ${source.outlet} (opens in a new tab)`}
        className="min-w-0 flex-1 wrap-anywhere text-zinc-200 hover:text-orange-300 hover:underline focus-visible:outline focus-visible:outline-orange-500"
      >
        {source.title} <span aria-hidden="true">↗</span>
      </a>
      <span className="text-[11px] text-zinc-400">
        {isVideo && "Video · "}
        {developerInterview ? "Developer interview" : source.type === "review" ? "Review" : source.type === "announcement" ? "Announcement" : source.handsOn ? "Hands-on preview" : "Preview"}
      </span>
      {developerInterview && <span className="text-[11px] text-zinc-400">{developerInterview}</span>}
      {source.publishedAt && (
        <time dateTime={source.publishedAt} className="font-mono text-[11px] text-zinc-400">
          {source.publishedAt.slice(0, 10)}
        </time>
      )}
    </div>
  );
}

export function MediaSources({ sources }: { sources: MediaSource[] }) {
  const sectionRef = useRef<HTMLElement>(null);
  const outlets = getMediaSourceReferences(sources);

  useEffect(() => {
    function revealSource() {
      const item = document.getElementById(window.location.hash.slice(1));
      if (!item || !sectionRef.current?.contains(item) || !item.id.startsWith("media-source-")) return;
      const outlet = item.closest("details");
      if (outlet) outlet.open = true;
      item.focus({ preventScroll: true });
      item.scrollIntoView({ block: "start" });
    }

    revealSource();
    window.addEventListener("hashchange", revealSource);
    return () => window.removeEventListener("hashchange", revealSource);
  }, [sources]);

  if (sources.length === 0) return null;

  return (
    <section ref={sectionRef} id="media-sources" aria-labelledby="media-sources-title" className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 pb-2">
        <h2 id="media-sources-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Sources
        </h2>
        <span className="font-mono text-xs text-zinc-400">
          {formatSourceCounts(outlets.flatMap(({ items }) => items))} · {outlets.length} {outlets.length === 1 ? "outlet" : "outlets"}
        </span>
      </div>
      <ul>
        {outlets.map(({ outlet, number, items }) => (
          <li key={outlet} className="border-t border-zinc-800">
            {items.length === 1 ? (
              <SourceRow item={items[0]!} showOutlet />
            ) : (
              // Fragment navigation can open the disclosure before React hydrates it.
              <details className="group" suppressHydrationWarning>
                <summary className="flex cursor-pointer list-none items-baseline gap-2 px-1 py-1.5 text-xs focus-visible:outline focus-visible:outline-orange-500 [&::-webkit-details-marker]:hidden">
                  <span className="w-6 shrink-0 font-mono text-zinc-400">{number}</span>
                  <strong className="text-zinc-200">
                    {outlet}
                    <span aria-hidden="true" className="ml-1 inline-block text-zinc-400 group-open:rotate-90">▸</span>
                  </strong>
                  <span className="ml-auto font-mono text-[11px] text-zinc-400">{formatSourceCounts(items)}</span>
                </summary>
                <div className="pl-4 sm:pl-8">
                  {items.map((item) => <SourceRow key={item.id} item={item} showOutlet={false} />)}
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
