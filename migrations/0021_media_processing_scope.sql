ALTER TABLE `media_processing_authorizations` ADD `affected_source_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `new_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `reused_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `replaced_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `invalidated_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `skipped_outputs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_processing_authorizations` ADD `refused_request_keys` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `processing_run_id` integer;--> statement-breakpoint
ALTER TABLE `media_sources` ADD `contribution_run_id` integer;--> statement-breakpoint
-- Each media source paired with every processing authorization whose run
-- covers the source's game, directly or through its parent game.
CREATE TEMP VIEW `media_source_coverage` AS
SELECT `source`.`id` AS `source_id`, `source`.`retrieved_at`, `authorization`.`run_id`, `authorization`.`status`, `authorization`.`authorized_at`
FROM `media_sources` AS `source`
JOIN `media_processing_authorizations` AS `authorization`
JOIN `media_discovery_runs` AS `run` ON `run`.`id` = `authorization`.`run_id`
WHERE EXISTS (
  SELECT 1 FROM json_each(`run`.`selected_games`) AS `game`
  WHERE `game`.`value` = `source`.`appid`
    OR `game`.`value` = (SELECT `parent_appid` FROM `apps` WHERE `apps`.`appid` = `source`.`appid`)
);--> statement-breakpoint
-- Sources processed before this migration are no longer new to processing.
-- Each is attributed to the latest run that reserved paid work for it, else to
-- the latest authorization covering its game that it existed for. A source
-- with no recorded processing state stays new.
UPDATE `media_sources` SET `processing_run_id` = COALESCE(
  (SELECT MAX(`run_id`) FROM `media_processing_jobs` WHERE `media_processing_jobs`.`source_id` = `media_sources`.`id`),
  (SELECT MAX(`coverage`.`run_id`) FROM `media_source_coverage` AS `coverage`
    WHERE `coverage`.`source_id` = `media_sources`.`id`
      AND julianday(`coverage`.`authorized_at`) >= julianday(`coverage`.`retrieved_at`))
)
WHERE `normalized_content_hash` IS NOT NULL
  OR EXISTS (SELECT 1 FROM `media_article_extractions` WHERE `media_article_extractions`.`source_id` = `media_sources`.`id`)
  OR EXISTS (SELECT 1 FROM `media_processing_jobs` WHERE `media_processing_jobs`.`source_id` = `media_sources`.`id`);
--> statement-breakpoint
-- A source whose fetch failed, or whose article was unusable, left no content
-- or job; its only trace is a processing fetch of its URL. It is attributed to
-- the latest authorization covering its game that it existed for and that
-- such a fetch followed. Attempts record no stage, so a fetch made while a
-- discovery run of the attempt's game was running is taken as a discovery
-- fetch and does not count.
UPDATE `media_sources` SET `processing_run_id` = (
  SELECT MAX(`coverage`.`run_id`)
  FROM `media_source_coverage` AS `coverage`
  WHERE `coverage`.`source_id` = `media_sources`.`id`
    AND julianday(`coverage`.`authorized_at`) >= julianday(`coverage`.`retrieved_at`)
    AND EXISTS (
      SELECT 1 FROM `media_discovery_attempts` AS `attempt`
      WHERE `attempt`.`url` = `media_sources`.`original_url`
        AND `attempt`.`kind` IN ('fetch', 'redirect', 'failure')
        AND julianday(`attempt`.`attempted_at`) >= julianday(`coverage`.`authorized_at`)
        AND NOT EXISTS (
          SELECT 1 FROM `media_discovery_runs` AS `discovery`, json_each(`discovery`.`selected_games`) AS `game`
          WHERE (`game`.`value` = `attempt`.`appid`
              OR `game`.`value` = (SELECT `parent_appid` FROM `apps` WHERE `apps`.`appid` = `attempt`.`appid`))
            AND julianday(`attempt`.`attempted_at`) >= julianday(`discovery`.`started_at`)
            AND (`discovery`.`finished_at` IS NULL
              OR julianday(`attempt`.`attempted_at`) < julianday(`discovery`.`finished_at`, '+1 second'))
        )
    )
)
WHERE `processing_run_id` IS NULL;--> statement-breakpoint
-- A run that was queued or waiting at upgrade still owes the Overview and
-- embedding work of every game it covers; a current output is kept without
-- paid work.
UPDATE `media_sources` SET `contribution_run_id` = (
  SELECT MAX(`coverage`.`run_id`) FROM `media_source_coverage` AS `coverage`
  WHERE `coverage`.`source_id` = `media_sources`.`id` AND `coverage`.`status` IN ('queued', 'waiting')
)
WHERE EXISTS (
  SELECT 1 FROM `media_source_coverage` AS `coverage`
  WHERE `coverage`.`source_id` = `media_sources`.`id` AND `coverage`.`status` IN ('queued', 'waiting')
);--> statement-breakpoint
-- A game with an active extraction but no active Overview, or no active
-- embedding, is attributed to the latest run covering it, the run that left
-- that work undone. A later run builds it once its affected set covers the
-- game.
UPDATE `media_sources` SET `contribution_run_id` = (
  SELECT MAX(`coverage`.`run_id`) FROM `media_source_coverage` AS `coverage`
  WHERE `coverage`.`source_id` = `media_sources`.`id`
)
WHERE `contribution_run_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `media_article_extractions` AS `extraction`
    JOIN `media_sources` AS `game_source` ON `game_source`.`id` = `extraction`.`source_id`
    WHERE `extraction`.`active` = 1 AND `game_source`.`appid` = `media_sources`.`appid`
  )
  AND (
    NOT EXISTS (SELECT 1 FROM `media_game_overviews` WHERE `media_game_overviews`.`appid` = `media_sources`.`appid` AND `media_game_overviews`.`active` = 1)
    OR NOT EXISTS (SELECT 1 FROM `media_game_embeddings` WHERE `media_game_embeddings`.`appid` = `media_sources`.`appid` AND `media_game_embeddings`.`active` = 1)
  );--> statement-breakpoint
DROP VIEW `media_source_coverage`;--> statement-breakpoint
-- Text is retained only for pending work of the run that took the source.
-- Text left by a finished run, such as after a failed token count, is
-- discarded.
UPDATE `media_sources` SET `processing_content` = NULL
WHERE `processing_content` IS NOT NULL
  AND (
    `processing_run_id` IS NULL
    OR `processing_run_id` NOT IN (SELECT `run_id` FROM `media_processing_authorizations` WHERE `status` IN ('queued', 'waiting'))
  );
