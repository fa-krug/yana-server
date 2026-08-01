"use server";

import fs from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { auth } from "@/lib/auth/server";
import { refreshSession, requireUser } from "@/lib/auth/session";
import { AVATAR_MAX_BYTES, avatarUrlFor } from "@/lib/avatar";
import { avatarFilePath, processAvatar } from "@/lib/avatar-storage";
import { writeTransaction } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

import { hasPasswordCredential } from "./queries";
import type { AccountKey, AccountResult as Result } from "./result";

/**
 * Everything `/account` writes.
 *
 * Four rules hold across every action here, and each one has already cost
 * somebody an hour somewhere in this phase:
 *
 * 1. **`requireUser()` first, and the id comes from it.** No action takes a
 *    user id as an argument; there is nothing to forge.
 * 2. **The result carries a catalog `errorKey`, never a zod message and never a
 *    driver or Better Auth message.** Same rule and the same reason as
 *    `@/lib/settings/actions` and `@/lib/auth/sign-in-errors`: Better Auth's
 *    messages are English constants and zod's are English too, and either one
 *    rendered into a German UI is a bug the type system can catch instead. The
 *    key is typed `AccountKey` at its *source* (see `./result`), so a key
 *    neither catalog defines fails `npm run typecheck`.
 * 3. **Every write to `users` goes through `writeTransaction()`** (CLAUDE.md),
 *    with a synchronous callback -- and is followed by `refreshSession()`,
 *    because a direct column write is invisible to `currentUser()` for five
 *    minutes otherwise. See the comment on that function.
 * 4. **`users.image` receives `avatarUrlFor(user.id)`, never a filesystem
 *    path.** The wrong value fails silently: it 404s, `AvatarImage` never
 *    mounts, and the initials show forever with nothing thrown.
 *
 * A fifth rule belongs to the *callers*: none of these may be awaited bare. An
 * action can fail without returning -- Next refusing an over-sized body, a
 * dropped connection -- and an unhandled rejection inside a `useTransition`
 * scope takes the whole page to the error boundary. Every call site goes
 * through `attempt()` in `./result`.
 */
/**
 * Better Auth's own bounds, restated so a rejection is a translated sentence
 * instead of an English `PASSWORD_TOO_SHORT` from the library. `8` is
 * `minPasswordLength`'s default (`context/create-context.mjs`); a change to the
 * `emailAndPassword` config has to change this line too, and
 * `src/lib/account/account.test.ts` pins the pair by asking the real endpoint.
 */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const profile = z.object({
  // `.trim()` before the checks, so " " is an empty name and not a one-space
  // one -- the two name columns are notNull with "" defaults and
  // `displayNameFor()` treats "" as "fall back to the address".
  email: z.email().max(254),
  firstName: z.string().trim().max(150),
  lastName: z.string().trim().max(150),
});

const password = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const passkeyRef = z.object({ id: z.string().min(1).max(255) });

/**
 * Which field failed, as a catalog key. Anything unlisted falls through to
 * `undefined` and the caller shows the generic `account.saveFailed`, exactly
 * as the settings actions do.
 */
const PROFILE_ERROR_KEYS: Record<string, AccountKey> = {
  email: "profile.emailInvalid",
  firstName: "profile.nameTooLong",
  lastName: "profile.nameTooLong",
};

const PASSWORD_ERROR_KEYS: Record<string, AccountKey> = {
  newPassword: "password.tooShort",
};

function errorKeyFor(
  issues: z.core.$ZodIssue[],
  table: Record<string, AccountKey>,
): AccountKey | undefined {
  const field = issues[0]?.path[0];
  return typeof field === "string" ? table[field] : undefined;
}

/**
 * Is this the unique-index violation on `users.email`?
 *
 * Matched on better-sqlite3's `code`, not on the message: the message is
 * English prose from the driver and is exactly the kind of string rule 2 above
 * forbids returning. The column check is what keeps this from also swallowing
 * some future unique index on the same table.
 */
function isEmailTaken(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = (error as { message?: unknown } | null)?.message;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof message === "string" &&
    message.includes("users.email")
  );
}

/**
 * Email, first name, last name.
 *
 * **Not through Better Auth's `/update-user`**, which `./server` disables
 * outright -- it accepts an arbitrary `image` from any signed-in user, and
 * `image` is a core field that `input: false` cannot reach. A direct write is
 * the sanctioned path (see the comment on `disabledPaths`), and it is the only
 * one that keeps `firstName`/`lastName` -- this app's `additionalFields` -- and
 * the email in a single transaction.
 *
 * `name` is written alongside them because Better Auth treats it as the user's
 * display name and WebAuthn shows it in the browser's passkey chooser; leaving
 * it at the bootstrap value would put a stale name in the OS credential UI
 * where nothing in this app can correct it.
 */
