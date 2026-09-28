CREATE TABLE `app_creators` (
	`appid` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`role` text NOT NULL,
	`sort_order` integer NOT NULL,
	PRIMARY KEY(`appid`, `creator_id`, `role`),
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_creators_role_check" CHECK("app_creators"."role" IN ('developer', 'publisher'))
);
--> statement-breakpoint
CREATE INDEX `idx_app_creators_creator_app` ON `app_creators` (`creator_id`,`appid`);--> statement-breakpoint
CREATE TABLE `creator_aliases` (
	`name` text PRIMARY KEY NOT NULL,
	`creator_id` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_creator_aliases_creator` ON `creator_aliases` (`creator_id`);--> statement-breakpoint
CREATE TABLE `creators` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`steam_group_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creators_steam_group_id_unique` ON `creators` (`steam_group_id`);
--> statement-breakpoint
-- SQLite TRIM removes spaces by default; these code points match JavaScript String.trim().
CREATE TEMP TABLE `_creator_names_backfill` AS
SELECT `appid`, 'developer' AS `role`,
	TRIM(`developer`, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS `name`
FROM `apps`
UNION ALL
SELECT `appid`, 'publisher' AS `role`,
	TRIM(`publisher`, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS `name`
FROM `apps`;
--> statement-breakpoint
DELETE FROM `_creator_names_backfill` WHERE `name` IS NULL OR `name` = '';
--> statement-breakpoint
INSERT INTO `creators` (`display_name`, `steam_group_id`)
SELECT 'CAPCOM Co., Ltd.', 33273264
WHERE EXISTS (
	SELECT 1 FROM `_creator_names_backfill`
	WHERE `name` IN ('CAPCOM Co., Ltd.', 'CAPCOM CO., LTD', 'CAPCOM CO., LTD.')
);
--> statement-breakpoint
INSERT INTO `creators` (`display_name`)
SELECT DISTINCT `name` FROM `_creator_names_backfill`
WHERE `name` NOT IN ('CAPCOM Co., Ltd.', 'CAPCOM CO., LTD', 'CAPCOM CO., LTD.')
ORDER BY `name`;
--> statement-breakpoint
INSERT INTO `creator_aliases` (`name`, `creator_id`)
SELECT `display_name`, `id` FROM `creators` WHERE `steam_group_id` IS NULL;
--> statement-breakpoint
INSERT INTO `creator_aliases` (`name`, `creator_id`)
SELECT DISTINCT `names`.`name`, `creators`.`id`
FROM `_creator_names_backfill` AS `names`
JOIN `creators` ON `creators`.`steam_group_id` = 33273264
WHERE `names`.`name` IN ('CAPCOM Co., Ltd.', 'CAPCOM CO., LTD', 'CAPCOM CO., LTD.');
--> statement-breakpoint
INSERT INTO `app_creators` (`appid`, `creator_id`, `role`, `sort_order`)
SELECT `names`.`appid`, `creator_aliases`.`creator_id`, `names`.`role`, 0
FROM `_creator_names_backfill` AS `names`
JOIN `creator_aliases` ON `creator_aliases`.`name` = `names`.`name`;
--> statement-breakpoint
DROP TABLE `_creator_names_backfill`;