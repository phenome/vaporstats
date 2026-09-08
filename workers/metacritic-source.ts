import type { CriticFetchResult, CriticMatchedIdentity, CriticRecord } from "../src/lib/critics";

const ALLOWED_METACRITIC_HOSTS: Record<string, true> = {
  "www.metacritic.com": true,
  "metacritic.com": true,
};
const METACRITIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLATFORM_NAMES: Record<string, string> = {
  pc: "pc",
  windows: "pc",
  "microsoft windows": "pc",
  ps5: "ps5",
  "playstation 5": "ps5",
  ps4: "ps4",
  "playstation 4": "ps4",
  xbox: "xbox",
  "xbox series": "xbox",
  "xbox series x": "xbox",
  "xbox series s": "xbox",
  "xbox one": "xbox-one",
  switch: "switch",
  "nintendo switch": "switch",
  ios: "ios",
  android: "android",
};

export interface MetacriticExpectedIdentity {
  title: string;
  edition?: string | null;
  releaseYear?: number | null;
  steamAppId: number;
  observedAt?: string | Date;
  cadence?: "weekly" | "monthly";
}

export interface MetacriticFetchOptions extends MetacriticExpectedIdentity {
  metacriticUrl?: string | null;
  metacritic?: { url?: string | null } | null;
  sourceUrl?: string | null;
}

interface CanonicalUrl {
  url: string;
  slug: string;
}

interface AggregateCandidate {
  score: number | null;
  reviewCount: number | null;
  platform: string | null;
  title: string | null;
  edition: string | null;
  releaseYear: number | null;
  firstReviewDate: string | null;
  latestReviewDate: string | null;
}

interface ParsedPage {
  title: string | null;
  edition: string | null;
  releaseYear: number | null;
  platforms: string[];
  hasConsoleAggregate: boolean;
  candidate: AggregateCandidate | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => String.fromCodePoint(parseInt(digits, 16)))
    .replace(/&([a-z]+);/gi, (_, name: string) => named[name.toLowerCase()] ?? `&${name};`);
}

