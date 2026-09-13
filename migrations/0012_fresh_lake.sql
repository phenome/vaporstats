CREATE TABLE `media_tag_memberships` (
	`appid` integer NOT NULL,
	`tag_slug` text NOT NULL,
	`tag_label` text NOT NULL,
	`source_id` integer NOT NULL,
	`extraction_input_identity` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_tag_memberships_identity` ON `media_tag_memberships` (`appid`,`tag_slug`,`source_id`,`extraction_input_identity`);