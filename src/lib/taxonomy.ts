import type { AppDatabase } from "./db";

export const FACET_GROUPS = ["genre", "feature", "community_tag"] as const;
export type FacetGroup = (typeof FACET_GROUPS)[number];
export type FacetUpdateStatus = "omitted" | "present";

export interface FacetValue {
  facet_group: FacetGroup;
  source_id: string;
  name: string | null;
  source_order: number;
  weight: number | null;
}

export interface FacetGroupUpdate {
  status: FacetUpdateStatus;
  values: FacetValue[];
}

export type FacetUpdates = Partial<Record<FacetGroup, FacetGroupUpdate>>;

export interface FacetDictionaryEntry {
  facet_group: FacetGroup;
  source_id: string;
  name: string | null;
}

export interface AppFacet extends FacetValue {
  updated_at?: string;
}

export interface FacetQueryOptions {
  group?: FacetGroup;
  search?: string;
  limit?: number;
  offset?: number;
}

const MAX_COMMUNITY_TAGS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sourceIdValue(value: unknown): string | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : null;
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function nameValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : null;
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function updateFromArray(
  group: FacetGroup,
  raw: unknown,
  idKeys: readonly string[],
  nameKeys: readonly string[],
  weightKeys: readonly string[] = [],
  limit?: number
): FacetGroupUpdate | undefined {
  if (!Array.isArray(raw)) return undefined;

  const values: FacetValue[] = [];
  const seen = new Set<string>();
  const source = limit === undefined ? raw : raw.slice(0, limit);
  source.forEach((entry, sourceOrder) => {
    const record = isRecord(entry) ? entry : null;
    const sourceId = record
      ? idKeys.map((key) => sourceIdValue(record[key])).find((value): value is string => value !== null)
      : sourceIdValue(entry);
    if (!sourceId || seen.has(sourceId)) return;
    seen.add(sourceId);

    const name = record
      ? nameKeys.map((key) => nameValue(record[key])).find((value): value is string => value !== null) ?? null
      : null;
    const weight =
      record && weightKeys.length > 0
        ? weightKeys
            .map((key) => nonNegativeInteger(record[key]))
            .find((value): value is number => value !== null) ?? null
        : null;
    values.push({ facet_group: group, source_id: sourceId, name, source_order: sourceOrder, weight });
  });

  if (source.length > 0 && values.length === 0) return undefined;
  return { status: "present", values };
}

/** Maps the existing Steam appdetails genres/categories response into separate groups. */
export function mapSteamAppDetailsFacets(payload: unknown): FacetUpdates {
  if (!isRecord(payload)) return {};
  const updates: FacetUpdates = {};
  if (hasOwn(payload, "genres")) {
    const update = updateFromArray("genre", payload.genres, ["id", "genreid"], ["description", "name"]);
    if (update) updates.genre = update;
  }
  if (hasOwn(payload, "categories")) {
    const update = updateFromArray("feature", payload.categories, ["id", "categoryid"], ["description", "name"]);
    if (update) updates.feature = update;
  }
  return updates;
}

/**
 * Maps StoreBrowse tags in source order. The first twenty source entries are
 * selected before deduplication or malformed-entry filtering.
 */
export function mapSteamStoreBrowseTags(tagsOrItem: unknown, tagids?: unknown): FacetGroupUpdate | undefined {
  let tags = tagsOrItem;
  let ids = tagids;
  if (isRecord(tagsOrItem) && tagids === undefined) {
    tags = hasOwn(tagsOrItem, "tags") ? tagsOrItem.tags : undefined;
    ids = hasOwn(tagsOrItem, "tagids") ? tagsOrItem.tagids : undefined;
  }

  const tagArray = Array.isArray(tags) ? tags : null;
  const idArray = Array.isArray(ids) ? ids : null;
  if (!tagArray && !idArray) return undefined;
  const source = tagArray ?? idArray ?? [];
  const values: FacetValue[] = [];
  const seen = new Set<string>();

  source.slice(0, MAX_COMMUNITY_TAGS).forEach((entry, sourceOrder) => {
    const record = isRecord(entry) ? entry : null;
    const sourceId = record
      ? ["tagid", "tag_id", "id"]
          .map((key) => sourceIdValue(record[key]))
          .find((value): value is string => value !== null) ??
        sourceIdValue(idArray?.[sourceOrder])
      : sourceIdValue(entry);
    if (!sourceId || seen.has(sourceId)) return;
    seen.add(sourceId);
    // Community labels come only from the shared GetTagList dictionary.
    const name = null;
    const weight = record
      ? ["weight", "count"]
          .map((key) => nonNegativeInteger(record[key]))
          .find((value): value is number => value !== null) ?? null
      : null;
    values.push({
      facet_group: "community_tag",
      source_id: sourceId,
      name,
      source_order: sourceOrder,
      weight,
    });
  });

  if (source.length > 0 && values.length === 0) return undefined;
  return { status: "present", values };
}

