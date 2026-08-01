import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * The routes that must answer without a session.
 *
 * `/login` so signing in is possible at all (Task 4 builds it), `/health` so an
 * orchestrator's probe never depends on credentials, and `/api/auth` because
 * that is where the sign-in request itself goes -- guarding it would make the
 * login form unable to authenticate.
 *
 * Prefix matching, so `/api/auth/sign-in/email` and `/health` alike are
 * covered. Nothing else may be added here without a reason of the same kind:
 * this list is the entire unauthenticated surface of the application.
 */
const PUBLIC_PREFIXES = ["/login", "/health", "/api/auth"];

/**
 * Is this one of the public routes -- **at a path boundary**?
 *
 * A bare `pathname.startsWith(prefix)` is wrong in the direction that matters:
 * it opens routes rather than closing them. `/loginx` is not `/login`, and
 * `/api/authorize` is not under `/api/auth`, yet a prefix test exempts both --
 * so any future route whose name merely begins with one of these strings would
 * ship unguarded, silently, with nothing failing. The equality-or-separator
 * form is the standard fix and still covers everything the prefix was there
 * for: `/api/auth/sign-in/email`, `/login/` and `/login?next=/settings` (a
 * query string is not part of `pathname`).
 */
function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * **`proxy`, not `middleware`.** Next 16 renamed the file convention and the
 * exported function; `middleware.ts` still works but logs a deprecation warning
 * on every build, and the rename is not cosmetic -- a Proxy defaults to the
 * **Node.js** runtime, where `middleware.ts` was compiled for the edge. The
 * local doc is
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
 * ("Runtime", and "Migration to Proxy"). Note that the `runtime` segment config
 * is rejected in this file, so the runtime is not something to pin here.
 *
 * **It still may not reach the database.** Not because it cannot -- on the
 * Node.js runtime it now could -- but because a proxy is documented as
 * something that "can run outside of your application's main runtime", is
 * deployable in front of the app, and must not rely on shared modules or
 * globals. Written against that contract, this file stays a pure request
 * inspection: no `@/lib/db/*`, no `@/lib/auth/server`, nothing that reaches
 * `better-sqlite3` or `node:fs`. Under the old edge compilation such an import
 * failed the *build* and made `next dev` answer 500 on every route -- the trap
 * `next.config.ts`'s `IgnorePlugin` comment describes for
 * `src/instrumentation.ts`, and one this project has already paid for twice.
 * On Node it would fail more quietly instead, which is worse, so
 * `src/proxy.test.ts` pins the import list.
 *
 * So the check here is **cookie presence only**, and it is not authentication:
 * the cookie is not verified, not decoded and not looked up. It does not need
 * to be -- `requireUser()` and `requireAdmin()` (`@/lib/auth/session`) validate
 * for real in the layout that renders the page, and they are what actually
 * protects the data. Next's own guidance says the same, and gives the sharpest
 * reason: a server function is a POST to the route that uses it, so a matcher
 * change silently removes proxy coverage from it, which is why authorization
 * has to live in the function and not out here. What this buys is that the
 * overwhelmingly common case -- a request with no cookie at all -- becomes a
 * redirect before Next renders anything, and that the redirect can carry
 * `?next=`, because only here is the requested pathname available.
 *
 * `getSessionCookie()` comes from `better-auth/cookies`: a cookie-header parse,
 * with no adapter and no database behind it. It is used rather than a
 * hand-rolled `name.includes("session")` because it knows the real cookie names
 * -- the configured prefix, the `.`/`-` separator variants, and the `__Secure-`
 * prefix that appears the moment this is served over HTTPS, which a substring
 * match written against a local HTTP dev server would get wrong in production
 * only.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  if (!getSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Only the path: the caller decides where to go afterwards, and copying the
    // original query string into the login URL would drag arbitrary parameters
    // through it. `next` is a path on this origin, so the login page can
    // redirect to it without an open-redirect check.
    url.search = "";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except Next's own build output and the files served straight out
   * of `public/`. Without a matcher a proxy runs on every request including
   * `_next/static`, which has no user data in it -- pure added latency.
   *
   * The extension list is what covers `public/`, and it is not an
   * optimization. Files there are served from the site root (`/globe.svg`),
   * which no prefix can distinguish from a route, so before it every asset the
   * **login page** loads answered `307 -> /login` instead of its own bytes --
   * on the one page that is unauthenticated by definition, whose visitor has
   * no session to redirect *with*. Next's own docs give this exact shape of
   * exclusion (`'/((?!api|_next/static|_next/image|.*\.png$).*)'`, see
   * `03-file-conventions/proxy.md`, "Matcher").
   *
   * **Every extension on this list is a path shape that can never be guarded
   * again, so it is kept to what `public/` actually holds** -- three `.svg`
   * files today, plus room for the icons, fonts and crawler metadata a real
   * deployment grows. The raster extensions were on it and are gone: `.png`,
   * `.jpg` and `.webp` are what *user content* is served as, so exempting them
   * pre-emptively removed proxy coverage from routes phases 5-13 have yet to
   * write -- avatars first. `.json` and `.js` are absent for the same reason:
   * an API route could plausibly end in one.
   *
   * A cheaper-looking alternative -- naming the three files
   * (`(?!file\.svg|globe\.svg|window\.svg)`) -- is perfectly legal here; a
   * matcher entry is a regex. It is rejected for maintenance, not
   * impossibility: it would have to be edited every time a file is added to
   * `public/`, and the failure mode of forgetting is an asset that redirects.
   *
   * `media/` used to be exempted too, and no longer is. The exemption was
   * written when nothing served the directory, which made it coverage removed
   * in advance of the code that would need it; `/media/avatars/[userId]` now
   * serves it and the exemption would have been a hole rather than a
   * pre-emptive one. It authenticates itself as well -- a route handler has no
   * layout above it -- and this pass is what gives a cookie-less request the
   * uniform `307 -> /login` that the handler deliberately does not diverge
   * from.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|ico|txt|xml|webmanifest|woff|woff2|ttf|otf)$).*)",
  ],
};
