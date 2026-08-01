import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { users } from "./users";

/**
 * Better Auth's satellite tables. `users` is NOT here: phase 2 already shaped
 * it for Better Auth (see schema/users.ts), so phase 4 only adds what hangs off
 * it.
 *
 * Two rules govern every column below, and breaking either produces runtime
 * failures that read like data corruption rather than a config mistake:
 *
 * 1. **The Drizzle *property* name is the contract, not the SQL column name.**
 *    The Drizzle adapter resolves a field by indexing the table object --
 *    `schemaModel[getFieldName({ model, field })]` in
 *    `@better-auth/drizzle-adapter` -- and `getFieldName` returns Better Auth's
 *    camelCase field name unless a `fields` mapping overrides it. So the
 *    property must be spelled exactly as Better Auth spells the field
 *    (`credentialID`, capital `ID` and all); the `text("credential_id")`
 *    argument is free to stay snake_case, matching every other table here.
 * 2. **The field set comes from the installed version, not from memory.** These
 *    were read out of `getAuthTables()` in
 *    `@better-auth/core/dist/db/get-tables.mjs` and out of the passkey plugin's
 *    `schema.ts` (`@better-auth/passkey`) at better-auth 1.6.25. Re-read those
 *    two places on an upgrade; a field Better Auth writes but the table lacks
 *    throws `The field "x" does not exist in the "y" Drizzle schema`.
 *
 * No `check()` constraints here, deliberately, unlike the ported tables. The
 * convention in CLAUDE.md exists to mirror what Django's SQLite backend
 * emitted; these tables have no Django ancestor, and none of them carries the
 * JSON column that makes a check load-bearing. Inventing constraints for tables
 * a third-party library owns risks a future Better Auth release writing a value
 * we decided was illegal -- and a CHECK cannot be added to an existing SQLite
 * table without the 12-step rebuild, so it would also be expensive to undo.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /**
     * The session cookie's value. Unique because Better Auth looks a session up
     * by token on every authenticated request.
     */
    token: text("token").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /**
     * The `admin()` plugin's one session column: the admin id behind an
     * impersonation session. No phase impersonates -- phase 5 declined it -- but
     * the plugin declares the field, and the adapter throws on a declared field
     * the table lacks, so it exists.
     */
    impersonatedBy: text("impersonated_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * Better Auth declares `onUpdate` on this field but no `defaultValue`, and
     * its adapter skips a value-less field on insert -- so the SQL default is
     * what fills this row on create, and `$onUpdate` (the same `auto_now=True`
     * port the other tables use) keeps it moving afterwards. Both halves are
     * needed.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("sessions_token_unique").on(table.token),
    index("sessions_user_idx").on(table.userId),
  ],
);

/**
 * Credentials. The email/password provider stores its scrypt hash in
 * `password`; the OAuth columns are unused today (no social providers are
 * configured) and are kept because Better Auth's account model declares them
 * and writes them unconditionally when a provider is added.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    /** The provider's own id for this user. For credentials, the user id. */
    accountId: text("account_id").notNull(),
    /** `"credential"` for email/password; a provider slug otherwise. */
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    /**
     * Better Auth's scrypt hash, never a plaintext password and never a hash of
     * our own making. Nothing in this repository writes this column directly.
     */
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [index("accounts_user_idx").on(table.userId)],
);

/**
 * Short-lived tokens (password reset, email change). Email verification is off
 * -- there is no mail transport -- but the table is still required: Better Auth
 * writes here for every token-bearing flow, not just verification.
 */
export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/**
 * Registered WebAuthn authenticators, from the `@better-auth/passkey` plugin.
 *
 * `credentialID` keeps Better Auth's capitalisation because the adapter indexes
 * the table object by field name -- see the module comment. Renaming it to
 * `credentialId` compiles and then fails at registration time.
 */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    /** User-chosen label, e.g. "MacBook Touch ID". Optional. */
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    /**
     * WebAuthn signature counter. Not constrained to `>= 0` here -- see the
     * module comment on why these tables carry no `check()`.
     */
    counter: integer("counter").notNull().default(0),
    /** `"singleDevice"` or `"multiDevice"`. */
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    /** Comma-separated WebAuthn transports ("internal,hybrid"). */
    transports: text("transports"),
    /** Authenticator model id. Apple devices report all zeroes. */
    aaguid: text("aaguid"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("passkeys_user_idx").on(table.userId),
    index("passkeys_credential_idx").on(table.credentialID),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
export type Passkey = typeof passkeys.$inferSelect;
export type NewPasskey = typeof passkeys.$inferInsert;
