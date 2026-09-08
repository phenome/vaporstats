import type { CriticFetchResult, CriticMatchedIdentity, CriticRecord, OpenCriticTier } from "../src/lib/critics";

const OPENCRITIC_HOSTS: Record<string, true> = { "opencritic.com": true, "www.opencritic.com": true };
const OPENCRITIC_GAME_PATH = /^\/game\/(\d+)\/([a-z0-9][a-z0-9-]*)\/?$/i;


export interface OpenCriticIdentity {
  steamAppId?: number | null;
  title?: string | null;
  slug?: string | null;
  providerGameId?: number | null;
}

type OpenCriticFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenCriticFetchOptions {
  sourceUrl: string;
  expected: OpenCriticIdentity & { steamAppId: number };
  fetch?: OpenCriticFetch;
  signal?: AbortSignal;
}

export type OpenCriticErrorCode =
  | "invalid_url"
  | "http_error"
  | "rate_limited"
  | "network_error"
  | "invalid_html"
  | "identity_mismatch";

export interface OpenCriticSourceError {
  ok: false;
  error: OpenCriticErrorCode;
  sourceUrl: string;
  status: number | null;
  rateLimited: boolean;
  retry: false;
  retryAfterSeconds: number | null;
  message: string;
}

export type OpenCriticParseResult =
  | { ok: true; record: CriticRecord }
  | { ok: false; failure: OpenCriticSourceError };

type JsonRecord = Record<string, unknown>;

type PageIdentity = {
  providerGameId: number;
  slug: string;
};

type MetaValues = {
  description: string;
  title: string | null;
  canonicalUrl: string | null;
  score: number | null;
  tier: OpenCriticTier | null;
  reviewCount: number | null;
  percentRecommended: number | null;
};

type StructuredValues = {
  candidate: JsonRecord | null;
  title: string | null;
  slug: string | null;
  providerGameId: number | null;
  steamAppId: number | null;
  platforms: string[] | null;
  edition: string | null;
  score: number | null;
  tier: OpenCriticTier | null;
  reviewCount: number | null;
  percentRecommended: number | null;
  firstReviewDate: string | null;
  latestReviewDate: string | null;
  identityUrl: string | null;
};

function failure(
  sourceUrl: string,
  error: OpenCriticErrorCode,
  message: string,
  status: number | null = null,
  retryAfterSeconds: number | null = null,
): OpenCriticSourceError {
  return {
    ok: false,
    error,
    sourceUrl,
    status,
    rateLimited: error === "rate_limited",
    retry: false,
    retryAfterSeconds,
    message,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function readNumber(record: JsonRecord, keys: string[], integer = false): number | null {
  for (const key of keys) {
    const value = record[key];
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())
          ? Number(value)
          : null;
    if (parsed === null || !Number.isFinite(parsed)) continue;
    if (integer && !Number.isInteger(parsed)) continue;
    return parsed;
  }
  return null;
}

function boundedNumber(value: number | null, min: number, max: number, integer = false): number | null {
  if (value === null || value < min || value > max || (integer && !Number.isInteger(value))) return null;
  return value;
}

function readTier(record: JsonRecord): OpenCriticTier | null {
  const value = readString(record, ["tier", "criticTier", "openCriticTier"]);
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === "weak") return "Weak";
  if (normalized === "fair") return "Fair";
  if (normalized === "strong") return "Strong";
  if (normalized === "mighty") return "Mighty";
  return null;
}

function normalizeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseAttributes(value: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const pattern = /([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (const match of value.matchAll(pattern)) {
    attrs.set(match[1].toLowerCase(), decodeHtml(match[3]));
  }
  return attrs;
}

function parseAllowedPageUrl(value: string): PageIdentity | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || OPENCRITIC_HOSTS[url.hostname.toLowerCase()] !== true) return null;
    if (url.username || url.password) return null;
    const match = url.pathname.match(OPENCRITIC_GAME_PATH);
    if (!match) return null;
    const providerGameId = Number(match[1]);
    const slug = normalizeSlug(decodeURIComponent(match[2]));
    if (!Number.isSafeInteger(providerGameId) || providerGameId <= 0 || !slug) return null;
    return { providerGameId, slug };
  } catch {
    return null;
  }
}

