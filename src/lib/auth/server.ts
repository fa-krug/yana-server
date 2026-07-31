import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import type { User } from "@/lib/db/schema";

/**
 * `drizzleAdapter()` takes the database handle by value, but `getDb()` opens
 * the SQLite file on its first call and `data/` does not exist until
 * docker-entrypoint.sh runs its migration step -- so calling `getDb()` while
 * this module is being imported would make `next build` (which imports every
 * route's module graph) create and open a database on the build machine, and
 * would also defeat the point of the lazy singleton.
 *
 * This proxy is the *only* thing keeping that from happening -- do not read the
 * absence of an eager `getDb()` as merely tidy. `betterAuth()` starts building
 * its context immediately at import (`createBetterAuth` in
 * `better-auth/dist/auth/base.mjs` calls `init(options)` and stores the promise
 * unawaited), `init` awaits `getAdapter`, and `db/adapter-base.mjs` invokes this
 * adapter factory right there at import time. What makes that safe is narrower
 * than "it is lazy": the factory never *dereferences* the handle
 * (`createCustomAdapter(db)` in `@better-auth/drizzle-adapter` closes over `db`
 * without reading it, and every `db.*` access sits inside an adapter method),
 * so the proxy's traps do not fire until a query runs.
 *
 * Two consequences of the `{}` target that are worth knowing before touching
 * this: the traps only cover `get` and `has`, so `instanceof`, `Object.keys()`,
 * spread and anything else that reflects over the handle sees an empty object;
 * and because `has` calls `getDb()`, a bare `"x" in db` is enough to open the
 * connection. Both are fine for the adapter as it is written today and neither
 * is guaranteed across better-auth upgrades -- if an upgrade starts inspecting
 * the handle at factory time, this is the first place to look.
 */
/**
 * The role the bootstrap grants and phases 5-13 check for, and the full list of
 * roles the `admin()` plugin treats as administrative.
 *
 * Exported and fed *into* the plugin below rather than written twice: anything
 * asking "is this user an admin" (`ensureAdminExists()` in `./bootstrap`, every
 * later authorization check) has to agree with the plugin's own `adminRoles`,
 * and a second literal `"admin"` somewhere else is exactly how those drift. The
 * array is deliberately mutable-typed -- `admin()` takes `string[]`, and an
 * `as const` tuple would need a spread at the call site, which is another copy.
 */
export const ADMIN_ROLE = "admin";
export const ADMIN_ROLES: string[] = [ADMIN_ROLE];

