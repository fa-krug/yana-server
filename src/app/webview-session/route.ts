import { DEFAULT_NEXT_PATH as LOGIN_DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/auth/next-path";
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
 * `next` is validated by `safeNextPath()` (`@/lib/auth/next-path`) -- the
 * same hardened, well-tested guard `/login` uses -- rather than a
 * second, hand-rolled same-origin check. That module's doc explains in
 * detail why a naive check is insufficient (backslash/tab normalization,
 * protocol-relative spellings, and the "network-path reference" bypass
 * where a same-origin absolute URL's `.pathname` starts with `//` and
 * re-parses as off-origin). `safeNextPath()` guarantees its returned path
 * never starts with `//`, which is exactly what makes it safe to feed
 * directly into `new URL(path, url)` below -- do not replace this with a
 * route-local reimplementation of the same guard.
 *
 * `safeNextPath()`'s own default is `/` (`login`'s landing page); this
 * route's default is `/feeds` instead, so an invalid/absent/unsafe `next`
 * (including one that points at `/login`, which `safeNextPath()` also
 * refuses) is translated from its default to this route's own.
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
  const target = resolveTarget(url.searchParams.get("next"), url);

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
 * Resolves `rawNext` into a same-origin `URL` via `safeNextPath()`, this
 * route's own `DEFAULT_NEXT_PATH` (`/feeds`) standing in wherever
 * `safeNextPath()` would have used its own default (`/`). `safeNextPath()`
 * already guarantees the returned path never starts with `//`, so passing
 * it as the first argument to `new URL(path, requestUrl)` here is safe --
 * see the module doc above.
 */
function resolveTarget(rawNext: string | null, requestUrl: URL): URL {
  const safePath = safeNextPath(rawNext);
  const path = safePath === LOGIN_DEFAULT_NEXT_PATH ? DEFAULT_NEXT_PATH : safePath;
  return new URL(path, requestUrl);
}
