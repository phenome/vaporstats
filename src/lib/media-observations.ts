import { LEGACY_V10_SOURCE_SUPPORT_LANGUAGE, MEDIA_CATEGORY_NAMES, normalizeMediaTag, sourceSupportTrigger } from "./media-overview";

const kinds = ["finding", "pro", "con", "tag", "gameplay", "storyWorld"] as const;
type ObservationKind = (typeof kinds)[number];
const categoryNames = new Set<string>(MEDIA_CATEGORY_NAMES);

export interface MediaObservation {
  id: string;
  appid: number;
  kind: ObservationKind;
  category: string;
  text: string;
  qualifiers: string[];
}

export interface ObservationSource {
  sourceIdentity: string;
  sourceUrl: string;
  observations: MediaObservation[];
}

export interface ObservationReference {
  sourceIdentity: string;
  observationId: string;
}

export interface EditorialOmission extends ObservationReference {
  question: string;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : "";
}

function contains(text: string, fragment: string): boolean {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function matchesRequestedApp(subject: unknown, appid: number): boolean {
  return subject === appid || subject === String(appid);
}

function observation(value: unknown, appid: number): MediaObservation | null {
  const { id, appid: subject, kind, category, text, qualifiers } = object(value);
  if (!matchesRequestedApp(subject, appid) || typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  if (!kinds.includes(kind as ObservationKind)) return null;
  if (typeof category !== "string" || (kind === "finding" ? !categoryNames.has(category) : category !== "")) return null;
  const label = line(text, 600);
  if (!label || !Array.isArray(qualifiers) || qualifiers.length > 6) return null;
  const scope = qualifiers.map((value) => line(value, 120));
  if (scope.some((value) => !value)) return null;
  return { id, appid, kind: kind as ObservationKind, category, text: label, qualifiers: [...new Set(scope)] };
}

export function extractionReviewIssues(
  value: unknown, appid: number, sourceIdentity: string, observations: readonly MediaObservation[],
  article: string, context: readonly (string | null)[],
): EditorialOmission[] {
  const body = line(article, Number.MAX_SAFE_INTEGER);
  const accepted = new Set(observations.map(({ id }) => id));
  return list(object(value).observations).slice(0, 60).flatMap((entry) => {
    const { id, appid: subject, reviewQuestion } = object(entry);
    if (!matchesRequestedApp(subject, appid) || typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || accepted.has(id)) return [];
    const candidate = observation(entry, appid);
    const reason = candidate
      ? rejectedArticleEvidence(candidate, object(entry), body, context, false) ?? "observation ID is duplicated"
      : "observation lacks a valid kind, category, text or qualification";
    const question = line(reviewQuestion, 240) || `What wording and scope does the article support? ${reason}.`;
    return [{ sourceIdentity, observationId: id, question }];
  });
}

const BUILD_SCOPE_MARKER = /\b(?:early access|at (?:PC )?launch|preview build|press build|day[- ]\d+ patch|patch \d+(?:\.\d+)*|Switch 2 port|announced|planned)\b/gi;

function articleObservations(value: unknown, appid: number, check: (item: MediaObservation, raw: unknown) => boolean): MediaObservation[] {
  const raw = list(object(value).observations);
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  const result: MediaObservation[] = [];
  for (const entry of raw.slice(0, 60)) {
    const item = observation(entry, appid);
    if (!item) continue;
    if (seen.has(item.id)) duplicate.add(item.id);
    seen.add(item.id);
    if (check(item, entry)) result.push(item);
  }
  return result.filter(({ id }) => !duplicate.has(id));
}

export function readArticleObservations(value: unknown, appid: number): MediaObservation[] {
  return articleObservations(value, appid, () => true);
}

function rejectedArticleEvidence(
  item: MediaObservation, source: Record<string, unknown>, article: string,
  context: readonly (string | null)[], pending: boolean,
): string | null {
  const quote = line(source.quote, 480);
  if (quote.length < 12 || !article.includes(quote)) return "supporting excerpt is missing or absent from the article";
  if (item.qualifiers.some((scope) => !contains(quote, scope) && !context.some((fact) => fact && contains(fact, scope)))) {
    return "qualification is absent from the excerpt and source context";
  }
  if (pending) return null;
  if (item.kind === "tag") {
    if (/^(?:early access|preview|press|launch|release)(?: build| version| edition)?[.!]?$/i.test(item.text)) {
      return "a release state on its own does not describe a game characteristic";
    }
    if (item.qualifiers.length === 0 && context.some((fact) => fact && /\b(?:early access|preview|press build|alpha|beta|pre[- ]release)\b/i.test(fact))) {
      return "tag has no scope despite evidence from a historical build";
    }
    if (/\bsingle[ -]player\b/i.test(item.text) && !/\bsingle[ -]player\b/i.test(quote)) {
      return "excerpt does not identify a single-player mode";
    }
  }
  const scopes = [...quote.matchAll(BUILD_SCOPE_MARKER)].map(([scope]) => scope);
  if (scopes.some((scope) => !item.qualifiers.some((qualifier) => contains(qualifier, scope)) && !contains(item.text, scope))) {
    return "observation does not carry the scope stated in the excerpt";
  }
  return null;
}

/** Validate excerpts while the cleaned article is in memory; retain the supported observation and its scope. */
export function parseArticleObservations(
  value: unknown,
  appid: number,
  article: string,
  context: readonly (string | null)[] = [],
  pending = false,
): MediaObservation[] {
  const body = line(article, Number.MAX_SAFE_INTEGER);
  return articleObservations(value, appid, (item, raw) => {
    const source = object(raw);
    const needsReview = source.reviewQuestion !== undefined && source.reviewQuestion !== null && source.reviewQuestion !== "";
    return needsReview === pending && rejectedArticleEvidence(item, source, body, context, pending) === null;
  });
}

function displayText({ text, qualifiers }: MediaObservation): string {
  const missing = qualifiers.filter((qualifier) => !contains(text, qualifier));
  return missing.length === 0 ? text : `${text.replace(/[.]$/, "")} (${missing.join(", ")})`;
}

interface DisplayIssue {
  reason: string;
  trigger?: string;
}

function invalidDisplay(text: string, kind: ObservationKind): DisplayIssue | null {
  if (kind === "tag") return normalizeMediaTag(text) ? null : { reason: "qualified tag exceeds the display limit or is empty" };
  const trigger = sourceSupportTrigger(text);
  if (trigger) return { reason: "claim uses source-support language", trigger };
  return text.length > 1_500 ? { reason: "claim exceeds the display limit" } : null;
}

function editorialQuestion({ reason, trigger }: DisplayIssue): string {
  const matched = trigger === undefined ? "" : ` (${JSON.stringify(trigger)})`;
  return `What wording and scope does this observation support? ${reason}${matched}.`;
}

type EditorialSection = "statements" | "pros" | "cons" | "tags" | (typeof MEDIA_CATEGORY_NAMES)[number];

/** One catalog defines the model's choices and the aliases accepted at settlement. */
export function synthesisSelections<T extends ObservationSource>(
  sources: readonly T[],
  { legacyV10 = false }: { legacyV10?: boolean } = {},
) {
  const observationsById = new Map<string, { observation: MediaObservation; ref: ObservationReference }>();
  const choices = new Map<EditorialSection, string[]>();
  const editorialOmissions: EditorialOmission[] = [];
  const diagnostics: Array<{ section: string } & DisplayIssue> = [];
  const evidence = [...sources].sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity)).flatMap((source) => {
    const observations = source.observations.flatMap((observation) => {
      if (observation.kind === "gameplay" || observation.kind === "storyWorld") return [];
      const sections: EditorialSection[] = observation.kind === "finding"
        ? ["statements", observation.category as (typeof MEDIA_CATEGORY_NAMES)[number]]
        : [observation.kind === "pro" ? "pros" : observation.kind === "con" ? "cons" : "tags"];
      const ref = { sourceIdentity: source.sourceIdentity, observationId: observation.id };
      const text = displayText(observation);
      const issue = invalidDisplay(text, observation.kind);
      // A reply to a v10 request uses aliases assigned before the wording check changed.
      const excluded = legacyV10 && observation.kind !== "tag"
        ? text.length > 1_500 || LEGACY_V10_SOURCE_SUPPORT_LANGUAGE.test(text)
        : issue !== null;
      if (excluded) {
        if (issue) {
          editorialOmissions.push({ ...ref, question: editorialQuestion(issue) });
          diagnostics.push({ section: sections[0]!, ...issue });
        }
        return [];
      }
      const selectionId = `o${observationsById.size + 1}`;
      observationsById.set(selectionId, { observation, ref });
      for (const section of sections) {
        const ids = choices.get(section) ?? [];
        ids.push(selectionId);
        choices.set(section, ids);
      }
      return [{ ...observation, selectionId }];
    });
    return observations.length ? [{ ...source, observations }] : [];
  });
  return { evidence, observationsById, choices, editorialOmissions, diagnostics };
}

