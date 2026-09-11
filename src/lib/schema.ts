import { asc, desc, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

export const apps = sqliteTable(
  "apps",
  {
    appid: integer("appid").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    type: text("type").notNull().default("game"),
    isEligible: integer("is_eligible").notNull().default(1),
    isPlayable: integer("is_playable").notNull().default(1),
    parentAppid: integer("parent_appid"),
    releaseDate: text("release_date"),
    releaseStatus: text("release_status").notNull().default("released"),
    description: text("description").default(""),
    headerImage: text("header_image").default(""),
    headerLqip: text("header_lqip"),
    iconHash: text("icon_hash"),
    iconLqip: text("icon_lqip"),
    developer: text("developer").default(""),
    publisher: text("publisher").default(""),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
    steamReleaseDate: text("steam_release_date"),
    originalReleaseDate: text("original_release_date"),
    originalSteamReleaseDate: text("original_steam_release_date"),
    releaseFromEarlyAccessDate: text("release_from_early_access_date"),
    releaseDateSource: text("release_date_source"),
    isEarlyAccess: integer("is_early_access"),
    hasLeftEarlyAccess: integer("has_left_early_access"),
    metacriticScore: integer("metacritic_score"),
    metacriticUrl: text("metacritic_url"),
    metacriticObservedAt: text("metacritic_observed_at"),
  },
  (table) => [
    index("idx_apps_slug").on(table.slug),
    index("idx_apps_type_playable").on(
      table.type,
      table.isPlayable,
      table.isEligible,
    ),
    index("idx_apps_parent").on(table.parentAppid),
    index("idx_apps_release_date").on(table.releaseDate),
    check(
      "apps_release_date_source_check",
      sql`${table.releaseDateSource} IS NULL OR ${table.releaseDateSource} IN ('original_release_date', 'steam_release_date', 'appdetails')`,
    ),
    check(
      "apps_is_early_access_check",
      sql`${table.isEarlyAccess} IS NULL OR ${table.isEarlyAccess} IN (0, 1)`,
    ),
    check(
      "apps_has_left_early_access_check",
      sql`${table.hasLeftEarlyAccess} IS NULL OR ${table.hasLeftEarlyAccess} IN (0, 1)`,
    ),
    check(
      "apps_metacritic_score_check",
      sql`${table.metacriticScore} IS NULL OR (typeof(${table.metacriticScore}) = 'integer' AND ${table.metacriticScore} BETWEEN 0 AND 100)`,
    ),
  ],
);

export const checkpoints = sqliteTable("checkpoints", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  cursor: integer("cursor"),
  updatedAt: text("updated_at").notNull().default(currentTimestamp),
});

export const observations = sqliteTable(
  "observations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appid: integer("appid").notNull(),
    currentPlayers: integer("current_players").notNull(),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("idx_observations_appid_observed_at").on(
      table.appid,
      desc(table.observedAt),
    ),
    index("idx_observations_observed_at").on(table.observedAt),
  ],
);

export const trackedGames = sqliteTable(
  "tracked_games",
  {
    appid: integer("appid").primaryKey(),
    tier: text("tier").notNull().default("daily"),
    slot: integer("slot").notNull().default(0),
    nextDueAt: text("next_due_at").notNull(),
    lastAttemptedAt: text("last_attempted_at"),
    lastSuccessfulAt: text("last_successful_at"),
    latestPlayers: integer("latest_players"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("idx_tracked_games_tier_due").on(table.tier, table.nextDueAt),
    index("idx_tracked_games_next_due").on(table.nextDueAt),
  ],
);

export const playerDailyRequests = sqliteTable("player_daily_requests", {
  date: text("date").primaryKey(),
  count: integer("count").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(currentTimestamp),
});

export const playerRollups = sqliteTable(
  "player_rollups",
  {
    appid: integer("appid").notNull(),
    date: text("date").notNull(),
    minPlayers: integer("min_players").notNull(),
    maxPlayers: integer("max_players").notNull(),
    avgPlayers: real("avg_players").notNull(),
    closePlayers: integer("close_players").notNull(),
    sampleCount: integer("sample_count").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.appid, table.date] }),
    index("idx_player_rollups_date").on(table.date),
    index("idx_player_rollups_appid_date").on(
      table.appid,
      desc(table.date),
    ),
  ],
);

