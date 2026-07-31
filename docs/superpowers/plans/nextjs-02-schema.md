# Phase 2: Drizzle Schema — Implementation Plan

> **Path note: this plan predates the folder swap.** It was written while the
> project lived in `yana-next/`. Phase 14 promoted that tree to the repository
> root and moved the Django tree to `old/`. Read every `yana-next/…` path below
> as a repository-root path, and every `core/…` / `yana/…` path as `old/core/…` /
> `old/yana/…`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the complete Drizzle schema — the ported domain tables, the four deliberate deviations, and the jobs table — with migrations generated and a bootstrap user seeded.

**Architecture:** One Drizzle table module per concern, re-exported through `schema.ts`. Ownership flows from `users`; articles inherit their owner through `feedId`, so `read`/`starred` stay plain columns with no per-user join table. The `users` table is shaped to Better Auth's expectations now so phase 4 only has to add the satellite tables rather than migrate this one.

**Tech Stack:** Drizzle ORM (SQLite dialect), drizzle-kit, Vitest.

## Global Constraints

- **Greenfield.** No data migrates from Django. Table and column names are idiomatic — no `core_` prefix, `camelCase` in TypeScript mapping to `snake_case` columns.
- Every index and constraint from `core/models.py` is reproduced. Missing an index is a silent performance regression that no test catches.
- `users` must be **Better Auth-compatible** from the start: `id` (text), `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt`. Phase 4 adds `sessions` / `accounts` / `passkeys` around it. Deviating here forces a migration in phase 4.
- `uniqBlockPosition` carries a known limitation, which must be commented in the code: **SQLite treats NULLs as distinct in a unique index**, so the constraint does not cover root-level rows (`parentId IS NULL`). Root position uniqueness is the application's job.
- `articleImages` has **no owner column** — images are content-addressed and shared across users by design.
- Timestamps are stored as SQLite `integer` with `{ mode: "timestamp" }`. Consistent everywhere; mixing modes silently breaks comparisons.
- The four deviations from "same schema as we currently have" are the ones the direction record lists, and no others.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/db/schema/users.ts` | `users`, `userSettings` |
| `src/lib/db/schema/feeds.ts` | `feeds`, `tags`, `feedTags` |
| `src/lib/db/schema/articles.ts` | `articles`, `articleBlocks`, `articleInlineRuns`, `articleImages` |
| `src/lib/db/schema/jobs.ts` | `jobs` |
| `src/lib/db/schema/references.ts` | `redditSubreddits`, `youtubeChannels` |
| `src/lib/db/schema/enums.ts` | Aggregator keys, block kinds, embed providers, job statuses |
| `src/lib/db/schema.ts` | Barrel re-exporting everything, plus relations |
| `src/lib/db/bootstrap.ts` | Seeds the bootstrap user |
| `drizzle/*.sql` | Generated migrations |

---

### Task 1: Port the shared enumerations

These are copied from Python constants rather than retyped from memory: `core/choices.py::AGGREGATOR_CHOICES`, and `BLOCK_KINDS` / `EMBED_PROVIDERS` / `STYLE_NAMES` from `core/blocks/types.py`.

**Files:**
- Create: `yana-next/src/lib/db/schema/enums.ts`
- Test: `yana-next/src/lib/db/schema/enums.test.ts`

**Interfaces:**
- Produces: `AGGREGATOR_KEYS`, `BLOCK_KINDS`, `EMBED_PROVIDERS`, `STYLE_NAMES`, `JOB_STATUSES` — all `readonly string[]` with matching `type` unions (`AggregatorKey`, `BlockKind`, `EmbedProvider`, `StyleName`, `JobStatus`).

- [ ] **Step 1: Read the real values out of Python**

```bash
cd /Users/skrug/PycharmProjects/yana-server
uv run python -c "
from core.choices import AGGREGATOR_CHOICES
from core.blocks.types import BLOCK_KINDS, EMBED_PROVIDERS, STYLE_NAMES
print('aggregators:', [k for k, _ in AGGREGATOR_CHOICES])
print('block kinds:', list(BLOCK_KINDS))
print('embeds:', list(EMBED_PROVIDERS))
print('styles:', list(STYLE_NAMES))
"
```

Use that output verbatim in Step 3. Do not retype from memory — a wrong aggregator key is a runtime failure that surfaces only when someone creates that feed type.

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/db/schema/enums.test.ts
import { describe, expect, it } from "vitest";

import { BLOCK_KINDS, EMBED_PROVIDERS, JOB_STATUSES, STYLE_NAMES } from "./enums";

describe("enums", () => {
  it("keeps list_item as a storage-only block kind", () => {
    // list_item encodes a list's [[Block]] shape as rows. It never appears on
    // the wire -- see core/blocks/types.py.
    expect(BLOCK_KINDS).toContain("list_item");
  });

  it("orders styles as the wire's styles array does", () => {
    expect(STYLE_NAMES).toEqual(["bold", "italic", "code", "strikethrough"]);
  });

  it("ends embed providers with the generic fallback", () => {
    expect(EMBED_PROVIDERS.at(-1)).toBe("generic");
  });

  it("defines the job lifecycle", () => {
    expect(JOB_STATUSES).toEqual(["pending", "running", "succeeded", "failed"]);
  });
});
```

- [ ] **Step 3: Write `enums.ts` using the Step 1 output**

```ts
// src/lib/db/schema/enums.ts

/** Mirrors core/choices.py AGGREGATOR_CHOICES. Substitute the Step 1 output. */
export const AGGREGATOR_KEYS = [
  "rss",
  "full_website",
  "youtube",
  "reddit",
  "podcast",
  "heise",
  "tagesschau",
  "merkur",
  "mein_mmo",
  "caschys_blog",
  "mactechnews",
  "the_verge",
  "ars_technica",
  "explosm",
  "dark_legacy",
  "oglaf",
] as const;
export type AggregatorKey = (typeof AGGREGATOR_KEYS)[number];

