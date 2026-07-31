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
