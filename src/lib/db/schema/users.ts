import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Shaped to Better Auth's expectations. Phase 2 got the core columns right;
 * phase 4 added the four the `admin()` plugin declares (see below) and dropped
 * the `isAdmin` boolean phase 2 had guessed at.
 *
 * **`role` is the authorization model.** It replaced `isAdmin` when phase 4
 * enabled Better Auth's `admin()` plugin, whose schema is role-based: keeping a
 * boolean alongside it would have meant two sources of truth for "may this
 * person delete users", one written by the plugin's `setRole` and one by our own
 * UI, with nothing keeping them agreed. A string also scales past two tiers,
 * where a boolean needs a migration plus a rewrite of every check. Still no
 * groups and no permission table: the only role this app reads is `"admin"`.
 *
 * `role`, `banned`, `banReason` and `banExpires` are the plugin's declared field
 * set, copied from `better-auth/dist/plugins/admin/schema.mjs` rather than from
 * memory -- the adapter throws on any field it declares that the table lacks.
 * `banned`/`banReason`/`banExpires` have no UI in any planned phase; they exist
 * because the plugin writes them.
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
    /**
     * `"admin"` or `"user"`. Better Auth declares this optional, so its model
     * would tolerate NULL; the column does not, because a nullable role makes
     * every check in phases 5-13 ask whether NULL means `"user"`. Nothing in
     * Better Auth writes NULL here -- `setRole` and the plugin's `createUser`
     * both write a string, and plain sign-up omits the field, which is what the
     * SQL default is for.
     */
    role: text("role").notNull().default("user"),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    /** Nullable: the plugin's `unbanUser` writes NULL to both ban columns. */
    banReason: text("ban_reason"),
    banExpires: integer("ban_expires", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * `auto_now=True` in Django. `$onUpdate` is the port of that: it is
     * client-side (it does not appear in the DDL), so every write must go
     * through Drizzle for it to hold -- which the writeTransaction() convention
     * already requires. Declared here rather than at a dozen call sites across
     * phases 3-13, none of which would remember.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

/**
 * Per-user credentials and preferences.
 *
 * Grows three columns beyond the Django model, for phase 3's settings tab:
 * theme, language and articleRetentionDays. Retention is currently a job
 * kwarg rather than a setting; this promotes it. `updateIntervalMinutes` was
 * a fourth (phase 3) but moved to a per-feed column on `feeds` -- see
 * docs/superpowers/specs/2026-08-06-per-feed-interval-and-concurrency-design.md.
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

    // --- Reddit ---
    redditEnabled: integer("reddit_enabled", { mode: "boolean" }).notNull().default(false),
    redditClientId: text("reddit_client_id").notNull().default(""),
    redditClientSecret: text("reddit_client_secret").notNull().default(""),
    redditUserAgent: text("reddit_user_agent").notNull().default("Yana/1.0"),

    // --- YouTube ---
    youtubeEnabled: integer("youtube_enabled", { mode: "boolean" }).notNull().default(false),
    youtubeApiKey: text("youtube_api_key").notNull().default(""),

    /**
     * --- AI provider selection: empty disables AI entirely ---
     *
     * **A value here is a preference, not a permission**, and the two are kept
     * apart on purpose. `setActiveProvider()` refuses to *write* a provider whose
     * probe-derived `*Enabled` flag is false, but nothing erases what is already
     * written when a flag later goes false -- a rejected re-probe, a removed key.
     * Which provider is *actually* active is derived instead, by
     * `activeProvider()` in `src/lib/ai/queries.ts`, which answers "none"
     * whenever the named provider's flag disagrees.
     *
     * Clearing the column on those paths was written and then removed. It bought
     * nothing the derivation did not already give, and it cost real state:
     * OpenAI's `insufficient_quota` is classified `unauthorized` deliberately
     * (see `src/lib/ai/openai.ts`), so an unpaid bill on the active provider
     * would have permanently erased a selection the operator never changed --
     * and paying it would not bring the selection back. Left alone, it does.
     */
    activeAiProvider: text("active_ai_provider").notNull().default(""),

    /**
     * The provider a request falls back to when the active one will not answer
     * -- refused credentials, a rate limit its own retry policy could not ride
     * out, an outage, or a network failure. `""` means there is no fallback and
     * a failed request is simply a failed request, which is what every row
     * before this column existed keeps meaning.
     *
     * **A preference, exactly like `active_ai_provider` above, and derived the
     * same way on the read side** (`fallbackProvider()` in
     * `src/lib/ai/queries.ts`): what is written here is only honoured while the
     * named provider's own `*Enabled` flag agrees, and never when it names the
     * provider that is already active -- a chain that retries the endpoint that
     * just failed is not a fallback. Nothing erases the column when either
     * condition stops holding, for the reason spelled out above: the derivation
     * brings the choice back by itself once the flag does, and clearing would
     * discard a selection the operator never changed.
     *
     * **A fallback needs an active provider to fall back *from*.** With
     * `active_ai_provider` empty the AI features are off entirely, and this
     * column is inert rather than a second way to switch them on.
     */
    fallbackAiProvider: text("fallback_ai_provider").notNull().default(""),

    /**
     * **The eight defaults below (one base URL plus each of the seven providers'
     * default model) are hand-maintained duplicates of
     * `src/lib/ai/providers.ts`**, and `src/lib/ai/defaults.test.ts` is what
     * keeps them honest: it migrates a real database, inserts a bare row, and
     * compares what SQLite filled in against `OPENAI_DEFAULT_API_URL` and each
     * provider's `defaultModel`.
     *
     * They are literals rather than imports of the registry on purpose. A
     * derived DDL default would change silently whenever a model list is
     * refreshed, and the migration that has to accompany it would be discovered
     * by a container that boots against an out-of-date table rather than by CI.
     * Written out, refreshing the registry fails that test until the migration
     * exists -- which is the same "duplicate plus tripwire" arrangement the
     * `better-sqlite3` override and `bodySizeLimit` already use.
     *
     * Phase 2 copied the Django-era ids (`gpt-4o-mini`,
     * `claude-3-5-sonnet-20240620`, `gemini-1.5-flash`) verbatim so that
     * refreshing them would be a visible, deliberate change. Migration `0003` is
     * that change. It matters beyond tidiness: a stored model absent from its
     * provider's list makes Base UI's `<Select.Value>` print the raw id, because
     * it resolves its label from `items` alone (CLAUDE.md). `getAiStatus()` falls
     * back to `defaultModel` for exactly that reason -- this default is what
     * keeps the fallback from being needed on every new account.
     */
    openaiEnabled: integer("openai_enabled", { mode: "boolean" }).notNull().default(false),
    openaiApiUrl: text("openai_api_url").notNull().default("https://api.openai.com/v1"),
    openaiApiKey: text("openai_api_key").notNull().default(""),
    openaiModel: text("openai_model").notNull().default("gpt-5.6-luna"),

    anthropicEnabled: integer("anthropic_enabled", { mode: "boolean" }).notNull().default(false),
    anthropicApiKey: text("anthropic_api_key").notNull().default(""),
    anthropicModel: text("anthropic_model").notNull().default("claude-haiku-4-5"),

    geminiEnabled: integer("gemini_enabled", { mode: "boolean" }).notNull().default(false),
    geminiApiKey: text("gemini_api_key").notNull().default(""),
    geminiModel: text("gemini_model").notNull().default("gemini-3.5-flash-lite"),

    mistralEnabled: integer("mistral_enabled", { mode: "boolean" }).notNull().default(false),
    mistralApiKey: text("mistral_api_key").notNull().default(""),
    mistralModel: text("mistral_model").notNull().default("mistral-small-latest"),

    qwenEnabled: integer("qwen_enabled", { mode: "boolean" }).notNull().default(false),
    qwenApiKey: text("qwen_api_key").notNull().default(""),
    qwenModel: text("qwen_model").notNull().default("qwen3.5-flash"),

    deepseekEnabled: integer("deepseek_enabled", { mode: "boolean" }).notNull().default(false),
    deepseekApiKey: text("deepseek_api_key").notNull().default(""),
    deepseekModel: text("deepseek_model").notNull().default("deepseek-v4-flash"),

    openrouterEnabled: integer("openrouter_enabled", { mode: "boolean" }).notNull().default(false),
    openrouterApiKey: text("openrouter_api_key").notNull().default(""),
    openrouterModel: text("openrouter_model").notNull().default("openrouter/free"),

    // --- Global AI tuning (phase 7's advanced section) ---
    aiTemperature: real("ai_temperature").notNull().default(0.3),
    aiMaxPromptLength: integer("ai_max_prompt_length").notNull().default(500),
    aiRequestTimeout: integer("ai_request_timeout").notNull().default(120),
    aiMaxRetries: integer("ai_max_retries").notNull().default(3),
    aiRetryDelay: integer("ai_retry_delay").notNull().default(2),
    /** Seconds between AI calls, to stay under provider rate limits. */
    aiRequestDelay: integer("ai_request_delay").notNull().default(2),

    // --- Reading position: the client's cross-device "current article" sync ---
    /**
     * The article the client last set as "current", or NULL if never set.
     * Deliberately **not** a `.references()` FK: retention and feed-delete
     * hard-delete `articles` rows outright (see `articleTombstones`, which
     * denormalizes `articleId` the same way rather than enforcing one), and
     * this pointer is meant to go stale rather than block that delete or
     * cascade into silently clearing itself. The client already falls back to
     * its normal anchor when a synced id doesn't resolve locally.
     */
    readingPositionArticleId: integer("reading_position_article_id"),
    /**
     * Stamped only by `PATCH /api/v1/reading-position`, never by the
     * `$onUpdate` on this row's own `updatedAt` below -- that one fires on
     * *any* write to this settings row (a theme change, an AI key save), which
     * would misreport "just synced" for a write that never touched the
     * reading position at all.
     */
    readingPositionUpdatedAt: integer("reading_position_updated_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * `auto_now=True` in Django. `$onUpdate` is the port of that: it is
     * client-side (it does not appear in the DDL), so every write must go
     * through Drizzle for it to hold -- which the writeTransaction() convention
     * already requires. Declared here rather than at a dozen call sites across
     * phases 3-13, none of which would remember.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("user_settings_user_unique").on(table.userId),
    index("user_settings_user_idx").on(table.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;
