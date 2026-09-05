ALTER TABLE `apps` ADD COLUMN `has_left_early_access` integer CONSTRAINT `apps_has_left_early_access_check` CHECK (`has_left_early_access` IS NULL OR `has_left_early_access` IN (0, 1));
--> statement-breakpoint
CREATE TABLE `app_release_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appid` integer NOT NULL,
	`expected_date` text NOT NULL,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_app_release_plans_appid_observed_at` ON `app_release_plans` (`appid`,"observed_at" asc);
