import { useEffect, useRef } from "react";
import type { MediaSource } from "../lib/media-discovery";
import { getMediaSourceReferences, type MediaSourceReference } from "./media-source-references";

function ArticleRow({
  article,
  showOutlet,
}: {
  article: MediaSourceReference;
  showOutlet: boolean;
}) {
  const { source, id, number, suffix } = article;
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
        aria-label={`Read ${source.title} on ${source.outlet} (opens in a new tab)`}
        className="min-w-0 flex-1 wrap-anywhere text-zinc-200 hover:text-orange-300 hover:underline focus-visible:outline focus-visible:outline-orange-500"
      >
        {source.title} <span aria-hidden="true">↗</span>
      </a>
      <span className="text-[11px] text-zinc-400">
        {source.type === "review" ? "Review" : source.type === "announcement" ? "Announcement" : source.handsOn ? "Hands-on preview" : "Preview"}
      </span>
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
    function revealArticle() {
      const article = document.getElementById(window.location.hash.slice(1));
      if (!article || !sectionRef.current?.contains(article) || !article.id.startsWith("media-source-")) return;
      const outlet = article.closest("details");
      if (outlet) outlet.open = true;
      article.focus({ preventScroll: true });
      article.scrollIntoView({ block: "start" });
    }

    revealArticle();
    window.addEventListener("hashchange", revealArticle);
    return () => window.removeEventListener("hashchange", revealArticle);
  }, [sources]);

  if (sources.length === 0) return null;

  return (
    <section ref={sectionRef} id="media-sources" aria-labelledby="media-sources-title" className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 pb-2">
        <h2 id="media-sources-title" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Sources
        </h2>
        <span className="font-mono text-xs text-zinc-400">
          {sources.length} {sources.length === 1 ? "article" : "articles"} · {outlets.length} {outlets.length === 1 ? "outlet" : "outlets"}
        </span>
      </div>
      <ul>
        {outlets.map(({ outlet, number, articles }) => (
          <li key={outlet} className="border-t border-zinc-800">
            {articles.length === 1 ? (
              <ArticleRow article={articles[0]!} showOutlet />
            ) : (
              // Fragment navigation can open the disclosure before React hydrates it.
              <details className="group" suppressHydrationWarning>
                <summary className="flex cursor-pointer list-none items-baseline gap-2 px-1 py-1.5 text-xs focus-visible:outline focus-visible:outline-orange-500 [&::-webkit-details-marker]:hidden">
                  <span className="w-6 shrink-0 font-mono text-zinc-400">{number}</span>
                  <strong className="text-zinc-200">
                    {outlet}
                    <span aria-hidden="true" className="ml-1 inline-block text-zinc-400 group-open:rotate-90">▸</span>
                  </strong>
                  <span className="ml-auto font-mono text-[11px] text-zinc-400">{articles.length} articles</span>
                </summary>
                <div className="pl-4 sm:pl-8">
                  {articles.map((article) => <ArticleRow key={article.id} article={article} showOutlet={false} />)}
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
