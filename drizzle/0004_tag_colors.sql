ALTER TABLE `tags` ADD `color` text DEFAULT 'red' NOT NULL;
--> statement-breakpoint
UPDATE `tags` SET `color` = CASE (`id` % 12)
  WHEN 0 THEN 'red'
  WHEN 1 THEN 'orange'
  WHEN 2 THEN 'amber'
  WHEN 3 THEN 'yellow'
  WHEN 4 THEN 'lime'
  WHEN 5 THEN 'green'
  WHEN 6 THEN 'teal'
  WHEN 7 THEN 'cyan'
  WHEN 8 THEN 'blue'
  WHEN 9 THEN 'indigo'
  WHEN 10 THEN 'violet'
  ELSE 'pink'
END;