export const appRelationships = sqliteTable(
  "app_relationships",
  {
    parentAppid: integer("parent_appid").notNull(),
    childAppid: integer("child_appid").notNull(),
    relationshipType: text("relationship_type").notNull(),
    prominence: integer("prominence").notNull().default(0),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.parentAppid, table.childAppid] }),
    index("idx_app_relationships_parent").on(
      table.parentAppid,
      table.relationshipType,
    ),
    index("idx_app_relationships_child").on(table.childAppid),
    index("idx_app_relationships_type").on(table.relationshipType),
  ],
);

export const appPrices = sqliteTable(
  "app_prices",
  {
    appid: integer("appid").primaryKey(),
    currency: text("currency").notNull().default("USD"),
    initialPrice: integer("initial_price"),
    finalPrice: integer("final_price"),
    discountPercent: integer("discount_percent").notNull().default(0),
    isFree: integer("is_free").notNull().default(0),
    isAvailable: integer("is_available").notNull().default(1),
    formattedInitial: text("formatted_initial"),
    formattedFinal: text("formatted_final"),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("idx_app_prices_discount").on(
      table.discountPercent,
      table.isAvailable,
    ),
    index("idx_app_prices_observed").on(table.observedAt),
  ],
);

export const priceHistory = sqliteTable(
  "price_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appid: integer("appid").notNull(),
    currency: text("currency").notNull().default("USD"),
    initialPrice: integer("initial_price"),
    finalPrice: integer("final_price"),
    discountPercent: integer("discount_percent").notNull().default(0),
    isFree: integer("is_free").notNull().default(0),
    isAvailable: integer("is_available").notNull().default(1),
    formattedPrice: text("formatted_price"),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("idx_price_history_appid_observed").on(
      table.appid,
      asc(table.observedAt),
    ),
    index("idx_price_history_observed").on(table.observedAt),
  ],
);

export const releaseFacts = sqliteTable(
  "release_facts",
  {
    appid: integer("appid").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    type: text("type").notNull(),
    parentAppid: integer("parent_appid"),
    releaseDate: text("release_date").notNull(),
    releaseYear: integer("release_year").notNull(),
    releaseWeek: text("release_week").notNull(),
    releaseStatus: text("release_status").notNull(),
    isPrecise: integer("is_precise").notNull().default(1),
    headerImage: text("header_image").default(""),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("idx_release_facts_week").on(table.releaseWeek, table.releaseDate),
    index("idx_release_facts_date").on(table.releaseDate),
    index("idx_release_facts_parent").on(table.parentAppid),
    index("idx_release_facts_type").on(table.type),
  ],
);

export const appReleaseEvents = sqliteTable(
  "app_release_events",
  {
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    source: text("source").notNull(),
    eventDate: text("event_date").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.appid, table.eventType, table.eventDate] }),
    check(
      "app_release_events_event_type_check",
      sql`${table.eventType} IN ('early_access', 'full_release', 'patch')`,
    ),
    check(
      "app_release_events_source_check",
      sql`${table.source} IN ('original_steam_release_date', 'release_from_early_access_date', 'original_release_date')`,
    ),
    index("idx_app_release_events_date").on(
      table.eventDate,
      table.appid,
    ),
    index("idx_app_release_events_appid").on(
      table.appid,
      table.eventDate,
    ),
  ],
);

export const appReleasePlans = sqliteTable(
  "app_release_plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    expectedDate: text("expected_date").notNull(),
    observedAt: text("observed_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("idx_app_release_plans_appid_observed_at").on(
      table.appid,
      asc(table.observedAt),
    ),
  ],
);


