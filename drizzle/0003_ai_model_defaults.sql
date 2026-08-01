PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`article_retention_days` integer DEFAULT 60 NOT NULL,
	`update_interval_minutes` integer DEFAULT 30 NOT NULL,
	`reddit_enabled` integer DEFAULT false NOT NULL,
	`reddit_client_id` text DEFAULT '' NOT NULL,
	`reddit_client_secret` text DEFAULT '' NOT NULL,
	`reddit_user_agent` text DEFAULT 'Yana/1.0' NOT NULL,
	`youtube_enabled` integer DEFAULT false NOT NULL,
	`youtube_api_key` text DEFAULT '' NOT NULL,
	`active_ai_provider` text DEFAULT '' NOT NULL,
	`openai_enabled` integer DEFAULT false NOT NULL,
	`openai_api_url` text DEFAULT 'https://api.openai.com/v1' NOT NULL,
	`openai_api_key` text DEFAULT '' NOT NULL,
	`openai_model` text DEFAULT 'gpt-5.6-luna' NOT NULL,
	`anthropic_enabled` integer DEFAULT false NOT NULL,
	`anthropic_api_key` text DEFAULT '' NOT NULL,
	`anthropic_model` text DEFAULT 'claude-haiku-4-5' NOT NULL,
	`gemini_enabled` integer DEFAULT false NOT NULL,
	`gemini_api_key` text DEFAULT '' NOT NULL,
	`gemini_model` text DEFAULT 'gemini-3.5-flash-lite' NOT NULL,
	`ai_temperature` real DEFAULT 0.3 NOT NULL,
	`ai_max_tokens` integer DEFAULT 2000 NOT NULL,
	`ai_default_daily_limit` integer DEFAULT 200 NOT NULL,
	`ai_default_monthly_limit` integer DEFAULT 2000 NOT NULL,
	`ai_max_prompt_length` integer DEFAULT 500 NOT NULL,
	`ai_request_timeout` integer DEFAULT 120 NOT NULL,
	`ai_max_retries` integer DEFAULT 3 NOT NULL,
	`ai_retry_delay` integer DEFAULT 2 NOT NULL,
	`ai_request_delay` integer DEFAULT 2 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_settings`("id", "user_id", "theme", "language", "article_retention_days", "update_interval_minutes", "reddit_enabled", "reddit_client_id", "reddit_client_secret", "reddit_user_agent", "youtube_enabled", "youtube_api_key", "active_ai_provider", "openai_enabled", "openai_api_url", "openai_api_key", "openai_model", "anthropic_enabled", "anthropic_api_key", "anthropic_model", "gemini_enabled", "gemini_api_key", "gemini_model", "ai_temperature", "ai_max_tokens", "ai_default_daily_limit", "ai_default_monthly_limit", "ai_max_prompt_length", "ai_request_timeout", "ai_max_retries", "ai_retry_delay", "ai_request_delay", "created_at", "updated_at") SELECT "id", "user_id", "theme", "language", "article_retention_days", "update_interval_minutes", "reddit_enabled", "reddit_client_id", "reddit_client_secret", "reddit_user_agent", "youtube_enabled", "youtube_api_key", "active_ai_provider", "openai_enabled", "openai_api_url", "openai_api_key", "openai_model", "anthropic_enabled", "anthropic_api_key", "anthropic_model", "gemini_enabled", "gemini_api_key", "gemini_model", "ai_temperature", "ai_max_tokens", "ai_default_daily_limit", "ai_default_monthly_limit", "ai_max_prompt_length", "ai_request_timeout", "ai_max_retries", "ai_retry_delay", "ai_request_delay", "created_at", "updated_at" FROM `user_settings`;--> statement-breakpoint
DROP TABLE `user_settings`;--> statement-breakpoint
ALTER TABLE `__new_user_settings` RENAME TO `user_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_user_unique` ON `user_settings` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_settings_user_idx` ON `user_settings` (`user_id`);