ALTER TABLE `media_discovery_progress` ADD `stopped_at` text;--> statement-breakpoint
-- A query stopped before this migration keeps the time of its last update,
-- which is no earlier than its stop, so it reopens on a UTC day after that.
UPDATE `media_discovery_progress` SET `stopped_at` = `updated_at` WHERE `status` = 'stopped';
