DROP INDEX `jobs_claim_idx`;--> statement-breakpoint
ALTER TABLE `jobs` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`priority`,`run_at`);