/**
 * Mirrors core/blocks/types.py BLOCK_KINDS.
 * `list_item` is the one synthetic kind: a list's children are list_item rows
 * and each item's children are its content blocks. It never goes on the wire.
 */
export const BLOCK_KINDS = [
  "paragraph",
  "heading",
  "list",
  "list_item",
  "blockquote",
  "image",
  "embed",
  "code_block",
  "divider",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Anything unrecognized decodes to `generic`, never fatal. */
export const EMBED_PROVIDERS = ["youtube", "dailymotion", "video", "tweet", "generic"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** Order matters: the wire's `styles` array uses it. */
export const STYLE_NAMES = ["bold", "italic", "code", "strikethrough"] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

export const JOB_STATUSES = ["pending", "running", "succeeded", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
```

- [ ] **Step 4: Run the tests, then commit**

```bash
cd yana-next && npm test -- enums
```

Expected: PASS.

```bash
cd .. && git add yana-next/src/lib/db/schema/enums.ts yana-next/src/lib/db/schema/enums.test.ts
git commit -m "feat(next): Port the shared enumerations

Values are read out of the Python constants rather than retyped, because a wrong
aggregator key only fails at runtime when someone creates that feed type."
```

---

### Task 2: Users and settings

**Files:**
- Create: `yana-next/src/lib/db/schema/users.ts`

**Interfaces:**
- Produces: `users`, `userSettings` tables, and inferred types `User`, `NewUser`, `UserSettings`, `NewUserSettings`.

- [ ] **Step 1: Write the schema**

```ts
// src/lib/db/schema/users.ts
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Shaped to Better Auth's expectations (phase 4) so that phase only adds the
 * satellite tables -- sessions, accounts, passkeys -- rather than migrating this
 * one. `isAdmin` is the entire authorization model: no roles, no groups.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default(""),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    /** Uploaded avatar path. Null means render initials on a generated colour. */
    image: text("image"),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

/**
 * Per-user credentials and preferences.
 *
 * Grows four columns beyond the Django model, for phase 3's settings tab:
 * theme, language, articleRetentionDays and updateIntervalMinutes. Retention is
 * currently a job kwarg rather than a setting; this promotes it.
 */
export const userSettings = sqliteTable(
  "user_settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // --- General (new in this migration) ---
    theme: text("theme").notNull().default("system"), // "light" | "dark" | "system"
    language: text("language").notNull().default("en"), // "en" | "de"

    // --- Library (new in this migration) ---
    articleRetentionDays: integer("article_retention_days").notNull().default(60),
    updateIntervalMinutes: integer("update_interval_minutes").notNull().default(30),

    // --- Reddit ---
    redditEnabled: integer("reddit_enabled", { mode: "boolean" }).notNull().default(false),
    redditClientId: text("reddit_client_id").notNull().default(""),
    redditClientSecret: text("reddit_client_secret").notNull().default(""),
    redditUserAgent: text("reddit_user_agent").notNull().default("Yana/1.0"),

    // --- YouTube ---
    youtubeEnabled: integer("youtube_enabled", { mode: "boolean" }).notNull().default(false),
    youtubeApiKey: text("youtube_api_key").notNull().default(""),

    // --- AI provider selection: empty disables AI entirely ---
    activeAiProvider: text("active_ai_provider").notNull().default(""),

    openaiEnabled: integer("openai_enabled", { mode: "boolean" }).notNull().default(false),
    openaiApiUrl: text("openai_api_url").notNull().default("https://api.openai.com/v1"),
    openaiApiKey: text("openai_api_key").notNull().default(""),
    openaiModel: text("openai_model").notNull().default("gpt-4o-mini"),

    anthropicEnabled: integer("anthropic_enabled", { mode: "boolean" }).notNull().default(false),
    anthropicApiKey: text("anthropic_api_key").notNull().default(""),
    anthropicModel: text("anthropic_model").notNull().default("claude-3-5-sonnet-20240620"),

    geminiEnabled: integer("gemini_enabled", { mode: "boolean" }).notNull().default(false),
    geminiApiKey: text("gemini_api_key").notNull().default(""),
    geminiModel: text("gemini_model").notNull().default("gemini-1.5-flash"),

    // --- Global AI tuning (phase 7's advanced section) ---
    aiTemperature: real("ai_temperature").notNull().default(0.3),
    aiMaxTokens: integer("ai_max_tokens").notNull().default(2000),
    aiDefaultDailyLimit: integer("ai_default_daily_limit").notNull().default(200),
    aiDefaultMonthlyLimit: integer("ai_default_monthly_limit").notNull().default(2000),
    aiMaxPromptLength: integer("ai_max_prompt_length").notNull().default(500),
    aiRequestTimeout: integer("ai_request_timeout").notNull().default(120),
    aiMaxRetries: integer("ai_max_retries").notNull().default(3),
    aiRetryDelay: integer("ai_retry_delay").notNull().default(2),
    /** Seconds between AI calls, to stay under provider rate limits. */
    aiRequestDelay: integer("ai_request_delay").notNull().default(2),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("user_settings_user_unique").on(table.userId), index("user_settings_user_idx").on(table.userId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;
```

> The AI model defaults are copied from `core/models.py` as-is, including the stale ones. Refreshing them is a deliberate change belonging to phase 7, not a silent one here.

- [ ] **Step 2: Commit**

```bash
git add yana-next/src/lib/db/schema/users.ts
git commit -m "feat(next): Add users and user settings

users is shaped to Better Auth's expectations now so phase 4 only adds satellite
tables instead of migrating this one. isAdmin is the whole authorization model.

user_settings gains theme, language, articleRetentionDays and
updateIntervalMinutes for phase 3 -- retention was a job kwarg, not a setting.
Stale AI model defaults are copied verbatim; refreshing them belongs to phase 7."
```

---

### Task 3: Feeds and tags

**Files:**
- Create: `yana-next/src/lib/db/schema/feeds.ts`

**Interfaces:**
- Produces: `feeds`, `tags`, `feedTags` tables and their inferred types.

- [ ] **Step 1: Write the schema**

```ts
// src/lib/db/schema/feeds.ts
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { redditSubreddits, youtubeChannels } from "./references";
import { users } from "./users";

/** Replaces Django's FeedGroup. Many-per-feed via feedTags. */
export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("tags_name_user_unique").on(table.name, table.userId)],
);

export const feeds = sqliteTable(
  "feeds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    aggregator: text("aggregator").notNull().default("full_website"),
    /** URL or external id. Required for reddit and youtube, optional elsewhere. */
    identifier: text("identifier").notNull().default(""),
    dailyLimit: integer("daily_limit").notNull().default(20),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Autocomplete relationships, mirroring Feed.reddit_subreddit / youtube_channel.
    redditSubredditId: integer("reddit_subreddit_id").references(() => redditSubreddits.id, {
      onDelete: "set null",
    }),
    youtubeChannelId: integer("youtube_channel_id").references(() => youtubeChannels.id, {
      onDelete: "set null",
    }),

    /**
     * Aggregator-specific configuration. Stays JSON in the column, but is typed
     * in code by the per-aggregator Zod registry (phase 9), which also generates
     * the create/edit form body.
     */
    options: text("options", { mode: "json" }).notNull().$type<Record<string, unknown>>().default({}),

    logo: text("logo"),
    /** Kept so the logo can be re-resolved without re-discovering the source. */
    logoSourceUrl: text("logo_source_url").notNull().default(""),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("feeds_user_idx").on(table.userId),
    index("feeds_aggregator_idx").on(table.aggregator),
  ],
);

export const feedTags = sqliteTable(
  "feed_tags",
  {
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.feedId, table.tagId] }),
    // Reverse lookup: "which feeds carry this tag" drives the sidebar.
    index("feed_tags_tag_idx").on(table.tagId),
  ],
);

