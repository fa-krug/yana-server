DROP INDEX `jobs_claim_idx`;--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,"priority" desc,"run_at" asc,"id" asc);