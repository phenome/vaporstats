import type { MediaOutlet } from "./media-outlet-access";

export type WrittenPreviewEvidence = "observed_demo" | "developer_interview" | "observed_demo_and_developer_interview";

/** Read article metadata before cleanup removes JSON-LD scripts. */
export function writtenArticleMetadata(document: Document) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const entries = Array.isArray(data) ? data : Array.isArray(data?.["@graph"]) ? data["@graph"] : [data];
    const article = entries.find((entry) => ["Article", "NewsArticle", "BlogPosting"].includes(entry?.["@type"]));
    if (!article) continue;
    const authors = (Array.isArray(article.author) ? article.author : [article.author])
      .flatMap((author: { name?: unknown } | null) => typeof author?.name === "string" && author.name.trim() ? [author.name.trim()] : []);
    return { author: authors.join(", ") || null, publishedAt: article.datePublished, updatedAt: article.dateModified };
  }
  return null;
}

const INTERVIEW_CREDIT: Partial<Record<MediaOutlet, RegExp>> = {
  "Game Informer": /\binterview with Game Informer\b/i,
  "RPG Site": /\binterview with RPG Site\b/i,
  "TechRadar Gaming": /\binterview with TechRadar(?: Gaming)?\b/i,
};
const FIRST_PERSON_INTERVIEW = /\b(?:in our interview|(?:I|we) (?:interviewed|spoke (?:with|to)))\b/i;

export function writtenPreviewEvidence(outlet: MediaOutlet, title: string, body: string) {
  // Exclude quoted first-person accounts when looking for what the journalist did.
  const withoutQuotes = (text: string) => text.replace(/“[^”]*”|"[^"]*"|‘.*?’(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])'.*?'(?![\p{L}\p{N}])/gu, " ");
  const lead = withoutQuotes(body).slice(0, 4_000);
  const headline = withoutQuotes(title);
  const context = `${headline} ${lead}`;
  const observedDemo = /\bhands?[- ]off (?:preview|demo(?:nstration)?)\b/i.test(context)
    || (/\bdemo(?:nstration)?\b/i.test(context)
      && /\b(?:I|we) (?:watch(?:ed)?|observ(?:e|ed))\b.{0,100}\b(?:gameplay|demo)\b|\b(?:gameplay|demo) (?:I|we) (?:watch(?:ed)?|observ(?:e|ed))\b/i.test(lead));
  const developerInterview = (INTERVIEW_CREDIT[outlet]?.test(lead) || FIRST_PERSON_INTERVIEW.test(lead)) && /\b(?:developer|development team|studio head|studios head|director|producer|designer|co-founder)\b/i.test(lead);
  const evidence: WrittenPreviewEvidence | null = observedDemo && developerInterview ? "observed_demo_and_developer_interview"
    : observedDemo ? "observed_demo" : developerInterview ? "developer_interview" : null;
  const handsOn = /\bhands?[- ]on (?:preview|impressions|session)\b/i.test(headline)
    && !/\b(?:not|non|no)[- ](?:an? )?hands?[- ]on\b/i.test(headline)
    || /\b(?:I|we) (?:played(?! with\b)|went hands?[- ]on|got to play)\b/i.test(lead);
  return { evidence, handsOn };
}
