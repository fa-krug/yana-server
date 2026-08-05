ALTER TABLE `user_settings` ADD `mistral_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `mistral_api_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `mistral_model` text DEFAULT 'mistral-small-latest' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `qwen_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `qwen_api_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `qwen_model` text DEFAULT 'qwen3.5-flash' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `deepseek_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `deepseek_api_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `deepseek_model` text DEFAULT 'deepseek-v4-flash' NOT NULL;