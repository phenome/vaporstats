CREATE TABLE `media_article_extractions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`input_identity` text NOT NULL,
	`content_hash` text NOT NULL,
	`cleanup_version` text NOT NULL,
	`model` text NOT NULL,
	`config_version` text NOT NULL,
	`output_json` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_article_extractions_active_check" CHECK("media_article_extractions"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_article_extractions_input` ON `media_article_extractions` (`source_id`,`input_identity`);--> statement-breakpoint
CREATE INDEX `idx_media_article_extractions_active` ON `media_article_extractions` (`source_id`,`active`);--> statement-breakpoint
CREATE TABLE `media_game_overviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appid` integer NOT NULL,
	`input_identity` text NOT NULL,
	`model` text NOT NULL,
	`config_version` text NOT NULL,
	`output_json` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_game_overviews_active_check" CHECK("media_game_overviews"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_game_overviews_input` ON `media_game_overviews` (`input_identity`);--> statement-breakpoint
CREATE INDEX `idx_media_game_overviews_active` ON `media_game_overviews` (`appid`,`active`);--> statement-breakpoint
CREATE TABLE `media_processing_authorizations` (
	`run_id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`billing_confirmation` text,
	`stop_reason` text,
	`authorized_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `media_discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_processing_authorizations_status_check" CHECK("media_processing_authorizations"."status" IN ('queued', 'waiting', 'completed', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE `media_processing_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`stage` text NOT NULL,
	`appid` integer NOT NULL,
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
	FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "media_processing_jobs_stage_check" CHECK("media_processing_jobs"."stage" IN ('extraction', 'synthesis')),
	CONSTRAINT "media_processing_jobs_status_check" CHECK("media_processing_jobs"."status" IN ('reserved', 'submitted', 'succeeded', 'failed', 'uncertain', 'stale')),
	CONSTRAINT "media_processing_jobs_reservation_check" CHECK("media_processing_jobs"."reservation_active" IN (0, 1)),
	CONSTRAINT "media_processing_jobs_token_check" CHECK("media_processing_jobs"."max_input_tokens" >= 0 AND "media_processing_jobs"."max_output_tokens" > 0),
	CONSTRAINT "media_processing_jobs_charge_check" CHECK("media_processing_jobs"."reserved_microusd" >= 0 AND ("media_processing_jobs"."charged_microusd" IS NULL OR "media_processing_jobs"."charged_microusd" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_processing_jobs_request` ON `media_processing_jobs` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_processing_jobs_provider_batch` ON `media_processing_jobs` (`provider_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_media_processing_jobs_authorization` ON `media_processing_jobs` (`run_id`,`status`);--> statement-breakpoint
ALTER TABLE `media_sources` ADD `normalized_content_hash` text;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `cleanup_version` text;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `processing_content` text;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `processing_input_identity` text;