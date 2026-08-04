CREATE TABLE `article_tombstones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`deleted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_tombstones_user_deleted_idx` ON `article_tombstones` (`user_id`,`deleted_at`,`id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_jobs` integer NOT NULL,
	`completed_jobs` integer DEFAULT 0 NOT NULL,
	`failed_jobs` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_user_idx` ON `runs` (`user_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `device_name` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `logo_image_hash` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `run_id` integer REFERENCES runs(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `jobs_run_idx` ON `jobs` (`run_id`);