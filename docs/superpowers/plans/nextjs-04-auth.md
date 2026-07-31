# Phase 4: Authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cookie-session authentication with passkeys preferred over passwords, an auto-created admin when none exists, a profile entry in the sidebar, and an account page for email, password, name, avatar and passkey management.

**Architecture:** Better Auth owns sessions, credential storage and WebAuthn. It adds `sessions`, `accounts` and `passkeys` around phase 2's already-compatible `users` table. The phase 3/4 seam closes by rewriting `currentUserId()` to read the session — every consumer written in phase 3 keeps working unchanged. Admin bootstrap runs at startup, not per-request.

**Tech Stack:** Better Auth (+ passkey and admin plugins), Drizzle adapter, Next.js middleware, sharp (avatar processing).

## Global Constraints

- **No roles, no groups, no permissions.** `users.isAdmin` is the entire authorization model.
- Sessions are **cookie-based**, `httpOnly`, `sameSite=lax`, `secure` in production. No JWT in local storage.
- The bootstrap admin is `admin@admin.com` / `admin`, created **only when no admin exists**. It must never resurrect after deletion, and never overwrite an existing user.
- The login form shows **passkey first**, with a button revealing the password field. Passwords remain fully functional — passkey is preferred, not required.
- Password hashing is Better Auth's default (scrypt). Never hand-roll it, never lower the cost.
- Avatar default is initials on a colour deterministically derived from the user id, so it is stable across sessions and devices.
- Uploaded avatars are re-encoded through `sharp` before storage. An uploaded file is never served back as-is — that is how an "image" upload becomes stored HTML.
- `currentUserId()` keeps its exact signature: `() => Promise<string>`. Changing the shape would ripple through phase 3.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/db/schema/auth.ts` | `sessions`, `accounts`, `passkeys`, `verifications` |
| `src/lib/auth/server.ts` | Better Auth instance — the single configuration point |
| `src/lib/auth/client.ts` | Browser client (`signIn`, `signOut`, passkey calls) |
| `src/app/api/auth/[...all]/route.ts` | Better Auth handler mount |
| `src/lib/auth/bootstrap.ts` | `ensureAdminExists()` |
| `src/lib/auth/session.ts` | `requireUser()`, `requireAdmin()`, `currentUserId()` |
| `src/middleware.ts` | Redirects unauthenticated requests to `/login` |
| `src/app/login/page.tsx` | Passkey-first login |
| `src/app/(app)/account/page.tsx` | Account management |
| `src/components/account/*.tsx` | Profile, password, passkey sections |
| `src/components/user-avatar.tsx` | Image or generated initials |
| `src/lib/avatar.ts` | `initialsFor()`, `colourFor()`, `processAvatar()` |
| `src/instrumentation.ts` | Runs `ensureAdminExists()` once at startup |

---

### Task 1: Auth schema and Better Auth wiring

**Interfaces:**
- Produces: `auth` (the Better Auth server instance), `sessions`/`accounts`/`passkeys`/`verifications` tables, and the `/api/auth/*` route.

- [ ] **Step 1: Install**

```bash
npm install --save-exact better-auth
```

- [ ] **Step 2: Generate the schema rather than hand-writing it**

Better Auth's adapter expects exact column names; guessing them produces runtime errors that look like data corruption.

```bash
npx @better-auth/cli generate --config src/lib/auth/server.ts --output src/lib/db/schema/auth.ts
```

If the CLI needs the config to exist first, write Step 3 before this step, then return.

- [ ] **Step 3: Configure the server instance**

```ts
// src/lib/auth/server.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, passkey } from "better-auth/plugins";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: "sqlite", schema }),

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
      isAdmin: { type: "boolean", required: false, defaultValue: false },
    },
  },

  plugins: [
    passkey({
      rpName: "Yana",
      // Must match the deployment host exactly or WebAuthn silently refuses.
      rpID: process.env.PASSKEY_RP_ID ?? "localhost",
      origin: process.env.PUBLIC_URL ?? "http://localhost:3000",
    }),
    admin(),
  ],
});
```

- [ ] **Step 4: Mount the handler and the client**

```ts
// src/app/api/auth/[...all]/route.ts
import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth/server";

export const { GET, POST } = toNextJsHandler(auth);
```

```ts
// src/lib/auth/client.ts
"use client";

import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });
export const { signIn, signOut, signUp, useSession } = authClient;
```

- [ ] **Step 5: Generate and inspect the migration**

```bash
npx drizzle-kit generate && cat drizzle/000*_*.sql | tail -60
```

Confirm `sessions`, `accounts`, `passkeys` and `verifications` are created and that **`users` is not recreated or altered destructively** — if it is, phase 2's shape diverged from Better Auth's expectations and must be corrected there, not patched here.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "feat(next): Wire Better Auth with passkey and admin plugins

Schema is generated by the CLI rather than hand-written: the adapter expects exact
column names, and guessing them produces runtime failures that read like data
corruption.

Email verification is off because there is no mail transport -- requiring it would
lock every user out permanently. rpID must match the deployment host exactly or
WebAuthn refuses without a useful error."
```

---

### Task 2: Admin bootstrap

**Interfaces:**
- Produces: `ensureAdminExists(): Promise<void>` — idempotent, safe to call concurrently, run once at startup via `instrumentation.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/bootstrap.test.ts
import { describe, expect, it } from "vitest";

import { ensureAdminExists } from "./bootstrap";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

describe("ensureAdminExists", () => {
  it("creates the default admin when none exists", async () => {
    await ensureAdminExists();
    const admins = getDb().select().from(users).all().filter((user) => user.isAdmin);
    expect(admins.length).toBeGreaterThanOrEqual(1);
    expect(admins.some((user) => user.email === "admin@admin.com")).toBe(true);
  });

  it("is idempotent", async () => {
    await ensureAdminExists();
    const before = getDb().select().from(users).all().length;
    await ensureAdminExists();
    expect(getDb().select().from(users).all().length).toBe(before);
  });

  it("creates nothing when some other admin already exists", async () => {
    // A deployment whose admin was renamed must not get admin@admin.com back.
    const db = getDb();
    db.insert(users).values({ id: "someone", email: "real@admin.tld", isAdmin: true }).run();
    await ensureAdminExists();
    expect(db.select().from(users).all().some((u) => u.email === "admin@admin.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails, then implement**

```ts
// src/lib/auth/bootstrap.ts
import { eq } from "drizzle-orm";

import { auth } from "./server";
import { getDb } from "@/lib/db/client";
import { userSettings, users } from "@/lib/db/schema";

const DEFAULT_EMAIL = "admin@admin.com";
const DEFAULT_PASSWORD = "admin";

/**
 * Create the default admin only when the instance has no admin at all.
 *
 * Keyed on "any admin exists", not on "admin@admin.com exists": an operator who
 * renamed or deleted the default must not have it reappear on next boot.
 */
