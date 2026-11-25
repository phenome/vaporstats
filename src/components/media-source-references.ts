import type { MediaSource } from "../lib/media-discovery";

export function getMediaSourceReferences(sources: MediaSource[]) {
  const byOutlet = new Map<string, Array<{ source: MediaSource; id: string }>>();
  sources.forEach((source, index) => {
    const articles = byOutlet.get(source.outlet) ?? [];
    articles.push({ source, id: `media-source-${index + 1}` });
    byOutlet.set(source.outlet, articles);
  });

  return [...byOutlet].map(([outlet, articles], index) => ({
    outlet,
    number: index + 1,
    articles: articles.map((article, articleIndex) => ({
      ...article,
      number: index + 1,
      suffix: articles.length > 1 ? articleIndex + 1 : undefined,
    })),
  }));
}

export type MediaSourceReference = ReturnType<typeof getMediaSourceReferences>[number]["articles"][number];