export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
```

> Django's `feeds_group_idx` has no counterpart — the `group` column is gone. `feed_tags_tag_idx` replaces its purpose.

- [ ] **Step 2: Commit**

```bash
git add yana-next/src/lib/db/schema/feeds.ts
git commit -m "feat(next): Add feeds and many-per-feed tags

tags + feed_tags replace FeedGroup and the single Feed.group FK. The reverse
index on tagId is what makes the sidebar's 'feeds carrying this tag' query cheap;
it replaces the dropped feeds_group_idx.

options stays a JSON column but gains a typed Zod registry in phase 9, which also
generates the aggregator-dependent form body."
```

---

### Task 4: Articles, blocks, runs and images

**Files:**
- Create: `yana-next/src/lib/db/schema/articles.ts`

**Interfaces:**
- Produces: `articles`, `articleBlocks`, `articleInlineRuns`, `articleImages` and their inferred types.

- [ ] **Step 1: Write the schema**

```ts
// src/lib/db/schema/articles.ts
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { feeds } from "./feeds";

/**
 * `content` from the Django model is deliberately absent: it held processed HTML
 * that blocks were rebuilt from, and blocks are authoritative here. `rawContent`
 * remains as the debugging surface and as what phase 12's reload action re-runs.
 */
export const articles = sqliteTable(
  "articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** URL or external id. */
    identifier: text("identifier").notNull(),
    rawContent: text("raw_content").notNull().default(""),
    /** Block tree flattened to visible text, for search. */
    plainText: text("plain_text").notNull().default(""),
    /**
     * The feed's real publish time. Aggregation never rewrites it, and it is for
     * display only -- never for retention or sync cursors. See createdAt.
     */
    date: integer("date", { mode: "timestamp" }).notNull(),
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    author: text("author").notNull().default(""),
    /** Per-article header image, written by the header-element extractor. */
    icon: text("icon"),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    /**
     * Stable, append-only ordering key. Retention and the phase 13 sync cursor
     * both key off this, NOT off `date`: keying retention off `date` would delete
     * articles almost immediately whenever their publish date already sits near
     * the retention cutoff.
     */
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("articles_feed_identifier_idx").on(table.feedId, table.identifier),
    index("articles_feed_date_idx").on(table.feedId, table.date),
    index("articles_date_idx").on(table.date),
    index("articles_read_idx").on(table.read),
    index("articles_starred_idx").on(table.starred),
    index("articles_feed_read_date_idx").on(table.feedId, table.read, table.date),
    // Sync cursor: createdAt with id as tie-breaker.
    index("articles_created_id_idx").on(table.createdAt, table.id),
    index("articles_feed_created_idx").on(table.feedId, table.createdAt),
  ],
);