export async function ensureAdminExists(): Promise<void> {
  const db = getDb();

  const hasAdmin = db.select().from(users).all().some((user) => user.isAdmin);
  if (hasAdmin) return;

  // Created through the API, not by direct insert, so the password is hashed by
  // the same code path a real signup uses.
  await auth.api.signUpEmail({
    body: {
      email: DEFAULT_EMAIL,
      password: DEFAULT_PASSWORD,
      name: "Admin",
    },
  });

  const created = db.select().from(users).where(eq(users.email, DEFAULT_EMAIL)).get();
  if (!created) throw new Error("admin bootstrap: signUpEmail did not create a user");

  db.update(users).set({ isAdmin: true, firstName: "Admin" }).where(eq(users.id, created.id)).run();
  db.insert(userSettings).values({ userId: created.id }).onConflictDoNothing().run();

  console.warn(
    `Created default admin ${DEFAULT_EMAIL} with password "${DEFAULT_PASSWORD}" -- change it.`,
  );
}
```

- [ ] **Step 3: Run at startup, not per request**

```ts
// src/instrumentation.ts
export async function register() {
  // Node runtime only: the edge runtime has no SQLite.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureAdminExists } = await import("@/lib/auth/bootstrap");
  await ensureAdminExists();
}
```

- [ ] **Step 4: Verify and commit**

```bash
npm test -- bootstrap
```

```bash
git add -A && git commit -m "feat(next): Auto-create an admin when none exists

Keyed on 'any admin exists' rather than on the default address, so an operator who
renamed or deleted admin@admin.com does not get it back on the next boot.

