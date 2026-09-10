import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { AppDatabase } from "./db";
import type { StoredSteamEvent } from "./reception-store";

export interface EventReaderSuccess {
  status: "success";
  eventId: string;
  appid: number;
  title: string;
  byline: string | null;
  publishedAt: string | null;
  contentHtml: string;
  textContent: string | null;
  excerpt: string | null;
  sourceUrl: string | null;
  category: string | null;
}

export interface EventReaderFallback {
  status: "fallback";
  eventId: string;
  appid: number;
  title: string;
  byline: null;
  publishedAt: string | null;
  contentHtml: null;
  textContent: null;
  excerpt: null;
  sourceUrl: string | null;
  category: string | null;
  fallbackReason: "no_url" | "fetch_failed" | "extraction_failed";
}

export interface EventReaderNotFound {
  status: "not_found";
  eventId: string;
  appid: number;
  message: string;
}

export type EventReaderResult = EventReaderSuccess | EventReaderFallback | EventReaderNotFound;

export interface EventReaderOptions {
  customFetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface ParsedReadabilityArticle {
  title: string;
  content: string;
  textContent: string;
  length: number;
  excerpt: string;
  byline: string | null;
  dir: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null;
}

const DISALLOWED_TAGS: Record<string, true> = {
  script: true,
  style: true,
  iframe: true,
  frame: true,
  object: true,
  embed: true,
  applet: true,
  form: true,
  input: true,
  button: true,
  select: true,
  textarea: true,
  link: true,
  meta: true,
  base: true,
  noscript: true,
  svg: true,
  canvas: true,
};

/**
 * Sanitizes reader HTML to prevent XSS and style poisoning.
 * Strips active scripts, frames, inline style attributes, and event handlers.
 */
export function sanitizeReaderHtml(dirtyHtml: string, baseUrl?: string): string {
  if (!dirtyHtml || typeof dirtyHtml !== "string") return "";
  const { document } = parseHTML(`<!DOCTYPE html><html><body><div id="root">${dirtyHtml}</div></body></html>`);
  const root = document.getElementById("root");
  if (!root) return "";
  for (const tag of Object.keys(DISALLOWED_TAGS)) {
    const elements = Array.from(root.querySelectorAll(tag));
    for (const el of elements) {
      if (tag === "iframe") {
        const src = el.getAttribute("src")?.trim() || "";
        if (/^https:\/\/(www\.)?(youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/)[\w-]+/i.test(src)) {
          continue;
        }
      }
      el.remove();
    }
  }

  const allElements = Array.from(root.querySelectorAll("*"));
  for (const el of allElements) {
    const element = el as HTMLElement;
    const attributeNames = element.getAttributeNames ? element.getAttributeNames() : [];
    for (const name of attributeNames) {
      if (name.toLowerCase().startsWith("on") || name.toLowerCase() === "style") {
        element.removeAttribute(name);
      }
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "a") {
      const href = element.getAttribute("href");
      if (href) {
        const trimmed = href.trim();
        if (/^javascript:/i.test(trimmed) || /^data:/i.test(trimmed)) {
          element.removeAttribute("href");
        } else {
          let resolved = trimmed;
          if (baseUrl) {
            try {
              resolved = new URL(trimmed, baseUrl).toString();
            } catch {
              resolved = trimmed;
            }
          }
          element.setAttribute("href", resolved);
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noopener noreferrer");
        }
      }
    } else if (tagName === "img") {
      const src = element.getAttribute("src");
      if (src) {
        const trimmed = src.trim();
        if (/^javascript:/i.test(trimmed)) {
          element.removeAttribute("src");
        } else {
          let resolved = trimmed;
          if (baseUrl) {
            try {
              resolved = new URL(trimmed, baseUrl).toString();
            } catch {
              resolved = trimmed;
            }
          }
          element.setAttribute("src", resolved);
          element.setAttribute("loading", "lazy");
        }
      }
    } else if (tagName === "iframe") {
      const src = element.getAttribute("src")?.trim() || "";
      if (!/^https:\/\/(www\.)?(youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/)[\w-]+/i.test(src)) {
        element.remove();
      }
    }
  }

  return root.innerHTML;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    try {
      const sanitized = str.replace(/[\u0000-\u001F\u007F-\u009F]/g, (char) => {
        if (char === "\n") return "\\n";
        if (char === "\r") return "\\r";
        if (char === "\t") return "\\t";
        return "";
      });
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}
/**
 * Converts Steam announcement BBCode into semantic HTML elements.
 */
export function bbcodeToHtml(bbcode: string): string {
  if (!bbcode || typeof bbcode !== "string") return "";

  let text = bbcode.replace(/\r\n|\r/g, "\n");

  // Unescape escaped brackets like \[ MAPS ]
  text = text.replace(/\\\[/g, "[").replace(/\\\]/g, "]");

  // Images: support both Steam's body form and attribute form.
  text = text.replace(
    /\[img\s+src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]([\s\S]*?)\[\/img\]/gi,
    (_, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
      const src = (doubleQuoted ?? singleQuoted ?? unquoted ?? "").replace(
        /^\{STEAM_CLAN_(?:LOC_)?IMAGE\}/i,
        "https://clan.fastly.steamstatic.com/images",
      );
      return `<img src="${src}" alt="" />`;
    },
  );
  text = text.replace(/\[img\]\{STEAM_CLAN_IMAGE\}(.*?)\[\/img\]/gi, '<img src="https://clan.fastly.steamstatic.com/images$1" />');
  text = text.replace(/\[img\](.*?)\[\/img\]/gi, '<img src="$1" />');

  // Headings
  text = text.replace(/\[h1\]([\s\S]*?)\[\/h1\]/gi, "<h1>$1</h1>");
  text = text.replace(/\[h2\]([\s\S]*?)\[\/h2\]/gi, "<h2>$1</h2>");
  text = text.replace(/\[h3\]([\s\S]*?)\[\/h3\]/gi, "<h3>$1</h3>");

  // Inline formatting
  text = text.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, "<strong>$1</strong>");
  text = text.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, "<em>$1</em>");
  text = text.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, "<u>$1</u>");
  text = text.replace(/\[strike\]([\s\S]*?)\[\/strike\]/gi, "<del>$1</del>");

  // Links: strip quotes from url target like [url="https://..."]
  text = text.replace(/\[url=["']?([^"'\]]+)["']?\]([\s\S]*?)\[\/url\]/gi, '<a href="$1">$2</a>');
  text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '<a href="$1">$1</a>');

  // Quotes and Code
  text = text.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, "<blockquote>$1</blockquote>");
  text = text.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, "<pre><code>$1</code></pre>");

  // YouTube previews: supports [previewyoutube=ID], [previewyoutube="ID"], [previewyoutube=ID;full], [previewyoutube="ID;full"]
  text = text.replace(
    /\[previewyoutube=["']?([^;"'\]]+)(?:;[^"'\]]*)?["']?\](?:\[\/previewyoutube\])?/gi,
    (_, videoId: string) => {
      const id = videoId.trim();
      return `
<div class="score-event-youtube-embed my-3 overflow-hidden rounded border border-zinc-800 bg-zinc-900">
  <div class="relative aspect-video w-full">
    <iframe
      src="https://www.youtube-nocookie.com/embed/${id}"
      title="YouTube video player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen
      loading="lazy"
      class="absolute inset-0 h-full w-full border-0"
    ></iframe>
  </div>
  <div class="border-t border-zinc-800/80 bg-zinc-950/60 px-3 py-1.5 font-mono text-[11px] text-zinc-400">
    <a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener noreferrer" class="text-violet-300 hover:text-violet-200 underline">Watch on YouTube ↗</a>
  </div>
</div>`;
    },
  );

  // Paragraphs: supports [p], [p align="start"], etc.
  text = text.replace(/\[p(?:\s+[^\]]*)?\]([\s\S]*?)\[\/p\]/gi, "<p>$1</p>");

  // Steam also emits literal asterisk bullets instead of [list] BBCode.
  text = text.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner: string) => {
    const parts = inner.split(/<br\s*\/?>\s*(?=\*\s+)/i);
    const first = parts[0]?.trim() ?? "";
    const hasPrefix = first.length > 0 && !/^\*\s+/.test(first);
    const items = hasPrefix ? parts.slice(1) : parts;
    if (items.length === 0 || items.some((item) => !/^\*\s+/.test(item.trim()))) return match;
    const prefix = hasPrefix ? `<p>${first}</p>` : "";
    const list = items.map((item) => `<li>${item.trim().replace(/^\*\s+/, "")}</li>`).join("");
    return `${prefix}<ul>${list}</ul>`;
  });
  text = text.replace(/(^|\n)((?:[ \t]*\*\s+.+(?:\n|$))+)/g, (_, prefix: string, block: string) => {
    const items = block
      .split(/\r?\n/)
      .map((item) => item.trim().replace(/^\*\s+/, ""))
      .filter(Boolean)
      .map((item) => `<li>${item}</li>`)
      .join("");
    return `${prefix}<ul>${items}</ul>`;
  });

  // Other layout helpers

  // Auto-link standalone URLs not already inside tags
  text = text.replace(/(?<!["'=])\b(https?:\/\/[^\s<>"']+)/gi, '<a href="$1">$1</a>');

  // Lists: Steam BBCode uses [*] to open item, [/*] to close item
  text = text.replace(/\[\/\*\]/gi, "</li>");
  text = text.replace(/\[\*\]/gi, "<li>");
  text = text.replace(/\[list\]/gi, "<ul>");
  text = text.replace(/\[\/list\]/gi, "</ul>");

  // Close any unclosed <li> before next <li>, </ul>, or end
  text = text.replace(/<li>([\s\S]*?)(?=(?:<li>|<\/ul>|$))/gi, (match, inner) => {
    if (inner.includes("</li>")) return match;
    return `<li>${inner.trim()}</li>`;
  });

  // Unwrap redundant <p> inside <li>
  text = text.replace(/<li>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/gi, "<li>$1</li>");

  // Trim list items and list containers
  text = text.replace(/<li>([\s\S]*?)<\/li>/gi, (_, item: string) => `<li>${item.trim()}</li>`);
  text = text.replace(/<ul>\s*/gi, "<ul>").replace(/\s*<\/ul>/gi, "</ul>");

  // Remove empty paragraphs
  text = text.replace(/<p>\s*<\/p>/gi, "");

  // Convert bracketed uppercase section headers like [ MAPS ], [ GAMEPLAY ], [ MISC ] into sticky section headers
  text = text.replace(/<p>\s*\[\s*([A-Z0-9 &/_.:'-]{2,})\s*\]\s*<\/p>/gi, (_, title: string) => `<h3 class="score-event-section-header">[ ${title.trim()} ]</h3>`);
  text = text.replace(/(?:^|\n)\s*\[\s*([A-Z0-9 &/_.:'-]{2,})\s*\]\s*(?:\n|$)/gi, (_, title: string) => `\n<h3 class="score-event-section-header">[ ${title.trim()} ]</h3>\n`);

  // Tag h1, h2, and h3 headings with score-event-section-header
  text = text.replace(/<(h[1-3])(?:\s+class="([^"]*)")?>([\s\S]*?)<\/\1>/gi, (_, tag: string, cls: string | undefined, content: string) => {
    if (cls?.includes("score-event-section-header")) return `<${tag} class="${cls}">${content}</${tag}>`;
    const combined = cls ? `${cls} score-event-section-header` : "score-event-section-header";
    return `<${tag} class="${combined}">${content}</${tag}>`;
  });
  // Wrap remaining bare text blocks in <p>
  text = text
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return "";
      if (/^<(h[1-3]|ul|ol|blockquote|pre|p|div)/i.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br />")}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  return text;
}

/**
 * Strips BBCode tags to produce clean plain text for excerpts.
 */
export function bbcodeToPlainText(bbcode: string): string {
  if (!bbcode || typeof bbcode !== "string") return "";
  return bbcode
    .replace(/\\\[/g, "[")
    .replace(/\\\]/g, "]")
    .replace(/\[img(?:\s+src\s*=\s*(?:"[^"]+"|'[^']+'|[^\]\s]+))?\s*\][\s\S]*?\[\/img\]/gi, "")
    .replace(/\[url=["']?([^"'\]]+)["']?\]([\s\S]*?)\[\/url\]/gi, "$2")
    .replace(/\[previewyoutube=[^\]]+\](?:\[\/previewyoutube\])?/gi, "")
    .replace(/\[p(?:\s+[^\]]*)?\]/gi, "")
    .replace(/\[\/p\]/gi, "\n")
    .replace(/\[\/\*\]/gi, "\n")
    .replace(/\[\*\]/gi, "\n- ")
    .replace(/\[\/?(?:img|url|b|i|u|strike|h[1-6]|list|\*|quote|code|previewyoutube|p|align|center|hr)(?:=[^\]]*)?\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}


interface SteamStoreRawEvent {
  gid?: string;
  event_name?: string;
  name?: string;
  announcement_body?: {
    gid?: string;
    event_gid?: string;
    headline?: string;
    body?: string;
  };
  body?: string;
}

/**
 * Extracts structured Steam announcement event content embedded in Steam store page HTML.
 */
export function extractSteamStoreEvent(
  html: string,
  sourceUrl?: string,
): { title?: string; body?: string; byline?: string | null } | null {
  const marker =
    html.match(/data-partnereventstore\s*=\s*(['"])(.*?)\1/s) ||
    html.match(/data-initialevents\s*=\s*(['"])(.*?)\1/s);
  if (!marker) return null;

  try {
    const decodedJson = decodeHtmlEntities(marker[2]);
    const parsed = safeParseJson(decodedJson);
    const events: SteamStoreRawEvent[] = Array.isArray(parsed)
      ? (parsed as SteamStoreRawEvent[])
      : parsed && typeof parsed === "object" && "events" in parsed && Array.isArray(parsed.events)
        ? (parsed.events as SteamStoreRawEvent[])
        : [];
    if (events.length === 0) return null;

    const targetId = sourceUrl
      ? sourceUrl.match(/\/view\/(\d+)/)?.[1] || sourceUrl.match(/\/detail\/(\d+)/)?.[1]
      : null;
    let event: SteamStoreRawEvent | undefined;
    if (targetId) {
      event = events.find(
        (e) =>
          e.gid === targetId ||
          e.announcement_body?.gid === targetId ||
          e.announcement_body?.event_gid === targetId,
      );
      if (!event) return null;
    } else {
      event = events[0];
    }
    const body = event.announcement_body?.body || event.body;
    if (!body || typeof body !== "string") return null;

    const title = event.announcement_body?.headline || event.event_name || event.name;
    return {
      title: typeof title === "string" ? title : undefined,
      body,
      byline: null,
    };
  } catch {
    return null;
  }
}

/**
 * Parses raw HTML, checking first for Steam store structured event data,
 * and falling back to @mozilla/readability for standard HTML articles.
 */
export function extractReaderContent(
  html: string,
  sourceUrl?: string,
): {
  title?: string;
  byline?: string | null;
  contentHtml?: string;
  textContent?: string;
  excerpt?: string | null;
} | null {
  if (!html || typeof html !== "string") return null;

  // 1. Structured Steam store announcement data embedded in page attributes
  const steamEvent = extractSteamStoreEvent(html, sourceUrl);
  if (steamEvent && steamEvent.body) {
    const rawHtml = bbcodeToHtml(steamEvent.body);
    const cleanContent = sanitizeReaderHtml(rawHtml, sourceUrl);
    if (cleanContent.trim()) {
      const plainText = bbcodeToPlainText(steamEvent.body);
      const excerpt = plainText.length > 280 ? `${plainText.slice(0, 277)}...` : plainText || null;
      return {
        title: steamEvent.title || undefined,
        byline: steamEvent.byline || null,
        contentHtml: cleanContent,
        textContent: plainText || undefined,
        excerpt,
      };
    }
  }

  // 2. Mozilla Readability for generic article pages
  let document: Document;
  try {
    const parsed = parseHTML(html);
    document = parsed.document as unknown as Document;
  } catch {
    return null;
  }

  const scripts = Array.from(document.querySelectorAll("script, style, noscript"));
  for (const s of scripts) {
    s.remove();
  }

  let article: ParsedReadabilityArticle | null = null;
  try {
    const reader = new Readability(document, { charThreshold: 20 });
    article = reader.parse() as ParsedReadabilityArticle | null;
  } catch {
    return null;
  }

  if (!article || !article.content) {
    return null;
  }

  const cleanContent = sanitizeReaderHtml(article.content, sourceUrl);
  if (!cleanContent.trim()) {
    return null;
  }

  // Ignore if Readability only captured Valve's legal footer boilerplate
  if (
    cleanContent.includes("Valve Corporation") &&
    cleanContent.includes("All rights reserved") &&
    cleanContent.length < 500
  ) {
    return null;
  }

  return {
    title: article.title || undefined,
    byline: article.byline || null,
    contentHtml: cleanContent,
    textContent: article.textContent?.trim() || undefined,
    excerpt: article.excerpt?.trim() || null,
  };
}

/**
 * Fetches and extracts reader content for a given game event,
 * falling back to event metadata if the source cannot be parsed.
 */
export async function getEventReader(
  db: AppDatabase,
  appid: number,
  eventId: string,
  options: EventReaderOptions = {},
): Promise<EventReaderResult> {
  const event = await db
    .prepare(
      `SELECT event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance
       FROM steam_events
       WHERE appid = ? AND event_id = ?`,
    )
    .bind(appid, eventId)
    .first<StoredSteamEvent>();

  if (!event) {
    return {
      status: "not_found",
      eventId,
      appid,
      message: `Event ${eventId} not found for appid ${appid}`,
    };
  }

  const publishedAt = event.publication_at ?? event.start_at;
  const eventTitle = event.title || "Game Update";
  const sourceUrl =
    event.url ||
    (event.appid && /^\d+$/.test(event.event_id)
      ? `https://store.steampowered.com/news/app/${event.appid}/view/${event.event_id}`
      : null);

  if (!sourceUrl) {
    return {
      status: "fallback",
      eventId: event.event_id,
      appid: event.appid,
      title: eventTitle,
      byline: null,
      publishedAt,
      contentHtml: null,
      textContent: null,
      excerpt: null,
      sourceUrl: null,
      category: event.category,
      fallbackReason: "no_url",
    };
  }
  const fetchFn = options.customFetch ?? fetch;
  let html = "";
  try {
    const response = await fetchFn(sourceUrl, {
      signal: options.signal,
      headers: {
        "User-Agent": "VaporStats-Reader/1.0 (+https://vaporstats.com)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return {
        status: "fallback",
        eventId: event.event_id,
        appid: event.appid,
        title: eventTitle,
        byline: null,
        publishedAt,
        contentHtml: null,
        textContent: null,
        excerpt: null,
        sourceUrl,
        category: event.category,
        fallbackReason: "fetch_failed",
      };
    }

    html = await response.text();
  } catch {
    return {
      status: "fallback",
      eventId: event.event_id,
      appid: event.appid,
      title: eventTitle,
      byline: null,
      publishedAt,
      contentHtml: null,
      textContent: null,
      excerpt: null,
      sourceUrl,
      category: event.category,
      fallbackReason: "fetch_failed",
    };
  }

  const extracted = extractReaderContent(html, sourceUrl);
  if (!extracted || !extracted.contentHtml) {
    return {
      status: "fallback",
      eventId: event.event_id,
      appid: event.appid,
      title: eventTitle,
      byline: null,
      publishedAt,
      contentHtml: null,
      textContent: null,
      excerpt: null,
      sourceUrl,
      category: event.category,
      fallbackReason: "extraction_failed",
    };
  }

  return {
    status: "success",
    eventId: event.event_id,
    appid: event.appid,
    title: extracted.title || eventTitle,
    byline: extracted.byline || null,
    publishedAt,
    contentHtml: extracted.contentHtml,
    textContent: extracted.textContent || null,
    excerpt: extracted.excerpt || null,
    sourceUrl,
    category: event.category,
  };
}

