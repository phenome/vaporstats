import { parseHTML } from "linkedom";

export const MIN_USABLE_ARTICLE_CHARS = 120;

/**
 * Parses fetched article HTML into a document, or returns null when the
 * content cannot be one. A body that holds no root element (an empty or
 * whitespace-only body, plain text, JSON, a lone comment, binary content)
 * parses into a linkedom document without a document element, whose `body`,
 * `title` and Readability parse then throw. Every caller that parses fetched
 * HTML goes through here and treats null as an unusable article.
 */
export function parseArticleDocument(html: string): Document | null {
  try {
    const { document } = parseHTML(html);
    if (!document.documentElement || !document.body) return null;
    return document as unknown as Document;
  } catch {
    return null;
  }
}
