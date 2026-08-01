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
 * sentinel when the user leaves that field untouched. No provider's API key or
 * client secret begins with a space, and any value a user actually pastes is
 * trimmed of surrounding whitespace before it is ever compared, so a real
 * credential can never collide with it.
 */
export const KEEP_EXISTING = " keep";

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