export const steamEvents = sqliteTable(
  "steam_events",
  {
    eventId: text("event_id").primaryKey(),
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    category: text("category"),
    title: text("title"),
    url: text("url"),
    startAt: text("start_at"),
    publicationAt: text("publication_at"),
    observedAt: text("observed_at").notNull(),
    source: text("source").notNull().default("steam_news_hub"),
    provenance: text("provenance").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    check(
      "steam_events_category_check",
      sql`${table.category} IS NULL OR length(trim(${table.category})) > 0`,
    ),
    check(
      "steam_events_dates_check",
      sql`(${table.startAt} IS NULL OR length(trim(${table.startAt})) > 0) AND (${table.publicationAt} IS NULL OR length(trim(${table.publicationAt})) > 0)`,
    ),
    index("idx_steam_events_appid_start").on(table.appid, desc(table.startAt)),
    index("idx_steam_events_appid_publication").on(
      table.appid,
      desc(table.publicationAt),
    ),
  ],
);

export const reviewSources = sqliteTable(
  "review_sources",
  {
    id: text("id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    requestFilter: text("request_filter").notNull(),
    language: text("language"),
    purchaseType: text("purchase_type"),
    dayRange: integer("day_range"),
    filterOfftopicActivity: integer("filter_offtopic_activity"),
    population: text("population").notNull(),
    populationFlags: text("population_flags").notNull().default("{}"),
    interpretationVersion: text("interpretation_version").notNull(),
    identityKey: text("identity_key").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("uq_review_sources_identity").on(table.identityKey),
    check(
      "review_sources_endpoint_check",
      sql`${table.endpoint} IN ('appreviews', 'appreviewhistogram')`,
    ),
    check(
      "review_sources_day_range_check",
      sql`${table.dayRange} IS NULL OR (typeof(${table.dayRange}) = 'integer' AND ${table.dayRange} >= 0)`,
    ),
    check(
      "review_sources_filter_offtopic_check",
      sql`${table.filterOfftopicActivity} IS NULL OR (typeof(${table.filterOfftopicActivity}) = 'integer' AND ${table.filterOfftopicActivity} IN (0, 1))`,
    ),
    check(
      "review_sources_identity_key_check",
      sql`length(trim(${table.identityKey})) > 0`,
    ),
  ],
);

export const reviewBuckets = sqliteTable(
  "review_buckets",
  {
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => reviewSources.id, { onDelete: "restrict" }),
    granularity: text("granularity").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    positiveCount: integer("positive_count").notNull(),
    negativeCount: integer("negative_count").notNull(),
    observedAt: text("observed_at").notNull(),
    provenance: text("provenance").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.appid,
        table.sourceId,
        table.granularity,
        table.periodStart,
        table.periodEnd,
      ],
    }),
    check(
      "review_buckets_granularity_check",
      sql`${table.granularity} IN ('daily', 'monthly')`,
    ),
    check(
      "review_buckets_interval_check",
      sql`${table.periodStart} < ${table.periodEnd}`,
    ),
    check(
      "review_buckets_positive_count_check",
      sql`typeof(${table.positiveCount}) = 'integer' AND ${table.positiveCount} >= 0`,
    ),
    check(
      "review_buckets_negative_count_check",
      sql`typeof(${table.negativeCount}) = 'integer' AND ${table.negativeCount} >= 0`,
    ),
    index("idx_review_buckets_appid_period").on(
      table.appid,
      asc(table.periodStart),
      asc(table.periodEnd),
    ),
    index("idx_review_buckets_source_period").on(
      table.sourceId,
      asc(table.periodStart),
      asc(table.periodEnd),
    ),
  ],
);

export const reviewSummarySnapshots = sqliteTable(
  "review_summary_snapshots",
  {
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => reviewSources.id, { onDelete: "restrict" }),
    observedAt: text("observed_at").notNull(),
    lifetimePositiveCount: integer("lifetime_positive_count").notNull(),
    lifetimeTotalCount: integer("lifetime_total_count").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.appid, table.sourceId, table.observedAt] }),
    check(
      "review_summary_positive_count_check",
      sql`typeof(${table.lifetimePositiveCount}) = 'integer' AND ${table.lifetimePositiveCount} >= 0 AND ${table.lifetimePositiveCount} <= ${table.lifetimeTotalCount}`,
    ),
    check(
      "review_summary_total_count_check",
      sql`typeof(${table.lifetimeTotalCount}) = 'integer' AND ${table.lifetimeTotalCount} >= 0`,
    ),
    index("idx_review_summaries_appid_observed").on(
      table.appid,
      desc(table.observedAt),
    ),
    index("idx_review_summaries_source_observed").on(
      table.sourceId,
      desc(table.observedAt),
    ),
  ],
);

