import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin, oneTimeToken } from "better-auth/plugins";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import type { User } from "@/lib/db/schema";

import { ADMIN_ROLES } from "./roles";

/**
 * `drizzleAdapter()` takes the database handle by value, but `getDb()` opens
 * the SQLite file on its first call and `data/` does not exist until
 * the server's own startup hook migrates it -- so calling `getDb()` while
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

/**
 * **Every endpoint the `admin()` plugin mounts. All of them are closed.**
 *
 * The plugin is enabled for its `role` field and its server-side semantics, not
 * for its HTTP surface -- no phase from 4 to 13 calls one of these, and phase 5
 * hand-rolls its user CRUD against Drizzle. Left open they were a live hazard
 * rather than dead weight, in three separate ways found by the phase-4 review:
 *
 * - **`/admin/set-role` accepts an arbitrary string or array.** With no custom
 *   `roles` map configured there is nothing to validate against, so an
 *   administrator could write `["user","admin"]` and land the literal
 *   `"user,admin"` in the column. The plugin reads that as a list and this
 *   application read it as one string, so the two disagreed about who was an
 *   administrator -- and `adminExists()` then reported "no admin" for an
 *   instance that had one, tried to recreate `admin@admin.com`, hit
 *   `users_email_unique` and took startup down **permanently**, with no
 *   in-app recovery. `isAdminRole()` splitting on commas (`./roles`) and the
 *   bootstrap repairing instead of rethrowing (`./bootstrap`) close the other
 *   two halves of that; this closes the cheapest way to trigger it.
 * - **`/admin/create-user` writes no `user_settings` row.** Only
 *   `ensureAdminExists()` does. `getSettings()` throws when the row is absent
 *   and is deliberately not self-healing, so a user created this way could sign
 *   in and then meet the error boundary on `/settings` forever.
 * - **`/admin/update-user` passes `ctx.body.data` (`z.record(z.any(),
 *   z.any())`) straight to `internalAdapter.updateUser`** -- an arbitrary-column
 *   write, which is why closing individual fields (as `/update-user` needed for
 *   `image`) would have been whack-a-mole here.
 *
 * `disabledPaths` gates **HTTP routing only** (`api/index.mjs`, `onRequest`),
 * so `auth.api.*` calls from server code still work -- which is how
 * `roles.test.ts` cross-checks `isAdminRole()` against the plugin's own
 * `/admin/has-permission` semantics without reopening the route.
 *
 * The list is written out rather than derived, because the plugin exports no
 * manifest of its paths; it is pinned against the installed library by
 * `server.test.ts`, which fails if a future version adds an endpoint this list
 * does not name.
 */
export const ADMIN_PLUGIN_PATHS = [
  "/admin/ban-user",
  "/admin/create-user",
  "/admin/get-user",
  "/admin/has-permission",
  "/admin/impersonate-user",
  "/admin/list-user-sessions",
  "/admin/list-users",
  "/admin/remove-user",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/stop-impersonating",
  "/admin/unban-user",
  "/admin/update-user",
];

/**
 * Every `/one-time-token/*` path the installed `oneTimeToken()` plugin
 * declares. Closed via `disabledPaths` below for the same reason
 * `ADMIN_PLUGIN_PATHS` is: this app never calls either endpoint over HTTP.
 * `generate` is unusable over HTTP here anyway (see the module doc on
 * `mintWebviewSessionToken` in `src/lib/auth/webview-session.ts` for why:
 * it resolves its caller via `sessionMiddleware`, cookie-only, and this app
 * has no `bearer()` plugin installed). `verify` is called exclusively via
 * `auth.api.verifyOneTimeToken()` from `src/app/webview-session/route.ts`.
 * Pinned against the installed library by `server.test.ts`.
 */
