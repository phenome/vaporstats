CREATE TABLE `media_article_embeddings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`dimension` text NOT NULL,
	`input_identity` text NOT NULL,
	`extraction_input_identity` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`config_version` text NOT NULL,
	`vector` blob NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_article_embeddings_dimension_check" CHECK("media_article_embeddings"."dimension" IN ('gameplay', 'story_world')),
	CONSTRAINT "media_article_embeddings_dimensions_check" CHECK("media_article_embeddings"."dimensions" = 3072),
	CONSTRAINT "media_article_embeddings_active_check" CHECK("media_article_embeddings"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_article_embeddings_input` ON `media_article_embeddings` (`source_id`,`dimension`,`input_identity`);--> statement-breakpoint
CREATE INDEX `idx_media_article_embeddings_active` ON `media_article_embeddings` (`source_id`,`dimension`,`active`);--> statement-breakpoint
CREATE TABLE `media_game_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appid` integer NOT NULL,
	`matched_appid` integer NOT NULL,
	`dimension` text NOT NULL,
	`trait` text NOT NULL,
	`explanation` text NOT NULL,
	`similarity` real NOT NULL,
	`current_source_ids` text NOT NULL,
	`matched_source_ids` text NOT NULL,
	`current_extraction_identities` text NOT NULL,
	`matched_extraction_identities` text NOT NULL,
	`current_vector_identities` text NOT NULL,
	`matched_vector_identities` text NOT NULL,
	`input_identity` text NOT NULL,
	`model` text NOT NULL,
	`config_version` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_game_matches_pair_check" CHECK("media_game_matches"."appid" < "media_game_matches"."matched_appid"),
	CONSTRAINT "media_game_matches_dimension_check" CHECK("media_game_matches"."dimension" IN ('gameplay', 'story_world')),
	CONSTRAINT "media_game_matches_similarity_check" CHECK("media_game_matches"."similarity" >= -1 AND "media_game_matches"."similarity" <= 1),
	CONSTRAINT "media_game_matches_active_check" CHECK("media_game_matches"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_game_matches_input` ON `media_game_matches` (`appid`,`matched_appid`,`dimension`,`input_identity`);--> statement-breakpoint
CREATE INDEX `idx_media_game_matches_active` ON `media_game_matches` (`appid`,`matched_appid`,`dimension`,`active`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_processing_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`stage` text NOT NULL,
	`appid` integer NOT NULL,
	`matched_appid` integer,
	`dimension` text,
	`source_id` integer,
	`request_key` text NOT NULL,
	`input_identity` text NOT NULL,
	`model` text NOT NULL,
	`config_version` text NOT NULL,
	`max_input_tokens` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`reserved_microusd` integer NOT NULL,
	`charged_microusd` integer,
	`reservation_active` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`provider_batch_id` text,
	`output_json` text,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`submitted_at` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `media_discovery_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "media_processing_jobs_stage_check" CHECK("__new_media_processing_jobs"."stage" IN ('extraction', 'embedding', 'synthesis', 'explanation')),
	CONSTRAINT "media_processing_jobs_status_check" CHECK("__new_media_processing_jobs"."status" IN ('reserved', 'submitted', 'succeeded', 'failed', 'uncertain', 'stale')),
	CONSTRAINT "media_processing_jobs_dimension_check" CHECK("__new_media_processing_jobs"."dimension" IS NULL OR "__new_media_processing_jobs"."dimension" IN ('gameplay', 'story_world')),
	CONSTRAINT "media_processing_jobs_reservation_check" CHECK("__new_media_processing_jobs"."reservation_active" IN (0, 1)),
	CONSTRAINT "media_processing_jobs_token_check" CHECK("__new_media_processing_jobs"."max_input_tokens" >= 0 AND "__new_media_processing_jobs"."max_output_tokens" > 0),
	CONSTRAINT "media_processing_jobs_charge_check" CHECK("__new_media_processing_jobs"."reserved_microusd" >= 0 AND ("__new_media_processing_jobs"."charged_microusd" IS NULL OR "__new_media_processing_jobs"."charged_microusd" >= 0))
);
--> statement-breakpoint
INSERT INTO `__new_media_processing_jobs`("id", "run_id", "stage", "appid", "matched_appid", "dimension", "source_id", "request_key", "input_identity", "model", "config_version", "max_input_tokens", "max_output_tokens", "reserved_microusd", "charged_microusd", "reservation_active", "status", "provider_batch_id", "output_json", "usage_json", "error", "submitted_at", "completed_at", "created_at") SELECT "id", "run_id", "stage", "appid", NULL, NULL, "source_id", "request_key", "input_identity", "model", "config_version", "max_input_tokens", "max_output_tokens", "reserved_microusd", "charged_microusd", "reservation_active", "status", "provider_batch_id", "output_json", "usage_json", "error", "submitted_at", "completed_at", "created_at" FROM `media_processing_jobs`;--> statement-breakpoint
DROP TABLE `media_processing_jobs`;--> statement-breakpoint
ALTER TABLE `__new_media_processing_jobs` RENAME TO `media_processing_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_processing_jobs_request` ON `media_processing_jobs` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_processing_jobs_provider_batch` ON `media_processing_jobs` (`provider_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_media_processing_jobs_authorization` ON `media_processing_jobs` (`run_id`,`status`);