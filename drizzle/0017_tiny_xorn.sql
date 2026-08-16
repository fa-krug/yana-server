DROP INDEX `jobs_claim_idx`;--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,"priority" desc,"run_at" asc,"id" asc);--> statement-breakpoint
ALTER TABLE `articles` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `articles_updated_id_idx` ON `articles` (`updated_at`,`id`);