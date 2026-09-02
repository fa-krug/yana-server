DROP TABLE `ai_requests`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `raw_content`;--> statement-breakpoint
ALTER TABLE `articles` DROP COLUMN `content_hash`;--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `ai_max_tokens`;--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `ai_default_daily_limit`;--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `ai_default_monthly_limit`;--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `ai_max_prompt_length`;