/**
 * One node of an article body in the Yana content format.
 *
 * Typed rows rather than an opaque JSON document, so the database understands
 * the data: imageRef is indexed (orphan pruning becomes a join) and
 * embedProvider is indexed ("articles containing video" becomes answerable).
 */
export const articleBlocks = sqliteTable(
  "article_blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    parentId: integer("parent_id").references((): AnySQLiteColumn => articleBlocks.id, {
      onDelete: "cascade",
    }),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),

    level: integer("level"), // heading
    ordered: integer("ordered", { mode: "boolean" }), // list
    text: text("text").notNull().default(""), // code_block
    language: text("language").notNull().default(""), // code_block
    imageRef: text("image_ref").notNull().default(""), // image

    embedProvider: text("embed_provider").notNull().default(""),
    embedThumbnailRef: text("embed_thumbnail_ref").notNull().default(""),
    embedExternalUrl: text("embed_external_url").notNull().default(""),
    embedTitle: text("embed_title").notNull().default(""),
  },
  (table) => [
    /**
     * KNOWN LIMITATION, carried over deliberately: SQLite treats NULLs as
     * distinct in a unique index, so this does NOT cover root-level rows where
     * parentId IS NULL. Root position uniqueness is enforced in application
     * code -- see the block writer. Do not "fix" this by dropping the
     * constraint; it still covers every nested row.
     */
    uniqueIndex("uniq_block_position").on(table.articleId, table.parentId, table.position),
    index("article_blocks_tree_idx").on(table.articleId, table.parentId, table.position),
    index("article_blocks_image_ref_idx").on(table.imageRef),
    index("article_blocks_embed_provider_idx").on(table.embedProvider),
  ],
);

