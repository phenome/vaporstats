/**
 * Slug generation and URL canonicalization for Steam AppIDs and games.
 * Format: /games/{appid}-{slug}
 * The numeric AppID is authoritative.
 */

export function toSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/['’]/g, "") // strip apostrophes before non-alphanumeric replacement
    .replace(/[^a-z0-9]+/g, "-") // replace non-alphanumeric with hyphen
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens

  return normalized || "game";
}

export function parseGameSlug(param: string): { appid: number; slug: string } | null {
  if (!param) return null;
  const match = param.match(/^(\d+)(?:-(.*))?$/);
  if (!match) return null;
  const appid = parseInt(match[1], 10);
  if (isNaN(appid) || appid <= 0) return null;
  const slug = match[2] ?? "";
  return { appid, slug };
}

export function getCanonicalGamePath(appid: number, name: string): string {
  const slug = toSlug(name);
  return `/games/${appid}-${slug}`;
}

/**
 * The ASCII slug is retained solely to resolve old publisher URLs. It is
 * lossy, so a matching slug must never establish a creator identity.
 */
export function toPublisherSlug(name: string): string {
  const normalized = toSlug(name);
  return normalized === "game" ? "publisher" : normalized;
}

export function parsePublisherSlug(param: string): { id?: number; slug: string; exactName?: string } | null {
  if (!param) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(param).trim();
  } catch {
    return null;
  }
  if (!decoded) return null;

  if (decoded.startsWith("~")) {
    const exactName = decoded.slice(1);
    return exactName ? { slug: "", exactName } : null;
  }
  const match = decoded.match(/^(\d+)(?:-(.*))?$/);
  if (match) {
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? { id, slug: match[2] ?? "" } : null;
  }
  return { slug: decoded };
}

export function toPublisherUnicodeSlug(name: string): string {
  return name.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "publisher";
}

export function getCanonicalPublisherPath(name: string, id?: number): string {
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
    return `/publisher/${id}-${encodeURIComponent(toPublisherUnicodeSlug(name))}`;
  }
  return `/publisher/~${encodeURIComponent(name.trim())}`;
}
