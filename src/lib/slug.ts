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
