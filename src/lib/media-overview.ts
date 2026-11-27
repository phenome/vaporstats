import type { AppDatabase } from "./db";
import { isMediaOverviewPublic, PUBLIC_MEDIA_ROOT_SQL } from "./media-publication";
import { ELIGIBLE_MEDIA_ENTITY_SQL } from "./media-similarity";

export const MEDIA_CATEGORY_NAMES = [
  "Gameplay & systems",
  "Story & world",
  "Visuals & audio",
  "Social play",
  "Technical experience & accessibility",
] as const;

export const PREMISE_FIRST_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v15";
export const RELEASE_GROUNDED_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v16";
export const SHORT_PREMISE_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v17";
export const TRANSFERABLE_BROWSE_TAG_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v28";
export const BROWSE_INDEX_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v32";
export const COMPOUND_BROWSE_TAG_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v29";
export const CONCISE_BROWSE_TAG_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v27";
export const PREVIEW_SCOPE_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v26";
export const TAG_FIRST_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v25";
export const DISCOVERY_TRAIT_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v24";
export const BROWSE_TAG_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v23";
export const ARTICLE_TAG_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v22";
export const CONTROLLER_TAG_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v21";
export const AUTHORED_TAG_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v20";
export const DISCOVERY_LABEL_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v19";
export const TECHNICAL_TIMING_SYNTHESIS_VERSION = "media-synthesis-2026-11-26-v18";

export type MediaCategoryName = (typeof MEDIA_CATEGORY_NAMES)[number];

export interface MediaFinding {
  text: string;
  sourceUrls: string[];
  contested?: boolean;
  edition?: string;
}

export interface MediaOverview {
  appid: number;
  statements: MediaFinding[];
  composedLead?: true;
  categories: Array<{ name: MediaCategoryName; findings: MediaFinding[] }>;
  prosCons: { pros: MediaFinding[]; cons: MediaFinding[] } | null;
  tags: Array<{ label: string; slug: string }>;
}

// Keep paired parentheses at a label boundary, such as the platform in “Aiming (Switch 2)”.
function trimTagDecoration(value: string): string {
  const opens: number[] = [];
  const paired = new Set<number>();
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") opens.push(i);
    if (value[i] === ")" && opens.length) {
      paired.add(opens.pop()!);
      paired.add(i);
    }
  }
  const leading = /^[\p{P}\p{S}]+/u.exec(value)?.[0].length ?? 0;
  const trailing = /[\p{P}\p{S}]+$/u.exec(value)?.index ?? value.length;
  let start = 0;
  let end = value.length;
  while (start < leading && !paired.has(start)) start++;
  while (end > trailing && !paired.has(end - 1)) end--;
  return value.slice(start, end).trim();
}

export function normalizeMediaTag(value: unknown): { label: string; slug: string } | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const label = trimTagDecoration(cleaned);
  if (!label || label.length > 120) return null;
  const slug = label
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug && slug.length <= 120 ? { label, slug } : null;
}

export interface MediaEvidenceSource {
  outlet: string;
  identities: string[];
  current?: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {};
}

const MALFORMED_JSON = Symbol("malformed JSON");

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { return MALFORMED_JSON; }
}

function cleanLine(value: string): string {
  return value.replace(/[\t ]+/g, " ").replace(/\s+([,.;!?])/g, "$1").trim();
}

export const LEGACY_V10_SOURCE_SUPPORT_LANGUAGE = /\b(?:agreement|agreed|agree|assessments?|commonly|consensus|concurred|coverage|critics?|generally|outlets?|publications?|reviews?|reviewers?|sources?|unanimously|universally|widely)\b/i;

const SOURCE_COUNTS = /\b(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|single|each|every|no)\s+(?:article|assessment|critic|outlet|publication|review|reviewer|source)s?\b/i;
const COLLECTIVE_SUPPORT = /\b(?:agreement|agreed|agrees?|articles|assessments|commonly|consensus|concur(?:s|red)?|coverage|critics|generally|outlets|publications|reviews|reviewers|sources|unanimously|universally|widely)\b/i;

export function sourceSupportTrigger(text: string): string | undefined {
  return SOURCE_COUNTS.exec(text)?.[0] ?? COLLECTIVE_SUPPORT.exec(text)?.[0];
}

export function createMediaEvidenceSource(input: {
  outlet: string;
  url: string;
  contentHash?: string | null;
  author?: string | null;
  title?: string | null;
  originatingAssessment?: string | null;
  current?: boolean;
}): MediaEvidenceSource {
  const identities = new Set<string>([`url:${input.url.toLowerCase()}`]);
  if (input.contentHash) identities.add(`content:${input.contentHash}`);
  if (input.author && input.title) {
    identities.add(`byline:${cleanLine(input.author).toLowerCase()}|${cleanLine(input.title).toLowerCase()}`);
  }
  if (input.originatingAssessment) {
    const origin = cleanLine(input.originatingAssessment).toLowerCase();
    try {
      identities.add(`url:${new URL(origin).toString().toLowerCase()}`);
    } catch {
      identities.add(`byline:${origin}`);
    }
  }
  return { outlet: input.outlet, identities: [...identities], ...(input.current === undefined ? {} : { current: input.current }) };
}

