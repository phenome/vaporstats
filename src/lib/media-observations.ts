import { MEDIA_OUTLETS } from "./media-outlet-access";
import { LEGACY_V10_SOURCE_SUPPORT_LANGUAGE, MEDIA_CATEGORY_NAMES, normalizeMediaTag, sourceSupportTrigger } from "./media-overview";

const kinds = ["finding", "pro", "con", "tag", "gameplay", "storyWorld"] as const;
type ObservationKind = (typeof kinds)[number];
export type ClauseVersion = "v12" | "v13" | "v14" | "v15" | "v16" | "v18" | "v19" | "v20" | "v21" | "v22" | "v23" | "v24" | "v25" | "v26" | "v27";
const categoryNames = new Set<string>(MEDIA_CATEGORY_NAMES);

export interface MediaObservation {
  id: string;
  appid: number;
  kind: ObservationKind;
  category: string;
  text: string;
  qualifiers: string[];
  versionEvidence?: VersionEvidence;
  technicalTiming?: string[];
}

export type PreviewScope = "announcement" | "hands-on preview" | "non-hands-on preview";

function isPreviewCoverageLabel(label: string, scope: PreviewScope): boolean {
  return /^preview$/i.test(label) || ({
    announcement: /^announcement$/i,
    "hands-on preview": /^hands[- ]on preview$/i,
    "non-hands-on preview": /^(?:non[- ]hands[- ]on|hands[- ]off) preview$/i,
  } satisfies Record<PreviewScope, RegExp>)[scope].test(label);
}

function withoutPreviewQualifierList(text: string, scope: PreviewScope): string {
  return text.replace(/ \(([^()]+)\)(?=[,;:.!?]?$)/, (_suffix, labels: string) => {
    const remaining = labels.split(",").map((label) => label.trim()).filter((label) => !isPreviewCoverageLabel(label, scope));
    return remaining.length ? ` (${remaining.join(", ")})` : "";
  });
}
const PREVIEW_WORDING: Record<PreviewScope, RegExp> = {
  announcement: /\b(?:announcement|announced)\b/i,
  "hands-on preview": /(?<!non[- ])\bhands[- ]on (?:preview|play|session)\b/i,
  "non-hands-on preview": /\b(?:(?:non[- ]hands[- ]on|hands[- ]off) (?:preview|demo|demonstration)|(?:preview|demo|demonstration|trailer|footage) (?:showed|shows)|(?:shown|seen|observed) in (?:an? |the )?(?:demo|demonstration|trailer|footage))\b/i,
};

function claimPreviewScope(source: ObservationSource, observation: MediaObservation): PreviewScope | undefined {
  if (!source.previewScope) return undefined;
  // A preview can also report an announced plan outside what was shown or played.
  return observation.qualifiers.some((label) => /^announcement$/i.test(label)) ? "announcement" : source.previewScope;
}

export interface ObservationSource {
  sourceIdentity: string;
  sourceUrl: string;
  observations: MediaObservation[];
  editionContext?: { platform: string | null; build: string | null };
  legacySimilarityInputs?: true;
  previewScope?: PreviewScope;
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
  article: string, context: readonly (string | null)[], includeTechnicalTiming = false,
): EditorialOmission[] {
  const body = line(article, Number.MAX_SAFE_INTEGER);
  const accepted = new Set(observations.map(({ id }) => id));
  return list(object(value).observations).slice(0, 60).flatMap((entry) => {
    const { id, appid: subject, reviewQuestion } = object(entry);
    if (!matchesRequestedApp(subject, appid) || typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || accepted.has(id)) return [];
    const candidate = observation(entry, appid);
    const reason = candidate
      ? rejectedArticleEvidence(candidate, object(entry), body, context, false, includeTechnicalTiming) ?? "observation ID is duplicated"
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

export function readArticleObservations(value: unknown, appid: number, includeVersionEvidence = false, includeTechnicalTiming = false): MediaObservation[] {
  return articleObservations(value, appid, (item, entry) => {
    if (includeVersionEvidence) {
      const { observed, distinctions, technical } = object(object(entry).versionEvidence);
      if (Array.isArray(observed) && Array.isArray(distinctions) && typeof technical === "boolean") {
        item.versionEvidence = { observed: markerLabels(observed), distinctions: markerLabels(distinctions), technical };
      }
    }
    if (includeTechnicalTiming) {
      const timing = list(object(entry).technicalTiming).map((label) => line(label, 120));
      if (timing.length > 0 && timing.every((label) => timingMarkers(label).size === 1)) {
        item.technicalTiming = [...new Set(timing)];
      }
    }
    return true;
  });
}

function rejectedArticleEvidence(
  item: MediaObservation, source: Record<string, unknown>, article: string,
  context: readonly (string | null)[], pending: boolean, includeTechnicalTiming = false,
): string | null {
  const quote = line(source.quote, 480);
  if (quote.length < 12 || !article.includes(quote)) return "supporting excerpt is missing or absent from the article";
  const timing = includeTechnicalTiming ? extractTechnicalTiming(item, quote) : undefined;
  if (timing) {
    // Retain context qualifiers on matching inputs for the embedding filter.
    // V18 prose uses the separately derived timing when projecting these inputs.
    const matchingInput = item.kind === "gameplay" || item.kind === "storyWorld";
    const asserted = matchingInput ? item.text : [item.text, ...item.qualifiers].join(" ");
    if (unsupportedTiming(asserted, timing)) return "technical timing is absent from the supporting excerpt";
  }
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
  const scopes = [...quote.matchAll(BUILD_SCOPE_MARKER)].map(([scope]) => scope)
    .filter((scope) => !timing || !timingMarkers(scope).size && !/^(?:announced|planned)$/i.test(scope));
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
  includeVersionEvidence = false,
  includeTechnicalTiming = false,
  requiredScope?: string,
): MediaObservation[] {
  const body = line(article, Number.MAX_SAFE_INTEGER);
  return articleObservations(value, appid, (item, raw) => {
    const source = object(raw);
    if (requiredScope && !item.qualifiers.includes(requiredScope)) item.qualifiers.push(requiredScope);
    const needsReview = source.reviewQuestion !== undefined && source.reviewQuestion !== null && source.reviewQuestion !== "";
    if (needsReview !== pending || rejectedArticleEvidence(item, source, body, context, pending, includeTechnicalTiming) !== null) return false;
    const quote = line(source.quote, 480);
    if (includeVersionEvidence) item.versionEvidence = classifyVersionEvidence(quote);
    const timing = includeTechnicalTiming ? extractTechnicalTiming(item, quote) : undefined;
    if (timing) item.technicalTiming = timing;
    return true;
  });
}

// Synthesis can naturally omit articles and the generic GPU suffix.
function includesHardwareQualifier(text: string, qualifier: string): boolean {
  if (!/\b(?:GPU|graphics card)\b/i.test(qualifier)) return false;
  const normalize = (value: string) => value.toLowerCase()
    .replace(/\b(?:a|an|the|gpu|graphics card)\b/g, " ").replace(/\s+/g, " ").trim();
  const hardware = normalize(qualifier);
  return /[a-z].*\d/.test(hardware) && contains(normalize(text), hardware);
}

function displayText({ text, qualifiers }: MediaObservation): string {
  const missing = qualifiers.filter((qualifier) => !contains(text, qualifier));
  return missing.length === 0 ? text : `${text.replace(/[.]$/, "")} (${missing.join(", ")})`;
}

const discoveryTagAliases: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:open[- ]world(?: game)?|single, unrestricted open urban map)$/i, "Open world"],
  [/^(?:(?:there are )?no (?:loading|load) screens?|seamless (?:world |open[- ]world )?traversal without (?:loading|load) screens?)$/i, "No load screens"],
  [/^(?:fps|first[- ]person shooter)$/i, "FPS"],
  [/^first[- ]person perspective$/i, "First-person perspective"],
  [/^(?:choices matter|(?:player )?choices (?:affect|change|shape|influence) (?:the )?(?:story|endings?|outcomes?))$/i, "Choices matter"],
  [/^(?:the player chooses )?one of (?:\d+|two|three|four|five|several|multiple) life paths at the start that set background and early events$/i, "Selectable backgrounds"],
  [/^joy[- ]cons?(?: controller)?(?: support| (?:mouse-style |motion )?aiming)?$/i, "Joy-Con support"],
  [/^dual\s?sense(?: controller)?(?: support)?$/i, "DualSense support"],
  [/^adaptive triggers?(?: support)?$/i, "Adaptive triggers"],
];

