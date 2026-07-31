import fs from "node:fs";
import path from "node:path";

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, proxy } from "./proxy";

const ROOT = path.resolve(import.meta.dirname, "..");

function request(url: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), {
    headers: cookie ? { cookie } : undefined,
  });
}

/** What `NextResponse.next()` sets, and a redirect never does. */
function isPassThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

/**
 * A source-level guard, in the same spirit as `src/instrumentation.test.ts`.
 *
 * A proxy is documented as code that may run outside the application's main
 * runtime, and as `middleware.ts` (the deprecated name for this same file) it
 * was compiled for the **edge**, where `better-sqlite3` -- a native addon -- and
 * `node:fs` do not exist. There, one import that transitively reached
 * `@/lib/db/client` did not fail at a query: it failed the *compilation*, and
 * `next dev` then answered 500 on every route with a healthy database sitting
 * behind it. This project has hit that twice. On the Node.js runtime Next 16
 * gives a proxy, the same import merely succeeds and quietly opens the database
 * from a layer that is supposed to be a request inspection -- a failure with no
 * symptom at all until it is deployed in front of the app.
 *
 * So the import list is pinned exactly. `better-auth/cookies` is on it because
 * it is a cookie-header parse with no adapter and no database behind it; adding
 * anything here means proving the same for the new specifier by running
 * `npm run dev` and fetching a page, not by reasoning about it.
 */
describe("the proxy's dependency contract", () => {
  it("imports only request-inspection modules", () => {
    const source = fs
      .readFileSync(path.join(ROOT, "src/proxy.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    expect(specifiers.toSorted()).toEqual(["better-auth/cookies", "next/server"]);
  });

  it("is the proxy convention, not the deprecated middleware one", () => {
    // Next 16 renamed the file *and* the export; `middleware.ts` still runs but
    // warns on every build and is compiled for a different runtime. Pinned
    // because the two conventions are one rename apart, and a half-applied one
    // -- proxy.ts exporting middleware() -- is a file Next silently never calls,
    // which would leave every route unguarded with nothing failing.
    expect(fs.existsSync(path.join(ROOT, "src/middleware.ts"))).toBe(false);
    expect(typeof proxy).toBe("function");
  });
});

describe("proxy", () => {
  it("redirects an unauthenticated request to the login page, remembering where it was going", () => {
    const response = proxy(request("/settings"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/settings");
  });

  it("does not carry the original query string into the login URL", () => {
    const response = proxy(request("/articles?tag=secret&page=3"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("next")).toBe("/articles");
    expect(location.searchParams.get("tag")).toBe(null);
    expect([...location.searchParams.keys()]).toEqual(["next"]);
  });

  it.each(["/login", "/login?next=/settings", "/health", "/api/auth/sign-in/email"])(
    "leaves %s reachable without a session",
    (url) => {
      // Guarding any of these breaks the application outright: no login form,
      // no health probe, and no endpoint for the login form to post to.
      expect(isPassThrough(proxy(request(url)))).toBe(true);
    },
  );

  it("lets a request carrying a session cookie through", () => {
    // Presence only -- this is not authentication, and the cookie below is not
    // a valid session. src/lib/auth/session.ts is what validates it, and
    // src/lib/auth/session.test.ts proves it refuses exactly this token.
    const passed = proxy(
      request("/settings", "better-auth.session_token=not-a-real-token.not-a-real-signature"),
    );

    expect(isPassThrough(passed)).toBe(true);
  });

  it("recognises the cookie name HTTPS actually produces", () => {
    // The reason getSessionCookie() is used instead of a substring match:
    // served over HTTPS, Better Auth prefixes the cookie with `__Secure-`. A
    // check written against a local HTTP dev server would send every
    // authenticated production request to /login.
    const secure = proxy(request("/settings", "__Secure-better-auth.session_token=abc.def"));

    expect(isPassThrough(secure)).toBe(true);
  });

  it("is not fooled by an unrelated cookie with 'session' in its name", () => {
    // What the substring check this replaced would have accepted.
    const response = proxy(request("/settings", "my_session_hint=1; analytics_session=abc"));

    expect(response.status).toBe(307);
  });

  it("does not run at all on Next's own static output", () => {
    // Through Next's own matcher evaluation rather than a hand-built regexp:
    // the matcher is data Next interprets, and re-implementing that here would
    // only test the re-implementation. (`unstable_doesMiddlewareMatch` is the
    // installed API's name for it -- the docs already call it
    // `unstable_doesProxyMatch`, which this version does not export yet.)
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

    expect(matches("/_next/static/chunks/main.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/media/logo.png")).toBe(false);
    expect(matches("/settings")).toBe(true);
    expect(matches("/")).toBe(true);
  });
});
