import { createHash } from "node:crypto";
import document from "../../docs/evaluations/media-unsure-entries.md?raw";

export function mediaEditorialKey(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function readMediaAmendments(markdown: string): ReadonlyMap<string, string> {
  const amendments = new Map<string, string>();
  const blocks = /^<!-- media-amendment ([a-f0-9]{64}) -->\r?\n((?:(?!^<!-- media-amendment )[\s\S])*?)^<!-- \/media-amendment -->\r?$/gm;
  for (const [, key, body] of markdown.matchAll(blocks)) {
    const amendment = body.replace(/\r\n/g, "\n").trim();
    if (amendment) amendments.set(key, amendment);
  }
  return amendments;
}

const amendments = readMediaAmendments(document);

export function mediaAmendment(sourceIdentity: string, observationId: string): string | undefined {
  return amendments.get(mediaEditorialKey(sourceIdentity, observationId));
}

export function isOmissionAmendment(value: string | undefined): boolean {
  return value?.trimStart().toLowerCase().startsWith("omit:") ?? false;
}

export function mediaAmendmentIdentity(sourceIdentity: string, observationId: string): string | undefined {
  const amendment = mediaAmendment(sourceIdentity, observationId);
  if (amendment === undefined) return undefined;
  return isOmissionAmendment(amendment)
    ? mediaEditorialKey(sourceIdentity, observationId, "omit")
    : mediaEditorialKey(sourceIdentity, observationId, "replace", amendment);
}
