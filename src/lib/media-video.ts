import { MIN_USABLE_ARTICLE_CHARS } from "./article-document";

const GAMESPOT_CHANNEL = "UCbu2SsF-Or3Rsn3NxqODImw";
export const GAMESPOT_VIDEO_URL_PREFIX = "https://www.youtube.com/watch?v=";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}(?![\s\S])/;
const ENGLISH = /^en(?:[-_][A-Za-z0-9]+)*(?![\s\S])/;
const MAX_MANIFEST_BYTES = 16_384;
const MAX_CAPTION_BYTES = 1_000_000;
const MAX_ROLLING_CUE_OVERLAP_WORDS = 32;

export function gameSpotVideoId(outlet: string, url: string): string | null {
  if (outlet !== "GameSpot" || !url.startsWith(GAMESPOT_VIDEO_URL_PREFIX)) return null;
  const id = url.slice(GAMESPOT_VIDEO_URL_PREFIX.length);
  return VIDEO_ID.test(id) ? id : null;
}

type ApprovedVideo = {
  id: string;
  title: string;
  publishedAt: string | null;
  developer: string | null;
  language: string;
};

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 300 ? value.trim() : null;
}

function approvedVideo(entry: unknown): ApprovedVideo | null {
  if (!entry || typeof entry !== "object") return null;
  const { id, title, channelId, publishedOn, developer, language } = entry as Record<string, unknown>;
  const cleanTitle = textField(title);
  const cleanDeveloper = textField(developer);
  if (channelId !== GAMESPOT_CHANNEL || typeof id !== "string" || !VIDEO_ID.test(id)
    || typeof language !== "string" || !ENGLISH.test(language) || !cleanTitle || (developer != null && !cleanDeveloper)) return null;
  const published = typeof publishedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(publishedOn)
    ? new Date(publishedOn) : null;
  const publishedAt = published && Number.isFinite(+published) && published.toISOString().slice(0, 10) === publishedOn
    ? published.toISOString() : null;
  return { id, title: cleanTitle, developer: cleanDeveloper, language, publishedAt };
}

async function readLocalFile(path: string, maxBytes: number): Promise<string | null> {
  const file = Bun.file(path);
  try {
    if (!await file.exists() || file.size > maxBytes) return null;
    const value = await file.slice(0, maxBytes + 1).text();
    return Buffer.byteLength(value) <= maxBytes ? value : null;
  } catch {
    // A missing or unreadable local bundle cannot supply evidence.
    return null;
  }
}

export function gameSpotCaptionDirectory(): string | undefined {
  return process.env.MEDIA_GAMESPOT_CAPTION_DIRECTORY?.trim() || undefined;
}

export async function approvedGameSpotVideos(directory: string, appid: number): Promise<ApprovedVideo[]> {
  const manifest = await readLocalFile(`${directory}/${appid}.json`, MAX_MANIFEST_BYTES);
  if (!manifest) return [];
  try {
    const entries: unknown = JSON.parse(manifest);
    if (Array.isArray(entries)) return entries.flatMap((entry) => {
      const video = approvedVideo(entry);
      return video ? [video] : [];
    });
  } catch {
    return [];
  }
  return [];
}

const TIMESTAMP = "(?:\\d{2,}:)?[0-5]\\d:[0-5]\\d\\.\\d{3}";
const CUE_TIMING = new RegExp(`^${TIMESTAMP}[ \\t]+-->[ \\t]+${TIMESTAMP}(?:[ \\t]+.*)?$`);
const VTT_ESCAPES: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "", rlm: "" };

function usableEnglishCaptionText(vtt: string): string | null {
  if (!/^\uFEFF?WEBVTT(?:[ \t][^\r\n]*)?\r?\n/.test(vtt)) return null;
  const words: string[] = [];
  for (const cue of vtt.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/).slice(1)) {
    const lines = cue.trim().split("\n");
    const timing = CUE_TIMING.test(lines[0] ?? "") ? 0 : 1;
    if (/^(?:NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0] ?? "") || !CUE_TIMING.test(lines[timing] ?? "")) continue;
    const caption = lines.slice(timing + 1).join(" ").replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (entity, key: string) => VTT_ESCAPES[key] ?? entity)
      .replace(/\[[^\]]*\]/g, "").trim();
    if (!caption) continue;
    const cueWords = caption.split(/\s+/);
    // Auto-captions repeat the last line while rolling in the next words.
    let overlap = Math.min(cueWords.length, words.length, MAX_ROLLING_CUE_OVERLAP_WORDS);
    while (overlap > 0 && !cueWords.slice(0, overlap).every((word, index) => word === words[words.length - overlap + index])) overlap -= 1;
    for (const word of cueWords.slice(overlap)) words.push(word);
  }
  const text = words.join(" ");
  return text.length >= MIN_USABLE_ARTICLE_CHARS ? text : null;
}

export async function readGameSpotCaptions(directory: string, video: ApprovedVideo): Promise<string | null> {
  const vtt = await readLocalFile(`${directory}/${video.id}.${video.language}.vtt`, MAX_CAPTION_BYTES);
  return vtt ? usableEnglishCaptionText(vtt) : null;
}

export function gameSpotWatchUrl(video: ApprovedVideo): string {
  return GAMESPOT_VIDEO_URL_PREFIX + video.id;
}