export async function updateProfile(input: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = profile.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: errorKeyFor(parsed.error.issues, PROFILE_ERROR_KEYS) };
  }
  const { email, firstName, lastName } = parsed.data;

  try {
    const changed = writeTransaction((tx) =>
      tx
        .update(users)
        .set({
          email,
          firstName,
          lastName,
          name: `${firstName} ${lastName}`.trim(),
        })
        .where(eq(users.id, user.id))
        .run(),
    );
    if (changed.changes === 0) {
      throw new Error(`updateProfile: no users row for "${user.id}"`);
    }
  } catch (error) {
    if (isEmailTaken(error)) return { ok: false, errorKey: "profile.emailTaken" };
    console.error("Failed to update the profile", error);
    return { ok: false };
  }

  await refreshSession();
  // Layout-wide: the sidebar footer renders the name and the avatar on *every*
  // route, so invalidating only /account would leave the old name in the
  // chrome of every page already in the client router cache.
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Change the password, ending every other session.
 *
 * `revokeOtherSessions: true` deletes **all** of the user's sessions, the
 * caller's included, and mints a replacement whose cookie Better Auth writes
 * into `ctx.context.responseHeaders`. Those headers reach the browser only
 * because `nextCookies()` is registered as the last plugin in `./server` --
 * without it this action signs the caller out while telling them it succeeded.
 * `src/lib/account/account.test.ts` asserts the caller is still authenticated
 * afterwards, which is the assertion that would catch the plugin being removed.
 *
 * `asResponse: true` rather than letting the endpoint throw: the failure codes
 * are the whole point here (wrong current password vs. no credential at all),
 * and reading them off a response is one branch instead of an `APIError`
 * type-guard. The Set-Cookie side is unaffected -- the plugin hook reads the
 * context, not the returned value.
 */
export async function changePassword(input: unknown): Promise<Result> {
  await requireUser();
  const parsed = password.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: errorKeyFor(parsed.error.issues, PASSWORD_ERROR_KEYS) };
  }

  let response: Response;
  try {
    response = await auth.api.changePassword({
      body: { ...parsed.data, revokeOtherSessions: true },
      headers: await headers(),
      asResponse: true,
    });
  } catch (error) {
    console.error("Failed to change the password", error);
    return { ok: false };
  }

  if (response.ok) return { ok: true };

  const code = await errorCode(response);
  if (code === "INVALID_PASSWORD") return { ok: false, errorKey: "password.wrongCurrent" };
  if (code === "PASSWORD_TOO_SHORT") return { ok: false, errorKey: "password.tooShort" };
  if (code === "CREDENTIAL_ACCOUNT_NOT_FOUND") {
    return { ok: false, errorKey: "password.noCredential" };
  }
  console.error(`Password change refused with ${response.status} ${code ?? "(no code)"}`);
  return { ok: false };
}

/** Better Auth's machine-readable error code, or null if the body has none. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * This user's avatar file, or `null` after logging why there is no such path.
 *
 * **Both halves of the avatar invariant go through here**, so "the signed-in id
 * is not avatar-shaped" cannot mean two different things: the upload refuses
 * before it writes anything, and the removal refuses before it nulls the
 * column. It is unreachable while ids are Better Auth's -- `avatar-storage.ts`
 * pins the pattern to `generateId()` and a test pins it to an id Better Auth
 * really minted -- but an invariant with two readings is one that will
 * eventually be read the wrong way.
 *
 * Refusing is the safe direction for both. Reporting success on a removal whose
 * file this process cannot name would leave the picture being served by
 * `src/app/media/avatars/[userId]/route.ts`, which is exactly what unlinking
 * exists to prevent.
 */
function avatarPathOrRefuse(userId: string, caller: string): string | null {
  const file = avatarFilePath(userId);
  if (!file) console.error(`${caller}: the signed-in id is not avatar-shaped: ${userId}`);
  return file;
}

/**
 * Store an uploaded avatar.
 *
 * **Size is checked twice, and the order matters.** `File.size` arrives from
 * the client, so it is a hint, not a fact -- a hand-built multipart body can
 * declare any number it likes. Checking it first is still worth doing because
 * it refuses the ordinary too-big upload without buffering it; checking the
 * real `byteLength` after the read is what actually holds. The pixel and time
 * limits behind both live inside `processAvatar()`, where no caller can forget
 * them, and a byte cap does not substitute for them: a 758 kB PNG can declare
 * 16000x16000.
 *
 * The file is written **before** the column, so the only window is one where
 * the bytes exist and nothing points at them yet -- which renders as initials.
 * The reverse order would point the column at a file that is not there.
 */