export const ONE_TIME_TOKEN_PLUGIN_PATHS = ["/one-time-token/generate", "/one-time-token/verify"];

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

  /**
   * **`/update-user` is closed, because it can set `users.image` to any string.**
   *
   * It accepts `{ image }` from *any* signed-in user (verified live: a plain
   * non-admin set it to an external URL and it landed in SQLite). `image` is a
   * core field, so the `input: false` trick that protects `role` does **not**
   * reach it: `api/routes/update-user.mjs` destructures `name` and `image` out
   * of the body *before* calling `parseUserInput()`, and `getFields(…, "input")`
   * returns only `additionalFields` and plugin fields anyway -- core fields are
   * in the "output" schema only. There is no field-level lever here; closing the
   * path is the lever there is, and `disabledPaths` makes the router answer 404
   * before the handler runs (`api/index.mjs`, `onRequest`).
   *
   * Nothing loses a capability: this app has no profile-update UI, the account
   * page (task 6) writes through a server action and `writeTransaction()` like
   * every other write here, and phase 5 hand-rolls user CRUD against Drizzle.
   * `disabledPaths` gates *HTTP routing* only, so none of those are affected.
   *
   * This is the write-side half. The render-side half -- `safeAvatarSrc()` in
   * `@/lib/avatar`, which renders the column only when it equals
   * `avatarUrlFor(user.id)` -- is the one that holds regardless of how a value
   * reached the column, and it stays the control that matters: it holds for
   * anything phase 5's hand-rolled user CRUD writes too. The plugin's own
   * `/admin/update-user` used to be the other routable way in and is now closed
   * with the rest of `ADMIN_PLUGIN_PATHS` above.
   */
  disabledPaths: ["/update-user", ...ADMIN_PLUGIN_PATHS, ...ONE_TIME_TOKEN_PLUGIN_PATHS],

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
    /**
     * Declared here so Better Auth's adapter agrees with the Drizzle schema
     * about this field's existence -- see the comment on `sessions.deviceName`
     * in `src/lib/db/schema/auth.ts`. `internalAdapter.createSession()`'s
     * `override` argument only persists a key the adapter knows to write.
     */
    additionalFields: {
      deviceName: { type: "string", required: false },
    },
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
     * `adminRoles` comes from `./roles`, which is also where `isAdminRole()`
     * reads it: the plugin's notion of an admin and the application's are the
     * same array, by construction.
     *
     * Its endpoints (list/create/ban/impersonate users) go unused -- phase 5
     * hand-rolls user CRUD against Drizzle and declines impersonation -- and
     * they are **closed**, not merely uncalled: see `ADMIN_PLUGIN_PATHS` above
     * and the `disabledPaths` entry that spreads it. What the plugin is here
     * for is the `role` field and its server-side semantics -- including
     * `input: false` on `role`, which is what stops a request body from setting
     * it.
     */
    admin({ defaultRole: "user", adminRoles: ADMIN_ROLES }),
    oneTimeToken({
      // `expiresIn` only governs the plugin's own `generateOneTimeToken`
      // endpoint, which this app never calls (see `disabledPaths` above and
      // `disableClientRequest` below) -- the mint path is hand-written in
      // `./webview-session.ts`, whose `WEBVIEW_TOKEN_TTL_MS` is the real TTL.
      expiresIn: 1, // minutes; the shortest granularity the plugin supports
      disableClientRequest: true, // belt-and-suspenders alongside disabledPaths below
    }),
    /**
     * **Must stay last, and it is not cosmetic.** Better Auth writes its
     * cookies into `ctx.context.responseHeaders`; the HTTP route at
     * `/api/auth/*` turns those into a real `Set-Cookie`, but an `auth.api.*`
     * call made from a **server action** has no response for the browser to
     * see, so without this plugin those headers are simply dropped. This hook
     * copies them into Next's own `cookies()` store, which the action's
     * response does carry.
     *
     * The case that made it mandatory is `changePassword({ revokeOtherSessions:
     * true })` in `@/lib/account/actions`: it deletes *every* session for the
     * user -- the caller's included -- then mints a replacement and sets its
     * cookie. Drop that cookie and the user is silently signed out by changing
     * their own password, with a success toast on screen. `refreshSession()` in
     * `./session` depends on it too, for the cookie-cache refresh that makes a
     * profile edit visible before the 5-minute cache expires.
     *
     * Order is enforced by the library itself: `warnIfCookiePluginNotLast()`
     * (`better-auth/dist/integrations/cookie-plugin-guard.mjs`) logs a warning
     * when any plugin *after* this one declares `hooks.after`, because those
     * hooks can set cookies this one has already stopped looking for.
     *
     * Harmless everywhere else: the hook's `cookies()` call is wrapped, so
     * outside a writable scope -- a Server Component render, or a Vitest run
     * with no request scope at all -- it returns quietly instead of throwing.
     */
    nextCookies(),
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
  /**
   * **Silent during `next build`, and only there.**
   *
   * The build imports every route's module graph in each of its workers, so
   * this handler ran seven times on a build machine with no
   * `BETTER_AUTH_SECRET` -- seven copies of a warning about requests that
   * cannot fail, because the build serves none. A message that appears when
   * nothing is wrong is a message readers learn to scroll past, which is the
   * cost: the *one* time it matters is a running server, and by then it looks
   * like ordinary build output.
   *
   * `NEXT_PHASE` is Next's own signal and is the same one
   * `registerInstrumentation()` uses to skip the startup hook during a build.
   * Nothing is hidden from a server: `npm start`, `next dev` and the container
   * all leave it unset and still log. The build's honest statement of the same
   * fact lives in `.env.example` and the README, where a deployer can act on it.
   */
  if (process.env.NEXT_PHASE === "phase-production-build") return;

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

  const user = await ctx.internalAdapter.createUser<User>({
    email: input.email,
    name: input.name ?? "",
    firstName: input.firstName ?? "",
    lastName: input.lastName ?? "",
    role: input.role ?? "user",
    emailVerified: false,
  });

  await linkPasswordCredential({ userId: user.id, password: input.password });

  return user;
}

