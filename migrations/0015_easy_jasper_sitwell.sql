CREATE TABLE `reception_collection_failures` (
	`appid` integer PRIMARY KEY NOT NULL,
	`first_failed_at` text NOT NULL,
	`last_failed_at` text NOT NULL,
	`failure_count` integer DEFAULT 1 NOT NULL,
	`failure_category` text NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reception_collection_failures_count_check" CHECK(typeof("reception_collection_failures"."failure_count") = 'integer' AND "reception_collection_failures"."failure_count" > 0),
	CONSTRAINT "reception_collection_failures_category_check" CHECK("reception_collection_failures"."failure_category" IN ('steam_summary', 'steam_histogram', 'steam_events', 'score_calculation', 'persistence'))
);
--> statement-breakpoint
CREATE INDEX `idx_reception_collection_failures_order` ON `reception_collection_failures` ("failure_count" desc,`first_failed_at`);