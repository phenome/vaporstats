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
 * Slug generation and URL canonicalization for publishers and developers.
 * Format: /publisher/{id-slug} or /publisher/{slug}
 */
export function toPublisherSlug(name: string): string {
  const normalized = toSlug(name);
  return normalized === "game" ? "publisher" : normalized;
}

export function parsePublisherSlug(param: string): { id?: number; slug: string } | null {
  if (!param) return null;
  const trimmed = param.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+)(?:-(.*))?$/);
  if (match) {
    const id = parseInt(match[1], 10);
    const slug = match[2] ?? "";
    return { id, slug };
  }
  return { slug: trimmed };
}

export function getCanonicalPublisherPath(name: string, id?: number): string {
  const slug = toPublisherSlug(name);
  if (typeof id === "number" && Number.isFinite(id) && id > 0) {
    return `/publisher/${id}-${slug}`;
  }
  return `/publisher/${slug}`;
}