/**
 * A styled span inside a paragraph, heading or image caption.
 *
 * Four real booleans, not a bitmask: the reason to choose rows over a JSON
 * document is that the database understands the data, and an opaque integer
 * would hand that back.
 */
export const articleInlineRuns = sqliteTable(
  "article_inline_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blockId: integer("block_id")
      .notNull()
      .references(() => articleBlocks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    bold: integer("bold", { mode: "boolean" }).notNull().default(false),
    italic: integer("italic", { mode: "boolean" }).notNull().default(false),
    code: integer("code", { mode: "boolean" }).notNull().default(false),
    strikethrough: integer("strikethrough", { mode: "boolean" }).notNull().default(false),
    link: text("link").notNull().default(""),
  },
  (table) => [index("article_inline_runs_block_idx").on(table.blockId, table.position)],
);

/**
 * Content-addressed image, referenced from block trees as `yana-img://<hash>`.
 *
 * The hash is SHA-256 over the *stored* (compressed) bytes, so one row per
 * distinct byte sequence: the same image across ten articles is stored once.
 * Unowned on purpose -- deduplication crosses users.
 */
export const articleImages = sqliteTable(
  "article_images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentHash: text("content_hash").notNull(),
    file: text("file").notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    byteSize: integer("byte_size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("article_images_hash_unique").on(table.contentHash),
    index("article_images_created_idx").on(table.createdAt),
  ],
);

export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type ArticleBlock = typeof articleBlocks.$inferSelect;
export type NewArticleBlock = typeof articleBlocks.$inferInsert;
export type ArticleInlineRun = typeof articleInlineRuns.$inferSelect;
export type ArticleImage = typeof articleImages.$inferSelect;
```

- [ ] **Step 2: Commit**

```bash
git add yana-next/src/lib/db/schema/articles.ts
git commit -m "feat(next): Add articles, blocks, inline runs and images

Article.content is deliberately not created -- blocks are authoritative and
rawContent covers debugging and phase 12's reload. All eight article indexes are
reproduced, including the createdAt+id sync cursor.

