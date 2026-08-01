/**
 * Secret handling: keep a saved API key or client secret from ever reaching
 * the browser.
 *
 * **This module imports nothing, and must stay that way** -- the same rule
 * `src/lib/avatar.ts` and `src/lib/auth/roles.ts` live under, for the same
 * reason. A later task renders these helpers from client components (the
 * integrations form), so anything reachable from here ends up in the browser
 * bundle.
 */

/**
 * Submitted in place of an unchanged secret.
 *
 * A saved secret is never sent to the client, so the form cannot round-trip
 * the real value -- it renders a masked placeholder instead, and submits this
 * sentinel when the user leaves that field untouched. Contains a NUL byte,
 * which no legitimate API key or client secret does.
 *
 * The NUL survives only because this sentinel never becomes an HTML input
 * value: a secret field renders empty with the mask shown as its placeholder,
 * and an empty submission already resolves to keep-existing, so this constant
 * only ever crosses the wire as an RSC-serialized argument, which preserves a
 * NUL byte intact -- an `<input value=...>` would strip or mangle it. Binding
 * this constant to an input's value would break it.
 */
export const KEEP_EXISTING = "\0keep";

export function mask(value: string): string {
  if (!value) return "";
  // Short secrets reveal nothing: the tail is only shown when there is enough
  // in front of it to stay unrecoverable.
  if (value.length <= 8) return "••••••••";
  return `••••••••${value.slice(-4)}`;
}

export function resolveSecret(submitted: string, existing: string): string {
  if (submitted === KEEP_EXISTING || submitted === "") return existing;
  return submitted;
}