export const appFacets = sqliteTable(
  "app_facets",
  {
    facetGroup: text("facet_group").notNull(),
    sourceId: text("source_id").notNull(),
    name: text("name"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.facetGroup, table.sourceId] }),
    check(
      "app_facets_group_check",
      sql`${table.facetGroup} IN ('genre', 'feature', 'community_tag')`,
    ),
    check(
      "app_facets_source_id_check",
      sql`length(trim(${table.sourceId})) > 0`,
    ),
    index("idx_app_facets_group_name").on(table.facetGroup, table.name),
  ],
);

export const appFacetMemberships = sqliteTable(
  "app_facet_memberships",
  {
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    facetGroup: text("facet_group").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrder: integer("source_order").notNull(),
    weight: integer("weight"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.appid, table.facetGroup, table.sourceId] }),
    foreignKey({
      columns: [table.facetGroup, table.sourceId],
      foreignColumns: [appFacets.facetGroup, appFacets.sourceId],
      name: "fk_app_facet_memberships_facet",
    }),
    check(
      "app_facet_memberships_group_check",
      sql`${table.facetGroup} IN ('genre', 'feature', 'community_tag')`,
    ),
    check(
      "app_facet_memberships_order_check",
      sql`typeof(${table.sourceOrder}) = 'integer' AND ${table.sourceOrder} >= 0`,
    ),
    check(
      "app_facet_memberships_weight_check",
      sql`${table.weight} IS NULL OR (typeof(${table.weight}) = 'integer' AND ${table.weight} >= 0)`,
    ),
    index("idx_app_facet_memberships_app_group_order").on(
      table.appid,
      table.facetGroup,
      table.sourceOrder,
    ),
    index("idx_app_facet_memberships_group_source").on(
      table.facetGroup,
      table.sourceId,
    ),
  ],
);

export const playerScoreHistory = sqliteTable(
  "player_score_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "restrict" }),
    observedAt: text("observed_at").notNull(),
    score: real("score").notNull(),
    formulaVersion: text("formula_version").notNull(),
    currentPositiveCount: integer("current_positive_count").notNull(),
    currentTotalCount: integer("current_total_count").notNull(),
    historicalPositiveCount: integer("historical_positive_count").notNull(),
    historicalTotalCount: integer("historical_total_count").notNull(),
    currentWindowStart: text("current_window_start").notNull(),
    currentWindowEnd: text("current_window_end").notNull(),
    historicalWindowStart: text("historical_window_start").notNull(),
    historicalWindowEnd: text("historical_window_end").notNull(),
    currentEvidenceIntervals: text("current_evidence_intervals").notNull(),
    historicalEvidenceIntervals: text("historical_evidence_intervals").notNull(),
    currentSourceId: text("current_source_id").references(() => reviewSources.id, {
      onDelete: "restrict",
    }),
    historicalSourceId: text("historical_source_id").references(() => reviewSources.id, {
      onDelete: "restrict",
    }),
    currentEvidenceObservedAt: text("current_evidence_observed_at"),
    historicalEvidenceObservedAt: text("historical_evidence_observed_at"),
    anchorEventId: text("anchor_event_id"),
    anchorAt: text("anchor_at"),
    provenance: text("provenance").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    check(
      "player_score_history_score_check",
      sql`typeof(${table.score}) IN ('integer', 'real') AND ${table.score} BETWEEN 0 AND 100`,
    ),
    check(
      "player_score_history_current_counts_check",
      sql`typeof(${table.currentPositiveCount}) = 'integer' AND typeof(${table.currentTotalCount}) = 'integer' AND ${table.currentPositiveCount} >= 0 AND ${table.currentTotalCount} >= 0 AND ${table.currentPositiveCount} <= ${table.currentTotalCount}`,
    ),
    check(
      "player_score_history_historical_counts_check",
      sql`typeof(${table.historicalPositiveCount}) = 'integer' AND typeof(${table.historicalTotalCount}) = 'integer' AND ${table.historicalPositiveCount} >= 0 AND ${table.historicalTotalCount} >= 0 AND ${table.historicalPositiveCount} <= ${table.historicalTotalCount}`,
    ),
    check(
      "player_score_history_window_check",
      sql`${table.currentWindowStart} < ${table.currentWindowEnd} AND ${table.historicalWindowStart} < ${table.historicalWindowEnd}`,
    ),
    uniqueIndex("uq_player_score_history_id_appid").on(
      table.id,
      table.appid,
    ),
    index("idx_player_score_history_appid_observed").on(
      table.appid,
      desc(table.observedAt),
    ),
    index("idx_player_score_history_source_observed").on(
      table.currentSourceId,
      desc(table.observedAt),
    ),
    index("idx_player_score_history_historical_source_observed").on(
      table.historicalSourceId,
      desc(table.observedAt),
    ),
  ],
);

