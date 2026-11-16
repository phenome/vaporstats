PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_discovery_attempts` (
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
	CONSTRAINT "media_discovery_attempts_pass_check" CHECK("__new_media_discovery_attempts"."pass" IN ('initial', 'later')),
	CONSTRAINT "media_discovery_attempts_outlet_check" CHECK("__new_media_discovery_attempts"."outlet" IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')),
	CONSTRAINT "media_discovery_attempts_kind_check" CHECK("__new_media_discovery_attempts"."kind" IN ('search', 'fetch', 'redirect', 'failure')),
	CONSTRAINT "media_discovery_attempts_succeeded_check" CHECK("__new_media_discovery_attempts"."succeeded" IN (0, 1)),
	CONSTRAINT "media_discovery_attempts_status_code_check" CHECK("__new_media_discovery_attempts"."status_code" IS NULL OR ("__new_media_discovery_attempts"."status_code" >= 100 AND "__new_media_discovery_attempts"."status_code" <= 599))
);
--> statement-breakpoint
INSERT INTO `__new_media_discovery_attempts`("id", "appid", "outlet", "pass", "day", "kind", "url", "status_code", "succeeded", "error", "attempted_at") SELECT "id", "appid", "outlet", "pass", "day", "kind", "url", "status_code", "succeeded", "error", "attempted_at" FROM `media_discovery_attempts`;--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name = '__new_media_discovery_attempts';--> statement-breakpoint
INSERT INTO sqlite_sequence (name, seq) SELECT '__new_media_discovery_attempts', seq FROM sqlite_sequence WHERE name = 'media_discovery_attempts';--> statement-breakpoint
DROP TABLE `media_discovery_attempts`;--> statement-breakpoint
ALTER TABLE `__new_media_discovery_attempts` RENAME TO `media_discovery_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_media_discovery_attempts_outlet_day` ON `media_discovery_attempts` (`outlet`,`day`);--> statement-breakpoint
CREATE INDEX `idx_media_discovery_attempts_game` ON `media_discovery_attempts` (`appid`,`pass`);--> statement-breakpoint
CREATE TABLE `__new_media_discovery_progress` (
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
	CONSTRAINT "media_discovery_progress_pass_check" CHECK("__new_media_discovery_progress"."pass" IN ('initial', 'later')),
	CONSTRAINT "media_discovery_progress_outlet_check" CHECK("__new_media_discovery_progress"."outlet" IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')),
	CONSTRAINT "media_discovery_progress_status_check" CHECK("__new_media_discovery_progress"."status" IN ('queued', 'searching', 'fetching', 'completed', 'stopped')),
	CONSTRAINT "media_discovery_progress_candidate_index_check" CHECK("__new_media_discovery_progress"."candidate_index" >= 0),
	CONSTRAINT "media_discovery_progress_credits_check" CHECK("__new_media_discovery_progress"."credits_used" IS NULL OR "__new_media_discovery_progress"."credits_used" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_media_discovery_progress`("id", "run_id", "appid", "pass", "outlet", "status", "query_attempted_at", "candidate_urls", "candidate_index", "provider_request_id", "credits_used", "usage", "stop_reason", "updated_at") SELECT "id", "run_id", "appid", "pass", "outlet", "status", "query_attempted_at", "candidate_urls", "candidate_index", "provider_request_id", "credits_used", "usage", "stop_reason", "updated_at" FROM `media_discovery_progress`;--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name = '__new_media_discovery_progress';--> statement-breakpoint