/** Resolve the wire format to the observation contract shared with stored v9 work. */
export function validateSynthesisSelections(
  value: unknown, appid: number, sources: readonly ObservationSource[],
  selections: ReturnType<typeof synthesisSelections>,
) {
  function claim(ids: unknown, contested = false) {
    const support = [...new Set(list(ids))].map((id) => typeof id === "string" ? selections.observationsById.get(id) : undefined);
    const observationRefs = support.map((item) => item?.ref ?? {});
    const texts = [...new Set(support.flatMap((item) => item ? [item.observation.text] : []))];
    const text = contested ? texts.join(" / ") : texts[0];
    return { text, label: text, observationRefs, contested };
  }
  const root = object(value);
  const prosCons = object(root.prosCons);
  const checked = validateObservationSynthesis({
    statements: list(root.statements).map((ids) => claim(ids)),
    categories: Object.entries(object(root.categories)).map(([name, findings]) => ({
      name,
      findings: list(findings).map((entry) => {
        const { observationIds, contested } = object(entry);
        return claim(observationIds, contested === true);
      }),
    })),
    prosCons: { pros: list(prosCons.pros).map((ids) => claim(ids)), cons: list(prosCons.cons).map((ids) => claim(ids)) },
    tags: list(root.tags).map((ids) => claim(ids)),
  }, appid, sources);
  return {
    ...checked,
    editorialOmissions: [...selections.editorialOmissions, ...checked.editorialOmissions],
    diagnostics: [...selections.diagnostics, ...checked.diagnostics],
  };
}