export const playerScoreState = sqliteTable(
  "player_score_state",
  {
    appid: integer("appid")
      .primaryKey()
      .references(() => apps.appid, { onDelete: "cascade" }),
    latestScoreHistoryId: integer("latest_score_history_id"),
    historicalPositiveCount: integer("historical_positive_count"),
    historicalTotalCount: integer("historical_total_count"),
    historicalSourceId: text("historical_source_id").references(() => reviewSources.id, {
      onDelete: "restrict",
    }),
    historicalWindowStart: text("historical_window_start"),
    historicalWindowEnd: text("historical_window_end"),
    historicalEvidenceIntervals: text("historical_evidence_intervals").notNull().default("[]"),
    historicalBaselineObservedAt: text("historical_baseline_observed_at"),
    eligibilityReviewCount: integer("eligibility_review_count"),
    eligibilitySourceId: text("eligibility_source_id").references(() => reviewSources.id, {
      onDelete: "restrict",
    }),
    eligibilityWindowStart: text("eligibility_window_start"),
    eligibilityWindowEnd: text("eligibility_window_end"),
    eligibilityEvidenceStart: text("eligibility_evidence_start"),
    eligibilityEvidenceEnd: text("eligibility_evidence_end"),
    eligibilityEvidenceIntervals: text("eligibility_evidence_intervals").notNull().default("[]"),
    eligibilityObservedAt: text("eligibility_observed_at"),
    eligibilityProvenance: text("eligibility_provenance").notNull().default("{}"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    check(
      "player_score_state_historical_counts_check",
      sql`(${table.historicalPositiveCount} IS NULL AND ${table.historicalTotalCount} IS NULL) OR (typeof(${table.historicalPositiveCount}) = 'integer' AND typeof(${table.historicalTotalCount}) = 'integer' AND ${table.historicalPositiveCount} >= 0 AND ${table.historicalTotalCount} >= 0 AND ${table.historicalPositiveCount} <= ${table.historicalTotalCount})`,
    ),
    check(
      "player_score_state_historical_window_check",
      sql`(${table.historicalWindowStart} IS NULL AND ${table.historicalWindowEnd} IS NULL) OR (${table.historicalWindowStart} IS NOT NULL AND ${table.historicalWindowEnd} IS NOT NULL AND ${table.historicalWindowStart} < ${table.historicalWindowEnd})`,
    ),
    check(
      "player_score_state_eligibility_count_check",
      sql`${table.eligibilityReviewCount} IS NULL OR (typeof(${table.eligibilityReviewCount}) = 'integer' AND ${table.eligibilityReviewCount} >= 0)`,
    ),
    check(
      "player_score_state_eligibility_window_check",
      sql`(${table.eligibilityWindowStart} IS NULL AND ${table.eligibilityWindowEnd} IS NULL) OR (${table.eligibilityWindowStart} IS NOT NULL AND ${table.eligibilityWindowEnd} IS NOT NULL AND ${table.eligibilityWindowStart} < ${table.eligibilityWindowEnd})`,
    ),
    check(
      "player_score_state_eligibility_evidence_check",
      sql`(${table.eligibilityEvidenceStart} IS NULL AND ${table.eligibilityEvidenceEnd} IS NULL) OR (${table.eligibilityEvidenceStart} IS NOT NULL AND ${table.eligibilityEvidenceEnd} IS NOT NULL AND ${table.eligibilityEvidenceStart} < ${table.eligibilityEvidenceEnd})`,
    ),
    foreignKey({
      columns: [table.latestScoreHistoryId, table.appid],
      foreignColumns: [playerScoreHistory.id, playerScoreHistory.appid],
      name: "fk_player_score_state_latest_score_app",
    }),
    index("idx_player_score_state_latest_score").on(table.latestScoreHistoryId),
    index("idx_player_score_state_eligibility").on(
      table.eligibilitySourceId,
      table.eligibilityEvidenceStart,
      table.eligibilityEvidenceEnd,
    ),
  ],
);

export const criticRecords = sqliteTable(
  "critic_records",
  {
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    source: text("source").notNull(),
    matchedIdentity: text("matched_identity"),
    platformScope: text("platform_scope").notNull().default("unknown"),
    edition: text("edition"),
    nativeScore: real("native_score"),
    nativeTier: text("native_tier"),
    reviewCount: integer("review_count"),
    scoreScale: integer("score_scale"),
    sourceUrl: text("source_url"),
    reviewPeriodStart: text("review_period_start"),
    reviewPeriodEnd: text("review_period_end"),
    collectionBasis: text("collection_basis").notNull().default("public_page"),
    observedAt: text("observed_at").notNull(),
    lastSuccessAt: text("last_success_at"),
    provenance: text("provenance").notNull().default("{}"),
    basis: text("basis").notNull().default("public aggregate page"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.appid, table.source] }),
    check(
      "critic_records_source_check",
      sql`${table.source} IN ('opencritic', 'metacritic')`,
    ),
    check(
      "critic_records_platform_scope_check",
      sql`${table.platformScope} IN ('pc', 'mixed', 'console', 'unknown')`,
    ),
    check(
      "critic_records_score_check",
      sql`(${table.nativeScore} IS NULL OR (typeof(${table.nativeScore}) IN ('integer', 'real') AND ${table.scoreScale} IS NOT NULL AND ${table.nativeScore} BETWEEN 0 AND ${table.scoreScale})) AND (${table.scoreScale} IS NULL OR (typeof(${table.scoreScale}) = 'integer' AND ${table.scoreScale} > 0))`,
    ),
    check(
      "critic_records_review_count_check",
      sql`${table.reviewCount} IS NULL OR (typeof(${table.reviewCount}) = 'integer' AND ${table.reviewCount} >= 0)`,
    ),
    check(
      "critic_records_review_period_check",
      sql`${table.reviewPeriodStart} IS NULL OR ${table.reviewPeriodEnd} IS NULL OR ${table.reviewPeriodStart} <= ${table.reviewPeriodEnd}`,
    ),
    check(
      "critic_records_collection_basis_check",
      sql`${table.collectionBasis} = 'public_page'`,
    ),
    index("idx_critic_records_source_observed").on(
      table.source,
      desc(table.observedAt),
    ),
  ],
);
export const mediaDiscoveryRuns = sqliteTable(
  "media_discovery_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pass: text("pass").notNull(),
    identityKey: text("identity_key").notNull(),
    selectedGames: text("selected_games").notNull(),
    status: text("status").notNull().default("queued"),
    resumed: integer("resumed").notNull().default(0),
    queryCount: integer("query_count").notNull().default(0),
    articleCount: integer("article_count").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerRequestIds: text("provider_request_ids").notNull().default("[]"),
    usage: text("usage").notNull().default("{}"),
    stopReason: text("stop_reason"),
    summary: text("summary").notNull().default("{}"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    check("media_discovery_runs_pass_check", sql`${table.pass} = 'initial'`),
    check(
      "media_discovery_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'stopped', 'failed')`,
    ),
    check("media_discovery_runs_resumed_check", sql`${table.resumed} IN (0, 1)`),
    check("media_discovery_runs_counts_check", sql`${table.queryCount} >= 0 AND ${table.articleCount} >= 0 AND ${table.attemptCount} >= 0`),
    uniqueIndex("uq_media_discovery_runs_identity").on(table.identityKey),
  ],
);