/** Parses the shared Steam GetTagList response without inventing labels. */
export function parseSteamTagDictionaryResponse(payload: unknown): FacetDictionaryEntry[] | null {
  const root = isRecord(payload) ? payload : null;
  const response = root && isRecord(root.response) ? root.response : null;
  const raw = response
    ? response.tags ?? response.taglist ?? response.tag_list
    : root?.tags ?? root?.taglist ?? root?.tag_list;
  if (!Array.isArray(raw)) return null;

  const result: FacetDictionaryEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const sourceId = ["tagid", "tag_id", "id"]
      .map((key) => sourceIdValue(item[key]))
      .find((value): value is string => value !== null);
    const name = ["name", "tag_name", "description"]
      .map((key) => nameValue(item[key]))
      .find((value): value is string => value !== null) ?? null;
    if (!sourceId || seen.has(sourceId) || !name) continue;
    seen.add(sourceId);
    result.push({ facet_group: "community_tag", source_id: sourceId, name });
  }
  return result;
}

function normalizedValues(values: FacetValue[], group: FacetGroup): FacetValue[] {
  const seen = new Set<string>();
  return values.flatMap((value, index) => {
    const sourceId = sourceIdValue(value.source_id);
    if (!sourceId || seen.has(sourceId)) return [];
    seen.add(sourceId);
    return [
      {
        facet_group: group,
        source_id: sourceId,
        name: nameValue(value.name),
        source_order: Number.isSafeInteger(value.source_order) && value.source_order >= 0 ? value.source_order : index,
        weight: nonNegativeInteger(value.weight),
      },
    ];
  });
}

/**
 * Applies only present groups. Omitted groups are untouched; present empty groups
 * clear memberships. Dictionary rows are retained even when their name is unknown.
 */
export async function syncAppFacets(
  db: AppDatabase,
  appid: number,
  updates: FacetUpdates | null | undefined
): Promise<void> {
  if (!updates) return;
  const statements = [];
  for (const group of FACET_GROUPS) {
    const update = updates[group];
    if (!update || update.status !== "present") continue;
    const values = normalizedValues(update.values, group);
    statements.push(
      db.prepare("DELETE FROM app_facet_memberships WHERE appid = ? AND facet_group = ?").bind(appid, group),
    );
    for (const value of values) {
      statements.push(
        db
          .prepare(
            `INSERT INTO app_facets (facet_group, source_id, name, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(facet_group, source_id) DO UPDATE SET
               name = COALESCE(excluded.name, app_facets.name),
               updated_at = CASE WHEN excluded.name IS NOT NULL THEN CURRENT_TIMESTAMP ELSE app_facets.updated_at END`,
          )
          .bind(group, value.source_id, value.name),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO app_facet_memberships
              (appid, facet_group, source_id, source_order, weight, updated_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(appid, facet_group, source_id) DO UPDATE SET
               source_order = excluded.source_order,
               weight = excluded.weight,
               updated_at = CURRENT_TIMESTAMP`,
          )
          .bind(appid, group, value.source_id, value.source_order, value.weight),
      );
    }
  }
  if (statements.length > 0) await db.batch(statements);
}

/** Updates shared facet names after a successful dictionary response. */
export async function syncFacetDictionary(
  db: AppDatabase,
  entries: readonly FacetDictionaryEntry[],
): Promise<number> {
  const statements = entries.flatMap((entry) => {
    const sourceId = sourceIdValue(entry.source_id);
    const name = nameValue(entry.name);
    if (!sourceId || !name || !FACET_GROUPS.includes(entry.facet_group)) return [];
    return [
      db
        .prepare(
          `INSERT INTO app_facets (facet_group, source_id, name, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(facet_group, source_id) DO UPDATE SET
             name = excluded.name,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(entry.facet_group, sourceId, name),
    ];
  });
  if (statements.length > 0) await db.batch(statements);
  return statements.length;
}

/** Lists named dictionary values; unknown IDs are intentionally hidden. */
export async function listFacetDictionary(
  db: AppDatabase,
  options: FacetQueryOptions = {},
): Promise<FacetDictionaryEntry[]> {
  const clauses = ["name IS NOT NULL", "length(trim(name)) > 0"];
  const bindings: unknown[] = [];
  if (options.group) {
    clauses.push("facet_group = ?");
    bindings.push(options.group);
  }
  if (options.search?.trim()) {
    clauses.push("LOWER(name) LIKE LOWER(?)");
    bindings.push(`%${options.search.trim()}%`);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  bindings.push(limit, offset);
  const result = await db
    .prepare(
      `SELECT facet_group, source_id, name
       FROM app_facets
       WHERE ${clauses.join(" AND ")}
       ORDER BY name COLLATE NOCASE ASC, facet_group ASC, source_id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings)
    .all<FacetDictionaryEntry>();
  return result.results ?? [];
}

/** Lists an app's current memberships in source order, including unknown IDs. */
export async function listAppFacets(
  db: AppDatabase,
  appid: number,
  group?: FacetGroup,
): Promise<AppFacet[]> {
  const bindings: unknown[] = [appid];
  const groupClause = group ? " AND membership.facet_group = ?" : "";
  if (group) bindings.push(group);
  const result = await db
    .prepare(
      `SELECT membership.facet_group, membership.source_id, facet.name,
              membership.source_order, membership.weight, membership.updated_at
       FROM app_facet_memberships AS membership
       LEFT JOIN app_facets AS facet
         ON facet.facet_group = membership.facet_group
        AND facet.source_id = membership.source_id
       WHERE membership.appid = ?${groupClause}
       ORDER BY membership.facet_group ASC, membership.source_order ASC, membership.source_id ASC`,
    )
    .bind(...bindings)
    .all<AppFacet>();
  return result.results ?? [];
}

