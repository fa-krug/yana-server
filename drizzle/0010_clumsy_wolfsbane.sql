ALTER TABLE `feeds` ADD `update_interval_minutes` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `concurrency` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `update_interval_minutes`;