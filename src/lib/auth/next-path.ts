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

/** Is this the login page itself, however it is spelled? */
function isLoginPath(pathname: string): boolean {
  // Trailing slashes and case are both stripped: `/login/`, `/login//` and
  // `/LOGIN` all reach the same page (or, for the last one, no page at all --
  // Next's routes are case-sensitive), and a guard that says "the login page"
  // should mean it. `/login/x` is a *different* route and stays allowed.
  return pathname.replace(/\/+$/, "").toLowerCase() === LOGIN_PATH;
}

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
 * link, signs in for real, and lands on a page the attacker controls.
 *
 * **The check that matters runs on the value being returned, not on the value
 * that came in.** The first version of this function tested the raw input for a
 * leading `//` and shipped a working open redirect anyway, because `URL`
 * normalization *creates* leading slashes that the input never had:
 * `/.//evil.tld`, `/./\evil.tld` and `/a/..//evil.tld` all pass every possible
 * input test and all normalize to `//evil.tld`, which a browser reads as
 * protocol-relative and follows off-site. Any future guard added here belongs
 * below the parse, for the same reason.
 *
 * Four rejections, and each one is the only thing standing between some real
 * input and a wrong answer -- verified by deleting them one at a time and
 * watching a test in `./next-path.test.ts` fail:
 *
 * - **not a path** (`evil.tld`, `javascript:alert(1)`): resolved against the
 *   probe origin these become `/evil.tld` and a `javascript:` URL. The first is
 *   a silent rewrite to a page nobody asked for, the second is not a path at
 *   all.
 * - **`URL` threw**: reachable, not defensive. `//` and `///` are hosts with no
 *   host in them, and the parser rejects them outright.
 * - **the origin moved**: what catches every protocol-relative spelling.
 *   `//evil.tld/x?y=1` parses with `origin === "http://evil.tld"`, and its
 *   *path* is the innocent-looking `/x?y=1` -- so testing the path alone would
 *   have quietly sent the user to the wrong local page. A backslash counts as a
 *   slash here (`URL` normalizes `\` to `/` for http(s), so `/\evil.tld` is
 *   another spelling), and so does a tab or a newline: the parser strips those
 *   before resolving, which turns `/<TAB>/evil.tld` into `//evil.tld` and trips
 *   this same check. That is why there is no separate control-character guard
 *   -- every other control character is percent-encoded into the path
 *   (`/<U+0001>/x` becomes `/%01/x`) and cannot escape anything, including a
 *   `Location` header.
 * - **the normalized path is protocol-relative**: the one described above.
 *
 * Returned normalized (`pathname + search + hash`), which is also what makes
 * the last check meaningful: what is validated is exactly the string that will
 * be requested.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_NEXT_PATH;
  if (!value.startsWith("/")) return DEFAULT_NEXT_PATH;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.origin !== PROBE_ORIGIN) return DEFAULT_NEXT_PATH;

  const path = `${url.pathname}${url.search}${url.hash}`;
  if (path.startsWith("//")) return DEFAULT_NEXT_PATH;
  // Not a loop -- `redirect(LOGIN_PATH)` carries no query, so the next hop
  // reads no `next` and terminates. It is one pointless extra hop, and a
  // sign-in page that "returns you to" the sign-in page. Refused so `next`
  // always names somewhere worth arriving.
  if (isLoginPath(url.pathname)) return DEFAULT_NEXT_PATH;

  return path;
}
