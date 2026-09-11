import type { AppDatabase } from "./db";

export interface MediaOverview {
  appid: number;
  statements: Array<{ text: string; sourceUrls: string[] }>;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { return null; }
}

function cleanLine(value: string): string {
  return value.replace(/[\t ]+/g, " ").replace(/\s+([,.;!?])/g, "$1").trim();
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function rows<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(query).bind(...values).all<T>()).results ?? [];
}

export function parseMediaOverview(value: unknown, appid: number, allowedUrls: Set<string>): MediaOverview | null {
  const parsed = jsonObject(parseJson(value));
  const candidate: unknown[] = Array.isArray(parsed.statements)
    ? parsed.statements
    : Array.isArray(jsonObject(parsed.overview).statements)
      ? jsonObject(parsed.overview).statements as unknown[]
      : [];
  const statements: MediaOverview["statements"] = [];
  for (const item of candidate) {
    const object = jsonObject(item);
    const text = typeof object.text === "string" ? cleanLine(object.text).slice(0, 1_500) : "";
    const sourceUrls = Array.isArray(object.sourceUrls)
      ? [...new Set(object.sourceUrls.filter((url): url is string => typeof url === "string" && allowedUrls.has(url)))]
      : [];
    if (text && sourceUrls.length > 0) statements.push({ text, sourceUrls });
  }
  return statements.length > 0 ? { appid, statements } : null;
}

export async function getMediaOverview(
  db: AppDatabase,
  appid: number,
  options: { includeUnpublished?: boolean } = {},
): Promise<MediaOverview | null> {
  if (!Number.isInteger(appid) || appid <= 0) return null;
  const publicEnabled = typeof process !== "undefined" && process.env?.MEDIA_OVERVIEW_PUBLIC === "true";
  if (!options.includeUnpublished && !publicEnabled) return null;
  const row = await first<{ output_json: string }>(
    db,
    "SELECT output_json FROM media_game_overviews WHERE appid = ? AND active = 1 ORDER BY id DESC LIMIT 1",
    appid,
  );
  if (!row) return null;
  const sources = await rows<{ original_url: string }>(
    db,
    "SELECT original_url FROM media_sources WHERE appid = ? AND pass = 'initial'",
    appid,
  );
  return parseMediaOverview(row.output_json, appid, new Set(sources.map((source) => source.original_url)));
}
