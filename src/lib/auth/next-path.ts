/** Where sign-in lands when the request carried no usable destination. */
export const DEFAULT_NEXT_PATH = "/";

/**
 * The sign-in page. Declared here rather than in `./session` so the redirect
 * target and the one path that must never *be* a redirect target are the same
 * string -- `src/lib/auth/session.ts` imports it back.
 */
export const LOGIN_PATH = "/login";

/**
 * Any origin at all: only used to decide whether a *relative* reference stays
 * relative. `.invalid` is the reserved TLD for exactly this (RFC 2606), so this
 * can never accidentally name a real host.
 */
const PROBE_ORIGIN = "http://next-path.invalid";

/**
 * The `?next=` destination, or `/` -- and never a URL that leaves this site.
 *
 * Two redirects arrive at /login and they do not agree: `src/proxy.ts` sets
 * `next` to the pathname it was guarding, while `requireUser()`
 * (`src/lib/auth/session.ts`) has no pathname available and sends a bare
 * `/login`. So "absent" is normal, not exceptional, and falls back to `/`.
 *
 * The proxy only ever writes a local pathname, but this value is read back out
 * of the *URL*, which anyone can write -- `/login?next=https://evil.tld` is a
 * link an attacker can mail around, and following it after a successful sign-in
 * is a textbook open redirect: the victim sees their own trusted host in the
 * link, signs in for real, and lands on a page the attacker controls. So the
 * value is validated here rather than trusted:
 *
 * - it must be a path on this origin -- `https://evil.tld` fails the leading
 *   `/` test, and `//evil.tld` (a protocol-relative URL, which is *not* a path
 *   however much it looks like one) fails the second-character test;
 * - a backslash counts as a slash. The URL parser normalizes `\` to `/` for
 *   http(s), so `/\evil.tld` is another spelling of `//evil.tld`;
 * - control characters are rejected before parsing, because browsers strip
 *   tabs and newlines out of URLs -- `/<TAB>/evil.tld` becomes `//evil.tld`
 *   after that strip, so a check that ran on the unstripped string would pass
 *   a string that navigates off-site;
 * - and the result is re-derived from a parse against a throwaway origin, so
 *   anything that survives the character checks but still resolves somewhere
 *   else is caught by comparing origins rather than by a longer blocklist.
 *
 * Returned normalized (`pathname + search + hash`), which also collapses
 * `/a/../b` and any percent-encoding tricks into the path that will actually be
 * requested.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_NEXT_PATH;
  if (!value.startsWith("/")) return DEFAULT_NEXT_PATH;
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_NEXT_PATH;
  if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_NEXT_PATH;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.origin !== PROBE_ORIGIN) return DEFAULT_NEXT_PATH;
  // `/login?next=/login` is a real URL to write by hand, and following it is an
  // infinite redirect: the page sends an already-signed-in visitor to `next`,
  // and `next` is this page again. The browser gives up after ~20 hops and
  // shows an error instead of the application.
  if (url.pathname === LOGIN_PATH || url.pathname === `${LOGIN_PATH}/`) {
    return DEFAULT_NEXT_PATH;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