INSERT INTO sqlite_sequence (name, seq) SELECT '__new_media_discovery_progress', seq FROM sqlite_sequence WHERE name = 'media_discovery_progress';--> statement-breakpoint
DROP TABLE `media_discovery_progress`;--> statement-breakpoint
ALTER TABLE `__new_media_discovery_progress` RENAME TO `media_discovery_progress`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_discovery_progress_game_outlet_pass` ON `media_discovery_progress` (`appid`,`outlet`,`pass`);--> statement-breakpoint
CREATE INDEX `idx_media_discovery_progress_run` ON `media_discovery_progress` (`run_id`);--> statement-breakpoint
CREATE TABLE `__new_media_discovery_runs` (
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
	CONSTRAINT "media_discovery_runs_pass_check" CHECK("__new_media_discovery_runs"."pass" IN ('initial', 'later')),
	CONSTRAINT "media_discovery_runs_status_check" CHECK("__new_media_discovery_runs"."status" IN ('queued', 'running', 'completed', 'stopped', 'failed')),
	CONSTRAINT "media_discovery_runs_resumed_check" CHECK("__new_media_discovery_runs"."resumed" IN (0, 1)),
	CONSTRAINT "media_discovery_runs_counts_check" CHECK("__new_media_discovery_runs"."query_count" >= 0 AND "__new_media_discovery_runs"."article_count" >= 0 AND "__new_media_discovery_runs"."attempt_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_media_discovery_runs`("id", "pass", "identity_key", "selected_games", "status", "resumed", "query_count", "article_count", "attempt_count", "provider_request_ids", "usage", "stop_reason", "summary", "started_at", "finished_at", "created_at") SELECT "id", "pass", "identity_key", "selected_games", "status", "resumed", "query_count", "article_count", "attempt_count", "provider_request_ids", "usage", "stop_reason", "summary", "started_at", "finished_at", "created_at" FROM `media_discovery_runs`;--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name = '__new_media_discovery_runs';--> statement-breakpoint
INSERT INTO sqlite_sequence (name, seq) SELECT '__new_media_discovery_runs', seq FROM sqlite_sequence WHERE name = 'media_discovery_runs';--> statement-breakpoint
DROP TABLE `media_discovery_runs`;--> statement-breakpoint
ALTER TABLE `__new_media_discovery_runs` RENAME TO `media_discovery_runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_discovery_runs_identity` ON `media_discovery_runs` (`identity_key`);--> statement-breakpoint
CREATE TABLE `__new_media_sources` (
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
	`normalized_content_hash` text,
	`cleanup_version` text,
	`processing_content` text,
	`processing_input_identity` text,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_sources_pass_check" CHECK("__new_media_sources"."pass" IN ('initial', 'later')),
	CONSTRAINT "media_sources_outlet_check" CHECK("__new_media_sources"."outlet" IN ('IGN', 'Eurogamer', 'GameSpot', 'PC Gamer', 'Kotaku', 'GamesRadar+')),
	CONSTRAINT "media_sources_type_check" CHECK("__new_media_sources"."type" IN ('review', 'preview')),
	CONSTRAINT "media_sources_hands_on_check" CHECK("__new_media_sources"."hands_on" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_media_sources`("id", "appid", "pass", "original_url", "discovery_url", "title", "outlet", "author", "published_at", "updated_at", "retrieved_at", "type", "hands_on", "affiliation", "platform", "build_context", "normalized_content_hash", "cleanup_version", "processing_content", "processing_input_identity") SELECT "id", "appid", "pass", "original_url", "discovery_url", "title", "outlet", "author", "published_at", "updated_at", "retrieved_at", "type", "hands_on", "affiliation", "platform", "build_context", "normalized_content_hash", "cleanup_version", "processing_content", "processing_input_identity" FROM `media_sources`;--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name = '__new_media_sources';--> statement-breakpoint
INSERT INTO sqlite_sequence (name, seq) SELECT '__new_media_sources', seq FROM sqlite_sequence WHERE name = 'media_sources';--> statement-breakpoint
DROP TABLE `media_sources`;--> statement-breakpoint
ALTER TABLE `__new_media_sources` RENAME TO `media_sources`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_sources_game_url` ON `media_sources` (`appid`,`original_url`);--> statement-breakpoint
CREATE INDEX `idx_media_sources_game` ON `media_sources` (`appid`,`published_at`);