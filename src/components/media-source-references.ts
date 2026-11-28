import type { MediaSource } from "../lib/media-discovery";

function isYouTubeVideo(url: string): boolean {
  return /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(url);
}

export function getMediaSourceReferences(sources: MediaSource[]) {
  const byOutlet = new Map<string, Array<{ source: MediaSource; id: string; isVideo: boolean }>>();
  sources.forEach((source, index) => {
    const items = byOutlet.get(source.outlet) ?? [];
    items.push({ source, id: `media-source-${index + 1}`, isVideo: isYouTubeVideo(source.originalUrl) });
    byOutlet.set(source.outlet, items);
  });

  return [...byOutlet].map(([outlet, items], index) => ({
    outlet,
    number: index + 1,
    items: items.map((item, itemIndex) => ({
      ...item,
      number: index + 1,
      suffix: items.length > 1 ? itemIndex + 1 : undefined,
    })),
  }));
}

export type MediaSourceReference = ReturnType<typeof getMediaSourceReferences>[number]["items"][number];