function discoveryTagText(observation: MediaObservation): string {
  const original = observation.text.replace(/[.!?]+$/, "");
  const platform = /^(.*?) (?:on|for) (?:the )?((?:(?:Nintendo )?Switch(?: 2)?|PS5|PlayStation 5)(?: port)?)$/i.exec(original);
  const wrapper = /^(?:(?:the game|it) is |(?:(?:the game|it) )?(?:has|uses|features|offers|supports) )(?:an? )?/i;
  const text = original.replace(wrapper, "");
  const candidate = (platform?.[1] ?? original).replace(wrapper, "");
  const alias = discoveryTagAliases.find(([pattern]) => pattern.test(candidate))?.[1];
  if (alias) return platform?.[2] ? `${alias} (${platform[2]})` : alias;
  // Unrecognized prose does not have a safe deterministic short label.
  if (!text || text.split(/\s+/).length > 6
    || /[!?;,]|\.\s|\b(?:the game|the player|you can|there (?:are|is)|avoids|allows|offers|includes|requires|\d+\s*fps)\b/i.test(text)) return "";
  return text;
}

// The model chooses the meaning and wording. Settlement checks that its
// response is a label suitable for display before attaching evidence scope.
function isDiscoveryLabel(value: unknown, version?: ClauseVersion): value is string {
  if (typeof value !== "string" || !normalizeMediaTag(value)) return false;
  const label = value.normalize("NFKC").trim();
  return label.split(/\s+/).length <= 8
    && !/[!?;,:{}<>`\p{Cc}]|\.\s|\.$/u.test(label)
    && !/[()]/.test(label.replace(/\([^()]+\)/g, ""))
    && !/\b\d+(?:\.\d+)?\s*fps\b/i.test(label)
    && !/^(?:the game|the player|players? (?:can|choose|have|use)|you |there (?:is|are)|(?:supports|features|offers|uses|has) )/i.test(label)
    && ((usesBrowseTags(version) && /^actions have consequences(?: \([^()]+\))?$/i.test(label))
      || !/\b(?:allows|avoids|includes|requires|offers|supports|chooses|affects|changes|has|have|is|are|can|could|will|would)\b/i.test(label))
    && !sourceSupportTrigger(label);
}

function observationDisplay(observation: MediaObservation, clauses?: ClauseVersion): string {
  if (clauses !== "v19" || observation.kind !== "tag") return displayText(observation);
  const text = discoveryTagText(observation);
  return text ? displayText({ ...observation, text }) : "";
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

function isComposedLead(version?: ClauseVersion): boolean {
  return version === "v15" || version === "v16" || version === "v18" || version === "v19" || usesAuthoredTags(version);
}

function canSupportLead(source: ObservationSource, observation: MediaObservation, version?: ClauseVersion): boolean {
  return observation.kind === "finding"
    || (isComposedLead(version) && !source.legacySimilarityInputs
      && (observation.kind === "gameplay" || observation.kind === "storyWorld"));
}

type SynthesisObservation = MediaObservation & {
  selectionId: string;
  scopeGroup?: string;
  tagScopeGroup?: string;
  tagQualifiers?: string[];
  previewScope?: PreviewScope;
};

type EditorialSection = "statements" | "pros" | "cons" | "tags" | (typeof MEDIA_CATEGORY_NAMES)[number];

/** One catalog defines the model's choices and the aliases accepted at settlement. */
export function synthesisSelections<T extends ObservationSource>(
  sources: readonly T[],
  { legacyV10 = false, clauses }: { legacyV10?: boolean; clauses?: ClauseVersion } = {},
) {
  const observationsById = new Map<string, { observation: MediaObservation; ref: ObservationReference }>();
  const choices = new Map<EditorialSection, string[]>();
  const editorialOmissions: EditorialOmission[] = [];
  const diagnostics: Array<{ section: string } & DisplayIssue> = [];
  const scopeGroups = new Map<string, string>();
  function groupFor(key: string): string {
    const group = scopeGroups.get(key) ?? `s${scopeGroups.size + 1}`;
    scopeGroups.set(key, group);
    return group;
  }
  const evidence: Array<Omit<T, "observations"> & { observations: SynthesisObservation[] }> = [...sources].sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity)).flatMap((source) => {
    const observations = source.observations.flatMap((observation) => {
      if (observation.kind === "tag" && !canSupportTag(observation, clauses)) return [];
      const similarity = observation.kind === "gameplay" || observation.kind === "storyWorld";
      if (similarity && !canSupportLead(source, observation, clauses)) return [];
      const sections: EditorialSection[] = observation.kind === "finding"
        ? ["statements", observation.category as (typeof MEDIA_CATEGORY_NAMES)[number]]
        : [similarity ? "statements" : observation.kind === "pro" ? "pros" : observation.kind === "con" ? "cons" : "tags"];
      const tagFinding = observation.kind === "finding" && canSupportTag(observation, clauses);
      if (tagFinding) sections.push("tags");
      const ref = { sourceIdentity: source.sourceIdentity, observationId: observation.id };
      const text = observationDisplay(observation, clauses);
      const authoredTag = usesAuthoredTags(clauses) && observation.kind === "tag";
      const issue = authoredTag ? null : invalidDisplay(text, observation.kind);
      // A reply to a v10 request uses aliases assigned before the wording check changed.
      const excluded = legacyV10 && observation.kind !== "tag"
        ? text.length > 1_500 || LEGACY_V10_SOURCE_SUPPORT_LANGUAGE.test(text)
        : issue !== null && (!clauses || observation.kind === "tag");
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
      if (!clauses || (observation.kind === "tag" && !authoredTag)) return [{
        ...observation,
        ...(clauses === "v19" ? { discoveryLabel: text } : {}),
        selectionId,
      }];
      const { edition, qualifiers, key } = observationScope(source, observation, clauses);
      const previewScope = usesPreviewScope(clauses) && !authoredTag ? claimPreviewScope(source, observation) : undefined;
      const scopeGroup = groupFor(key);
      const tagScope = tagFinding ? authoredTagScope(source, observation, clauses) : undefined;
      const tagContext = tagScope ? { tagScopeGroup: groupFor(tagScope.key), tagQualifiers: tagScope.qualifiers } : {};
      const promptText = !authoredTag && (clauses === "v16" || usesTechnicalTiming(clauses))
        ? removeIncidentalReviewWording(observation, qualifiers) : observation.text;
      return [{ ...observation, text: promptText, selectionId, qualifiers, ...tagContext, ...(previewScope ? { previewScope } : {}), ...(edition ? { edition } : {}), ...(clauses !== "v12" ? { scopeGroup } : {}) }];
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

export function validateSynthesisClauses(
  value: unknown, appid: number, sources: readonly ObservationSource[],
  selections: ReturnType<typeof synthesisSelections>,
  version: ClauseVersion = "v13",
) {
  function entries(raw: unknown, tags = false) {
    return list(raw).map((entry) => {
      const authoredTag = tags && usesAuthoredTags(version);
      const observationIds = tags && !authoredTag ? entry : object(entry).observationIds;
      const observationRefs = [...new Set(list(observationIds))]
        .map((id) => typeof id === "string" ? selections.observationsById.get(id)?.ref ?? {} : {});
      const label = authoredTag ? object(entry).label : tags && typeof list(observationIds)[0] === "string"
        ? selections.observationsById.get(list(observationIds)[0] as string)?.observation.text : undefined;
      return { text: object(entry).text, label, observationRefs };
    });
  }
  const root = object(value);
  const prosCons = object(root.prosCons);
  const checked = validateObservationSynthesis({
    statements: entries(root.statements),
    categories: Object.entries(object(root.categories)).map(([name, findings]) => ({ name, findings: entries(findings) })),
    prosCons: { pros: entries(prosCons.pros), cons: entries(prosCons.cons) },
    tags: entries(root.tags, true),
  }, appid, sources, { clauses: version });
  return {
    ...checked,
    editorialOmissions: [...selections.editorialOmissions, ...checked.editorialOmissions],
    diagnostics: [...selections.diagnostics, ...checked.diagnostics],
  };
}

export function usesAuthoredTags(version?: ClauseVersion): boolean {
  return version === "v20" || usesControllerTags(version);
}

export function usesControllerTags(version?: ClauseVersion): boolean {
  return version === "v21" || usesArticleTags(version);
}

export function usesArticleTags(version?: ClauseVersion): boolean {
  return version === "v22" || usesBrowseTags(version);
}

export function usesTagFirst(version?: ClauseVersion): boolean {
  return version === "v25" || usesPreviewScope(version);
}

export function usesPreviewScope(version?: ClauseVersion): boolean {
  return version === "v26" || version === "v27";
}

export function usesBrowseTags(version?: ClauseVersion): boolean {
  return version === "v23" || version === "v24" || usesTagFirst(version);
}

function canSupportTag(observation: MediaObservation, version?: ClauseVersion): boolean {
  if (!usesArticleTags(version)) return observation.kind === "tag";
  return !hasTechnicalIssue(observation.text)
    && !/\b\d+(?:\.\d+)?\s*fps\b/i.test(observation.text)
    && (!usesBrowseTags(version) || !isPreviewOnlyTagEvidence(observation))
    && (observation.kind === "tag" || (observation.kind === "finding" && observation.category === "Gameplay & systems"));
}

export function usesTechnicalTiming(version?: ClauseVersion): boolean {
  return version === "v18" || version === "v19" || usesAuthoredTags(version);
}

// Legacy amendments can carry play scope in the observation's wording.
// Match explicit play context, without inferring a build from article dates.
function observationScope(source: ObservationSource, observation: MediaObservation, version: ClauseVersion) {
  if (version === "v14" || isComposedLead(version)) {
    if (usesAuthoredTags(version) && observation.kind === "tag") return authoredTagScope(source, observation, version);
    const scope = sourceGroundedScope(source, observation, usesTechnicalTiming(version));
    const preview = usesPreviewScope(version) ? claimPreviewScope(source, observation) : undefined;
    return preview ? { ...scope, key: JSON.stringify([scope.key, preview]) } : scope;
  }
  const scopeInText = version === "v12"
    ? /\b(?:on the (?:Nintendo )?Switch 2 port|reviewed (?:PC|PS5|Xbox Series X) (?:version|build)|at (?:PC )?launch|early access|day[- ]\d+ patch)\b/gi
    : /\b(?:on the (?:Nintendo )?Switch 2 port|reviewed (?:PC|PS5|Xbox Series X) (?:version|build)|at (?:PC )?launch|early access|(?:PC |version |v)?1\.0(?!\.\d)|day[- ]\d+ patch)\b/gi;
  const textScope = [...observation.text.matchAll(scopeInText)].map(([scope]) => scope);
  const observationContext = [...observation.qualifiers, ...textScope].join(" ");
  const context = [observationContext, source.editionContext?.build].filter(Boolean).join(" ");
  const platformPattern = /\b(?:Switch 2|PC|PS5|PlayStation 5|Xbox Series [XS]|Switch)\b/i;
  const platformMatch = platformPattern.exec(observationContext)?.[0] ?? platformPattern.exec(source.editionContext?.platform ?? "")?.[0];
  const platform = platformMatch?.toLowerCase() === "pc" ? "PC" : platformMatch;
  const qualifierByKey = new Map<string, string>();
  for (const qualifier of [...observation.qualifiers, ...textScope]) {
    qualifierByKey.set(scopeKey(qualifier), qualifier);
  }
  if (platform && ![...qualifierByKey.values()].some((qualifier) => contains(qualifier, platform))) {
    qualifierByKey.set(scopeKey(platform), platform);
  }
  const build = source.editionContext?.build;
  if (build && ![...qualifierByKey.values()].some((qualifier) => contains(qualifier, build) || contains(build, qualifier) && scopeKey(build) === scopeKey(qualifier))) {
    qualifierByKey.set(scopeKey(build), build);
  }
  const buildLabels = [
    [/\bearly access\b/i, "Early Access"],
    [/\bspecial edition\b/i, "Special Edition"],
    [/\banniversary edition\b/i, "Anniversary Edition"],
    [/\bultimate edition\b/i, "Ultimate Edition"],
    [/\b(?:launch|full release|1\.0)\b/i, version === "v13" && /\b(?:v)?1\.0\b/i.test(context)
      ? [platform, "1.0"].filter(Boolean).join(" ") : platform ? `${platform} launch` : "Launch"],
    [/\bpreview\b/i, "Preview"],
  ] as const;
  const editions = buildLabels.flatMap(([pattern, label]) => pattern.test(context) ? [label] : []);
  const edition = platform?.toLowerCase() === "switch 2" ? "Switch 2"
    : editions.length === 1 ? editions[0] : editions.length === 0 ? platform : undefined;
  return { edition, qualifiers: [...qualifierByKey.values()], key: JSON.stringify([...qualifierByKey.keys()].sort()), timing: undefined };
}

const VERSION_MARKER = /\b(?:early access|technical test|(?:press|preview|review|pre[- ]release) build|preview|full release|PC launch|at launch|launch build|(?:version |v)\d+\.\d+(?:\.\d+)*|1\.0(?!\.\d)|(?:\d+\s?GB )?day[- ]\d+ patch|patch \d+(?:\.\d+)*|(?:special|anniversary|ultimate|definitive) edition|(?:Nintendo )?Switch 2(?: port)?|(?:Nintendo )?Switch(?: port)?|PlayStation [45]|PS[45]|Xbox Series [XS]|PC)\b/gi;
const HISTORICAL_BUILD = /^(?:early access|technical test|preview|(?:press|preview|review|pre[- ]release) build)$/i;
const HISTORICAL_TAG_BUILD = /\b(?:early access|technical test|(?:press|preview|review|pre[- ]release|development|alpha|beta) (?:build|version)|preview|pre[- ]release|alpha|beta)\b/i;

function isPreviewOnlyTagEvidence(observation: MediaObservation): boolean {
  const build = `(?:the |an? |this )?(?:${HISTORICAL_TAG_BUILD.source})`;
  const restriction = new RegExp(
    `(?:\\b(?:only (?:available |playable |present )?|exclusive(?:ly)? |limited |restricted )(?:to |in |during |for )?${build}|${build}[- ]only\\b|\\b(?:removed|dropped|absent) (?:from|in|at) (?:the )?(?:full |final )?(?:release|launch))`, "i",
  );
  return [observation.text, ...observation.qualifiers].some((text) => restriction.test(text));
}
const VERSION_CHANGE = /\b(?:both|only|unlike|compared (?:with|to)|versus|than|no longer|newly|now|previously|introduced|added|removed|replaced|fixed|changed|limited to|exclusive to)\b/i;
const TECHNICAL_FAILURE = /\b(?:glitches?|bugs?|crash(?:es|ed|ing)?|stutter(?:s|ed|ing)?|pop[- ]in|textures? (?:could |can )?load late|dialogue (?:could |can )?overlap|vehicles? (?:could |can )?spawn inside)\b/i;

function versionMarkers(text: string): Map<string, string> {
  return new Map([...text.matchAll(VERSION_MARKER)].map(([label]) => {
    const key = scopeKey(label).replace(/^playstation /, "ps").replace(/^(?:version |v)(?=\d)/, "").replace(/^\d+\s?gb /, "");
    return [key, label];
  }));
}

// Scope is decided before projecting wording for the model. Keep the source
// observation intact for settlement and evidence lookup.
function removeIncidentalReviewWording(observation: MediaObservation, qualifiers: readonly string[]): string {
  const { text, category } = observation;
  if (VERSION_CHANGE.test(text) || PORT_FEATURE.test(text)) return text;
  const required = versionMarkers(qualifiers.join(" "));
  if (required.has("pc")) return text;
  const withoutReviewContext = text
    .replace(/^In the reviewed PC version, (.)/i, (_, initial: string) => initial.toUpperCase())
    .replace(/ in the reviewed PC version\b/gi, "")
    .replace(/, based on the 1\.0 version played on PC(?=[.!?]?$)/i, (context) => required.has("1.0") ? context : "");
  if (category === "Technical experience & accessibility" || required.size > 0 || TECHNICAL_FAILURE.test(text)) return withoutReviewContext;
  return withoutReviewContext.replace(/ \(\d+\s?GB Day[- ]\d+ patch, PC\)(?=[.!?]?$)/i, "");
}

interface VersionEvidence {
  observed: string[];
  distinctions: string[];
  technical: boolean;
}

function markerLabels(values: unknown[]): string[] {
  return [...versionMarkers(values.map((value) => line(value, 120)).join(" ")).values()];
}

const PORT_FEATURE = /\b(?:FPS|frame[ -]?rate|frame pacing|resolution|\d{3,4}p|docked|handheld|Joy[- ]Con|DLSS|ray tracing|mouse controls?|performance mode)\b/i;

const DURING_REVIEW = "during review";
const TECHNICAL_ISSUE = /\b(?:glitches?|stutter(?:s|ed|ing)?|pop[- ]in|textures? (?:could |can )?load late|dialogue (?:could |can )?overlap|vehicles? (?:could |can )?spawn inside|broken (?:character )?animations?|(?:caught|stuck|locked) in (?:an? |their )?(?:idle )?animations?|(?:crashed|crashes|froze) (?:the )?(?:game|client|app)|(?:animation|game[- ]breaking|technical|visual|audio|progression|recurring|frequent|several) bugs?|bugs? (?:were |are )?(?:(?:slightly )?reduced|interrupt|block|break|disrupt|affect)\w*|(?:encountered|experienced|hit|fixed) (?:a |some |several |repeated )?bugs?|(?:game|app|build|client|screen|it) (?:can |could |would |kept )?(?:crash(?:es|ed|ing)?|froze|freez(?:es|ing))|(?:crashes|freezes) (?:to desktop|on startup|when loading)|(?:frequent|random|repeated|occasional|several) (?:crashes|freezes))\b/i;
const PERFORMANCE_ISSUE = /\b(?:slowdowns?|hitch(?:es|ed|ing)?|input lag|lag spikes?|performance (?:issues?|problems?|drops?|dips?|is poor|was poor)|(?:frame[ -]?rates?|FPS) (?:drops?|dips?|dropped|dropping|dipped|dipping|fell|tanks?|plunges?)|(?:unstable|inconsistent|poor|low) (?:frame[ -]?rates?|FPS|performance)|(?:frame[ -]?rate|FPS) (?:issues?|drops?|dips?))\b/i;
const PATCH = String.raw`(?:(?:(?:\d+\s?GB )?day[- ](?:\d+|one|zero)|launch) patch|(?:the |a |an )?(?:patch|update)(?: \d+(?:\.\d+)*)?)`;
const BUILD = String.raw`(?:early access|technical test|(?:press|preview|review|launch|release|retail|pre[- ]release) build|preview|full release|(?:PC )?launch|release|(?:version |v)\d+\.\d+(?:\.\d+)*|1\.0(?!\.\d)|(?:special|anniversary|ultimate|definitive) edition)`;
const DATE = String.raw`(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)(?: \d{1,2}(?:st|nd|rd|th)?(?:,)?(?= |$|[.!?]))?(?: (?:19|20)\d{2})?|(?:19|20)\d{2}(?:-\d{2}-\d{2})?)`;
const TIMING_MARKER = new RegExp(String.raw`\b(?:(?:before|after|since|until|at|on|during|in|with|as of) (?:the )?(?:${PATCH}|${BUILD}|${DATE})|on day[- ](?:one|1)|${PATCH}|(?:pre|post)[- ](?:launch|release|patch)|${BUILD}|during (?:the )?review|at the time of (?:the )?review|currently|still|now|recently|to this day)\b`, "gi");
const SPECULATIVE_TIMING = /\b(?:will|(?:would|should|could|might) (?:address|fix|improve|resolve|be (?:fixed|patched))|forthcoming|upcoming|planned|expected|promised|not (?:at|on|in|with|before|after|since|until)|\w+n['’]t (?:at|on|in|with|before|after|since|until)|(?:did not|didn['’]t) (?:test|play|try)|had yet to|not yet)\b/i;

function isTechnicalIssue(observation: MediaObservation): boolean {
  return observation.kind !== "tag" && hasTechnicalIssue(observation.text);
}

function hasTechnicalIssue(text: string): boolean {
  return TECHNICAL_ISSUE.test(text) || PERFORMANCE_ISSUE.test(text);
}

function timingMarkers(text: string): Map<string, string> {
  return new Map([...text.matchAll(TIMING_MARKER)].map(([label]) => {
    const key = label.toLowerCase()
      .replace(/^(?:at the time of (?:the )?review|during (?:the )?review)$/, DURING_REVIEW)
      .replace(/^(?:at|on|during|in|with) (?:the )?/, "")
      .replace(/^(before|after|since|until) (?:the |a |an )/, "$1 ")
      .replace(/\bday[- ]one(?= patch)/, "day 1")
      .replace(/\bday[- ]zero(?= patch)/, "day 0")
      .replace(/\bday-(?=\d)/, "day ")
      .replace(/^(?:version |v)(?=\d)/, "")
      .replace(/^(?:launch build|full release|release|day[- ](?:one|1))$/, "launch")
      .replace(/^(?:pre|post)[- ](launch|release|patch)$/, (word, event: string) =>
        `${word.startsWith("pre") ? "before" : "after"} ${event === "release" ? "launch" : event}`);
    return [key, label];
  }));
}

function extractTechnicalTiming(observation: MediaObservation, quote: string): string[] | undefined {
  if (!isTechnicalIssue(observation)) return undefined;
  // A timing marker must modify the issue in the same clause. Other review
  // sentences and independent remarks about planned updates supply no scope.
  const clauses = quote.split(/(?<=[.!?])\s+|;\s*|,?\s+\b(?:but|however|whereas|while|and (?=(?:the |a |an )?(?:game|developers?|studio|patch|update)\b))\s*/i);
  const timings = new Map(clauses.flatMap((clause) => {
    if (!hasTechnicalIssue(clause) || SPECULATIVE_TIMING.test(clause)) return [];
    return [...timingMarkers(clause)].filter(([key, label]) =>
      !/^(?:currently|still|now|recently|to this day|patch|update)$/.test(key)
      && !/^(?:a |an |the )?(?:patch|update)$/i.test(label));
  }));
  return timings.size > 0 ? [...timings.values()] : [DURING_REVIEW];
}

function observationTiming(observation: MediaObservation): string[] | undefined {
  return observation.technicalTiming ?? (isTechnicalIssue(observation) ? [DURING_REVIEW] : undefined);
}

function unsupportedTiming(text: string, timing: readonly string[]): string | undefined {
  const supported = timingMarkers(timing.join(" "));
  return [...timingMarkers(text)].find(([key]) => !supported.has(key))?.[1];
}

function classifyVersionEvidence(excerpt: string): VersionEvidence {
  const distinctions = excerpt.split(/(?<=[.!?])\s+/).flatMap((sentence) =>
    VERSION_CHANGE.test(sentence) || PORT_FEATURE.test(sentence) ? [...versionMarkers(sentence).values()] : []);
  return {
    observed: [...versionMarkers(excerpt).values()],
    distinctions: markerLabels(distinctions),
    technical: PORT_FEATURE.test(excerpt) || TECHNICAL_FAILURE.test(excerpt),
  };
}

// Use the facts derived from the validated quote at extraction. Older
// extractions can only attest to what their accepted wording says.
function sourceGroundedScope(source: ObservationSource, observation: MediaObservation, includeTechnicalTiming = false) {
  const { observed, distinctions: labels, technical: legacyTechnical } = observation.versionEvidence ?? classifyVersionEvidence(observation.text);
  const timing = includeTechnicalTiming ? observationTiming(observation) : undefined;
  const technical = includeTechnicalTiming ? Boolean(timing) || PORT_FEATURE.test(observation.text) : legacyTechnical;
  const distinctions = versionMarkers(labels.join(" "));
  const context = versionMarkers([...observed, ...observation.qualifiers, source.editionContext?.build ?? ""].join(" "));
  if (timing) {
    for (const markers of [distinctions, context]) {
      for (const [key, label] of markers) {
        if (timingMarkers(label).size) markers.delete(key);
      }
    }
  }
  const required = new Map(distinctions);
  for (const [key, label] of context) {
    if ((HISTORICAL_BUILD.test(key) || technical) && !required.has(key)) required.set(key, label);
  }
  if (technical) {
    for (const [key, label] of versionMarkers(source.editionContext?.platform ?? "")) {
      if (!required.has(key)) required.set(key, label);
    }
  }
  const otherQualifiers = observation.qualifiers.filter((qualifier) =>
    (!timing || !timingMarkers(qualifier).size)
    && qualifier.replace(VERSION_MARKER, "").replace(/\b(?:at|in|on|with|the|reviewed|version|build|port|platform|release|and)\b|[(),]/gi, "").trim() !== "");
  const qualifiers = [...otherQualifiers, ...required.values(), ...(timing ?? [])];
  const nonPlatformDistinctions = [...distinctions].filter(([key]) => !/^(?:pc|ps[45]|xbox series [xs]|switch(?: 2)?)$/.test(key));
  const edition = nonPlatformDistinctions.length === 1 ? nonPlatformDistinctions[0]![1]
    : nonPlatformDistinctions.length === 0 && distinctions.size === 1 ? [...distinctions.values()][0] : undefined;
  return {
    edition,
    qualifiers,
    key: JSON.stringify([[...distinctions.keys()].sort(), [...required.keys(), ...otherQualifiers.map(scopeKey)].sort(),
      ...(timing ? [[...timingMarkers(timing.join(" ")).keys()].sort()] : [])]),
    timing,
  };
}

function authoredTagScope(source: ObservationSource, observation: MediaObservation, version?: ClauseVersion) {
  const scope = sourceGroundedScope(source, observation, true);
  const byScope = new Map<string, string>();
  for (const qualifier of [...observation.qualifiers, ...scope.qualifiers]) {
    const context = version === "v27" ? withoutTagCoverageQualifiers(qualifier) : qualifier;
    const material = usesBrowseTags(version) ? withoutHistoricalTagContext(context) : context;
    if (!material) continue;
    const versions = versionMarkers(material);
    const key = versions.size && !qualifierWithoutVersion(material)
      ? JSON.stringify([...versions.keys()].sort()) : scopeKey(material);
    if (!byScope.has(key)) byScope.set(key, material);
  }
  const qualifiers = [...byScope.values()];
  const versions = versionMarkers(qualifiers.join(" "));
  // Older observations can carry their platform or build only in the wording.
  for (const [key, label] of versionMarkers(observation.text)) {
    if (usesBrowseTags(version) && HISTORICAL_TAG_BUILD.test(label)) continue;
    if (!versions.has(key)) {
      versions.set(key, label);
      qualifiers.push(label);
    }
  }
  const remaining = qualifiers.map(qualifierWithoutVersion).filter(Boolean).map(scopeKey);
  return {
    ...scope, qualifiers,
    key: JSON.stringify([[...versions.keys()].sort(), [...new Set(remaining)].sort()]),
  };
}

// Coverage and release status describe the citation. Keep any other
// qualifier, including explicit limits on a mechanic or edition.
function withoutTagCoverageQualifiers(qualifiers: string): string {
  return qualifiers.split(",").map((label) => label.trim()).filter((label) => !isTagCoverageQualifier(label)).join(", ");
}

function isTagCoverageQualifier(label: string): boolean {
  const context = label.replace(/^(?:in|during|from) (?:(?:a|an|the) )?/i, "");
  return /^(?:upcoming|pre[- ]release|early access)$/i.test(context)
    || (Object.keys(PREVIEW_WORDING) as PreviewScope[]).some((scope) => isPreviewCoverageLabel(context, scope));
}

function withoutTagCoverageWording(label: unknown): unknown {
  if (typeof label !== "string") return label;
  const text = label.normalize("NFKC").trim();
  if (isTagCoverageQualifier(text)) return "";
  return text.replace(/^upcoming\s+/i, "")
    .replace(/ \(([^()]+)\)$/, (_suffix, qualifiers: string) => {
      const material = withoutTagCoverageQualifiers(qualifiers);
      return material ? ` (${material})` : "";
    });
}

function withoutHistoricalTagContext(qualifier: string): string {
  if (/^(?:non-)?hands-on preview$/.test(qualifier) || !HISTORICAL_TAG_BUILD.test(qualifier)) return qualifier;
  return qualifier.replace(new RegExp(HISTORICAL_TAG_BUILD.source, "gi"), "")
    .replace(/^(?:(?:on|in|for|during|the|and)\s+)+|\s+(?:(?:on|in|for|during|the|and)\s*)+$/gi, "")
    .replace(/^[\s(),/–-]+|[\s(),/–-]+$/g, "").replace(/\s+/g, " ");
}

function qualifierWithoutVersion(qualifier: string): string {
  return qualifier.replace(VERSION_MARKER, "").trim()
    .replace(/^(?:on|at|in|for)(?: the)?$/i, "");
}

// The citation retains the exact edition even when the named controller already
// establishes its platform family. Keep qualifiers that carry additional scope.
function controllerImpliesPlatform(label: string, qualifier: string): boolean {
  const platform = scopeKey(qualifier);
  return (/\bjoy[- ]cons?\b/i.test(label) && /^switch(?: 2)?$/.test(platform))
    || (/\bdualsense\b/i.test(label) && /^(?:playstation 5|ps5)$/.test(platform));
}

function omitImpliedControllerPlatform(label: string): string {
  const marker = [...label.matchAll(VERSION_MARKER)].at(-1);
  if (!marker) return label;
  const [platform] = marker;
  const prefix = label.slice(0, marker.index);
  const suffix = label.slice(marker.index + platform.length);
  const wording = suffix === ")" ? prefix.replace(/ \($/, "")
    : suffix === "" ? prefix.replace(/ (?:on|for) (?:the )?$/i, "")
    : prefix;
  return (suffix === "" || suffix === ")") && wording !== prefix && controllerImpliesPlatform(wording, platform)
    ? wording : label;
}

function missingTagQualifiers(label: string, qualifiers: readonly string[], version?: ClauseVersion): string[] {
  const labelVersions = versionMarkers(label);
  return qualifiers.filter((qualifier) => {
    if (contains(label, qualifier) || (usesControllerTags(version) && controllerImpliesPlatform(label, qualifier))) return false;
    const versions = versionMarkers(qualifier);
    return qualifierWithoutVersion(qualifier) || versions.size === 0
      || [...versions.keys()].some((key) => !labelVersions.has(key));
  });
}

function scopeKey(qualifier: string): string {
  return qualifier.toLowerCase()
    .replace(/^(?:on the |at |reviewed )/, "")
    .replace(/^nintendo (?=switch)/, "")
    .replace(/ (?:port|version|build)$/, "")
    .replace(/day-(?=\d)/, "day ");
}

function isTechnicalTagEvidence(text: string): boolean {
  return hasTechnicalIssue(text)
    || /\b(?:bug[- ]ridden|(?:technical|performance) (?:issues?|problems?|complaints?)|unstable (?:performance|frame[ -]?rates?))\b/i.test(text)
    || /\b(?:\d{3,4}p|\d+(?:\.\d+)?\s*fps|\d+(?:\.\d+)?\s*frames per second|(?:4|8)K|benchmarks?)\b/i.test(text);
}

function supportsStoryBranching(evidence: string): boolean {
  const branchingPlot = /\b(?:branching (?:main )?(?:story(?:line)?|plot|narrative)|(?:story(?:line)?|plot|narrative) branch(?:es|ed))\b/i;
  const distinctOutcomes = /\b(?:multiple|different|alternate|alternative|distinct) (?:endings|(?:story|plot|narrative) outcomes)\b/i;
  const decisionEffects = /\b(?:choices?|decisions?|actions?)\b[^.!?]*\b(?:affect|alter|change|determine|influence|reshape|shape)\w*\b[^.!?]*\b(?:main story|main quest|plot|narrative|ending)\b/i;
  return evidence.split(/(?<=[.!?])\s+/).some((sentence) =>
    !/\b(?:no|not|never|doesn['’]t|don['’]t|cannot|can['’]t|without)\b/i.test(sentence)
    && (branchingPlot.test(sentence) || distinctOutcomes.test(sentence) || decisionEffects.test(sentence)));
}

// Declaring a sequence, or turning a possible effect into a routine result,
// changes the claim even when the source and the game both match.
function strengthenedWording(claim: string, evidence: string): string | undefined {
  const sequence = /\balternat(?:e|es|ed|ing) between\b/i.exec(claim);
  if (sequence && !/\b(?:alternat(?:e|es|ed|ing)|take turns|in turn)\b/i.test(evidence)) return sequence[0];
  for (const [, verb] of evidence.matchAll(/\b(?:can|could|may|might) ([a-z]{3,})\b/gi)) {
    const result = new RegExp(`\\b${verb}(?:s|es)?\\b`, "i").exec(claim);
    if (result && !/\b(?:can|could|may|might|sometimes|potentially|possible|occasionally)\b/i.test(claim)) return result[0];
  }
  return undefined;
}

export function validateObservationSynthesis(
  value: unknown, appid: number, sources: readonly ObservationSource[],
  { clauses }: { clauses?: ClauseVersion } = {},
) {
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
  let previousLeadPreview: string | undefined;
  const previewDedupKeys = new WeakMap<object, string>();
  function claim(raw: unknown, section: string, kind: ObservationKind, category?: unknown) {
    const entry = object(raw);
    const refs = list(entry.observationRefs);
    const resolve = refs.map((rawRef) => {
      const { sourceIdentity, observationId } = object(rawRef);
      const source = typeof sourceIdentity === "string" ? sourceByIdentity.get(sourceIdentity) : undefined;
      const observation = source?.observations.find(({ id }) => id === observationId);
      return source && observation?.appid === appid ? { source, observation } : null;
    });
    if (resolve.length === 0 || resolve.some((ref) => ref === null)) {
      omit(section, "missing or unknown observation reference", refs);
      return [];
    }
    const support = resolve.filter((ref) => ref !== null);
    if (support.some(({ source, observation }) => section === "statements"
      ? !canSupportLead(source, observation, clauses)
      : kind === "tag" ? !canSupportTag(observation, clauses)
      : observation.kind !== kind || (category !== undefined && category !== observation.category))) {
      omit(section, "referenced observation has a different evidence category", refs);
      return [];
    }
    const authoredTag = usesAuthoredTags(clauses) && kind === "tag";
    const label = authoredTag && clauses === "v27" ? withoutTagCoverageWording(entry.label) : entry.label;
    if (authoredTag && !isDiscoveryLabel(label, clauses)) {
      omit(section, "tag label must be a concise discovery phrase", refs);
      return [];
    }
    const preview = usesPreviewScope(clauses) && kind !== "tag" ? claimPreviewScope(support[0]!.source, support[0]!.observation) : undefined;
    const authoredText = kind === "tag" ? line(label, 600) : line(entry.text, Infinity);
    const matchingText = preview ? withoutPreviewQualifierList(authoredText, preview) : authoredText;
    if (preview && preview !== "hands-on preview" && /(?<!non[- ])\bhands[- ]on (?:preview|play|demo|demonstration|session)\b/i.test(matchingText)) {
      omit(section, "claim describes firsthand play without hands-on evidence", refs);
      return [];
    }
    const sourceTexts = [...new Set(support.map(({ observation }) => observation.text))];
    if (usesArticleTags(clauses) && authoredTag
      && (isTechnicalTagEvidence(matchingText) || sourceTexts.some(isTechnicalTagEvidence))) {
      omit(section, "tag describes or relies on a technical complaint or benchmark", refs);
      return [];
    }
    if (usesArticleTags(clauses) && authoredTag && /\bsingle[ -]player\b/i.test(matchingText)
      && sourceTexts.some((evidence) => !/\bsingle[ -]player\b/i.test(evidence))) {
      omit(section, "evidence does not identify a single-player mode", refs);
      return [];
    }
    if (usesBrowseTags(clauses) && authoredTag && /\bisometric\b/i.test(matchingText)
      && sourceTexts.some((evidence) => !/\bisometric\b/i.test(evidence))) {
      omit(section, "evidence does not establish an isometric view", refs);
      return [];
    }
    if (usesTagFirst(clauses) && authoredTag && /\bbranching (?:main )?(?:story(?:line)?|plot|narrative)\b/i.test(matchingText)
      && sourceTexts.some((evidence) => !supportsStoryBranching(evidence))) {
      omit(section, "evidence does not establish story branching", refs);
      return [];
    }
    const semantic = clauses !== undefined && (kind !== "tag" || authoredTag);
    const contested = !semantic && entry.contested === true && category !== undefined;
    const projectedTag = clauses === "v19" && kind === "tag";
    const displays = [...new Set(support.map(({ observation }) => observationDisplay(observation, clauses)))];
    const scopes = semantic ? support.map(({ source, observation }) => authoredTag ? authoredTagScope(source, observation, clauses) : observationScope(source, observation, clauses)) : [];
    if (semantic) {
      const scopeKeys = new Set(scopes.map(({ key }) => key));
      if (scopeKeys.size !== 1) {
        omit(section, "claim combines different evidence scopes", refs);
        return [];
      }
      const outlet = MEDIA_OUTLETS.find(({ name }) => contains(matchingText, name));
      if (!matchingText || outlet) {
        omit(section, outlet ? "claim names an outlet" : "claim has no wording", refs, outlet?.name);
        return [];
      }
      if (clauses !== "v12") {
        for (const evidence of sourceTexts) {
          const trigger = strengthenedWording(matchingText, evidence);
          if (trigger) {
            omit(section, "claim adds unsupported sequence or certainty", refs, trigger);
            return [];
          }
        }
      }
      const attribution = clauses !== "v12" && /\b(?:reviewers?|(?:was|were|is|are) (?:described|reported))\b/i.exec(matchingText)?.[0];
      if (attribution) {
        omit(section, "claim describes source attribution instead of the game", refs, attribution);
        return [];
      }
    } else if (contested) {
      const scopes = new Set(support.map(({ observation }) => JSON.stringify([...observation.qualifiers].sort())));
      if (sourceTexts.length < 2 || scopes.size !== 1 || matchingText !== sourceTexts.join(" / ")) {
        omit(section, "disagreement requires distinct observations with the same scope and wording joined by ' / '", refs);
        return [];
      }
    } else if ((!projectedTag && sourceTexts.length !== 1) || matchingText !== sourceTexts[0] || displays.length !== 1) {
      omit(section, "claim wording or scope differs from its observations", refs);
      return [];
    }
    const timing = scopes[0]?.timing;
    const unsupported = timing && unsupportedTiming(matchingText, timing);
    if (unsupported) {
      omit(section, "claim introduces technical timing absent from its evidence", refs, unsupported);
      return [];
    }
    const qualifiers = scopes[0]?.qualifiers ?? [];
    if ((clauses === "v14" || isComposedLead(clauses)) && semantic) {
      const supported = new Set(versionMarkers(qualifiers.join(" ")).keys());
      const unsupported = [...versionMarkers(matchingText)].find(([key, label]) =>
        !supported.has(key) && (!timing || !timingMarkers(label).size));
      if (unsupported) {
        omit(section, "claim introduces a version distinction absent from its evidence", refs, unsupported[1]);
        return [];
      }
    }
    const displayedTiming = timingMarkers(matchingText);
    const missingTiming = timing?.filter((label) => [...timingMarkers(label).keys()].some((key) => !displayedTiming.has(key))) ?? [];
    const displayQualifiers = timing ? [...qualifiers.filter((label) => !timing.includes(label)), ...missingTiming] : qualifiers;
    if (authoredTag) {
      const unsupported = unsupportedTiming(matchingText, qualifiers);
      if (unsupported) {
        omit(section, "tag introduces timing absent from its evidence", refs, unsupported);
        return [];
      }
    }
    const punctuation = isComposedLead(clauses) && (section === "statements" || timing) ? /[,;:.!?]$/.exec(matchingText)?.[0] ?? "" : "";
    const unpunctuatedWording = punctuation ? matchingText.slice(0, -1) : matchingText;
    const tagWording = usesTagFirst(clauses) && authoredTag
      ? unpunctuatedWording.replace(/^Dungeons (?:&|and) Dragons (5th Edition)(?: rules(?:et| basis)?)?(?=$| \([^()]+\)$)/i, "D&D $1")
      : unpunctuatedWording;
    const wording = usesControllerTags(clauses) && authoredTag ? omitImpliedControllerPlatform(tagWording) : tagWording;
    const sourceUrls = [...new Set(support.map(({ source }) => source.sourceUrl))];
    const previewKey = preview ? JSON.stringify([preview, [...sourceUrls].sort()]) : undefined;
    const needsPreviewLabel = preview && !PREVIEW_WORDING[preview].test(wording)
      && (section !== "statements" || previewKey !== previousLeadPreview);
    const sourceHasOtherPreviewScope = support[0]!.source.previewScope;
    const proseQualifiers = preview
      ? [
        ...displayQualifiers.filter((label) => !isPreviewCoverageLabel(label, preview) && !(sourceHasOtherPreviewScope && label === sourceHasOtherPreviewScope)),
        ...(needsPreviewLabel ? [preview === "non-hands-on preview" ? "hands-off preview" : preview] : []),
      ] : displayQualifiers;
    const text = semantic
      ? displayText({
        ...support[0]!.observation,
        text: missingTiming.includes(DURING_REVIEW) ? `${wording} ${DURING_REVIEW}` : wording,
        qualifiers: authoredTag
          ? missingTagQualifiers(wording, displayQualifiers, clauses)
          : clauses === "v19" || usesAuthoredTags(clauses)
            ? proseQualifiers.filter((q) => !includesHardwareQualifier(wording, q))
            : displayQualifiers,
      }) + punctuation
      : displays.join(" / ");
    const issue = invalidDisplay(text, kind);
    if (issue) {
      omit(section, issue.reason, refs, issue.trigger);
      return [];
    }
    const edition = scopes[0]?.edition;
    if (section === "statements") previousLeadPreview = previewKey;
    const finding = { text, sourceUrls, ...(contested ? { contested } : {}), ...(edition ? { edition } : {}), observationRefs: support.map(({ source, observation }) => ({ sourceIdentity: source.sourceIdentity, observationId: observation.id })) };
    if (preview) {
      previewDedupKeys.set(finding, JSON.stringify([preview, withoutPreviewQualifierList(text, preview).toLowerCase().replace(/[.!?]+$/, "")]));
    }
    return [finding];
  }
  const root = object(value);
  for (const raw of list(root.categories)) {
    const category = object(raw);
    if (typeof category.name === "string" && categoryNames.has(category.name)) continue;
    for (const entry of list(category.findings)) {
      omit("categories", "unsupported evidence category", list(object(entry).observationRefs));
    }
  }
  const seenText = new Set<string>();
  const seenEvidence = new Set<string>();
  function uniqueFinding(finding: ReturnType<typeof claim>[number]): boolean {
    if (!clauses) return true;
    const textKey = JSON.stringify([finding.edition, previewDedupKeys.get(finding) ?? finding.text.toLowerCase().replace(/[.!?]+$/, "")]);
    const evidenceKey = JSON.stringify(finding.observationRefs.map((ref) => JSON.stringify(ref)).sort());
    if (seenText.has(textKey) || (clauses === "v12" && seenEvidence.has(evidenceKey))) return false;
    seenText.add(textKey);
    seenEvidence.add(evidenceKey);
    return true;
  }
  const statements = list(root.statements).slice(0, 60).flatMap((entry) => {
    const priorPreview = previousLeadPreview;
    const findings = claim(entry, "statements", "finding").filter(uniqueFinding);
    if (findings.length === 0) previousLeadPreview = priorPreview;
    return findings;
  });
  if (statements.length === 0) omit("statements", "no supported statements", []);
  const categories = MEDIA_CATEGORY_NAMES.flatMap((name) => {
    const findings = list(root.categories).map(object).filter((entry) => entry.name === name)
      .flatMap((entry) => list(entry.findings)).slice(0, 60).flatMap((entry) => claim(entry, name, "finding", name)).filter(uniqueFinding);
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
