ALTER TABLE `feeds` ADD `update_interval_minutes` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `concurrency` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `update_interval_minutes`;--> statement-breakpoint
UPDATE `feeds` SET `update_interval_minutes` = 60, `concurrency` = 2 WHERE `aggregator` IN ('caschys_blog', 'youtube', 'reddit');--> statement-breakpoint
UPDATE `feeds` SET `update_interval_minutes` = 1440 WHERE `aggregator` IN ('explosm', 'dark_legacy', 'oglaf', 'podcast');