Created through signUpEmail rather than a direct insert, so the password goes
through the same hashing path a real signup uses. Runs once from instrumentation,
not per request."
```

---

### Task 3: Close the phase 3/4 seam

**Interfaces:**
- Produces:
  - `currentUserId(): Promise<string>` — **same signature as phase 3**, now session-backed.
  - `requireUser(): Promise<User>` — redirects to `/login` when absent.
  - `requireAdmin(): Promise<User>` — 404s for non-admins (not 403: a non-admin should not learn the route exists).

- [ ] **Step 1: Write the session helpers**

```ts
// src/lib/auth/session.ts
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { auth } from "./server";
import type { User } from "@/lib/db/schema";

export async function currentUser(): Promise<User | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return (session?.user as User | undefined) ?? null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * 404 rather than 403 for non-admins: a 403 confirms the route exists, which is
 * information a non-admin has no reason to receive.
 */
export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!user.isAdmin) notFound();
  return user;
}

/** Closes the phase 3/4 seam. Signature unchanged from phase 3 on purpose. */
export async function currentUserId(): Promise<string> {
  return (await requireUser()).id;
}
```

- [ ] **Step 2: Repoint phase 3's consumers**

Replace the body of `src/lib/settings/queries.ts`'s `currentUserId` with a re-export:

```ts
export { currentUserId } from "@/lib/auth/session";
```

Then delete `src/lib/db/bootstrap.ts` and its `BOOTSTRAP_USER_ID`, and find anything still importing it:

```bash
grep -rn "BOOTSTRAP_USER_ID\|db/bootstrap" src/
```

Expected: no matches. Any match is a consumer that bypassed the seam and needs fixing.

- [ ] **Step 3: Add middleware**

```ts
// src/middleware.ts
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/health", "/api/auth"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();

  // Cookie presence only -- validation happens in requireUser(). Middleware
  // cannot reach SQLite, so a real check here is not possible.
  const hasSession = request.cookies.getAll().some((c) => c.name.includes("session"));
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|media).*)"],
};
```

- [ ] **Step 4: Pass the real `isAdmin` into the sidebar**

In `src/app/(app)/layout.tsx`, replace the hardcoded `isAdmin` with the session value. The layout may now await — it is above the data Suspense boundaries but session lookup is a cookie read plus one indexed query, not a data fetch.

```tsx
const user = await requireUser();
// ...
<AppSidebar isAdmin={user.isAdmin} user={user} />
```

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm test && npm run dev
```

Confirm: unauthenticated `/settings` redirects to `/login?next=/settings`; `/health` stays reachable unauthenticated.

```bash
git add -A && git commit -m "feat(next): Close the 3/4 seam with session-backed identity

currentUserId() keeps its exact signature, so every phase 3 consumer works
unchanged and BOOTSTRAP_USER_ID disappears entirely -- a grep confirms nothing
still imports it.

requireAdmin() returns 404 rather than 403: a 403 confirms the route exists, which
a non-admin has no reason to learn. Middleware only checks cookie presence, since
it cannot reach SQLite; real validation is requireUser()'s job."
```

---

### Task 4: Passkey-first login

**Interfaces:**
- Produces: `/login` with passkey attempted first and a reveal button for the password field.

- [ ] **Step 1: Add message keys**

Add to both catalogs under `auth`: `signIn`, `passkeySignIn`, `usePassword`, `email`, `password`, `signInFailed`, `passkeyUnsupported`.

- [ ] **Step 2: Write the login page**

```tsx
// src/app/login/page.tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/";
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function withPasskey() {
    // Feature-detect rather than assume: passkeys are unavailable on older
    // browsers and in some embedded webviews, and the password path must remain
    // reachable there.
    if (!window.PublicKeyCredential) {
      toast.error(t("passkeyUnsupported"));
      setShowPassword(true);
      return;
    }
    setBusy(true);
    const result = await signIn.passkey();
    setBusy(false);
    result?.error ? toast.error(result.error.message ?? t("signInFailed")) : router.push(next);
  }

  async function withPassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await signIn.email({ email, password });
    setBusy(false);
    result?.error ? toast.error(result.error.message ?? t("signInFailed")) : router.push(next);
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">{t("signIn")}</h1>

      <Button onClick={withPasskey} disabled={busy} className="w-full">
        {t("passkeySignIn")}
      </Button>

      {showPassword ? (
        <form onSubmit={withPassword} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          <Button type="submit" disabled={busy} variant="secondary" className="w-full">
            {t("signIn")}
          </Button>
        </form>
      ) : (
        <Button variant="ghost" onClick={() => setShowPassword(true)} className="w-full">
          {t("usePassword")}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify and commit**

Test the default admin logs in with `admin@admin.com` / `admin` after revealing the password field.

```bash
git add -A && git commit -m "feat(next): Add passkey-first login with password reveal

