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
    }
  }

  return root.innerHTML;
}

/**
 * Parses raw HTML using linkedom and extracts article content via @mozilla/readability.
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

  if (!event.url) {
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
    const response = await fetchFn(event.url, {
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
        sourceUrl: event.url,
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
      sourceUrl: event.url,
      category: event.category,
      fallbackReason: "fetch_failed",
    };
  }

  const extracted = extractReaderContent(html, event.url);
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
      sourceUrl: event.url,
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
    sourceUrl: event.url,
    category: event.category,
  };
}
