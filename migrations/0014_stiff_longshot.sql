CREATE TABLE `media_game_embeddings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appid` integer NOT NULL,
	`dimension` text NOT NULL,
	`input_identity` text NOT NULL,
	`overview_input_identity` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`config_version` text NOT NULL,
	`vector` blob NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_game_embeddings_dimension_check" CHECK("media_game_embeddings"."dimension" IN ('gameplay', 'story_world')),
	CONSTRAINT "media_game_embeddings_dimensions_check" CHECK("media_game_embeddings"."dimensions" = 3072),
	CONSTRAINT "media_game_embeddings_vector_check" CHECK(typeof("media_game_embeddings"."vector") = 'blob' AND length("media_game_embeddings"."vector") = 12288),
	CONSTRAINT "media_game_embeddings_active_check" CHECK("media_game_embeddings"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_game_embeddings_input` ON `media_game_embeddings` (`appid`,`dimension`,`input_identity`,`model`,`dimensions`,`config_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_game_embeddings_active` ON `media_game_embeddings` (`appid`,`dimension`) WHERE "media_game_embeddings"."active" = 1;--> statement-breakpoint
CREATE INDEX `idx_media_game_embeddings_active` ON `media_game_embeddings` (`appid`,`dimension`,`active`);--> statement-breakpoint
UPDATE `media_processing_jobs`
SET `status` = 'stale',
	`reservation_active` = 0,
	`error` = 'obsolete reservation retired by migration',
	`completed_at` = CURRENT_TIMESTAMP
WHERE `status` = 'reserved'
	AND (
		(`stage` = 'embedding' AND (
			`source_id` IS NOT NULL
			OR `dimension` IS NULL
			OR `dimension` NOT IN ('gameplay', 'story_world')
			OR `model` <> 'gemini-embedding-2'
			OR `config_version` <> 'media-embedding-2026-09-13-v1'
		))
		OR `stage` = 'explanation'
		OR (`stage` = 'synthesis' AND `config_version` = 'media-synthesis-2026-09-13-v4')
	);--> statement-breakpoint
UPDATE `media_processing_jobs`
SET `output_json` = NULL
WHERE `stage` = 'explanation';--> statement-breakpoint
DROP TABLE `media_article_embeddings`;--> statement-breakpoint
DROP TABLE `media_game_matches`;