function absoluteUrl(value: string, sourceUrl: string): string | null {
  try {
    const url = new URL(value, sourceUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseCanonicalIdentity(value: string | null, sourceUrl: string): PageIdentity | null {
  if (!value) return null;
  return parseAllowedPageUrl(absoluteUrl(value, sourceUrl) ?? value);
}

function extractMeta(html: string, sourceUrl: string): MetaValues {
  let description = "";
  let title: string | null = null;
  let canonicalUrl: string | null = null;
  const descriptions: Array<{ priority: number; text: string }> = [];
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = parseAttributes(match[1]);
    const name = (attrs.get("name") ?? attrs.get("property") ?? "").toLowerCase();
    const content = attrs.get("content") ?? "";
    if ((name === "description" || name === "og:description" || name === "twitter:description") && content) {
      descriptions.push({ priority: name === "description" ? 1 : 0, text: content });
    }
    if ((name === "og:title" || name === "twitter:title") && content && !title) title = content;
  }
  descriptions.sort((left, right) => left.priority - right.priority || right.text.length - left.text.length);
  description = descriptions[0]?.text ?? "";
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = parseAttributes(match[1]);
    if ((attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
      canonicalUrl = attrs.get("href") ?? null;
      break;
    }
  }
  if (!title) {
    const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    title = titleMatch ? stripTags(titleMatch[1]).replace(/\s*[|–-]\s*OpenCritic\s*$/i, "").replace(/\s+reviews?$/i, "").trim() || null : null;
  }
  if (!title) {
    const headingMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    title = headingMatch ? stripTags(headingMatch[1]) || null : null;
  }

  let score: number | null = null;
  let reviewCount: number | null = null;
  let percentRecommended: number | null = null;
  let tier: OpenCriticTier | null = null;
  for (const candidate of descriptions.map(({ text }) => text)) {
    const scoreMatch = candidate.match(/\b(?:top\s+critic\s+)?(?:score|rating|average)\s*[:\-]?\s*(\d{1,3})(?:\s*\/\s*100)?\b/i);
    const reviewMatch = candidate.match(/\b(?:reviews?|review\s+count)\s*[:\-]?\s*([\d,]+)\b/i);
    const recommendedMatch = candidate.match(/\b(?:recommended|recommendation)(?:\s+by)?\s*[:\-]?\s*(\d{1,3})\s*%?/i) ?? candidate.match(/\b(\d{1,3})\s*%\s*(?:recommended|recommendation)\b/i);
    const tierMatch = candidate.match(/\b(weak|fair|strong|mighty)\b/i);
    score ??= boundedNumber(scoreMatch ? Number(scoreMatch[1]) : null, 0, 100);
    reviewCount ??= boundedNumber(reviewMatch ? Number(reviewMatch[1].replace(/,/g, "")) : null, 0, Number.MAX_SAFE_INTEGER, true);
    percentRecommended ??= boundedNumber(recommendedMatch ? Number(recommendedMatch[1]) : null, 0, 100);
    tier ??= tierMatch ? (tierMatch[1][0].toUpperCase() + tierMatch[1].slice(1).toLowerCase()) as OpenCriticTier : null;
  }
  return {
    description,
    title,
    canonicalUrl,
    score,
    tier,
    reviewCount,
    percentRecommended,
  };
}

function parseBalancedJson(value: string, start: number): string | null {
  const opening = value[start];
  if (opening !== "{" && opening !== "[") return null;
  const closing = opening === "{" ? "}" : "]";
  const stack = [closing];
  let quoted = false;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
    else if (character === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return value.slice(start, index + 1);
    } else if (character === "}" || character === "]") {
      return null;
    }
  }
  return null;
}

function parseScriptJson(value: string): unknown | null {
  const trimmed = value.trim().replace(/;\s*$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Public pages also embed JSON after an assignment such as window.__NEXT_DATA__ = ….
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{" && trimmed[index] !== "[") continue;
    const candidate = parseBalancedJson(trimmed, index);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Keep looking for the next balanced object in this script.
    }
  }
  return null;
}

function extractStructuredJson(html: string): unknown[] {
  const payloads: unknown[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = parseAttributes(match[1]);
    const type = (attrs.get("type") ?? "").toLowerCase();
    const id = (attrs.get("id") ?? "").toLowerCase();
    if (type !== "application/ld+json" && type !== "application/json" && !id.includes("next_data") && !id.includes("initial_state")) continue;
    const payload = parseScriptJson(match[2]);
    if (payload !== null) payloads.push(payload);
  }
  return payloads;
}

function collectRecords(value: unknown, records: JsonRecord[], depth = 0): void {
  if (depth > 12 || records.length > 2000) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, records, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  records.push(value);
  for (const child of Object.values(value)) collectRecords(child, records, depth + 1);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function candidateRank(record: JsonRecord): number {
  let rank = 0;
  if (record["@type"] === "VideoGame") rank += 20;
  if (typeof record.url === "string" && /\/game\/\d+\//i.test(record.url)) rank += 10;
  if (["topCriticScore", "score", "criticScore", "ratingValue"].some((key) => hasOwn(record, key))) rank += 4;
  if (["percentRecommended", "recommendationPercent", "percent_recommended"].some((key) => hasOwn(record, key))) rank += 4;
  if (["numReviews", "reviewCount", "numberOfReviews", "review_count"].some((key) => hasOwn(record, key))) rank += 4;
  if (["tier", "criticTier", "openCriticTier"].some((key) => hasOwn(record, key))) rank += 3;
  if (["name", "title"].some((key) => hasOwn(record, key))) rank += 2;
  if (["slug", "steamId", "steamAppId", "steamAppID", "opencriticId", "openCriticId"].some((key) => hasOwn(record, key))) rank += 2;
  if (["platforms", "platformRecords", "availablePlatforms", "gamePlatform", "operatingSystem"].some((key) => hasOwn(record, key))) rank += 1;
  return rank;
}

function findCandidate(payloads: unknown[]): JsonRecord | null {
  const records: JsonRecord[] = [];
  for (const payload of payloads) collectRecords(payload, records);
  let selected: JsonRecord | null = null;
  let bestRank = 0;
  for (const record of records) {
    const rank = candidateRank(record);
    if (rank > bestRank) {
      bestRank = rank;
      selected = record;
    }
  }
  return selected;
}

function nestedAggregate(record: JsonRecord): JsonRecord | null {
  for (const key of ["aggregateRating", "rating", "criticScore"]) {
    if (isRecord(record[key])) return record[key];
  }
  return null;
}

function readAggregateNumber(record: JsonRecord, keys: string[], min: number, max: number, integer = false): number | null {
  const aggregate = nestedAggregate(record);
  return boundedNumber(readNumber(record, keys) ?? (aggregate ? readNumber(aggregate, keys) : null), min, max, integer);
}

function readAggregateString(record: JsonRecord, keys: string[]): string | null {
  const aggregate = nestedAggregate(record);
  return readString(record, keys) ?? (aggregate ? readString(aggregate, keys) : null);
}

function readAggregateTier(record: JsonRecord): OpenCriticTier | null {
  const aggregate = nestedAggregate(record);
  return readTier(record) ?? (aggregate ? readTier(aggregate) : null);
}

function validDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:[Tt][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.\d{1,3})?)?(?:[Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : value;
}

function collectPlatforms(record: JsonRecord): string[] | null {
  const raw = record.platforms ?? record.platformRecords ?? record.availablePlatforms ?? record.platform ?? record.gamePlatform ?? record.operatingSystem;
  const values: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (text && !values.some((existing) => existing.toLowerCase() === text.toLowerCase())) values.push(text);
      return;
    }
    if (isRecord(value)) {
      for (const key of ["name", "platform", "displayName", "slug", "abbreviation"]) {
        const text = nonEmptyString(value[key]);
        if (text) {
          add(text);
          return;
        }
      }
    }
  };
  if (Array.isArray(raw)) raw.forEach(add);
  else if (isRecord(raw)) {
    Object.entries(raw).forEach(([key, value]) => {
      add(value);
      add(key);
    });
  }
  else add(raw);
  return values.length ? values : null;
}

function extractIdentityUrl(record: JsonRecord): string | null {
  return readString(record, ["canonicalUrl", "canonical_url", "url", "opencriticUrl", "openCriticUrl"]);
}

function extractStructured(html: string, sourceUrl: string): StructuredValues {
  const candidate = findCandidate(extractStructuredJson(html));
  if (!candidate) {
    return {
      candidate: null,
      title: null,
      slug: null,
      providerGameId: null,
      steamAppId: null,
      platforms: null,
      edition: null,
      score: null,
      tier: null,
      reviewCount: null,
      percentRecommended: null,
      firstReviewDate: null,
      latestReviewDate: null,
      identityUrl: null,
    };
  }
  const aggregate = nestedAggregate(candidate);
  const providerGameId = boundedNumber(readNumber(candidate, ["opencriticId", "openCriticId", "gameId", "opencritic_game_id", "id"], true), 1, Number.MAX_SAFE_INTEGER, true);
  const steamAppId = boundedNumber(readNumber(candidate, ["steamId", "steamAppId", "steamAppID", "steam_appid", "appid", "appId"], true), 1, Number.MAX_SAFE_INTEGER, true);
  const firstReviewDate = validDate(readString(candidate, ["firstReviewDate", "first_review_date", "reviewPeriodStart", "review_period_start"]));
  const latestReviewDate = validDate(readString(candidate, ["latestReviewDate", "latest_review_date", "reviewPeriodEnd", "review_period_end"]));
  return {
    candidate,
    title: readAggregateString(candidate, ["name", "title"]),
    slug: readAggregateString(candidate, ["slug", "pathSlug", "urlSlug"]),
    providerGameId,
    steamAppId,
    platforms: collectPlatforms(candidate),
    edition: readAggregateString(candidate, ["edition", "editionName", "productEdition"]),
    score: readAggregateNumber(candidate, ["topCriticScore", "score", "criticScore", "ratingValue"], 0, 100),
    tier: readAggregateTier(candidate),
    reviewCount: readAggregateNumber(candidate, ["numReviews", "reviewCount", "numberOfReviews", "review_count", "reviewCountTotal"], 0, Number.MAX_SAFE_INTEGER, true),
    percentRecommended: readAggregateNumber(candidate, ["percentRecommended", "recommendationPercent", "percent_recommended", "recommended"], 0, 100),
    firstReviewDate,
    latestReviewDate,
    identityUrl: extractIdentityUrl(candidate) ?? (aggregate ? extractIdentityUrl(aggregate) : null),
  };
}

function compareIdentity(
  page: PageIdentity,
  title: string | null,
  steamAppId: number | null,
  canonical: PageIdentity | null,
  structured: StructuredValues,
  expected: OpenCriticIdentity,
): { matched: CriticMatchedIdentity | null; valid: boolean } {
  const providerGameId = expected.providerGameId == null || page.providerGameId === expected.providerGameId;
  const slug = expected.slug == null || page.slug === normalizeSlug(expected.slug);
  const titleMatch = expected.title == null ? title !== null : title !== null && normalizeTitle(title) === normalizeTitle(expected.title);
  const steamAppIdMatch = expected.steamAppId !== null && expected.steamAppId !== undefined && steamAppId === expected.steamAppId;
  const canonicalMatch = canonical === null || (canonical.providerGameId === page.providerGameId && canonical.slug === page.slug);
  const structuredMatch = structured.providerGameId === null || structured.providerGameId === page.providerGameId;
  const structuredSlugMatch = structured.slug === null || normalizeSlug(structured.slug) === page.slug;
  const steamCrossReferenceMismatch = structured.steamAppId !== null && !steamAppIdMatch;
  const valid = providerGameId && slug && titleMatch && canonicalMatch && structuredMatch && structuredSlugMatch && !steamCrossReferenceMismatch;
  return {
    valid,
    matched: valid && steamAppIdMatch && expected.steamAppId !== null && expected.steamAppId !== undefined && title
      ? {
          steamAppId: expected.steamAppId,
          platformScope: "mixed",
          edition: structured.edition ?? "",
          evidence: canonical ? "canonical_url" : structuredIdentityEvidence(structured),
        }
      : null,
  };
}

function structuredIdentityEvidence(structured: StructuredValues): string {
  return structured.identityUrl ? "structured_url" : "source_url_slug";
}

function visiblePageTier(html: string): OpenCriticTier | null {
  const sourceMatch = html.match(/mighty-man\/(weak|fair|strong|mighty)-man/i);
  const altMatch = html.match(/<img\b[^>]*\balt=["'](weak|fair|strong|mighty)["']/i);
  const value = sourceMatch?.[1] ?? altMatch?.[1];
  return value ? (value[0].toUpperCase() + value.slice(1).toLowerCase()) as OpenCriticTier : null;
}

export function parseOpenCriticAggregate(
  html: string,
  sourceUrl: string,
  expected: OpenCriticIdentity = {},
): OpenCriticParseResult {
  const page = parseAllowedPageUrl(sourceUrl);
  if (!page) return { ok: false, failure: failure(sourceUrl, "invalid_url", "Only an HTTPS OpenCritic game page URL is allowed") };
  if (!html.trim()) {
    return { ok: false, failure: failure(sourceUrl, "invalid_html", "OpenCritic returned an empty page") };
  }

  const meta = extractMeta(html, sourceUrl);
  const canonical = parseCanonicalIdentity(meta.canonicalUrl, sourceUrl);
  if (meta.canonicalUrl && !canonical) {
    return { ok: false, failure: failure(sourceUrl, "identity_mismatch", "OpenCritic canonical URL is not an allowed game page") };
  }
  const structured = extractStructured(html, sourceUrl);
  const structuredIdentity = parseCanonicalIdentity(structured.identityUrl, sourceUrl);
  if (structured.identityUrl && !structuredIdentity) {
    return { ok: false, failure: failure(sourceUrl, "identity_mismatch", "OpenCritic structured identity is not an allowed game page") };
  }
  const title = structured.title ?? meta.title;
  if (!title && !canonical && !structuredIdentity) {
    return { ok: false, failure: failure(sourceUrl, "invalid_html", "OpenCritic page contains no verifiable game identity") };
  }
  const identity = compareIdentity(page, title, structured.steamAppId, canonical ?? structuredIdentity, structured, expected);
  const steamAppId = expected.steamAppId;
  if (!identity.valid || steamAppId == null) {
    return { ok: false, failure: failure(sourceUrl, "identity_mismatch", "OpenCritic page identity does not match the requested game") };
  }

  const score = structured.score ?? meta.score;
  const tier = structured.tier ?? meta.tier ?? visiblePageTier(html);
  const reviewCount = structured.reviewCount ?? meta.reviewCount;
  const percentRecommended = structured.percentRecommended ?? meta.percentRecommended;
  const observedAt = new Date().toISOString();
  const record: CriticRecord = {
    source: "opencritic",
    sourceUrl,
    sourceId: String(page.providerGameId),
    steamAppId,
    title: title as string,
    slug: page.slug,
    edition: structured.edition ?? "",
    platforms: structured.platforms ?? [],
    platformScope: "mixed",
    score,
    tier,
    reviewCount,
    percentRecommended,
    reviewPeriodStart: structured.firstReviewDate,
    reviewPeriodEnd: structured.latestReviewDate,
    observedAt,
    collectionBasis: "public_page",
    matchedIdentity: identity.matched,
    identityVerified: identity.matched !== null,
    cadence: "monthly",
  };
  return { ok: true, record };
}

export async function fetchOpenCriticAggregate(options: OpenCriticFetchOptions): Promise<CriticFetchResult> {
  const page = parseAllowedPageUrl(options.sourceUrl);
  if (!page || options.expected.steamAppId == null) {
    return { status: "missing", error: "identity_missing", httpStatus: null };
  }
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(options.sourceUrl, {
      redirect: "manual",
      signal: options.signal,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : "network_error", httpStatus: null };
  }
  if (response.status === 429) {
    return { status: "rate_limited", error: "rate_limited", httpStatus: 429 };
  }
  if (!response.ok) {
    return {
      status: response.status === 404 ? "missing" : "error",
      error: "http_" + response.status,
      httpStatus: response.status,
    };
  }
  const responseUrl = response.url || options.sourceUrl;
  const responsePage = parseAllowedPageUrl(responseUrl);
  if (!responsePage || responsePage.providerGameId !== page.providerGameId || responsePage.slug !== page.slug) {
    return { status: "missing", error: "identity_mismatch", httpStatus: response.status };
  }
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : "response_body_failed", httpStatus: response.status };
  }
  const parsed = parseOpenCriticAggregate(html, options.sourceUrl, options.expected);
  if (!parsed.ok) {
    return {
      status: parsed.failure.error === "rate_limited" ? "rate_limited" : "missing",
      error: parsed.failure.message,
      httpStatus: parsed.failure.status,
    };
  }
  return { status: "ok", record: parsed.record };
}