PublicKeyCredential is feature-detected rather than assumed: passkeys are absent
in older browsers and some embedded webviews, and the password path has to stay
reachable there rather than leaving a dead button."
```

---

### Task 5: Avatars

**Interfaces:**
- Produces:
  - `initialsFor(user: { firstName: string; lastName: string; email: string }): string`
  - `colourFor(id: string): string` — deterministic HSL
  - `processAvatar(input: Buffer): Promise<Buffer>` — re-encoded 256×256 WebP
  - `<UserAvatar user={...} />`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/avatar.test.ts
import { describe, expect, it } from "vitest";

import { colourFor, initialsFor } from "./avatar";

describe("initialsFor", () => {
  it("uses both name initials", () => {
    expect(initialsFor({ firstName: "Ada", lastName: "Lovelace", email: "a@b.c" })).toBe("AL");
  });

  it("falls back to the email when names are empty", () => {
    expect(initialsFor({ firstName: "", lastName: "", email: "ada@example.com" })).toBe("A");
  });

  it("handles a first name alone", () => {
    expect(initialsFor({ firstName: "Ada", lastName: "", email: "a@b.c" })).toBe("A");
  });
});

describe("colourFor", () => {
  it("is stable for the same id", () => {
    expect(colourFor("user-1")).toBe(colourFor("user-1"));
  });

  it("differs across ids", () => {
    expect(colourFor("user-1")).not.toBe(colourFor("user-2"));
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/lib/avatar.ts
import sharp from "sharp";

export function initialsFor(user: {
  firstName: string;
  lastName: string;
  email: string;
}): string {
  const letters = [user.firstName, user.lastName].map((part) => part.trim().charAt(0)).filter(Boolean);
  if (letters.length) return letters.join("").toUpperCase();
  return (user.email.trim().charAt(0) || "?").toUpperCase();
}

/**
 * Deterministic colour from the user id, so an avatar looks the same on every
 * device and across sessions. Fixed saturation and lightness keep contrast with
 * white text predictable in both themes.
 */
export function colourFor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  return `hsl(${hash} 55% 45%)`;
}

/**
 * Re-encode an upload rather than storing it.
 *
 * An uploaded file that is served back untouched is how an "image" upload
 * becomes stored HTML or an SVG carrying script. Decoding and re-encoding
 * discards everything that is not pixels.
 */
export async function processAvatar(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "error" })
    .rotate() // honour EXIF orientation before stripping it
    .resize(256, 256, { fit: "cover" })
    .webp({ quality: 82 })
    .toBuffer();
}
```

```bash
npm install --save-exact sharp
```

- [ ] **Step 3: Write the component**

```tsx
// src/components/user-avatar.tsx
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { colourFor, initialsFor } from "@/lib/avatar";

export function UserAvatar({
  user,
  className,
}: {
  user: { id: string; firstName: string; lastName: string; email: string; image: string | null };
  className?: string;
}) {
  return (
    <Avatar className={className}>
      {user.image ? <AvatarImage src={user.image} alt="" /> : null}
      <AvatarFallback style={{ backgroundColor: colourFor(user.id), color: "white" }}>
        {initialsFor(user)}
      </AvatarFallback>
    </Avatar>
  );
}
```

- [ ] **Step 4: Verify and commit**

```bash
npm test -- avatar
```

```bash
git add -A && git commit -m "feat(next): Add avatars with deterministic initial fallbacks

Uploads are decoded and re-encoded through sharp rather than stored as received:
serving an upload back untouched is how an image upload becomes stored HTML or an
SVG carrying script. EXIF rotation is applied before the data is stripped.

Fallback colour derives from the user id, so it is identical on every device."
```