function distinctOutletSupport(
  sourceUrls: readonly string[],
  sources: ReadonlyMap<string, MediaEvidenceSource>,
): number {
  const cited = sourceUrls.flatMap((url) => {
    const source = sources.get(url);
    return source ? [source] : [];
  });
  const parent = cited.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  for (let left = 0; left < cited.length; left += 1) {
    for (let right = left + 1; right < cited.length; right += 1) {
      if (!cited[left]!.identities.some((identity) => cited[right]!.identities.includes(identity))) continue;
      const leftRoot = root(left);
      const rightRoot = root(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    }
  }
  const outletSets = new Map<number, Set<string>>();
  cited.forEach((source, index) => {
    const outlets = outletSets.get(root(index)) ?? new Set<string>();
    outlets.add(source.outlet);
    outletSets.set(root(index), outlets);
  });
  const components = [...outletSets.values()];
  const outletOwners = new Map<string, number>();
  const assignOutlet = (componentIndex: number, visited: Set<string>): boolean => {
    for (const outlet of components[componentIndex]!) {
      if (visited.has(outlet)) continue;
      visited.add(outlet);
      const owner = outletOwners.get(outlet);
      if (owner === undefined || assignOutlet(owner, visited)) {
        outletOwners.set(outlet, componentIndex);
        return true;
      }
    }
    return false;
  };
  components.forEach((_, index) => assignOutlet(index, new Set()));
  return outletOwners.size;
}

function parseFinding(value: unknown, sources: ReadonlyMap<string, MediaEvidenceSource>): MediaFinding | null {
  const object = jsonObject(value);
  const text = typeof object.text === "string" ? cleanLine(object.text).slice(0, 1_500) : "";
  const sourceUrls = Array.isArray(object.sourceUrls)
    ? [...new Set(object.sourceUrls.filter((url): url is string => typeof url === "string" && sources.has(url)))]
    : [];
  if (!text || sourceUrls.length === 0) return null;
  if (sourceSupportTrigger(text)) return null;
  const edition = typeof object.edition === "string" ? cleanLine(object.edition).slice(0, 120) : "";
  return { text, sourceUrls, ...(object.contested === true ? { contested: true } : {}), ...(edition ? { edition } : {}) };
}

function parseFindings(value: unknown, sources: ReadonlyMap<string, MediaEvidenceSource>, preserveOrder = false): MediaFinding[] {
  if (!Array.isArray(value)) return [];
  const findings = value.map((item) => parseFinding(item, sources)).filter((finding) => finding !== null);
  if (!preserveOrder) {
    findings.sort((left, right) => distinctOutletSupport(right.sourceUrls, sources) - distinctOutletSupport(left.sourceUrls, sources));
  }
  return findings;
}
export interface MediaTagEvidence {
  tag: { label: string; slug: string };
  sourceUrls: string[];
}

export function parseMediaTagEvidence(
  value: unknown,
  sources: ReadonlyMap<string, MediaEvidenceSource>,
): MediaTagEvidence[] {
  const parsed = jsonObject(parseJson(value));
  if (!Array.isArray(parsed.tags)) return [];
  const bySlug = new Map<string, MediaTagEvidence>();
  for (const item of parsed.tags) {
    const object = jsonObject(item);
    const tag = normalizeMediaTag(object.label);
    const sourceUrls = Array.isArray(object.sourceUrls)
      ? [...new Set(object.sourceUrls.filter((url): url is string => typeof url === "string" && sources.has(url) && sources.get(url)?.current !== false))]
      : [];
    if (!tag || sourceUrls.length === 0) continue;
    const existing = bySlug.get(tag.slug);
    if (existing) {
      existing.sourceUrls = [...new Set([...existing.sourceUrls, ...sourceUrls])];
    } else {
      bySlug.set(tag.slug, { tag, sourceUrls });
    }
  }
  return [...bySlug.values()];
}


async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function rows<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(query).bind(...values).all<T>()).results ?? [];
}
export function parseMediaOverview(
  value: unknown,
  appid: number,
  sources: ReadonlyMap<string, MediaEvidenceSource>,
  configVersion?: string,
): MediaOverview | null {
  const result = validateMediaOverview(value, appid, sources, configVersion);
  return "overview" in result ? result.overview : null;
}

type MediaOverviewValidation =
  | { overview: MediaOverview }
  | { error: "malformed JSON" | "expected a JSON object" | "no cited statements" };

