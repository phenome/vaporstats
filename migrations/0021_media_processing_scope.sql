ALTER TABLE `media_processing_authorizations` ADD `affected_source_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `new_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `reused_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `replaced_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `invalidated_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `skipped_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `processing_run_id` integer;--> statement-breakpoint
-- Sources processed before this migration are no longer new to processing.
-- Each is attributed to the latest run that reserved paid work for it, else to
-- the latest processing authorization. A source with no recorded processing
-- state stays new.
UPDATE `media_sources` SET `processing_run_id` = COALESCE(
  (SELECT MAX(`run_id`) FROM `media_processing_jobs` WHERE `media_processing_jobs`.`source_id` = `media_sources`.`id`),
  (SELECT MAX(`run_id`) FROM `media_processing_authorizations`)
)
WHERE `normalized_content_hash` IS NOT NULL
  OR EXISTS (SELECT 1 FROM `media_article_extractions` WHERE `media_article_extractions`.`source_id` = `media_sources`.`id`)
  OR EXISTS (SELECT 1 FROM `media_processing_jobs` WHERE `media_processing_jobs`.`source_id` = `media_sources`.`id`);