export const mediaDiscoveryProgress = sqliteTable(
  "media_discovery_progress",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => mediaDiscoveryRuns.id, { onDelete: "cascade" }),
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    pass: text("pass").notNull(),
    outlet: text("outlet").notNull(),
    status: text("status").notNull().default("queued"),
    queryAttemptedAt: text("query_attempted_at"),
    candidateUrls: text("candidate_urls").notNull().default("[]"),
    candidateIndex: integer("candidate_index").notNull().default(0),
    providerRequestId: text("provider_request_id"),
    creditsUsed: integer("credits_used"),
    usage: text("usage").notNull().default("{}"),
    stopReason: text("stop_reason"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("uq_media_discovery_progress_game_outlet_pass").on(
      table.appid,
      table.outlet,
      table.pass,
    ),
    index("idx_media_discovery_progress_run").on(table.runId),
    check("media_discovery_progress_pass_check", sql`${table.pass} = 'initial'`),
    check(
      "media_discovery_progress_outlet_check",
      sql`${table.outlet} IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')`,
    ),
    check(
      "media_discovery_progress_status_check",
      sql`${table.status} IN ('queued', 'searching', 'fetching', 'completed', 'stopped')`,
    ),
    check(
      "media_discovery_progress_candidate_index_check",
      sql`${table.candidateIndex} >= 0`,
    ),
    check(
      "media_discovery_progress_credits_check",
      sql`${table.creditsUsed} IS NULL OR ${table.creditsUsed} >= 0`,
    ),
  ],
);

