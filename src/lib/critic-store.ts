import type { AppDatabase } from "./db";
import {
  normalizeCriticRecord,
  type CriticRecord,
  type CriticSource,
} from "./critics";

type CriticProvenance = {
  sourceId: string;
  title: string;
  slug: string;
  platforms: readonly string[];
  percentRecommended: number | null;
  identityVerified: boolean;
  cadence: "weekly" | "monthly";
};

type CriticRow = {
  appid: number;
  source: CriticSource;
  matched_identity: string | null;
  platform_scope: string;
  edition: string | null;
  native_score: number | null;
  native_tier: CriticRecord["tier"];
  review_count: number | null;
  score_scale: number | null;
  source_url: string | null;
  review_period_start: string | null;
  review_period_end: string | null;
  collection_basis: "public_page";
  observed_at: string;
  provenance: string;
};

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function provenanceFor(record: CriticRecord): CriticProvenance {
  return {
    sourceId: record.sourceId,
    title: record.title,
    slug: record.slug,
    platforms: [...record.platforms],
    percentRecommended: record.percentRecommended,
    identityVerified: record.identityVerified,
    cadence: record.cadence,
  };
}

function fromRow(row: CriticRow): CriticRecord {
  const provenance = parseJson<Partial<CriticProvenance>>(row.provenance) ?? {};
  const matchedIdentity = parseJson<CriticRecord["matchedIdentity"]>(row.matched_identity);
  return {
    source: row.source,
    sourceUrl: row.source_url ?? "",
    sourceId: typeof provenance.sourceId === "string" ? provenance.sourceId : "",
    steamAppId: row.appid,
    title: typeof provenance.title === "string" ? provenance.title : "",
    slug: typeof provenance.slug === "string" ? provenance.slug : "",
    edition: row.edition ?? "",
    platforms: Array.isArray(provenance.platforms)
      ? provenance.platforms.filter((value): value is string => typeof value === "string")
      : [],
    platformScope: row.platform_scope as CriticRecord["platformScope"],
    score: row.native_score,
    tier: row.native_tier,
    reviewCount: row.review_count,
    percentRecommended:
      typeof provenance.percentRecommended === "number" ? provenance.percentRecommended : null,
    reviewPeriodStart: row.review_period_start,
    reviewPeriodEnd: row.review_period_end,
    observedAt: row.observed_at,
    collectionBasis: row.collection_basis,
    matchedIdentity,
    identityVerified: provenance.identityVerified === true,
    cadence: provenance.cadence === "weekly" ? "weekly" : "monthly",
  };
}

/** Read the latest durable source-native record for one Steam app. */
export async function getCriticRecords(
  db: AppDatabase,
  appid: number,
): Promise<CriticRecord[]> {
  const result = await db
    .prepare(
      `SELECT appid, source, matched_identity, platform_scope, edition,
              native_score, native_tier, review_count, score_scale, source_url,
              review_period_start, review_period_end, collection_basis,
              observed_at, provenance
         FROM critic_records
        WHERE appid = ?
        ORDER BY source`,
    )
    .bind(appid)
    .all<CriticRow>();
  return result.results.map(fromRow);
}

/**
 * Upsert one successful public aggregate fetch. Unknown values remain NULL;
 * provider failure paths must not call this function.
 */
export async function persistCriticRecord(
  db: AppDatabase,
  input: CriticRecord,
): Promise<void> {
  const record = normalizeCriticRecord(input);
  if (!record || record.collectionBasis !== "public_page") {
    throw new Error("Invalid public critic record");
  }
  if (!record.observedAt) throw new Error("Critic record is missing observedAt");

  await db
    .prepare(
      `INSERT INTO critic_records (
         appid, source, matched_identity, platform_scope, edition,
         native_score, native_tier, review_count, score_scale, source_url,
         review_period_start, review_period_end, collection_basis,
         observed_at, last_success_at, provenance, basis, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public_page', ?, ?, ?,
                 'public aggregate page', CURRENT_TIMESTAMP)
       ON CONFLICT(appid, source) DO UPDATE SET
         matched_identity = excluded.matched_identity,
         platform_scope = excluded.platform_scope,
         edition = excluded.edition,
         native_score = excluded.native_score,
         native_tier = excluded.native_tier,
         review_count = excluded.review_count,
         score_scale = excluded.score_scale,
         source_url = excluded.source_url,
         review_period_start = excluded.review_period_start,
         review_period_end = excluded.review_period_end,
         collection_basis = excluded.collection_basis,
         observed_at = excluded.observed_at,
         last_success_at = excluded.last_success_at,
         provenance = excluded.provenance,
         basis = excluded.basis,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      record.steamAppId,
      record.source,
      record.matchedIdentity ? JSON.stringify(record.matchedIdentity) : null,
      record.platformScope,
      record.edition || null,
      record.score,
      record.tier,
      record.reviewCount,
      record.score === null ? null : 100,
      record.sourceUrl || null,
      record.reviewPeriodStart,
      record.reviewPeriodEnd,
      record.observedAt,
      record.observedAt,
      JSON.stringify(provenanceFor(record)),
    )
    .run();
}