The uniq_block_position limitation is carried over with a comment explaining it:
SQLite treats NULLs as distinct, so root-level rows are not covered and the block
writer enforces their positions."
```

---

### Task 5: Jobs and reference tables

**Files:**
- Create: `yana-next/src/lib/db/schema/jobs.ts`, `yana-next/src/lib/db/schema/references.ts`

**Interfaces:**
- Produces: `jobs`, `redditSubreddits`, `youtubeChannels` and their inferred types. Phase 12's worker claims rows from `jobs`.

- [ ] **Step 1: Write `references.ts`**

```ts
// src/lib/db/schema/references.ts
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Autocomplete cache for the feeds form. */
export const redditSubreddits = sqliteTable(
  "reddit_subreddits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    displayName: text("display_name").notNull(),
    title: text("title").notNull().default(""),
    subscribers: integer("subscribers").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("reddit_subreddits_name_unique").on(table.displayName)],
);

export const youtubeChannels = sqliteTable(
  "youtube_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id").notNull(),
    title: text("title").notNull(),
    handle: text("handle").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("youtube_channels_channel_id_unique").on(table.channelId),
    index("youtube_channels_title_idx").on(table.title),
  ],
);
```

- [ ] **Step 2: Write `jobs.ts`**

```ts
// src/lib/db/schema/jobs.ts
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Durable work queue, replacing django-q2's ORM broker. Same idea: the database
 * is the broker, so there is no Redis to run.
 *
 * The claim protocol is a conditional UPDATE inside BEGIN IMMEDIATE -- see
 * phase 12. `progress` exists so long bulk actions can report to the toast
 * system rather than appearing hung.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** When the job becomes eligible. Retry backoff pushes this forward. */
    runAt: integer("run_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    /** 0-100, for progress reporting on bulk actions. */
    progress: integer("progress").notNull().default(0),
    error: text("error").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // The claim query's index: pending jobs whose runAt has passed, oldest first.
    index("jobs_claim_idx").on(table.status, table.runAt),
    index("jobs_kind_idx").on(table.kind),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
```

- [ ] **Step 3: Commit**

```bash
git add yana-next/src/lib/db/schema/jobs.ts yana-next/src/lib/db/schema/references.ts
git commit -m "feat(next): Add the jobs queue and reference tables

jobs keeps django-q2's core idea -- the database is the broker, so no Redis. The
composite (status, runAt) index is the claim query's index. progress exists so
bulk actions report to the toast system instead of looking hung."
```

---

### Task 6: Barrel, relations, migrations and bootstrap

**Files:**
- Modify: `yana-next/src/lib/db/schema.ts`
- Create: `yana-next/src/lib/db/bootstrap.ts`, `yana-next/src/lib/db/schema.test.ts`
- Create: `yana-next/drizzle/0000_*.sql` (generated)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `schema.ts` re-exporting every table plus Drizzle `relations`.
  - `BOOTSTRAP_USER_ID: string` — the constant phase 3 reads settings for and phase 4 replaces with session lookups.
  - `ensureBootstrapUser(): Promise<string>` — idempotent; returns the user id.

- [ ] **Step 1: Write the barrel with relations**

```ts
// src/lib/db/schema.ts
import { relations } from "drizzle-orm";

import {
  articleBlocks,
  articleImages,
  articleInlineRuns,
  articles,
} from "./schema/articles";
import { feedTags, feeds, tags } from "./schema/feeds";
import { jobs } from "./schema/jobs";
import { redditSubreddits, youtubeChannels } from "./schema/references";
import { userSettings, users } from "./schema/users";

export * from "./schema/articles";
export * from "./schema/enums";
export * from "./schema/feeds";
export * from "./schema/jobs";
export * from "./schema/references";
export * from "./schema/users";

export const usersRelations = relations(users, ({ many, one }) => ({
  feeds: many(feeds),
  tags: many(tags),
  settings: one(userSettings),
}));

export const feedsRelations = relations(feeds, ({ many, one }) => ({
  owner: one(users, { fields: [feeds.userId], references: [users.id] }),
  articles: many(articles),
  feedTags: many(feedTags),
}));

export const tagsRelations = relations(tags, ({ many, one }) => ({
  owner: one(users, { fields: [tags.userId], references: [users.id] }),
  feedTags: many(feedTags),
}));

export const feedTagsRelations = relations(feedTags, ({ one }) => ({
  feed: one(feeds, { fields: [feedTags.feedId], references: [feeds.id] }),
  tag: one(tags, { fields: [feedTags.tagId], references: [tags.id] }),
}));

export const articlesRelations = relations(articles, ({ many, one }) => ({
  feed: one(feeds, { fields: [articles.feedId], references: [feeds.id] }),
  blocks: many(articleBlocks),
}));

export const articleBlocksRelations = relations(articleBlocks, ({ many, one }) => ({
  article: one(articles, { fields: [articleBlocks.articleId], references: [articles.id] }),
  parent: one(articleBlocks, {
    fields: [articleBlocks.parentId],
    references: [articleBlocks.id],
    relationName: "blockTree",
  }),
  children: many(articleBlocks, { relationName: "blockTree" }),
  runs: many(articleInlineRuns),
}));

export const articleInlineRunsRelations = relations(articleInlineRuns, ({ one }) => ({
  block: one(articleBlocks, {
    fields: [articleInlineRuns.blockId],
    references: [articleBlocks.id],
  }),
}));

// Referenced for completeness so the barrel's export surface is explicit.
export { articleImages, jobs, redditSubreddits, youtubeChannels };
```

- [ ] **Step 2: Generate the migration**

```bash
cd yana-next
npx drizzle-kit generate
ls drizzle/
```

Expected: a `0000_*.sql` file. Read it. Confirm every `CREATE INDEX` you declared appears, and that `uniq_block_position` is a `CREATE UNIQUE INDEX`.

- [ ] **Step 3: Write the failing test**

```ts
// src/lib/db/schema.test.ts
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applyPragmas } from "./client";

