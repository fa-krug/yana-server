CREATE VIRTUAL TABLE `articles_fts` USING fts5(
  `name`,
  `plain_text`,
  content=`articles`,
  content_rowid=`id`,
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `articles_fts`(`rowid`, `name`, `plain_text`)
  SELECT `id`, `name`, `plain_text` FROM `articles`;
--> statement-breakpoint
CREATE TRIGGER `articles_fts_insert` AFTER INSERT ON `articles` BEGIN
  INSERT INTO `articles_fts`(`rowid`, `name`, `plain_text`)
    VALUES (new.`id`, new.`name`, new.`plain_text`);
END;
--> statement-breakpoint
CREATE TRIGGER `articles_fts_delete` AFTER DELETE ON `articles` BEGIN
  INSERT INTO `articles_fts`(`articles_fts`, `rowid`, `name`, `plain_text`)
    VALUES ('delete', old.`id`, old.`name`, old.`plain_text`);
END;
--> statement-breakpoint
CREATE TRIGGER `articles_fts_update` AFTER UPDATE ON `articles` BEGIN
  INSERT INTO `articles_fts`(`articles_fts`, `rowid`, `name`, `plain_text`)
    VALUES ('delete', old.`id`, old.`name`, old.`plain_text`);
  INSERT INTO `articles_fts`(`rowid`, `name`, `plain_text`)
    VALUES (new.`id`, new.`name`, new.`plain_text`);
END;
