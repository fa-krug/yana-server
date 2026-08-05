ALTER TABLE `jobs` ADD `user_id` text REFERENCES users(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `jobs_user_idx` ON `jobs` (`user_id`);
--> statement-breakpoint
UPDATE jobs SET user_id = (
  SELECT runs.user_id FROM runs WHERE runs.id = jobs.run_id
) WHERE jobs.run_id IS NOT NULL AND jobs.user_id IS NULL;
--> statement-breakpoint
UPDATE jobs SET user_id = (
  SELECT feeds.user_id FROM articles JOIN feeds ON feeds.id = articles.feed_id
  WHERE articles.id = CAST(json_extract(jobs.payload, '$.articleId') AS INTEGER)
) WHERE jobs.kind = 'article.reload' AND jobs.user_id IS NULL;
--> statement-breakpoint
UPDATE jobs SET user_id = (
  SELECT feeds.user_id FROM feeds
  WHERE feeds.id = CAST(json_extract(jobs.payload, '$.feedId') AS INTEGER)
) WHERE jobs.kind IN ('aggregate', 'feed.logo', 'feed.update', 'feed.restore')
  AND jobs.user_id IS NULL;
