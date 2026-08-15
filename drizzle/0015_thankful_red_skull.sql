DROP INDEX `article_blocks_embed_provider_idx`;--> statement-breakpoint
CREATE INDEX `article_blocks_embed_thumbnail_ref_idx` ON `article_blocks` (`embed_thumbnail_ref`);