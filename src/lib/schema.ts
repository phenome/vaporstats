import { asc, desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
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
