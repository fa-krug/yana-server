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
 * `next` is restricted to an in-app relative path -- validated by actually
 * resolving it against the request URL and checking the resulting origin,
 * not by a string-prefix heuristic -- so a crafted `next` cannot turn this
 * into an open redirect. A string-prefix check (`startsWith("/")`, reject
 * `startsWith("//")`) is insufficient on its own: the WHATWG URL parser
 * normalizes backslashes to forward slashes and strips TAB/LF/CR for
 * special schemes, so e.g. `"/\\evil.com"` passes a naive prefix check but
 * resolves to `https://evil.com/` once parsed -- exactly what the browser
 * would actually navigate to. Resolving first and comparing the origin
 * closes that gap by validating the same resolution the browser performs.
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
  const next = sanitizeNextPath(url.searchParams.get("next"), url);

  if (!token) {
    return redirectToLogin(url, next);
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await auth.api.verifyOneTimeToken({ body: { token }, asResponse: true });
  } catch {
    return redirectToLogin(url, next);
  }
  if (!verifyResponse.ok) {
    return redirectToLogin(url, next);
  }

  const headers = new Headers({ location: new URL(next, url).toString() });
  for (const cookie of verifyResponse.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function redirectToLogin(url: URL, next: string): Response {
  const location = new URL(`/login?next=${encodeURIComponent(next)}`, url);
  return new Response(null, { status: 302, headers: { location: location.toString() } });
}

function sanitizeNextPath(rawNext: string | null, requestUrl: URL): string {
  if (!rawNext) return DEFAULT_NEXT_PATH;
  let resolved: URL;
  try {
    resolved = new URL(rawNext, requestUrl);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (resolved.origin !== requestUrl.origin) return DEFAULT_NEXT_PATH;
  return resolved.pathname + resolved.search + resolved.hash;
}
