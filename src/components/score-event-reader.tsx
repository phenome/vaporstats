import React, { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, ExternalLink } from "lucide-react";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";
import { formatDateOnly } from "../lib/format";
import type { EventReaderApiResponse } from "../routes/api.games.$appid.events.$eventid.reader";

export interface ScoreEventReaderProps {
  appid: number;
  eventId: string;
  onClose: () => void;
}

export function eventReaderQueryOptions(appid: number, eventId: string) {
  return {
    queryKey: ["event-reader", appid, eventId],
    queryFn: async (): Promise<EventReaderApiResponse> => {
      const response = await fetch(
        `/api/games/${appid}/events/${encodeURIComponent(eventId)}/reader`,
      );
      if (!response.ok) {
        throw new Error(`Failed to load event ${eventId}`);
      }
      return (await response.json()) as EventReaderApiResponse;
    },
    staleTime: 5 * 60 * 1000,
  };
}

function categoryLabel(cat: string | null | undefined): string {
  if (!cat) return "Event";
  return cat.replaceAll("_", " ").toUpperCase();
}

export function ScoreEventReader({ appid, eventId, onClose }: ScoreEventReaderProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const { data, isLoading, isError } = useQuery(eventReaderQueryOptions(appid, eventId));

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const rawResult = data?.data;
  const payload = rawResult && rawResult.status !== "not_found" ? rawResult : null;
  const fallbackPayload = payload?.status === "fallback" ? payload : null;
  const successPayload = payload?.status === "success" ? payload : null;
  return (
    <article
      id="score-event-reader"
      aria-labelledby="score-event-reader-title"
      className="flex h-full flex-col min-h-[440px]"
    >
      <header className="flex items-start justify-between gap-3 border-b border-zinc-900 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-violet-300">
            <span className="border border-violet-500/40 bg-violet-950/60 px-1.5 py-0.5">
              {categoryLabel(payload?.category)}
            </span>
            {payload?.publishedAt && (
              <time dateTime={payload.publishedAt} className="text-zinc-400">
                {formatDateOnly(payload.publishedAt)}
              </time>
            )}
          </div>
          <h2
            id="score-event-reader-title"
            className="mt-2 text-sm font-bold text-zinc-100 break-words"
          >
            {payload?.title || "Game Update"}
          </h2>
          {payload?.byline && (
            <p className="mt-0.5 font-mono text-[11px] text-zinc-400">{payload.byline}</p>
          )}
        </div>

        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close article reader"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 shrink-0"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 mt-3 min-h-0">
        {isLoading && (
          <div className="space-y-3 py-4" aria-busy="true" aria-label="Loading event article">
            <Skeleton className="h-4 w-3/4 bg-zinc-800" />
            <Skeleton className="h-4 w-full bg-zinc-800" />
            <Skeleton className="h-4 w-5/6 bg-zinc-800" />
            <Skeleton className="h-20 w-full bg-zinc-800" />
          </div>
        )}

        {(isError || !payload) && !isLoading && (
          <div className="py-6 text-center">
            <p className="text-xs font-mono text-zinc-500">Event article unavailable.</p>
          </div>
        )}

        {!isLoading && payload && (
          <>
            {fallbackPayload ? (
              <div className="space-y-3 py-2 text-xs leading-relaxed text-zinc-300">
                <p className="rounded border border-zinc-800 bg-zinc-900/60 p-2.5 text-zinc-400 font-mono text-[11px]">
                  Full article cannot be rendered in reader view.
                </p>
                {fallbackPayload.excerpt && (
                  <blockquote className="border-l-2 border-violet-400/40 pl-3 italic text-zinc-400">
                    {fallbackPayload.excerpt}
                  </blockquote>
                )}
                {fallbackPayload.sourceUrl && (
                  <div className="pt-2">
                    <a
                      href={fallbackPayload.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-[44px] items-center gap-1.5 border border-violet-500 bg-violet-600 px-3 py-2 font-mono text-xs font-medium text-white transition-colors hover:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                    >
                      <span>Read on Steam</span>
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  </div>
                )}
              </div>
            ) : successPayload ? (
              <ScrollArea className="h-[440px] w-full pr-3">
                {successPayload.sourceUrl && (
                  <div className="mb-3 border-b border-zinc-900 pb-2.5">
                    <a
                      href={successPayload.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-violet-300 underline underline-offset-2 hover:text-violet-200"
                    >
                      <span>Original announcement on Steam</span>
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                )}
                <div
                  className="space-y-3 text-xs leading-relaxed text-zinc-300 break-words font-sans selection:bg-violet-500/30 selection:text-violet-100
                    [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-zinc-100 [&_h1]:mt-3
                    [&_h2]:text-xs [&_h2]:font-bold [&_h2]:text-zinc-100 [&_h2]:mt-2.5
                    [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-zinc-200 [&_h3]:mt-2
                    [&_p]:mt-1.5 [&_p]:leading-relaxed
                    [&_a]:text-violet-300 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-violet-200
                    [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-1 [&_ul]:my-2
                    [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:space-y-1 [&_ol]:my-2
                    [&_li]:text-zinc-300
                    [&_blockquote]:border-l-2 [&_blockquote]:border-violet-400/50 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:my-2
                    [&_code]:rounded [&_code]:bg-zinc-900 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-violet-200
                    [&_pre]:rounded [&_pre]:bg-zinc-900 [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[11px] [&_pre]:overflow-x-auto
                    [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded [&_img]:my-2
                    [&_hr]:border-zinc-800 [&_hr]:my-3"
                  dangerouslySetInnerHTML={{ __html: successPayload.contentHtml }}
                />
              </ScrollArea>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}
