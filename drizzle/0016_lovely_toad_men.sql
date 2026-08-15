PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_article_inline_runs` (
	`block_id` integer NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`bold` integer DEFAULT false NOT NULL,
	`italic` integer DEFAULT false NOT NULL,
	`code` integer DEFAULT false NOT NULL,
	`strikethrough` integer DEFAULT false NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`block_id`, `position`),
	FOREIGN KEY (`block_id`) REFERENCES `article_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "article_inline_runs_position_positive" CHECK("position" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_article_inline_runs`("block_id", "position", "text", "bold", "italic", "code", "strikethrough", "link") SELECT "block_id", "position", "text", "bold", "italic", "code", "strikethrough", "link" FROM `article_inline_runs`;--> statement-breakpoint
DROP TABLE `article_inline_runs`;--> statement-breakpoint
ALTER TABLE `__new_article_inline_runs` RENAME TO `article_inline_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;