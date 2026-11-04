CREATE TABLE `__new_review_buckets` (
	`appid` integer NOT NULL,
	`source_id` text NOT NULL,
	`granularity` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`positive_count` integer NOT NULL,
	`negative_count` integer NOT NULL,
	`observed_at` text NOT NULL,
	`provenance` text NOT NULL,
	PRIMARY KEY(`appid`, `source_id`, `granularity`, `period_start`, `period_end`),
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `review_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_buckets_granularity_check" CHECK("__new_review_buckets"."granularity" IN ('daily', 'weekly', 'monthly')),
	CONSTRAINT "review_buckets_interval_check" CHECK("__new_review_buckets"."period_start" < "__new_review_buckets"."period_end"),
	CONSTRAINT "review_buckets_positive_count_check" CHECK(typeof("__new_review_buckets"."positive_count") = 'integer' AND "__new_review_buckets"."positive_count" >= 0),
	CONSTRAINT "review_buckets_negative_count_check" CHECK(typeof("__new_review_buckets"."negative_count") = 'integer' AND "__new_review_buckets"."negative_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_review_buckets`("appid", "source_id", "granularity", "period_start", "period_end", "positive_count", "negative_count", "observed_at", "provenance") SELECT "appid", "source_id", "granularity", "period_start", "period_end", "positive_count", "negative_count", "observed_at", "provenance" FROM `review_buckets`;--> statement-breakpoint
DROP TABLE `review_buckets`;--> statement-breakpoint
ALTER TABLE `__new_review_buckets` RENAME TO `review_buckets`;--> statement-breakpoint
CREATE INDEX `idx_review_buckets_appid_period` ON `review_buckets` (`appid`, `period_start` ASC, `period_end` ASC);--> statement-breakpoint
CREATE INDEX `idx_review_buckets_source_period` ON `review_buckets` (`source_id`, `period_start` ASC, `period_end` ASC);