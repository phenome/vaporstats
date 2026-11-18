CREATE TABLE `media_enrollments` (
	`appid` integer PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`enrolled_at` text NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_enrollments_reason_check" CHECK("media_enrollments"."reason" IN ('experiment', 'new_release', 'watchlist'))
);
--> statement-breakpoint
-- Every existing discovery run was started by the retired manual trigger, so
-- each keeps the `authorized` origin. The migration seeds no enrollment: the
-- daily media run records enrollments and the enrollment start date.
ALTER TABLE `media_discovery_runs` ADD `origin` text DEFAULT 'authorized' NOT NULL;
