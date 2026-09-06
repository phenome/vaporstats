import type { AppDatabase } from "./db";
import type { CatalogEntity, GameDetail } from "./catalog";

/**
 * Generates an inline base64 low-quality image placeholder (LQIP)
 * from an image buffer using Bun 1.4 native image processing.
 */
export async function generateLqipFromBuffer(
  buffer: ArrayBuffer | Uint8Array
): Promise<string> {
  const img = new Bun.Image(buffer);
  return await img.placeholder();
}

/**
 * Resizes the full image into a 32x32 square bitmap without cropping,
 * capturing the full visual composition in the interim square placeholder.
 */
export async function generateSquareLqipFromBuffer(
  buffer: ArrayBuffer | Uint8Array
): Promise<string> {
  const img = new Bun.Image(buffer);
  img.resize(32, 32);
  return await img.placeholder();
}

export function getCommunityIconUrl(appid: number, iconHash: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${iconHash}.jpg`;
}

export interface EnsureLqipsOptions {
  customFetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Lazily computes and persists missing header_lqip and icon_lqip placeholders
 * in SQLite for a given game. Bounded by a strict timeout to ensure page loads
 * never hang on external image fetches.
 */
export async function ensureAppLqips<T extends CatalogEntity | GameDetail>(
  db: AppDatabase,
  app: T,
  options: EnsureLqipsOptions = {}
): Promise<{ header_lqip: string | null; icon_lqip: string | null }> {
  let headerLqip = app.header_lqip ?? null;
  let iconLqip = app.icon_lqip ?? null;

  if (headerLqip && iconLqip) {
    return { header_lqip: headerLqip, icon_lqip: iconLqip };
  }

  const fetchFn = options.customFetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  let changed = false;

  try {
    // 1. Generate header_lqip and/or fallback square icon_lqip from header_image
    if ((!headerLqip || (!iconLqip && !app.icon_hash)) && app.header_image) {
      try {
        const res = await fetchFn(app.header_image, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (!headerLqip) {
            headerLqip = await generateLqipFromBuffer(buf);
            changed = true;
          }
          if (!iconLqip && !app.icon_hash) {
            iconLqip = await generateSquareLqipFromBuffer(buf);
            changed = true;
          }
        }
      } catch {
        // Fetch or placeholder generation failed, continue
      }
    }

    // 2. If app has an icon_hash, generate square icon_lqip from the official Steam Community Icon
    if (!iconLqip && app.icon_hash) {
      try {
        const iconUrl = getCommunityIconUrl(app.appid, app.icon_hash);
        const res = await fetchFn(iconUrl, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          iconLqip = await generateSquareLqipFromBuffer(buf);
          changed = true;
        }
      } catch {
        // Icon fetch failed
      }
    }

    if (changed) {
      await db
        .prepare(
          "UPDATE apps SET header_lqip = ?, icon_lqip = ?, updated_at = CURRENT_TIMESTAMP WHERE appid = ?"
        )
        .bind(headerLqip, iconLqip, app.appid)
        .run();
    }
  } catch {
    // Non-fatal: return whatever we have
  }

  return { header_lqip: headerLqip, icon_lqip: iconLqip };
}
