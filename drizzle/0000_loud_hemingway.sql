CREATE TABLE `article_blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_id` integer NOT NULL,
	`parent_id` integer,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`level` integer,
	`ordered` integer,
	`text` text DEFAULT '' NOT NULL,
	`language` text DEFAULT '' NOT NULL,
	`image_ref` text DEFAULT '' NOT NULL,
	`embed_provider` text DEFAULT '' NOT NULL,
	`embed_thumbnail_ref` text DEFAULT '' NOT NULL,
	`embed_external_url` text DEFAULT '' NOT NULL,
	`embed_title` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `article_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "article_blocks_position_positive" CHECK("position" >= 0),
	CONSTRAINT "article_blocks_level_positive" CHECK("level" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_block_position` ON `article_blocks` (`article_id`,`parent_id`,`position`);--> statement-breakpoint
CREATE INDEX `article_blocks_tree_idx` ON `article_blocks` (`article_id`,`parent_id`,`position`);--> statement-breakpoint
CREATE INDEX `article_blocks_image_ref_idx` ON `article_blocks` (`image_ref`);--> statement-breakpoint
CREATE INDEX `article_blocks_embed_provider_idx` ON `article_blocks` (`embed_provider`);--> statement-breakpoint
CREATE TABLE `article_images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_hash` text NOT NULL,
	`file` text NOT NULL,
	`content_type` text NOT NULL,
	`width` integer,
	`height` integer,
	`byte_size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "article_images_width_positive" CHECK("width" >= 0),
	CONSTRAINT "article_images_height_positive" CHECK("height" >= 0),
	CONSTRAINT "article_images_byte_size_positive" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `article_images_hash_unique` ON `article_images` (`content_hash`);--> statement-breakpoint
CREATE INDEX `article_images_created_idx` ON `article_images` (`created_at`);--> statement-breakpoint
CREATE TABLE `article_inline_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`block_id` integer NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`bold` integer DEFAULT false NOT NULL,
	`italic` integer DEFAULT false NOT NULL,
	`code` integer DEFAULT false NOT NULL,
	`strikethrough` integer DEFAULT false NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `article_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "article_inline_runs_position_positive" CHECK("position" >= 0)
);
--> statement-breakpoint
CREATE INDEX `article_inline_runs_block_idx` ON `article_inline_runs` (`block_id`,`position`);--> statement-breakpoint
CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`identifier` text NOT NULL,
	`raw_content` text DEFAULT '' NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`date` integer NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`icon` text,
	`feed_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `articles_feed_identifier_idx` ON `articles` (`feed_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `articles_feed_date_idx` ON `articles` (`feed_id`,`date`);--> statement-breakpoint
CREATE INDEX `articles_date_idx` ON `articles` (`date`);--> statement-breakpoint
CREATE INDEX `articles_read_idx` ON `articles` (`read`);--> statement-breakpoint
CREATE INDEX `articles_starred_idx` ON `articles` (`starred`);--> statement-breakpoint
CREATE INDEX `articles_feed_read_date_idx` ON `articles` (`feed_id`,`read`,`date`);--> statement-breakpoint
CREATE INDEX `articles_created_id_idx` ON `articles` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `articles_feed_created_idx` ON `articles` (`feed_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `feed_tags` (
	`feed_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`feed_id`, `tag_id`),
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_tags_tag_idx` ON `feed_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`aggregator` text DEFAULT 'full_website' NOT NULL,
	`identifier` text DEFAULT '' NOT NULL,
	`daily_limit` integer DEFAULT 20 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`user_id` text NOT NULL,
	`reddit_subreddit_id` integer,
	`youtube_channel_id` integer,
	`options` text DEFAULT '{}' NOT NULL,
	`logo` text,
	`logo_source_url` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reddit_subreddit_id`) REFERENCES `reddit_subreddits`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`youtube_channel_id`) REFERENCES `youtube_channels`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "feeds_options_json" CHECK(json_valid("options"))
);
--> statement-breakpoint
CREATE INDEX `feeds_user_idx` ON `feeds` (`user_id`);--> statement-breakpoint
CREATE INDEX `feeds_aggregator_idx` ON `feeds` (`aggregator`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_user_unique` ON `tags` (`name`,`user_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`progress` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "jobs_payload_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `jobs_kind_idx` ON `jobs` (`kind`);--> statement-breakpoint
CREATE TABLE `reddit_subreddits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`subscribers` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reddit_subreddits_name_unique` ON `reddit_subreddits` (`display_name`);--> statement-breakpoint
CREATE INDEX `reddit_subreddits_name_idx` ON `reddit_subreddits` (`display_name`);--> statement-breakpoint
CREATE TABLE `youtube_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`handle` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_channels_channel_id_unique` ON `youtube_channels` (`channel_id`);--> statement-breakpoint
CREATE INDEX `youtube_channels_title_idx` ON `youtube_channels` (`title`);--> statement-breakpoint
CREATE TABLE `user_settings` (
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
	`openai_model` text DEFAULT 'gpt-4o-mini' NOT NULL,
	`anthropic_enabled` integer DEFAULT false NOT NULL,
	`anthropic_api_key` text DEFAULT '' NOT NULL,
	`anthropic_model` text DEFAULT 'claude-3-5-sonnet-20240620' NOT NULL,
	`gemini_enabled` integer DEFAULT false NOT NULL,
	`gemini_api_key` text DEFAULT '' NOT NULL,
	`gemini_model` text DEFAULT 'gemini-1.5-flash' NOT NULL,
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
CREATE UNIQUE INDEX `user_settings_user_unique` ON `user_settings` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_settings_user_idx` ON `user_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);