const lazyDb = new Proxy({} as ReturnType<typeof getDb>, {
  get(_target, property) {
    const db = getDb();
    // `db` is the receiver, not the proxy: an accessor property would otherwise
    // run its getter with `this` bound to the empty target.
    const value = Reflect.get(db as object, property, db);
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
     * The adapter default, set explicitly as documentation. It is *not* what
     * keeps this safe on SQLite: every `db.transaction(...)` call site in the
     * adapter is gated on `provider === "mysql"`, so the hazard the setting
     * would otherwise guard -- wrapping writes in `db.transaction(async ...)`
     * over a driver with no async support, which `writeTransaction()` in
     * `@/lib/db/client` documents and rejects -- is unreachable here either
     * way. Left pinned so a future provider change does not silently opt in.
     */
    transaction: false,
  }),

  emailAndPassword: {
    // Kept enabled alongside passkeys: passkey is *preferred*, not required.
    enabled: true,
    /**
     * **There is no self-registration path in this application, by policy.**
     * Accounts come from exactly two places: the admin bootstrap that runs once
     * at startup, and admin-created users in phase 5. No phase ships a
     * registration form.
     *
     * Without this line /api/auth/sign-up/email is a public endpoint on a
     * self-hosted server -- anyone who can reach the host gets a working
     * account, with unbounded account creation and feed-URL fetching as an
     * amplification surface behind it. `disableSignUp` makes the route throw
     * BAD_REQUEST before it reads the body (see the first guard in
     * `better-auth/dist/api/routes/sign-up.mjs`), so no request body can get
     * past it -- which is why it is a config line and not a hook.
     *
     * Server-side provisioning goes through `createUserWithPassword()` below,
     * which is not reachable over HTTP. A later phase adding invitations is
     * reopening self-registration: that is the decision being reversed, so
     * design the invitation token first and keep this closed for callers who do
     * not hold one.
     */
    disableSignUp: true,
    // No mail transport exists, so a verification requirement would lock
    // everyone out permanently.
    requireEmailVerification: false,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    /**
     * Serves the user object from a signed cookie for 5 minutes without a
     * database read. That includes `role`, so an authorization check that
     * trusts this cookie can be up to `maxAge` stale -- a demoted admin keeps
     * admin for 5 minutes. Any check that must be current has to pass
     * `disableCookieCache: true` or read `users.role` from the database.
     */
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
    },
  },

  plugins: [
    passkey({
      rpName: "Yana",
      // Must match the deployment host exactly or WebAuthn silently refuses.
      rpID: process.env.PASSKEY_RP_ID ?? "localhost",
      origin: process.env.PUBLIC_URL ?? "http://localhost:3000",
    }),
    /**
     * `role` is the authorization model, not a boolean -- see the comment on
     * `users.role`. Both options below are the library defaults, set explicitly
     * because the values are load-bearing for every check in phases 5-13 and
     * should not have to be looked up in a `??` chain inside the plugin.
     *
     * Its endpoints (list/create/ban/impersonate users) go unused: phase 5 hand
     * -rolls user CRUD against Drizzle and declines impersonation. What the
     * plugin is here for is the `role` field and its server-side semantics --
     * including `input: false` on `role`, which is what stops a request body
     * from setting it.
     */
    admin({ defaultRole: "user", adminRoles: ADMIN_ROLES }),
  ],
});

/**
 * Better Auth builds its context eagerly at import and stores the promise
 * unawaited, so a rejection there -- `validateSecret` throwing under
 * NODE_ENV=production with no BETTER_AUTH_SECRET is the live case -- would
 * otherwise surface as an *unhandled rejection at module load*. Under Node's
 * default `--unhandled-rejections=throw` that can take a whole server worker
 * down instead of failing the one route that needs auth.
 *
 * Attaching a handler here marks that promise handled without consuming it:
 * `auth.handler` and every `auth.api.*` call await the same promise, so they
 * still reject, and the failure arrives as a 500 on /api/auth/* with the reason
 * in the log. `void` because nothing should await this.
 */
void auth.$context.catch((error: unknown) => {
  console.error(
    "Better Auth failed to initialise. Every /api/auth/* request will fail " +
      "until this is fixed; the most common cause is a missing " +
      "BETTER_AUTH_SECRET under NODE_ENV=production.",
    error,
  );
});

/**
 * Create a user with a password, server-side. **This is the only way an account
 * comes into existence** now that `disableSignUp` closes the public endpoint --
 * the admin bootstrap (task 2) and phase 5's admin user creation both go
 * through here.
 *
 * It reaches past the HTTP layer into `auth.$context` on purpose, and that is
 * exactly why it is safe to expose: `internalAdapter` is not routable, so
 * nothing about this function is reachable by an unauthenticated caller. The
 * hash comes from `ctx.password.hash` -- Better Auth's own scrypt, the same
 * function `/sign-up/email` calls -- so no hashing is hand-rolled and no cost
 * parameter is chosen here. The `linkAccount` shape mirrors that route's
 * (`providerId: "credential"`, `accountId` = the new user id) so a user created
 * here is indistinguishable from one created by sign-up.
 *
 * `role` bypasses `input: false` because that flag guards *request bodies*, not
 * server code; a caller here is already trusted.
 */
export async function createUserWithPassword(input: {
  email: string;
  password: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  role?: string;
}): Promise<User> {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);

  const user = await ctx.internalAdapter.createUser<User>({
    email: input.email,
    name: input.name ?? "",
    firstName: input.firstName ?? "",
    lastName: input.lastName ?? "",
    role: input.role ?? "user",
    emailVerified: false,
  });

  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: hash,
  });

  return user;
}

export type Auth = typeof auth;
