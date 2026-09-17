ALTER TABLE `articles` ADD `external_id` text;--> statement-breakpoint
CREATE INDEX `articles_feed_external_id_idx` ON `articles` (`feed_id`,`external_id`);