export async function uploadAvatar(formData: FormData): Promise<Result> {
  const user = await requireUser();

  const upload = formData.get("avatar");
  if (!(upload instanceof File) || upload.size === 0) {
    return { ok: false, errorKey: "avatar.noFile" };
  }
  // Declared size first: refuse the honest oversize upload before reading it
  // into memory.
  if (upload.size > AVATAR_MAX_BYTES) return { ok: false, errorKey: "avatar.tooLarge" };

  const received = Buffer.from(await upload.arrayBuffer());
  // Actual length second: this is the check that holds against a lying client.
  if (received.byteLength > AVATAR_MAX_BYTES) return { ok: false, errorKey: "avatar.tooLarge" };

  const file = avatarPathOrRefuse(user.id, "uploadAvatar");
  if (!file) return { ok: false };

  let encoded: Buffer;
  try {
    encoded = await processAvatar(received);
  } catch (error) {
    // Both "this is not an image" and "this decodes to more pixels than we
    // allow" land here, and they get one message that names the megapixel
    // limit. Branching on sharp's English message text to tell them apart
    // would be a string this project cannot keep in step with libvips.
    console.error("Rejected an avatar upload", error);
    return { ok: false, errorKey: "avatar.rejected" };
  }

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, new Uint8Array(encoded));
    writeTransaction((tx) =>
      // avatarUrlFor(), never `file`. See rule 4 in this module's header.
      tx
        .update(users)
        .set({ image: avatarUrlFor(user.id) })
        .where(eq(users.id, user.id))
        .run(),
    );
  } catch (error) {
    console.error("Failed to store an avatar", error);
    return { ok: false };
  }

  await refreshSession();
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Remove the avatar.
 *
 * **Unlinks the file as well as nulling the column**, and that is not
 * housekeeping: `src/app/media/avatars/[userId]/route.ts` serves whatever is on
 * disk and never reads `users.image`, so nulling alone leaves the old
 * photograph being served to its owner on a URL that still works.
 *
 * The column is cleared first here -- the opposite of the upload's order, and
 * for the same reason. Whichever step fails, the state in between is "nothing
 * is displayed", never "the column points at a file that is gone".
 *
 * An id that is not avatar-shaped refuses *before* the column is nulled, the
 * same way the upload refuses before it writes. The alternative -- null the
 * column and skip the unlink -- would report success over a file this process
 * has decided it cannot name, which is the one outcome the unlink exists to
 * prevent.
 */
export async function removeAvatar(): Promise<Result> {
  const user = await requireUser();
  const file = avatarPathOrRefuse(user.id, "removeAvatar");
  if (!file) return { ok: false };

  try {
    writeTransaction((tx) =>
      tx.update(users).set({ image: null }).where(eq(users.id, user.id)).run(),
    );
    // `force: true` so an already-absent file is success, not an error: the
    // user asked for "no avatar" and that is what they have.
    await fs.rm(file, { force: true });
  } catch (error) {
    console.error("Failed to remove an avatar", error);
    return { ok: false };
  }

  await refreshSession();
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Delete one passkey.
 *
 * **The guard is here, on the server, not only in the dialog.** Deleting the
 * last passkey from an account with no password credential leaves it with no
 * credential of any kind, and this application has no self-registration, no
 * mail transport and therefore no recovery flow -- getting back in would mean
 * editing SQLite by hand. A client-side check alone is a check a second tab, a
 * stale render or a direct action call walks straight past.
 *
 * The count and the delete are not in one transaction, so two concurrent
 * deletions of the *last two* passkeys could in principle both pass the count.
 * Left as is deliberately: the writes belong to Better Auth's adapter rather
 * than to `writeTransaction()`, the race needs one person double-clicking two
 * different rows in the same instant, and the outcome is recoverable by an
 * administrator in phase 5. Worth knowing about; not worth reaching into the
 * library's write path for.
 */
export async function removePasskey(input: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = passkeyRef.safeParse(input);
  if (!parsed.success) return { ok: false };

  let remaining: number;
  try {
    const registered = await auth.api.listPasskeys({ headers: await headers() });
    remaining = registered.filter((passkey) => passkey.id !== parsed.data.id).length;
  } catch (error) {
    console.error("Failed to list passkeys before deleting one", error);
    return { ok: false };
  }

  if (remaining === 0 && !hasPasswordCredential(user.id)) {
    return { ok: false, errorKey: "passkeys.lastOneNeedsPassword" };
  }

  try {
    // Better Auth's own endpoint, not a DELETE of our own: it carries
    // `requireResourceOwnership`, so a passkey id belonging to someone else is
    // refused by the library rather than by a WHERE clause written here.
    await auth.api.deletePasskey({ body: { id: parsed.data.id }, headers: await headers() });
  } catch (error) {
    console.error("Failed to delete a passkey", error);
    return { ok: false };
  }

  revalidatePath("/account");
  return { ok: true };
}
