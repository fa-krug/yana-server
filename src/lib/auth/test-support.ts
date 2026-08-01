import type { Auth } from "./server";

/**
 * TEST-ONLY helpers, the auth counterpart to `src/lib/db/test-support.ts`.
 * Nothing under `src/app` or `src/components` may import this module.
 *
 * They exist because every session-backed test needs the same two awkward
 * steps: turn a sign-in response's `Set-Cookie` headers into a request `Cookie`
 * header, and hand that to a helper that reads `next/headers`. Getting the
 * first one wrong is subtle -- `Response.headers.get("set-cookie")` joins
 * multiple cookies with ", " into a string that is *not* a valid Cookie header,
 * and with `session.cookieCache` enabled a sign-in sets two of them (the token
 * and the cached session data). A test that only forwarded the first would
 * quietly never exercise the cookie cache, which is precisely what
 * `requireAdmin()` has to defeat.
 */

/**
 * The `Cookie` request header a browser would send after this response.
 *
 * `getSetCookie()` keeps the individual headers apart (undici implements it for
 * exactly this reason); each one's first `name=value` pair is the cookie, and
 * everything after the first `;` is attributes a request never echoes back.
 */
export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * Sign in with email and password and return the cookie header for the session.
 *
 * Goes through the real `/sign-in/email` endpoint -- the same path the login
 * form will take -- so the cookies are the genuine article, signed with the
 * configured secret, rather than a hand-built token row.
 */
export async function signInCookie(
  auth: Auth,
  credentials: { email: string; password: string },
): Promise<string> {
  const response = await auth.api.signInEmail({ body: credentials, asResponse: true });
  if (response.status !== 200) {
    throw new Error(
      `signInCookie: sign-in failed with ${response.status} ${await response.text()}`,
    );
  }
  return cookieHeaderFrom(response);
}
