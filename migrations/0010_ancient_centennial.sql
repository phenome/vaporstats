CREATE TABLE `media_discovery_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appid` integer NOT NULL,
	`outlet` text NOT NULL,
	`pass` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`url` text,
	`status_code` integer,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`error` text,
	`attempted_at` text NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_discovery_attempts_pass_check" CHECK("media_discovery_attempts"."pass" = 'initial'),
	CONSTRAINT "media_discovery_attempts_outlet_check" CHECK("media_discovery_attempts"."outlet" IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')),
	CONSTRAINT "media_discovery_attempts_kind_check" CHECK("media_discovery_attempts"."kind" IN ('search', 'fetch', 'redirect', 'failure')),
	CONSTRAINT "media_discovery_attempts_succeeded_check" CHECK("media_discovery_attempts"."succeeded" IN (0, 1)),
	CONSTRAINT "media_discovery_attempts_status_code_check" CHECK("media_discovery_attempts"."status_code" IS NULL OR ("media_discovery_attempts"."status_code" >= 100 AND "media_discovery_attempts"."status_code" <= 599))
);
--> statement-breakpoint
CREATE INDEX `idx_media_discovery_attempts_outlet_day` ON `media_discovery_attempts` (`outlet`,`day`);--> statement-breakpoint
CREATE INDEX `idx_media_discovery_attempts_game` ON `media_discovery_attempts` (`appid`,`pass`);--> statement-breakpoint
CREATE TABLE `media_discovery_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`appid` integer NOT NULL,
	`pass` text NOT NULL,
	`outlet` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`query_attempted_at` text,
	`candidate_urls` text DEFAULT '[]' NOT NULL,
	`candidate_index` integer DEFAULT 0 NOT NULL,
	`provider_request_id` text,
	`credits_used` integer,
	`usage` text DEFAULT '{}' NOT NULL,
	`stop_reason` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `media_discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_discovery_progress_pass_check" CHECK("media_discovery_progress"."pass" = 'initial'),
	CONSTRAINT "media_discovery_progress_outlet_check" CHECK("media_discovery_progress"."outlet" IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')),
	CONSTRAINT "media_discovery_progress_status_check" CHECK("media_discovery_progress"."status" IN ('queued', 'searching', 'fetching', 'completed', 'stopped')),
	CONSTRAINT "media_discovery_progress_candidate_index_check" CHECK("media_discovery_progress"."candidate_index" >= 0),
	CONSTRAINT "media_discovery_progress_credits_check" CHECK("media_discovery_progress"."credits_used" IS NULL OR "media_discovery_progress"."credits_used" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_discovery_progress_game_outlet_pass` ON `media_discovery_progress` (`appid`,`outlet`,`pass`);--> statement-breakpoint
CREATE INDEX `idx_media_discovery_progress_run` ON `media_discovery_progress` (`run_id`);--> statement-breakpoint
CREATE TABLE `media_discovery_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pass` text NOT NULL,
	`identity_key` text NOT NULL,
	`selected_games` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`resumed` integer DEFAULT 0 NOT NULL,
	`query_count` integer DEFAULT 0 NOT NULL,
	`article_count` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`provider_request_ids` text DEFAULT '[]' NOT NULL,
	`usage` text DEFAULT '{}' NOT NULL,
	`stop_reason` text,
	`summary` text DEFAULT '{}' NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "media_discovery_runs_pass_check" CHECK("media_discovery_runs"."pass" = 'initial'),
	CONSTRAINT "media_discovery_runs_status_check" CHECK("media_discovery_runs"."status" IN ('queued', 'running', 'completed', 'stopped', 'failed')),
	CONSTRAINT "media_discovery_runs_resumed_check" CHECK("media_discovery_runs"."resumed" IN (0, 1)),
	CONSTRAINT "media_discovery_runs_counts_check" CHECK("media_discovery_runs"."query_count" >= 0 AND "media_discovery_runs"."article_count" >= 0 AND "media_discovery_runs"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_discovery_runs_identity` ON `media_discovery_runs` (`identity_key`);--> statement-breakpoint
CREATE TABLE `media_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appid` integer NOT NULL,
	`pass` text NOT NULL,
	`original_url` text NOT NULL,
	`discovery_url` text,
	`title` text NOT NULL,
	`outlet` text NOT NULL,
	`author` text,
	`published_at` text,
	`updated_at` text,
	`retrieved_at` text NOT NULL,
	`type` text NOT NULL,
	`hands_on` integer,
	`affiliation` text,
	`platform` text,
	`build_context` text,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_sources_pass_check" CHECK("media_sources"."pass" = 'initial'),
	CONSTRAINT "media_sources_outlet_check" CHECK("media_sources"."outlet" IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')),
	CONSTRAINT "media_sources_type_check" CHECK("media_sources"."type" IN ('review', 'preview')),
	CONSTRAINT "media_sources_hands_on_check" CHECK("media_sources"."hands_on" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_sources_game_url` ON `media_sources` (`appid`,`original_url`);--> statement-breakpoint
CREATE INDEX `idx_media_sources_game` ON `media_sources` (`appid`,`published_at`);