/**
 * Give an existing user an email+password credential.
 *
 * The second half of `createUserWithPassword()`, split out because it is also
 * the repair the admin bootstrap needs: these are **two** writes, and a user
 * whose creation was interrupted between them exists but cannot sign in --
 * exactly the shape of the phase-3 seeder's bug. Keeping the `linkAccount` call
 * in one place means the repair path cannot drift from the creation path.
 *
 * Same reasoning as above about reaching into `auth.$context`: not routable, so
 * not reachable by an unauthenticated caller, and the hash comes from Better
 * Auth's own scrypt rather than anything written here.
 *
 * This *adds* a credential; it does not rotate one. Better Auth's own
 * `/change-password` is the way to replace an existing hash.
 */
export async function linkPasswordCredential(input: {
  userId: string;
  password: string;
}): Promise<void> {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);

  await ctx.internalAdapter.linkAccount({
    userId: input.userId,
    providerId: "credential",
    accountId: input.userId,
    password: hash,
  });
}

/**
 * Mint a device session: a Better Auth session row distinct from any browser
 * session the same user already holds, tagged with `deviceName` so
 * `/device/pair` and phase 13's device-management UI can tell it apart from
 * an ordinary sign-in. This is the credential `/device/pair` hands to the
 * native app -- there is no separate "API key" concept, the Bearer token
 * `src/lib/api/auth.ts` resolves on `/api/v1/**` IS this session's token, and
 * revoking it (`auth.api.revokeSession`) is the entire "sign this device out"
 * story.
 *
 * Reaches into `auth.$context.internalAdapter` for the same reason
 * `createUserWithPassword` and `linkPasswordCredential` do: creating a session
 * for an arbitrary `userId` with no session of its own to authenticate the
 * call is not something any `/api/auth/*` route exposes, and does not need to
 * be -- `internalAdapter` is not routable, so this is only reachable from
 * server code that already knows which user it is minting a session for
 * (`/device/pair`, gated by `requireUser()`).
 *
 * `dontRememberMe` (the adapter's second positional argument) is left `false`
 * so this gets the same `session.expiresIn` (30 days) as a browser session,
 * not the one-day "don't remember me" expiry -- a device pairing is exactly
 * the case where the user is not sitting at a shared browser and does want
 * the session to last.
 *
 * `override` is `internalAdapter.createSession`'s third argument, spread into
 * the new row *before* the adapter's own `userId`/`token`/timestamps -- so it
 * can add `deviceName` but not override those. That only persists because
 * `deviceName` is declared in `session.additionalFields` above; an
 * `override` key the adapter does not know about would be silently dropped.
 */
export async function createDeviceSession(
  userId: string,
  deviceName: string,
): Promise<{ token: string }> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false, { deviceName });
  return { token: session.token };
}

export type Auth = typeof auth;
