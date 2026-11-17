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
	`status` text DEFAULT 'queued' NOT NULL,
	`provider` text DEFAULT 'gemini' NOT NULL,
	`enqueued_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`retained` integer DEFAULT 0 NOT NULL,
	`cost_source` text,
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
	CONSTRAINT "media_processing_jobs_status_check" CHECK("__new_media_processing_jobs"."status" IN ('queued', 'reserved', 'submitted', 'succeeded', 'failed', 'refused', 'uncertain', 'stale')),
	CONSTRAINT "media_processing_jobs_attempt_check" CHECK("__new_media_processing_jobs"."attempt_count" >= 0),
	CONSTRAINT "media_processing_jobs_retained_check" CHECK("__new_media_processing_jobs"."retained" IN (0, 1)),
	CONSTRAINT "media_processing_jobs_cost_source_check" CHECK("__new_media_processing_jobs"."cost_source" IS NULL OR "__new_media_processing_jobs"."cost_source" IN ('estimated', 'provider_reported', 'unknown')),
	CONSTRAINT "media_processing_jobs_dimension_check" CHECK("__new_media_processing_jobs"."dimension" IS NULL OR "__new_media_processing_jobs"."dimension" IN ('gameplay', 'story_world')),
	CONSTRAINT "media_processing_jobs_reservation_check" CHECK("__new_media_processing_jobs"."reservation_active" IN (0, 1)),
	CONSTRAINT "media_processing_jobs_token_check" CHECK("__new_media_processing_jobs"."max_input_tokens" >= 0 AND "__new_media_processing_jobs"."max_output_tokens" > 0),
	CONSTRAINT "media_processing_jobs_charge_check" CHECK("__new_media_processing_jobs"."reserved_microusd" >= 0 AND ("__new_media_processing_jobs"."charged_microusd" IS NULL OR "__new_media_processing_jobs"."charged_microusd" >= 0))
);
--> statement-breakpoint
-- Every retained paid-job row is copied unchanged as cost history and marked
-- retained, so the queue never deletes, submits or requeues it. Its queue
-- fields describe it without rewriting it: all retained work was Gemini work,
-- and it joined the ledger when it was created.
INSERT INTO `__new_media_processing_jobs`("id", "run_id", "stage", "appid", "matched_appid", "dimension", "source_id", "request_key", "input_identity", "model", "config_version", "max_input_tokens", "max_output_tokens", "reserved_microusd", "charged_microusd", "reservation_active", "status", "provider", "enqueued_at", "retained", "provider_batch_id", "output_json", "usage_json", "error", "submitted_at", "completed_at", "created_at") SELECT "id", "run_id", "stage", "appid", "matched_appid", "dimension", "source_id", "request_key", "input_identity", "model", "config_version", "max_input_tokens", "max_output_tokens", "reserved_microusd", "charged_microusd", "reservation_active", "status", 'gemini', "created_at", 1, "provider_batch_id", "output_json", "usage_json", "error", "submitted_at", "completed_at", "created_at" FROM `media_processing_jobs`;--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name = '__new_media_processing_jobs';--> statement-breakpoint
INSERT INTO sqlite_sequence (name, seq) SELECT '__new_media_processing_jobs', seq FROM sqlite_sequence WHERE name = 'media_processing_jobs';--> statement-breakpoint
DROP TABLE `media_processing_jobs`;--> statement-breakpoint
ALTER TABLE `__new_media_processing_jobs` RENAME TO `media_processing_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_processing_jobs_request` ON `media_processing_jobs` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_processing_jobs_provider_batch` ON `media_processing_jobs` (`provider_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_media_processing_jobs_authorization` ON `media_processing_jobs` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_media_processing_jobs_queue` ON `media_processing_jobs` (`provider`,`status`,`appid`,`enqueued_at`);