ALTER TABLE `media_discovery_progress` ADD `completed_at` text;--> statement-breakpoint
-- A query completed before this migration keeps the time of its search, by
-- its run's clock, which is the closest recorded time to its completion.
UPDATE `media_discovery_progress` SET `completed_at` = `query_attempted_at` WHERE `status` = 'completed';