export function validateMediaOverview(
  value: unknown,
  appid: number,
  sources: ReadonlyMap<string, MediaEvidenceSource>,
  configVersion?: string,
): MediaOverviewValidation {
  const parsed = parseJson(value);
  if (parsed === MALFORMED_JSON) return { error: "malformed JSON" };
  if (!isJsonObject(parsed)) return { error: "expected a JSON object" };

  const rawStatements = Array.isArray(parsed.statements)
    ? parsed.statements
    : Array.isArray(jsonObject(parsed.overview).statements)
      ? jsonObject(parsed.overview).statements as unknown[]
      : [];
  const composedLead = configVersion === PREMISE_FIRST_SYNTHESIS_VERSION || configVersion === RELEASE_GROUNDED_SYNTHESIS_VERSION || configVersion === SHORT_PREMISE_SYNTHESIS_VERSION || configVersion === TECHNICAL_TIMING_SYNTHESIS_VERSION || configVersion === DISCOVERY_LABEL_SYNTHESIS_VERSION || configVersion === AUTHORED_TAG_SYNTHESIS_VERSION || configVersion === CONTROLLER_TAG_SYNTHESIS_VERSION || configVersion === ARTICLE_TAG_SYNTHESIS_VERSION || configVersion === BROWSE_TAG_SYNTHESIS_VERSION || configVersion === DISCOVERY_TRAIT_SYNTHESIS_VERSION || configVersion === TAG_FIRST_SYNTHESIS_VERSION || configVersion === PREVIEW_SCOPE_SYNTHESIS_VERSION || configVersion === CONCISE_BROWSE_TAG_SYNTHESIS_VERSION || configVersion === TRANSFERABLE_BROWSE_TAG_SYNTHESIS_VERSION || configVersion === COMPOUND_BROWSE_TAG_SYNTHESIS_VERSION || configVersion === BROWSE_INDEX_SYNTHESIS_VERSION;
  const statements = parseFindings(rawStatements, sources, composedLead);
  if (statements.length === 0) return { error: "no cited statements" };

  const categories: MediaOverview["categories"] = [];
  const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
  for (const name of MEDIA_CATEGORY_NAMES) {
    const category = rawCategories.map(jsonObject).find((item) => item.name === name);
    const findings = parseFindings(category?.findings, sources);
    if (findings.length > 0) categories.push({ name, findings });
  }

  const rawProsCons = jsonObject(parsed.prosCons);
  const pros = parseFindings(rawProsCons.pros, sources);
  const cons = parseFindings(rawProsCons.cons, sources);
  const tags = parseMediaTagEvidence(parsed, sources).map(({ tag }) => tag);
  return {
    overview: {
      appid,
      statements,
      ...(composedLead ? { composedLead: true } : {}),
      categories,
      prosCons: pros.length > 0 || cons.length > 0 ? { pros, cons } : null,
      tags,
    },
  };
}

export async function getMediaOverview(
  db: AppDatabase,
  appid: number,
  options: { includeUnpublished?: boolean } = {},
): Promise<MediaOverview | null> {
  if (!Number.isInteger(appid) || appid <= 0) return null;
  if (!options.includeUnpublished && !isMediaOverviewPublic()) return null;
  const row = await first<{ output_json: string; config_version: string }>(
    db,
    `SELECT overview.output_json, overview.config_version
     FROM media_game_overviews AS overview
     JOIN apps AS app
       ON app.appid = overview.appid
      AND app.is_eligible = 1
      AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
     WHERE overview.appid = ? AND overview.active = 1
       ${options.includeUnpublished ? "" : `AND ${PUBLIC_MEDIA_ROOT_SQL}`}
     ORDER BY overview.id DESC
     LIMIT 1`,
    appid,
  );
  if (!row) return null;
  const sourceRows = await rows<{
    original_url: string;
    outlet: string;
    author: string | null;
    title: string;
    content_hash: string | null;
    output_json: string | null;
  }>(
    db,
    `SELECT source.original_url, source.outlet, source.author, source.title,
            extraction.content_hash, extraction.output_json
     FROM media_sources AS source
     LEFT JOIN media_article_extractions AS extraction
       ON extraction.source_id = source.id AND extraction.active = 1
     WHERE source.appid = ?`,
    appid,
  );
  const sources = new Map(sourceRows.map((source) => {
    const extraction = jsonObject(parseJson(source.output_json));
    return [
      source.original_url,
      createMediaEvidenceSource({
        outlet: source.outlet,
        url: source.original_url,
        contentHash: source.content_hash,
        author: source.author,
        title: source.title,
        originatingAssessment: typeof extraction.originatingAssessment === "string"
          ? extraction.originatingAssessment
          : null,
        current: source.output_json !== null,
      }),
    ];
  }));
  return parseMediaOverview(row.output_json, appid, sources, row.config_version);
}
