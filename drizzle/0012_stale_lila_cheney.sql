ALTER TABLE `user_settings` ADD `openrouter_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `openrouter_api_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `openrouter_model` text DEFAULT 'openrouter/free' NOT NULL;