import { mediaAmendment, isOmissionAmendment } from "./media-amendments";
import { readArticleObservations, type MediaObservation } from "./media-observations";

type LegacyQuestion = { observationId: string; question: string; wording: string };

// Older extractions kept qualifications at article level. Reuse wording with its
// own explicit scope, or restrict a finding to the explicitly recorded build.
// Matching a scope marker never removes or rewrites the original wording.
function hasExplicitScope(text: string): boolean {
  return /\b(?:early access|preview build|press version|release build|day[- ]0 patch|at launch|at release)\b/i.test(text)
    || /\b(?:version|patch|build)\s+\d+(?:\.\d+)+\b/i.test(text)
    || /\b\d+(?:\.\d+)+\s+(?:version|patch|build|release)\b/i.test(text)
    || /\b(?:on|for) (?:the )?[^.,;]{1,40}\b(?:port|edition)\b/i.test(text);
}

export function legacyObservationEvidence(value: unknown, appid: number, buildContext?: string | null, sourceIdentity?: string, includeArticleTags = false) {
  const observations: MediaObservation[] = [];
  const editorialOmissions: LegacyQuestion[] = [];
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (!value || typeof value !== "object") return { observations, editorialOmissions };
  const root = value as { contributions?: unknown; traits?: unknown; qualifications?: unknown; similarityInputs?: {gameplay?: unknown; storyWorld?: unknown} };
  // Some earlier extractors recorded the tested patch as a standalone field.
  // A sentence discussing multiple versions cannot establish this default.
  const patches = Array.isArray(root.qualifications) ? root.qualifications.filter((scope): scope is string =>
    typeof scope === "string" && /^(?:\d+(?:\.\d+)?\s*(?:MB|GB)\s+)?(?:day[- ]\d+ patch|patch \d+(?:\.\d+)+)$/i.test(scope)) : [];
  const platforms = Array.isArray(root.qualifications) ? root.qualifications.filter((scope): scope is string =>
    typeof scope === "string" && /^[\w -]{1,40} platform$/i.test(scope)) : [];
  const historicalBuilds = Array.isArray(root.qualifications) ? root.qualifications.filter((scope): scope is string =>
    typeof scope === "string" && /^(?:early access|preview|press|alpha|beta|pre[- ]release)(?: build| version)?$/i.test(scope)) : [];
  const assessedBuild = buildContext || (patches.length === 1 ? patches[0] : undefined);
  function record(id: string, text: string, kind: MediaObservation["kind"], category: string) {
    const amended = sourceIdentity ? mediaAmendment(sourceIdentity, id) : undefined;
    if (isOmissionAmendment(amended)) return;
    if (amended) text = amended;
    const explicit = hasExplicitScope(text);
    // A source's build can bound a historical statement. It cannot establish
    // ordinary discovery membership, including whether that build is current.
    // A hardware trait can already name its platform. Confirm that exact name
    // in the article qualifications before retaining the original label.
    const platform = kind === "tag" && /^(?:supports|offers) .+ on ([\w -]+)$/i.exec(text)?.[1];
    const qualifiedTag = platform && Array.isArray(root.qualifications)
      && root.qualifications.some((fact) => typeof fact === "string" && fact.toLowerCase().includes(platform.toLowerCase()));
    const unqualifiedDescription = Array.isArray(root.qualifications) && root.qualifications.length === 0
      && (category === "Gameplay & systems" || category === "Story & world");
    // A bare mode label in the older output does not establish that the article
    // actually identified a single-player mode.
    const articleTag = includeArticleTags && kind === "tag"
      && !/\bsingle[ -]player\b/i.test(text);
    if (amended || qualifiedTag || articleTag || (kind !== "tag" && (explicit || assessedBuild || unqualifiedDescription))) {
      const qualifiers = kind !== "tag" && !explicit && assessedBuild ? [assessedBuild] : [];
      if (articleTag && !buildContext && historicalBuilds.length === 1 && !explicit) {
        qualifiers.push(historicalBuilds[0]!);
      }
      if (qualifiers.length && category === "Technical experience & accessibility" && platforms.length === 1) {
        qualifiers.push(platforms[0]!.replace(/ platform$/i, ""));
      }
      const parsed = readArticleObservations({ observations: [{ id, appid, kind, category, text, qualifiers }] }, appid);
      const releaseLabel = includeArticleTags && kind === "tag"
        && /^(?:early access|preview|press|launch|release|full release)(?: build| version| edition)?[.!]?$/i.test(text);
      if (parsed.length && !releaseLabel && !(kind === "tag" && /^(?:early access|preview)(?: build| version)?$/i.test(text))) {
        observations.push(...parsed);
        return;
      }
    }
    editorialOmissions.push({ observationId: id, wording: text, question: kind === "tag"
      ? "Does the article establish this characteristic at the scope of the discovery label?"
      : "Which version or platform does this observation describe, and does that qualification affect the claim?" });
  }
  if (Array.isArray(root.contributions)) {
    root.contributions.forEach((entry, index) => {
      if (typeof entry?.text === "string" && typeof entry.category === "string") {
        record(`legacy-${index + 1}`, entry.text, "finding", entry.category);
      }
    });
  }
  if (Array.isArray(root.traits)) {
    root.traits.forEach((text, index) => {
      if (typeof text === "string") record(`legacy-tag-${index + 1}`, text, "tag", "");
    });
  }
  for (const dimension of ["gameplay", "storyWorld"] as const) {
    const inputs = root.similarityInputs?.[dimension];
    if (Array.isArray(inputs)) {
      inputs.forEach((text, index) => {
        if (typeof text === "string") record(`legacy-${dimension}-${index + 1}`, text, dimension, "");
      });
    }
  }
  return { observations, editorialOmissions };
}
