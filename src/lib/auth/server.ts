import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

/**
 * `drizzleAdapter()` takes the database handle by value, but `getDb()` opens
 * the SQLite file on its first call and `data/` does not exist until
 * docker-entrypoint.sh runs its migration step -- so calling `getDb()` while
 * this module is being imported would make `next build` (which imports every
 * route's module graph) create and open a database on the build machine, and
 * would also defeat the point of the lazy singleton.
 *
 * A proxy keeps the handle lazy without changing the adapter's shape: the first
 * property the adapter touches resolves `getDb()`, and because `getDb()` is
 * memoized, every later access lands on the same connection. Methods are bound
 * to the real handle so `this` inside Drizzle is never the proxy.
 *
 * The rest of the instance is safe at module scope: `betterAuth()` only records
 * options. It builds its context -- and calls this adapter factory -- lazily,
 * on the first request (see `createAuthContext` in
 * `better-auth/dist/context/create-context.mjs`).
 */
const lazyDb = new Proxy({} as ReturnType<typeof getDb>, {
  get(_target, property, receiver) {
    const db = getDb();
    const value = Reflect.get(db as object, property, receiver);
    return typeof value === "function" ? value.bind(db) : value;
  },
  has(_target, property) {
    return Reflect.has(getDb() as object, property);
  },
});

export const auth = betterAuth({
  database: drizzleAdapter(lazyDb, {
    provider: "sqlite",
    schema,
    /**
     * Better Auth's model names are singular (`user`, `session`, `account`,
     * `verification`, `passkey`); this repository's Drizzle exports are plural.
     * `usePlural` appends the `s` when the adapter resolves a model against the
     * schema object, which is exactly the whole of the mapping this port needs:
     * phase 2 shaped `users` with camelCase Drizzle properties, and the adapter
     * indexes fields by property name (not by SQL column name), so `email`,
     * `emailVerified`, `image`, `createdAt` and `updatedAt` already line up and
     * no per-field `fields` mapping is required.
     */
    usePlural: true,
    /**
     * Left off deliberately. Turning it on makes the adapter wrap writes in
     * `db.transaction(async ...)`, and better-sqlite3 has no async driver --
     * the same hazard `writeTransaction()` in `@/lib/db/client` documents and
     * rejects outright. Better Auth's writes are single-statement, so the loss
     * is theoretical; an async transaction over a synchronous driver would not
     * be.
     */
    transaction: false,
  }),

  emailAndPassword: {
    // Kept enabled alongside passkeys: passkey is *preferred*, not required.
    enabled: true,
    // No mail transport exists, so a verification requirement would lock
    // everyone out permanently.
    requireEmailVerification: false,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  },

  user: {
    additionalFields: {
      firstName: { type: "string", required: false, defaultValue: "" },
      lastName: { type: "string", required: false, defaultValue: "" },
      /**
       * `input: false` is not optional here. Additional fields are part of the
       * sign-up and update-user request bodies by default, so without it
       * anybody could POST `{ isAdmin: true }` to /api/auth/sign-up/email and
       * self-promote. `isAdmin` is the entire authorization model in this app
       * (no roles, no groups), which makes that the whole privilege ladder in
       * one request. Server code sets it directly through Drizzle instead --
       * see the admin bootstrap.
       */
      isAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },

  /**
   * The phase plan also listed Better Auth's `admin()` plugin, on the direction
   * record's belief that it "matches the admin-boolean, no-roles-or-groups
   * requirement". Read at the installed version, it does not: its schema
   * (`better-auth/dist/plugins/admin/schema.mjs`) adds `role`, `banned`,
   * `banReason` and `banExpires` to the user model and `impersonatedBy` to the
   * session, and the adapter throws on any field the Drizzle table lacks -- so
   * enabling it would mean altering `users` to carry a role column, which is
   * the one thing phase 4's constraints forbid ("no roles, no groups, no
   * permissions; `users.isAdmin` is the entire authorization model"). Phase 2
   * had already chosen `isAdmin` over `role` for the same reason.
   *
   * Nothing in the phase needs it: `requireAdmin()` and the sidebar both read
   * `users.isAdmin`, and no task calls an `admin()` endpoint. So it is left
   * out. Adding it later is a schema change, not a config change.
   */
  plugins: [
    passkey({
      rpName: "Yana",
      // Must match the deployment host exactly or WebAuthn silently refuses.
      rpID: process.env.PASSKEY_RP_ID ?? "localhost",
      origin: process.env.PUBLIC_URL ?? "http://localhost:3000",
    }),
  ],
});

export type Auth = typeof auth;
