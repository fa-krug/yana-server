import type { NamespaceKey } from "@/i18n/next-intl";

/**
 * A key under the `auth` catalog namespace -- never a Better Auth message.
 *
 * Same rule, and the same reason, as `errorKey` in
 * `src/lib/settings/actions.ts`: every user-facing string comes from
 * `messages/*.json` (CLAUDE.md), and Better Auth's `error.message` is an
 * English constant baked into the library ("Invalid email or password", see
 * `BASE_ERROR_CODES` in `@better-auth/core/dist/error/codes.mjs`). Rendering it
 * would put English into a German UI, and it is not a string this project can
 * translate, review or change.
 *
 * Typed rather than `string` so the value stays compiler-checked at its
 * *source* against the catalogs (see `src/i18n/next-intl.d.ts`); casting at the
 * `t()` call site would switch that check off, which is exactly what the
 * augmentation exists to prevent.
 */
export type AuthMessageKey = NamespaceKey<"auth">;

/**
 * The error half of what the Better Auth client returns.
 *
 * Structurally typed, not imported: the client's return type is a five-way
 * union whose `code` field is present in some members and absent in others (see
 * `signIn.passkey` in `@better-auth/passkey/dist/client.d.mts`), so pinning to
 * one member would not compile against the others. `code` is optional here for
 * the same reason.
 */
export type SignInError = { code?: string; message?: string; status?: number };

/**
 * The only server-side code this maps specifically.
 *
 * Better Auth answers a bad password, an unknown email and an account with no
 * credential the same way -- all four throws in
 * `better-auth/dist/api/routes/sign-in.mjs` use this one code -- which is the
 * correct behaviour (it does not confirm whether an address has an account) and
 * makes one catalog message cover the whole "you typed something wrong" case.
 *
 * Deliberately not a table of Better Auth's ~40 error codes: every entry would
 * be a string this project has to keep in step with a dependency, for messages
 * a user cannot act on anyway. Everything else is a generic failure, and the
 * detail stays in the browser console where the library already puts it.
 */
const INVALID_CREDENTIALS_CODE = "INVALID_EMAIL_OR_PASSWORD";

/** What the passkey client reports when the ceremony never produced a credential. */
const PASSKEY_CANCELLED_CODE = "AUTH_CANCELLED";

/**
 * SimpleWebAuthn's `WebAuthnError.code` values all start with this, and the
 * passkey client passes them through verbatim
 * (`code: err instanceof WebAuthnError ? err.code : "AUTH_CANCELLED"`). They
 * cover both halves of the same user-visible situation -- the browser dialog
 * was dismissed, or no credential for this site exists on the device -- and
 * WebAuthn deliberately does not distinguish those two, so neither does this.
 */
const WEBAUTHN_ERROR_PREFIX = "ERROR_";

/** The catalog key for a failed password sign-in. */
export function passwordErrorKey(error: SignInError | null | undefined): AuthMessageKey {
  return error?.code === INVALID_CREDENTIALS_CODE ? "invalidCredentials" : "signInFailed";
}

/**
 * The catalog key for a failed passkey sign-in.
 *
 * The cancelled/no-credential case is separated from a real failure because the
 * two need different things from the user: one is "your passkey did not
 * happen -- use your password", the other is "something broke, try again".
 * Telling a user to try again when their device has no passkey for this site
 * would loop them forever.
 */
export function passkeyErrorKey(error: SignInError | null | undefined): AuthMessageKey {
  const code = error?.code;
  if (code === PASSKEY_CANCELLED_CODE || code?.startsWith(WEBAUTHN_ERROR_PREFIX)) {
    return "passkeyUnavailable";
  }
  return "signInFailed";
}