export const mediaDiscoveryAttempts = sqliteTable(
  "media_discovery_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    outlet: text("outlet").notNull(),
    pass: text("pass").notNull(),
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    url: text("url"),
    statusCode: integer("status_code"),
    succeeded: integer("succeeded").notNull().default(0),
    error: text("error"),
    attemptedAt: text("attempted_at").notNull(),
  },
  (table) => [
    index("idx_media_discovery_attempts_outlet_day").on(table.outlet, table.day),
    index("idx_media_discovery_attempts_game").on(table.appid, table.pass),
    check("media_discovery_attempts_pass_check", sql`${table.pass} = 'initial'`),
    check(
      "media_discovery_attempts_outlet_check",
      sql`${table.outlet} IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')`,
    ),
    check(
      "media_discovery_attempts_kind_check",
      sql`${table.kind} IN ('search', 'fetch', 'redirect', 'failure')`,
    ),
    check("media_discovery_attempts_succeeded_check", sql`${table.succeeded} IN (0, 1)`),
    check(
      "media_discovery_attempts_status_code_check",
      sql`${table.statusCode} IS NULL OR (${table.statusCode} >= 100 AND ${table.statusCode} <= 599)`,
    ),
  ],
);

export const mediaSources = sqliteTable(
  "media_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appid: integer("appid")
      .notNull()
      .references(() => apps.appid, { onDelete: "cascade" }),
    pass: text("pass").notNull(),
    originalUrl: text("original_url").notNull(),
    discoveryUrl: text("discovery_url"),
    title: text("title").notNull(),
    outlet: text("outlet").notNull(),
    author: text("author"),
    publishedAt: text("published_at"),
    updatedAt: text("updated_at"),
    retrievedAt: text("retrieved_at").notNull(),
    type: text("type").notNull(),
    handsOn: integer("hands_on"),
    affiliation: text("affiliation"),
    platform: text("platform"),
    buildContext: text("build_context"),
  },
  (table) => [
    uniqueIndex("uq_media_sources_game_url").on(table.appid, table.originalUrl),
    index("idx_media_sources_game").on(table.appid, table.publishedAt),
    check("media_sources_pass_check", sql`${table.pass} = 'initial'`),
    check(
      "media_sources_outlet_check",
      sql`${table.outlet} IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')`,
    ),
    check("media_sources_type_check", sql`${table.type} IN ('review', 'preview')`),
    check("media_sources_hands_on_check", sql`${table.handsOn} IN (0, 1)`),
  ],
);
