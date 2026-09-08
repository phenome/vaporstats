CREATE TABLE `app_facet_memberships` (
	`appid` integer NOT NULL,
	`facet_group` text NOT NULL,
	`source_id` text NOT NULL,
	`source_order` integer NOT NULL,
	`weight` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`appid`, `facet_group`, `source_id`),
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`facet_group`,`source_id`) REFERENCES `app_facets`(`facet_group`,`source_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_facet_memberships_group_check" CHECK("app_facet_memberships"."facet_group" IN ('genre', 'feature', 'community_tag')),
	CONSTRAINT "app_facet_memberships_order_check" CHECK(typeof("app_facet_memberships"."source_order") = 'integer' AND "app_facet_memberships"."source_order" >= 0),
	CONSTRAINT "app_facet_memberships_weight_check" CHECK("app_facet_memberships"."weight" IS NULL OR (typeof("app_facet_memberships"."weight") = 'integer' AND "app_facet_memberships"."weight" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_app_facet_memberships_app_group_order` ON `app_facet_memberships` (`appid`,`facet_group`,`source_order`);--> statement-breakpoint
CREATE INDEX `idx_app_facet_memberships_group_source` ON `app_facet_memberships` (`facet_group`,`source_id`);--> statement-breakpoint
CREATE TABLE `app_facets` (
	`facet_group` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`facet_group`, `source_id`),
	CONSTRAINT "app_facets_group_check" CHECK("app_facets"."facet_group" IN ('genre', 'feature', 'community_tag')),
	CONSTRAINT "app_facets_source_id_check" CHECK(length(trim("app_facets"."source_id")) > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_app_facets_group_name` ON `app_facets` (`facet_group`,`name`);--> statement-breakpoint
CREATE TABLE `critic_records` (
	`appid` integer NOT NULL,
	`source` text NOT NULL,
	`matched_identity` text,
	`platform_scope` text DEFAULT 'unknown' NOT NULL,
	`edition` text,
	`native_score` real,
	`native_tier` text,
	`review_count` integer,
	`score_scale` integer,
	`source_url` text,
	`review_period_start` text,
	`review_period_end` text,
	`collection_basis` text DEFAULT 'public_page' NOT NULL,
	`observed_at` text NOT NULL,
	`last_success_at` text,
	`provenance` text DEFAULT '{}' NOT NULL,
	`basis` text DEFAULT 'public aggregate page' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`appid`, `source`),
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "critic_records_source_check" CHECK("critic_records"."source" IN ('opencritic', 'metacritic')),
	CONSTRAINT "critic_records_platform_scope_check" CHECK("critic_records"."platform_scope" IN ('pc', 'mixed', 'console', 'unknown')),
	CONSTRAINT "critic_records_score_check" CHECK(("critic_records"."native_score" IS NULL OR (typeof("critic_records"."native_score") IN ('integer', 'real') AND "critic_records"."score_scale" IS NOT NULL AND "critic_records"."native_score" BETWEEN 0 AND "critic_records"."score_scale")) AND ("critic_records"."score_scale" IS NULL OR (typeof("critic_records"."score_scale") = 'integer' AND "critic_records"."score_scale" > 0))),
	CONSTRAINT "critic_records_review_count_check" CHECK("critic_records"."review_count" IS NULL OR (typeof("critic_records"."review_count") = 'integer' AND "critic_records"."review_count" >= 0)),
	CONSTRAINT "critic_records_review_period_check" CHECK("critic_records"."review_period_start" IS NULL OR "critic_records"."review_period_end" IS NULL OR "critic_records"."review_period_start" <= "critic_records"."review_period_end"),
	CONSTRAINT "critic_records_collection_basis_check" CHECK("critic_records"."collection_basis" = 'public_page')
);
--> statement-breakpoint
CREATE INDEX `idx_critic_records_source_observed` ON `critic_records` (`source`,"observed_at" desc);--> statement-breakpoint
CREATE TABLE `player_score_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appid` integer NOT NULL,
	`observed_at` text NOT NULL,
	`score` real NOT NULL,
	`formula_version` text NOT NULL,
	`current_positive_count` integer NOT NULL,
	`current_total_count` integer NOT NULL,
	`historical_positive_count` integer NOT NULL,
	`historical_total_count` integer NOT NULL,
	`current_window_start` text NOT NULL,
	`current_window_end` text NOT NULL,
	`historical_window_start` text NOT NULL,
	`historical_window_end` text NOT NULL,
	`current_evidence_intervals` text NOT NULL,
	`historical_evidence_intervals` text NOT NULL,
	`current_source_id` text,
	`historical_source_id` text,
	`current_evidence_observed_at` text,
	`historical_evidence_observed_at` text,
	`anchor_event_id` text,
	`anchor_at` text,
	`provenance` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_source_id`) REFERENCES `review_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`historical_source_id`) REFERENCES `review_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "player_score_history_score_check" CHECK(typeof("player_score_history"."score") IN ('integer', 'real') AND "player_score_history"."score" BETWEEN 0 AND 100),
	CONSTRAINT "player_score_history_current_counts_check" CHECK(typeof("player_score_history"."current_positive_count") = 'integer' AND typeof("player_score_history"."current_total_count") = 'integer' AND "player_score_history"."current_positive_count" >= 0 AND "player_score_history"."current_total_count" >= 0 AND "player_score_history"."current_positive_count" <= "player_score_history"."current_total_count"),
	CONSTRAINT "player_score_history_historical_counts_check" CHECK(typeof("player_score_history"."historical_positive_count") = 'integer' AND typeof("player_score_history"."historical_total_count") = 'integer' AND "player_score_history"."historical_positive_count" >= 0 AND "player_score_history"."historical_total_count" >= 0 AND "player_score_history"."historical_positive_count" <= "player_score_history"."historical_total_count"),
	CONSTRAINT "player_score_history_window_check" CHECK("player_score_history"."current_window_start" < "player_score_history"."current_window_end" AND "player_score_history"."historical_window_start" < "player_score_history"."historical_window_end")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_player_score_history_id_appid` ON `player_score_history` (`id`,`appid`);--> statement-breakpoint
CREATE INDEX `idx_player_score_history_appid_observed` ON `player_score_history` (`appid`,"observed_at" desc);--> statement-breakpoint
CREATE INDEX `idx_player_score_history_source_observed` ON `player_score_history` (`current_source_id`,"observed_at" desc);--> statement-breakpoint
CREATE INDEX `idx_player_score_history_historical_source_observed` ON `player_score_history` (`historical_source_id`,"observed_at" desc);--> statement-breakpoint
CREATE TABLE `player_score_state` (
	`appid` integer PRIMARY KEY NOT NULL,
	`latest_score_history_id` integer,
	`historical_positive_count` integer,
	`historical_total_count` integer,
	`historical_source_id` text,
	`historical_window_start` text,
	`historical_window_end` text,
	`historical_evidence_intervals` text DEFAULT '[]' NOT NULL,
	`historical_baseline_observed_at` text,
	`eligibility_review_count` integer,
	`eligibility_source_id` text,
	`eligibility_window_start` text,
	`eligibility_window_end` text,
	`eligibility_evidence_start` text,
	`eligibility_evidence_end` text,
	`eligibility_evidence_intervals` text DEFAULT '[]' NOT NULL,
	`eligibility_observed_at` text,
	`eligibility_provenance` text DEFAULT '{}' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`historical_source_id`) REFERENCES `review_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`eligibility_source_id`) REFERENCES `review_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`latest_score_history_id`,`appid`) REFERENCES `player_score_history`(`id`,`appid`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "player_score_state_historical_counts_check" CHECK(("player_score_state"."historical_positive_count" IS NULL AND "player_score_state"."historical_total_count" IS NULL) OR (typeof("player_score_state"."historical_positive_count") = 'integer' AND typeof("player_score_state"."historical_total_count") = 'integer' AND "player_score_state"."historical_positive_count" >= 0 AND "player_score_state"."historical_total_count" >= 0 AND "player_score_state"."historical_positive_count" <= "player_score_state"."historical_total_count")),
	CONSTRAINT "player_score_state_historical_window_check" CHECK(("player_score_state"."historical_window_start" IS NULL AND "player_score_state"."historical_window_end" IS NULL) OR ("player_score_state"."historical_window_start" IS NOT NULL AND "player_score_state"."historical_window_end" IS NOT NULL AND "player_score_state"."historical_window_start" < "player_score_state"."historical_window_end")),
	CONSTRAINT "player_score_state_eligibility_count_check" CHECK("player_score_state"."eligibility_review_count" IS NULL OR (typeof("player_score_state"."eligibility_review_count") = 'integer' AND "player_score_state"."eligibility_review_count" >= 0)),
	CONSTRAINT "player_score_state_eligibility_window_check" CHECK(("player_score_state"."eligibility_window_start" IS NULL AND "player_score_state"."eligibility_window_end" IS NULL) OR ("player_score_state"."eligibility_window_start" IS NOT NULL AND "player_score_state"."eligibility_window_end" IS NOT NULL AND "player_score_state"."eligibility_window_start" < "player_score_state"."eligibility_window_end")),
	CONSTRAINT "player_score_state_eligibility_evidence_check" CHECK(("player_score_state"."eligibility_evidence_start" IS NULL AND "player_score_state"."eligibility_evidence_end" IS NULL) OR ("player_score_state"."eligibility_evidence_start" IS NOT NULL AND "player_score_state"."eligibility_evidence_end" IS NOT NULL AND "player_score_state"."eligibility_evidence_start" < "player_score_state"."eligibility_evidence_end"))
);
--> statement-breakpoint
CREATE INDEX `idx_player_score_state_latest_score` ON `player_score_state` (`latest_score_history_id`);--> statement-breakpoint
CREATE INDEX `idx_player_score_state_eligibility` ON `player_score_state` (`eligibility_source_id`,`eligibility_evidence_start`,`eligibility_evidence_end`);--> statement-breakpoint
CREATE TABLE `review_buckets` (
	`appid` integer NOT NULL,
	`source_id` text NOT NULL,
	`granularity` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`positive_count` integer NOT NULL,
	`negative_count` integer NOT NULL,
	`observed_at` text NOT NULL,
	`provenance` text NOT NULL,
	PRIMARY KEY(`appid`, `source_id`, `granularity`, `period_start`, `period_end`),
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `review_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_buckets_granularity_check" CHECK("review_buckets"."granularity" IN ('daily', 'monthly')),
	CONSTRAINT "review_buckets_interval_check" CHECK("review_buckets"."period_start" < "review_buckets"."period_end"),
	CONSTRAINT "review_buckets_positive_count_check" CHECK(typeof("review_buckets"."positive_count") = 'integer' AND "review_buckets"."positive_count" >= 0),
	CONSTRAINT "review_buckets_negative_count_check" CHECK(typeof("review_buckets"."negative_count") = 'integer' AND "review_buckets"."negative_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_review_buckets_appid_period` ON `review_buckets` (`appid`,"period_start" asc,"period_end" asc);--> statement-breakpoint
CREATE INDEX `idx_review_buckets_source_period` ON `review_buckets` (`source_id`,"period_start" asc,"period_end" asc);--> statement-breakpoint
CREATE TABLE `review_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`request_filter` text NOT NULL,
	`language` text,
	`purchase_type` text,
	`day_range` integer,
	`filter_offtopic_activity` integer,
	`population` text NOT NULL,
	`population_flags` text DEFAULT '{}' NOT NULL,
	`interpretation_version` text NOT NULL,
	`identity_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "review_sources_endpoint_check" CHECK("review_sources"."endpoint" IN ('appreviews', 'appreviewhistogram')),
	CONSTRAINT "review_sources_day_range_check" CHECK("review_sources"."day_range" IS NULL OR (typeof("review_sources"."day_range") = 'integer' AND "review_sources"."day_range" >= 0)),
	CONSTRAINT "review_sources_filter_offtopic_check" CHECK("review_sources"."filter_offtopic_activity" IS NULL OR (typeof("review_sources"."filter_offtopic_activity") = 'integer' AND "review_sources"."filter_offtopic_activity" IN (0, 1))),
	CONSTRAINT "review_sources_identity_key_check" CHECK(length(trim("review_sources"."identity_key")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_sources_identity` ON `review_sources` (`identity_key`);--> statement-breakpoint
CREATE TABLE `review_summary_snapshots` (
	`appid` integer NOT NULL,
	`source_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`lifetime_positive_count` integer NOT NULL,
	`lifetime_total_count` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`appid`, `source_id`, `observed_at`),
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `review_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_summary_positive_count_check" CHECK(typeof("review_summary_snapshots"."lifetime_positive_count") = 'integer' AND "review_summary_snapshots"."lifetime_positive_count" >= 0 AND "review_summary_snapshots"."lifetime_positive_count" <= "review_summary_snapshots"."lifetime_total_count"),
	CONSTRAINT "review_summary_total_count_check" CHECK(typeof("review_summary_snapshots"."lifetime_total_count") = 'integer' AND "review_summary_snapshots"."lifetime_total_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_review_summaries_appid_observed` ON `review_summary_snapshots` (`appid`,"observed_at" desc);--> statement-breakpoint
CREATE INDEX `idx_review_summaries_source_observed` ON `review_summary_snapshots` (`source_id`,"observed_at" desc);--> statement-breakpoint
CREATE TABLE `steam_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`appid` integer NOT NULL,
	`category` text,
	`title` text,
	`url` text,
	`start_at` text,
	`publication_at` text,
	`observed_at` text NOT NULL,
	`source` text DEFAULT 'steam_news_hub' NOT NULL,
	`provenance` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "steam_events_category_check" CHECK("steam_events"."category" IS NULL OR length(trim("steam_events"."category")) > 0),
	CONSTRAINT "steam_events_dates_check" CHECK(("steam_events"."start_at" IS NULL OR length(trim("steam_events"."start_at")) > 0) AND ("steam_events"."publication_at" IS NULL OR length(trim("steam_events"."publication_at")) > 0))
);
--> statement-breakpoint
CREATE INDEX `idx_steam_events_appid_start` ON `steam_events` (`appid`,"start_at" desc);--> statement-breakpoint
CREATE INDEX `idx_steam_events_appid_publication` ON `steam_events` (`appid`,"publication_at" desc);--> statement-breakpoint
ALTER TABLE `apps` ADD `metacritic_score` integer CONSTRAINT `apps_metacritic_score_check` CHECK (`metacritic_score` IS NULL OR (typeof(`metacritic_score`) = 'integer' AND `metacritic_score` BETWEEN 0 AND 100));--> statement-breakpoint
ALTER TABLE `apps` ADD `metacritic_url` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `metacritic_observed_at` text;