function freshDb(): Database.Database {
  const connection = new Database(":memory:");
  applyPragmas(connection);
  const dir = path.resolve(import.meta.dirname, "../../../drizzle");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    // drizzle-kit separates statements with this marker.
    for (const statement of readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) connection.exec(statement);
    }
  }
  return connection;
}

describe("migrations", () => {
  it("creates every expected table", () => {
    const connection = freshDb();
    const names = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const expected of [
      "users",
      "user_settings",
      "feeds",
      "tags",
      "feed_tags",
      "articles",
      "article_blocks",
      "article_inline_runs",
      "article_images",
      "jobs",
      "reddit_subreddits",
      "youtube_channels",
    ]) {
      expect(names).toContain(expected);
    }
    connection.close();
  });

  it("reproduces every article index", () => {
    const connection = freshDb();
    const names = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='articles'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const expected of [
      "articles_feed_identifier_idx",
      "articles_feed_date_idx",
      "articles_date_idx",
      "articles_read_idx",
      "articles_starred_idx",
      "articles_feed_read_date_idx",
      "articles_created_id_idx",
      "articles_feed_created_idx",
    ]) {
      expect(names).toContain(expected);
    }
    connection.close();
  });

  it("does not constrain root-level block positions, which is why the writer must", () => {
    const connection = freshDb();
    connection.exec(`
      INSERT INTO users (id, email) VALUES ('u1', 'a@b.c');
      INSERT INTO feeds (name, user_id, date) VALUES ('f', 'u1', 0);
    `);
    // Guard the documented SQLite NULL-distinctness behavior so nobody
    // "simplifies" the application-side check away.
    const insert = connection.prepare(
      "INSERT INTO article_blocks (article_id, parent_id, position, kind) VALUES (?, NULL, ?, ?)",
    );
    connection.exec(
      "INSERT INTO articles (name, identifier, date, feed_id) VALUES ('a', 'i', 0, 1)",
    );
    insert.run(1, 0, "paragraph");
    expect(() => insert.run(1, 0, "paragraph")).not.toThrow();
    connection.close();
  });
});
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- schema
```

Expected: PASS. If the third test *throws*, the unique index somehow does cover NULLs on this SQLite build — a genuinely useful discovery. Update the block-writer plan in 11a accordingly and note it here.

- [ ] **Step 5: Write the bootstrap**

```ts
// src/lib/db/bootstrap.ts
import { eq } from "drizzle-orm";

