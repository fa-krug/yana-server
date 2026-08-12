import { auth } from "@/lib/auth/server";

const DEFAULT_NEXT_PATH = "/feeds";

/**
 * `ManagementWebView`'s landing point on the native client: exchanges the
 * short-lived, single-use bootstrap token minted by
 * `POST /api/v1/auth/webview-session-token` for the *same* device session
 * already authenticating that Bearer call, by delegating to the installed
 * `oneTimeToken()` plugin's own verify endpoint -- which sets the session
 * cookie itself via its internal `setSessionCookie()` call. See
 * `src/lib/auth/webview-session.ts`'s module doc for why the mint side is
 * hand-written but the verify side reuses the plugin unmodified.
 *
 * `next` is restricted to an in-app, same-origin target -- validated by
 * actually resolving it against the request URL and checking the resulting
 * origin, not by a string-prefix heuristic -- so a crafted `next` cannot
 * turn this into an open redirect. Two things matter here, both learned the
 * hard way across two rounds of security review:
 *
 * 1. A string-prefix check (`startsWith("/")`, reject `startsWith("//")`) is
 *    insufficient on its own: the WHATWG URL parser normalizes backslashes
 *    to forward slashes and strips TAB/LF/CR for special schemes, so e.g.
 *    `"/\\evil.com"` passes a naive prefix check but resolves to
 *    `https://evil.com/` once parsed -- exactly what the browser would
 *    actually navigate to. Resolving first and comparing the *origin*
 *    closes that gap.
 * 2. It is NOT safe to take the validated `URL`'s `pathname`/`search`/`hash`,
 *    concatenate them back into a string, and feed that string into a
 *    *second* `new URL(x, base)` call. A same-origin absolute URL whose
 *    path happens to start with `//` right after the authority (e.g.
 *    `https://example.com//evil.example.com`) passes the origin check on
 *    first resolution, but `.pathname` for that URL is the literal string
 *    `"//evil.example.com"` -- a WHATWG "network-path reference" that, when
 *    it is itself the *input* to a fresh `new URL(..., base)` call, replaces
 *    the authority outright regardless of `base`'s origin, escaping to
 *    `https://evil.example.com/` on the second resolution. `pathname` is a
 *    safe *property of* an already-resolved URL; it is not safe as *input*
 *    to another resolution. So `resolveSameOriginTarget` below returns the
 *    validated `URL` object itself, and every consumer must use it directly
 *    (`.toString()`, or its `.pathname`/`.search`/`.hash` embedded as an
 *    *opaque, percent-encoded* value -- never re-parsed as a URL again).
 *
 * Falls back to `/login?next=...` on any missing/invalid/expired/already-used
 * token, exactly like a plain visitor who isn't signed in yet, so a stale
 * bootstrap token degrades to a normal login screen instead of an opaque
 * error.
 *
 * Built with `new Response(null, { status, headers })` rather than
 * `Response.redirect()` -- the latter returns a `Response` with **immutable
 * headers**, so a `Set-Cookie` cannot be appended onto it afterward.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const target = resolveSameOriginTarget(url.searchParams.get("next"), url);

  if (!token) {
    return redirectToLogin(url, target);
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await auth.api.verifyOneTimeToken({ body: { token }, asResponse: true });
  } catch {
    return redirectToLogin(url, target);
  }
  if (!verifyResponse.ok) {
    return redirectToLogin(url, target);
  }

  // `target` is already a validated, same-origin `URL` object -- use it
  // directly. Do NOT re-derive a string from it and pass that string
  // through another `new URL(x, base)` call (see the module doc above).
  const headers = new Headers({ location: target.toString() });
  for (const cookie of verifyResponse.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function redirectToLogin(url: URL, target: URL): Response {
  // `target`'s path/search/hash are embedded here as an opaque,
  // percent-encoded query *value* (via encodeURIComponent) -- never as
  // structural input to a URL resolution -- so a leading "//" in it cannot
  // be reinterpreted as a network-path reference the way it would be if
  // this string were later passed as the first argument to `new URL()`.
  const nextValue = target.pathname + target.search + target.hash;
  const location = new URL(`/login?next=${encodeURIComponent(nextValue)}`, url);
  return new Response(null, { status: 302, headers: { location: location.toString() } });
}

/**
 * Resolves `rawNext` against `requestUrl` and returns it as a `URL` only if
 * the resolved origin matches `requestUrl`'s origin; otherwise returns the
 * default in-app target. Returning a `URL` object (not a string) is
 * deliberate: callers must use this value directly rather than
 * re-serializing part of it and re-parsing that string as a URL, which is
 * exactly the bypass described in the module doc above.
 */
function resolveSameOriginTarget(rawNext: string | null, requestUrl: URL): URL {
  const fallback = new URL(DEFAULT_NEXT_PATH, requestUrl);
  if (!rawNext) return fallback;
  let resolved: URL;
  try {
    resolved = new URL(rawNext, requestUrl);
  } catch {
    return fallback;
  }
  return resolved.origin === requestUrl.origin ? resolved : fallback;
}