export function validateObservationSynthesis(value: unknown, appid: number, sources: readonly ObservationSource[]) {
  const sourceByIdentity = new Map(sources.map((source) => [source.sourceIdentity, source]));
  const editorialOmissions: EditorialOmission[] = [];
  const diagnostics: Array<{ section: string } & DisplayIssue> = [];
  const questions = new Set<string>();
  function omit(section: string, reason: string, refs: unknown[], trigger?: string) {
    const issue = { reason, ...(trigger === undefined ? {} : { trigger }) };
    diagnostics.push({ section, ...issue });
    for (const ref of refs) {
      const { sourceIdentity, observationId } = object(ref);
      if (typeof sourceIdentity !== "string" || typeof observationId !== "string") continue;
      if (!sourceByIdentity.get(sourceIdentity)?.observations.some(({ id }) => id === observationId)) continue;
      const question = editorialQuestion(issue);
      const key = JSON.stringify([sourceIdentity, observationId, question]);
      if (questions.has(key)) continue;
      questions.add(key);
      editorialOmissions.push({ sourceIdentity, observationId, question });
    }
  }
  function claim(raw: unknown, section: string, kind: ObservationKind, category?: unknown) {
    const entry = object(raw);
    const refs = list(entry.observationRefs);
    const resolve = refs.map((rawRef) => {
      const { sourceIdentity, observationId } = object(rawRef);
      const source = typeof sourceIdentity === "string" ? sourceByIdentity.get(sourceIdentity) : undefined;
      const observation = source?.observations.find(({ id }) => id === observationId);
      return source && observation?.appid === appid ? { sourceIdentity: source.sourceIdentity, sourceUrl: source.sourceUrl, observation } : null;
    });
    if (resolve.length === 0 || resolve.some((ref) => ref === null)) {
      omit(section, "missing or unknown observation reference", refs);
      return [];
    }
    const support = resolve.filter((ref) => ref !== null);
    if (support.some(({ observation }) => observation.kind !== kind || (category !== undefined && category !== observation.category))) {
      omit(section, "referenced observation has a different evidence category", refs);
      return [];
    }
    const matchingText = kind === "tag" ? line(entry.label, 600) : line(entry.text, Infinity);
    const sourceTexts = [...new Set(support.map(({ observation }) => observation.text))];
    const contested = entry.contested === true && category !== undefined;
    const displays = [...new Set(support.map(({ observation }) => displayText(observation)))];
    if (contested) {
      const scopes = new Set(support.map(({ observation }) => JSON.stringify([...observation.qualifiers].sort())));
      if (sourceTexts.length < 2 || scopes.size !== 1 || matchingText !== sourceTexts.join(" / ")) {
        omit(section, "disagreement requires distinct observations with the same scope and wording joined by ' / '", refs);
        return [];
      }
    } else if (sourceTexts.length !== 1 || matchingText !== sourceTexts[0] || displays.length !== 1) {
      omit(section, "claim wording or scope differs from its observations", refs);
      return [];
    }
    const text = displays.join(" / ");
    const issue = invalidDisplay(text, kind);
    if (issue) {
      omit(section, issue.reason, refs, issue.trigger);
      return [];
    }
    return [{ text, sourceUrls: [...new Set(support.map(({ sourceUrl }) => sourceUrl))], ...(contested ? { contested } : {}), observationRefs: support.map(({ sourceIdentity, observation }) => ({ sourceIdentity, observationId: observation.id })) }];
  }
  const root = object(value);
  for (const raw of list(root.categories)) {
    const category = object(raw);
    if (typeof category.name === "string" && categoryNames.has(category.name)) continue;
    for (const entry of list(category.findings)) {
      omit("categories", "unsupported evidence category", list(object(entry).observationRefs));
    }
  }
  const statements = list(root.statements).slice(0, 60).flatMap((entry) => claim(entry, "statements", "finding"));
  if (statements.length === 0) omit("statements", "no supported statements", []);
  const categories = MEDIA_CATEGORY_NAMES.flatMap((name) => {
    const findings = list(root.categories).map(object).filter((entry) => entry.name === name)
      .flatMap((entry) => list(entry.findings)).slice(0, 60).flatMap((entry) => claim(entry, name, "finding", name));
    return findings.length > 0 ? [{ name, findings }] : [];
  });
  const prosCons = object(root.prosCons);
  const pros = list(prosCons.pros).slice(0, 60).flatMap((entry) => claim(entry, "pros", "pro"));
  const cons = list(prosCons.cons).slice(0, 60).flatMap((entry) => claim(entry, "cons", "con"));
  const tags = list(root.tags).slice(0, 60).flatMap((entry) => claim(entry, "tags", "tag"))
    .map(({ text: label, ...evidence }) => ({ label, ...evidence }));
  const observations = sources.flatMap((source) => source.observations.filter((observation) => observation.appid === appid));
  const similarityInputs = {
    gameplay: observations.filter(({ kind }) => kind === "gameplay").map(displayText),
    storyWorld: observations.filter(({ kind }) => kind === "storyWorld").map(displayText),
  };
  return { overview: { statements, categories, prosCons: { pros, cons }, tags, similarityInputs }, editorialOmissions, diagnostics };
}