import { getDb } from "./client";
import { userSettings, users } from "./schema";

/**
 * The pre-auth owner.
 *
 * Phase 3 needs somewhere to persist settings before authentication exists
 * (phase 4). Rather than reorder the phases, every query is scoped to this
 * constant, and phase 4 swaps the source of the id from here to the session.
 * No UI changes at that point -- only where the id comes from.
 */
export const BOOTSTRAP_USER_ID = "bootstrap";

export async function ensureBootstrapUser(): Promise<string> {
  const db = getDb();

  const existing = db.select().from(users).where(eq(users.id, BOOTSTRAP_USER_ID)).get();
  if (!existing) {
    db.insert(users)
      .values({
        id: BOOTSTRAP_USER_ID,
        email: "admin@admin.com",
        name: "Admin",
        firstName: "Admin",
        lastName: "",
        isAdmin: true,
      })
      .run();
  }

  const settings = db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, BOOTSTRAP_USER_ID))
    .get();
  if (!settings) {
    db.insert(userSettings).values({ userId: BOOTSTRAP_USER_ID }).run();
  }

  return BOOTSTRAP_USER_ID;
}
```

- [ ] **Step 6: Verify the full check suite, then commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

```bash
cd .. && git add yana-next
git commit -m "feat(next): Add relations, generate migrations, seed a bootstrap user

The bootstrap user resolves the phase 3/4 seam: phase 3 needs somewhere to
persist settings before auth exists, so queries scope to a constant id that
phase 4 swaps for a session lookup. No UI changes then -- only the id's source.

A test asserts root-level block positions are NOT constrained by
uniq_block_position, guarding the documented SQLite NULL-distinctness behavior so
nobody deletes the application-side check as redundant."
```

---

## Self-Review

**Spec coverage.** Against the direction record's schema section:

| Requirement | Task |
|---|---|
| Ported tables, same columns/indexes/constraints | 2, 3, 4, 5 |
| `auth_*` / `django_q_*` etc. dropped | Not created anywhere |
| `tags` + `feed_tags` | 3 |
| `Article.content` absent | 4 |
| `user_settings` grows 4 preference columns | 2 |
| Zod option registry | Column typed here; registry is phase 9 |
| `users`, `sessions`, `accounts`, `passkeys` | `users` here; satellites are phase 4 |
| `jobs` | 5 |
| `userId` on feeds/tags/user_settings | 2, 3 |
| `read`/`starred` plain columns, no join table | 4 |
| `articleImages` unowned | 4 |
| `uniqBlockPosition` NULL caveat documented | 4, tested in 6 |
| `Article.icon` retained | 4 |
| Bootstrap user for the 3/4 seam | 6 |

**Placeholder scan.** No TBDs. Task 1 Step 1 reads enum values out of Python rather than trusting this document's list — the aggregator keys in Step 3 are a best reconstruction and must be replaced with the real output.

**Type consistency.** Table identifiers are `camelCase` in TS and `snake_case` in SQL throughout, with no exceptions. `users.id` is `text` and every FK referencing it is `text`; `feeds.id` is `integer` and its referrers are `integer`. `BOOTSTRAP_USER_ID` is `string`, matching `users.id`. Inferred type names (`Feed`, `NewFeed`, …) follow one convention. `articleBlocks.parentId` uses `AnySQLiteColumn` for the self-reference, which is what Drizzle requires to avoid a circular inference error.

**One deliberate omission.** No test asserts the *column* set matches Django's, only tables and the article indexes. A column-level comparison would need to read Django's schema, and Django is gone by the time this matters. The `uniq_block_position` and index tests cover what actually breaks silently; column drift surfaces immediately as a type error.
