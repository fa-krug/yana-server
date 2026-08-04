CREATE TABLE `device_pairing_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_pairing_states_state_unique` ON `device_pairing_states` (`state`);