function normalizeTitle(value: string): string {
  return decodeHtml(value)
    .replace(/\s*[|–—-]\s*metacritic\s*$/i, "")
    .replace(/\s+(?:critic\s+)?reviews?\s*$/i, "")
    .replace(/\s+for\s+(?:pc|windows)\s*$/i, "")
    .replace(/\s*[-|]\s*(?:pc|windows)\s*$/i, "")
    .replace(/[™®©]/g, "")
    .toLocaleLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanPageTitle(value: string): string {
  return decodeHtml(value)
    .replace(/\s*[|–—-]\s*metacritic\s*$/i, "")
    .replace(/\s+(?:critic\s+)?reviews?\s*$/i, "")
    .replace(/\s+for\s+(?:pc|windows)\s*$/i, "")
    .replace(/\s*[-|]\s*(?:pc|windows)\s*$/i, "")
    .replace(/\s+(?:pc|windows)\s*$/i, "")
    .trim();
}

function inferEdition(title: string | null): string | null {
  if (!title) return null;
  const match = title.match(
    /\b(complete edition|game of the year edition|goty edition|definitive edition|deluxe edition|remastered|remaster|remake|director(?:'s|’s) cut|expansion|dlc)\b/i
  );
  return match?.[1]?.replace(/[’]/g, "'").toLowerCase() ?? null;
}

function normalizePlatform(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  return PLATFORM_NAMES[normalized] ?? null;
}

function extractNumber(value: unknown, maximum: number): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(value.trim())) return null;
  const trimmed = value.trim();
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : trimmed;
}

function yearFromValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1900 && value <= 2200 ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = value.match(/\b(19\d{2}|20\d{2}|21\d{2}|22\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function scriptContents(html: string): string[] {
  const scripts: string[] = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) scripts.push(match[1]);
  return scripts;
}

function jsonScripts(html: string): unknown[] {
  const values: unknown[] = [];
  for (const script of scriptContents(html)) {
    const trimmed = script.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      // A page can contain unrelated JavaScript; malformed data is ignored.
    }
  }
  return values;
}

function valueForKeys(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function titleFromMetadata(html: string, values: unknown[]): string | null {
  const metadata = html.match(
    /<meta\b[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']+)["'][^>]*>/i
  ) ?? html.match(
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*>/i
  );
  if (metadata?.[1]) return cleanPageTitle(metadata[1]);
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag?.[1]) return cleanPageTitle(titleTag[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (heading?.[1]) return cleanPageTitle(heading[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  for (const value of values) {
    const record = asRecord(value);
    const candidate = record && valueForKeys(record, ["name", "title", "productTitle"]);
    if (typeof candidate === "string" && candidate.trim()) return cleanPageTitle(candidate);
  }
  return null;
}

function candidateFromRecord(
  record: Record<string, unknown>,
  context: string,
  inheritedPlatform: string | null,
  inheritedYear: number | null,
  allPlatforms: Set<string>,
  candidates: AggregateCandidate[]
): void {
  const platformValue = valueForKeys(record, ["platform", "platformName", "selectedPlatform", "platform_name"]);
  const platform = normalizePlatform(platformValue) ?? inheritedPlatform;
  if (platform) allPlatforms.add(platform);
  const platformList = valueForKeys(record, ["platforms", "availablePlatforms", "available_platforms"]);
  if (Array.isArray(platformList)) {
    for (const item of platformList) {
      const itemPlatform = normalizePlatform(typeof item === "string" ? item : asRecord(item)?.name);
      if (itemPlatform) allPlatforms.add(itemPlatform);
    }
  }
  const lowerContext = context.toLocaleLowerCase();
  const recordName = valueForKeys(record, ["name"]);
  const metascoreNamed = typeof recordName === "string" && /metascore/i.test(recordName);
  const scoreValue = valueForKeys(record, ["metascore", "metaScore", "criticScore", "critic_score"]);
  const genericScore = valueForKeys(record, ["score", "ratingValue"]);
  const score = extractNumber(
    scoreValue !== undefined || metascoreNamed || lowerContext.includes("critic") || lowerContext.includes("metascore") || lowerContext.includes("aggregate")
      ? scoreValue ?? genericScore
      : undefined,
    100
  );
  const countValue = valueForKeys(record, ["criticReviewCount", "criticReviewsCount", "critic_review_count"]);
  const genericCount = valueForKeys(record, ["reviewCount", "ratingCount", "totalReviews"]);
  const reviewCount = extractNumber(
    countValue !== undefined || metascoreNamed || lowerContext.includes("critic") || lowerContext.includes("metascore") || lowerContext.includes("aggregate")
      ? countValue ?? genericCount
      : undefined,
    Number.MAX_SAFE_INTEGER
  );
  const hasAggregateValue = score !== null || reviewCount !== null;
  if (!hasAggregateValue) return;
  const firstReviewDate = parseDate(
    valueForKeys(record, ["firstReviewDate", "reviewPeriodStart"])
  );
  const latestReviewDate = parseDate(
    valueForKeys(record, ["latestReviewDate", "reviewPeriodEnd"])
  );
  const titleValue = valueForKeys(record, ["title", "name", "productTitle"]);
  const editionValue = valueForKeys(record, ["edition", "editionName", "edition_name"]);
  const yearValue = valueForKeys(record, ["releaseYear", "release_year", "releaseDate"]);
  candidates.push({
    score,
    reviewCount,
    platform,
    title: typeof titleValue === "string" ? cleanPageTitle(titleValue) : null,
    edition: typeof editionValue === "string" ? editionValue.trim() || null : null,
    releaseYear: yearFromValue(yearValue) ?? inheritedYear,
    firstReviewDate,
    latestReviewDate,
  });
}

function parseEmbeddedAggregate(values: unknown[]): {
  candidate: AggregateCandidate | null;
  platforms: string[];
  hasConsoleAggregate: boolean;
} {
  const candidates: AggregateCandidate[] = [];
  const platforms = new Set<string>();
  function visit(value: unknown, context: string, inheritedPlatform: string | null, inheritedYear: number | null): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, context, inheritedPlatform, inheritedYear);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const platformValue = valueForKeys(record, ["platform", "platformName", "selectedPlatform", "platform_name"]);
    const platform = normalizePlatform(platformValue) ?? inheritedPlatform;
    const year = yearFromValue(valueForKeys(record, ["releaseYear", "release_year", "releaseDate"])) ?? inheritedYear;
    candidateFromRecord(record, context, platform, year, platforms, candidates);
    for (const [key, child] of Object.entries(record)) {
      visit(child, `${context}.${key}`, platform, year);
    }
  }
  for (const value of values) visit(value, "", null, null);
  const hasConsoleAggregate = candidates.some(
    (candidate) => candidate.platform !== null && candidate.platform !== "pc" && (candidate.score !== null || candidate.reviewCount !== null)
  );
  const pcCandidates = candidates.filter((candidate) => candidate.platform === "pc");
  const unscopedCandidates = candidates.filter((candidate) => candidate.platform === null);
  const candidate = pcCandidates[0] ?? unscopedCandidates[0] ?? null;
  return { candidate, platforms: [...platforms], hasConsoleAggregate };
}

function visibleText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

function parseMarkupAggregate(html: string): AggregateCandidate | null {
  const reviewListStart = html.search(/class=["'][^"']*\bproduct-reviews-list\b/i);
  const aggregateHtml = reviewListStart >= 0 ? html.slice(0, reviewListStart) : html;
  const text = visibleText(aggregateHtml);
  const scoreMatch = text.match(/\bmetascore\b\s*:?\s*(\d{1,3})\b/i)
    ?? text.match(/(\d{1,3})\s+\bmetascore\b/i)
    ?? aggregateHtml.match(/(?:title|aria-label)=["']Metascore\s+(\d{1,3})\s+out\s+of\s+100["']/i);
  const countText = visibleText(html);
  const countMatch = countText.match(/\bshowing\s+(\d[\d,]*)\s+critic\s+reviews?\b/i);
  const score = extractNumber(scoreMatch?.[1], 100);
  const reviewCount = extractNumber(countMatch?.[1], Number.MAX_SAFE_INTEGER);
  if (score === null && reviewCount === null) return null;
  return {
    score,
    reviewCount,
    platform: null,
    title: null,
    edition: null,
    releaseYear: null,
    firstReviewDate: null,
    latestReviewDate: null,
  };
}

function canonicalMetacriticUrl(rawUrl: string, requireCriticPage = false): CanonicalUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    ALLOWED_METACRITIC_HOSTS[parsed.hostname.toLocaleLowerCase()] !== true ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return null;
  }
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (segments[0]?.toLocaleLowerCase() !== "game") return null;
  const hasPcSegment = segments[1]?.toLocaleLowerCase() === "pc";
  const slug = hasPcSegment ? segments[2] : segments[1];
  const remainder = hasPcSegment ? segments.slice(3) : segments.slice(2);
  if (!slug || !METACRITIC_SLUG.test(slug) || (remainder.length > 1 || (remainder[0] && remainder[0].toLocaleLowerCase() !== "critic-reviews")) || (requireCriticPage && remainder.length !== 1)) {
    return null;
  }
  const platformValues = parsed.searchParams.getAll("platform");
  if (platformValues.length > 1 || (platformValues[0] && platformValues[0].toLocaleLowerCase() !== "pc")) return null;
  const canonical = new URL(`https://www.metacritic.com/game/${slug.toLocaleLowerCase()}/critic-reviews/`);
  canonical.searchParams.set("platform", "pc");
  return { url: canonical.href, slug: slug.toLocaleLowerCase() };
}

function normalizedObservedAt(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return new Date().toISOString();
}

function expectedAppId(expected: MetacriticExpectedIdentity): number | null {
  const value = expected.steamAppId;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function expectedYear(expected: MetacriticExpectedIdentity): number | null {
  const value = expected.releaseYear;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parsePage(html: string): ParsedPage {
  const values = jsonScripts(html);
  const embedded = parseEmbeddedAggregate(values);
  const markupCandidate = parseMarkupAggregate(html);
  const candidate = embedded.candidate ?? markupCandidate;
  const metadataTitle = titleFromMetadata(html, values);
  const title = metadataTitle ?? candidate?.title ?? null;
  const edition = candidate?.edition ?? inferEdition(title);
  return {
    title,
    edition,
    releaseYear: candidate?.releaseYear ?? null,
    platforms: embedded.platforms,
    hasConsoleAggregate: embedded.hasConsoleAggregate,
    candidate,
  };
}

function failure(
  status: "missing" | "error" | "rate_limited",
  error: string,
  httpStatus: number | null
): CriticFetchResult {
  return { status, error, httpStatus };
}

export function parseMetacriticAggregate(
  html: string,
  sourceUrl: string,
  expected: MetacriticExpectedIdentity
): CriticRecord | null {
  if (typeof html !== "string" || !expected?.title) return null;
  const canonical = canonicalMetacriticUrl(sourceUrl);
  if (!canonical) return null;
  const page = parsePage(html);
  const candidate = page.candidate;
  if (!candidate || !page.title || normalizeTitle(page.title) !== normalizeTitle(expected.title)) return null;
  const expectedEdition = expected.edition ?? inferEdition(expected.title);
  const sourceEdition = page.edition ?? inferEdition(page.title);
  const canonicalEdition = sourceEdition ?? "";
  if (page.platforms.length > 0 && !page.platforms.includes("pc")) return null;
  if (candidate.platform && candidate.platform !== "pc") return null;
  const requiredYear = expectedYear(expected);
  if (requiredYear !== null && page.releaseYear !== null && page.releaseYear !== requiredYear) return null;
  const releaseYearMatch = requiredYear === null || page.releaseYear === null ? null : page.releaseYear === requiredYear;
  const mixedPlatform = page.hasConsoleAggregate && !candidate.platform && page.platforms.length > 1;
  const editionMatch = expectedEdition === null
    ? sourceEdition === null
    : Boolean(sourceEdition && normalizeTitle(sourceEdition) === normalizeTitle(expectedEdition));
  const evidence = ["steam_appdetails_metacritic_url", "exact_title", "pc_platform"];
  if (editionMatch) evidence.push("exact_edition");
  if (releaseYearMatch === true) evidence.push("exact_release_year");
  if (mixedPlatform || !editionMatch) return null;
  const appid = expectedAppId(expected);
  if (appid === null) return null;
  const identity: CriticMatchedIdentity | null = sourceEdition === null
    ? null
    : {
        steamAppId: appid,
        platformScope: "pc",
        edition: canonicalEdition,
        evidence: evidence.join("; "),
      };
  const observedAt = normalizedObservedAt(expected.observedAt);
  const firstReviewDate = candidate.firstReviewDate;
  const latestReviewDate = candidate.latestReviewDate;
  const platforms = page.platforms.length > 0 ? page.platforms : ["pc"];
  const sourceId = canonical.slug;
  const record: CriticRecord = {
    source: "metacritic",
    sourceUrl: canonical.url,
    sourceId,
    steamAppId: appid,
    title: page.title,
    slug: canonical.slug,
    edition: canonicalEdition,
    platforms,
    platformScope: "pc",
    score: candidate.score,
    tier: null,
    reviewCount: candidate.reviewCount,
    percentRecommended: null,
    collectionBasis: "public_page",
    matchedIdentity: identity,
    reviewPeriodStart: firstReviewDate,
    reviewPeriodEnd: latestReviewDate,
    identityVerified: identity !== null,
    observedAt,
    cadence: expected.cadence ?? "weekly",
  };
  return record;
}

function inputUrl(options: MetacriticFetchOptions): string | null {
  return options.metacriticUrl ?? options.metacritic?.url ?? options.sourceUrl ?? null;
}

export async function fetchMetacriticAggregate(
  options: MetacriticFetchOptions,
  customFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): Promise<CriticFetchResult> {
  const source = inputUrl(options);
  const canonical = source ? canonicalMetacriticUrl(source) : null;
  if (!canonical) return failure("missing", "No safe Steam Metacritic PC URL", null);
  const fetcher = customFetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(canonical.url, {
      headers: { accept: "text/html" },
      redirect: "follow",
    });
  } catch (error) {
    const status = asRecord(error)?.status;
    if (status === 429) return failure("rate_limited", "Metacritic returned HTTP 429", 429);
    return failure("error", error instanceof Error ? error.message : "Metacritic request failed", null);
  }
  if (response.status === 429) return failure("rate_limited", "Metacritic returned HTTP 429", 429);
  if (!response.ok) {
    return failure(response.status === 404 ? "missing" : "error", `Metacritic returned HTTP ${response.status}`, response.status);
  }
  const finalUrl = response.url || canonical.url;
  const finalCanonical = canonicalMetacriticUrl(finalUrl, true);
  if (!finalCanonical || finalCanonical.slug !== canonical.slug) {
    return failure("error", "Metacritic redirect changed game identity", null);
  }
  let html: string;
  try {
    html = await response.text();
  } catch {
    return failure("error", "Metacritic response body could not be read", null);
  }
  const record = parseMetacriticAggregate(html, finalCanonical.url, options);
  return record
    ? { status: "ok", record }
    : failure("missing", "Metacritic page has no verified PC critic aggregate", null);
}