---

### Task 6: The account page

**Interfaces:**
- Produces: `/account` with profile (email, first name, last name, avatar), password change, and passkey add/replace/remove.

- [ ] **Step 1: Add the server actions**

`src/lib/account/actions.ts` — `updateProfile`, `changePassword`, `uploadAvatar`. Each validates with Zod, scopes to `requireUser()`, and returns `{ ok, error? }`, matching phase 3's action convention.

`uploadAvatar` accepts `FormData`, enforces a **2 MB** limit before reading the buffer, passes it through `processAvatar`, writes to `media/avatars/<userId>.webp`, and stores that path on `users.image`. Reject by declared size first, then by actual byte length after reading — a client-supplied `size` is not trustworthy.

`changePassword` calls `auth.api.changePassword` with `revokeOtherSessions: true`, so a password change ends sessions on other devices.

- [ ] **Step 2: Build the sections**

Three client components under `src/components/account/`, each a card with its own submit and toast, following phase 3's `useTransition` + `toast` shape:

- `profile-section.tsx` — email, first name, last name, avatar upload with a live `<UserAvatar>` preview.
- `password-section.tsx` — current password, new password, confirm. Confirm mismatch is caught client-side before the round trip.
- `passkey-section.tsx` — lists registered passkeys with created dates; `authClient.passkey.addPasskey()` to add; delete behind an `AlertDialog`. Deleting the last passkey is allowed **only** when a password credential exists, otherwise the account becomes unreachable — check and block with an explanatory toast.

- [ ] **Step 3: Add the profile entry to the sidebar footer**

In `app-sidebar.tsx`'s `SidebarFooter`, a `SidebarMenuButton` linking to `/account` showing `<UserAvatar>` plus the display name, collapsing to the avatar alone in icon mode.

- [ ] **Step 4: Verify by hand**

Change each field and confirm persistence after reload; upload a PNG and confirm it is stored as WebP at 256×256; register a passkey and sign out/in with it; confirm the last-passkey guard fires when no password is set.

- [ ] **Step 5: Run every check and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

```bash
git add -A && git commit -m "feat(next): Add the account page and sidebar profile entry

Password changes revoke other sessions, so a change actually ends access
elsewhere. Avatar uploads are size-checked twice -- declared size before reading,
actual length after -- because a client-supplied size is not trustworthy.

Removing the last passkey is blocked unless a password credential exists;
otherwise the account becomes permanently unreachable."
```

---

## Self-Review

**Spec coverage.** Against bullet 4:

| Requirement | Task |
|---|---|
| Cookie session auth | 1 |
| Users, no groups/permissions, admin flag only | 1 (`isAdmin`), 3 (`requireAdmin`) |
| Auto-create admin when none exists | 2 |
| Profile icon in sidebar | 6 Step 3 |
| Account page: email, password, first/last name, image | 6 |
| Default avatar: colour + initials | 5 |
| Passkey login, preferred, password revealable | 4 |
| Passkey replace in account settings | 6 Step 2 |
| Phase 3/4 seam closed | 3 |

**Placeholder scan.** Task 6 Steps 1–2 describe components at interface level rather than showing full source — deliberate and bounded: each follows the `useTransition` + `toast` + `{ ok, error }` pattern established concretely in phase 3 Task 5, and the non-obvious decisions (double size check, `revokeOtherSessions`, last-passkey guard) are stated explicitly. The Zod schemas and JSX are mechanical from there.

**Type consistency.** `currentUserId(): Promise<string>` is unchanged from phase 3. `requireUser`/`requireAdmin` both return `Promise<User>` using phase 2's inferred type. `UserAvatar`'s prop shape matches the `users` columns exactly (`id`, `firstName`, `lastName`, `email`, `image`), and `image` is `string | null` as the schema declares. `initialsFor` takes a subset of that shape, so a `User` satisfies it structurally.

**One risk.** Task 1 Step 2 generates the auth schema with the Better Auth CLI, whose output may not match phase 2's `users` table if the plugin set demands extra columns. Step 5 checks for exactly that by reading the migration. If `users` is altered, correct phase 2's definition rather than accepting a destructive migration here — a greenfield project should never need one.
