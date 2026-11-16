ALTER TABLE `media_processing_authorizations` ADD `affected_source_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `new_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `reused_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `replaced_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `invalidated_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `skipped_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `refused_request_keys` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `processing_run_id` integer;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `contribution_run_id` integer;--> statement-breakpoint
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
--> statement-breakpoint
-- A source whose fetch failed, or whose article was unusable, left no content
-- or job; its only trace is an outlet attempt on its URL. It is attributed to
-- the latest authorization covering its game that it existed for and that an
-- attempt on its URL followed. A discovery fetch of a source found after every
-- such authorization does not count.
UPDATE `media_sources` SET `processing_run_id` = (
  SELECT MAX(`authorization`.`run_id`)
  FROM `media_processing_authorizations` AS `authorization`
  JOIN `media_discovery_runs` AS `run` ON `run`.`id` = `authorization`.`run_id`
  WHERE julianday(`authorization`.`authorized_at`) >= julianday(`media_sources`.`retrieved_at`)
    AND EXISTS (
      SELECT 1 FROM json_each(`run`.`selected_games`) AS `game`
      WHERE `game`.`value` = `media_sources`.`appid`
        OR `game`.`value` = (SELECT `parent_appid` FROM `apps` WHERE `apps`.`appid` = `media_sources`.`appid`)
    )
    AND EXISTS (
      SELECT 1 FROM `media_discovery_attempts` AS `attempt`
      WHERE `attempt`.`url` = `media_sources`.`original_url`
        AND julianday(`attempt`.`attempted_at`) >= julianday(`authorization`.`authorized_at`)
    )
)
WHERE `processing_run_id` IS NULL;--> statement-breakpoint
-- Text is retained only for pending work of the run that took the source.
-- Text left by a finished run, such as after a failed token count, is
-- discarded.
UPDATE `media_sources` SET `processing_content` = NULL
WHERE `processing_content` IS NOT NULL
  AND (
    `processing_run_id` IS NULL
    OR `processing_run_id` NOT IN (SELECT `run_id` FROM `media_processing_authorizations` WHERE `status` IN ('queued', 'waiting'))
  );
