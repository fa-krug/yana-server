ALTER TABLE `sessions` ADD `impersonated_by` text;--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `banned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `ban_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `ban_expires` integer;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `is_admin`;