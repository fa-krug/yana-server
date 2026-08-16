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
 * never starts with `//`, which is exactly what makes it safe to emit
 * directly as the relative `Location` below -- do not replace this with a
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
 * **Both `Location` headers are relative references (`/feeds`,
 * `/login?next=...`), never absolute URLs, and that is load-bearing rather
 * than stylistic.** In production this app is a standalone Next server
 * listening on `0.0.0.0:3000` behind a reverse proxy, and `request.url`
 * there is that internal listening address -- not the public origin the
 * client dialled. An absolute `Location` built from it (the shape this route
 * originally shipped: `new URL(path, request.url).toString()`) therefore
 * sent `ManagementWebView` to `http://0.0.0.0:3000/feeds`, which WebKit
 * refuses outright as restricted network access (WebKitErrorDomain 103) --
 * so the whole webview bootstrap died on the redirect, after the token had
 * already been minted and burned. RFC 9110 §10.2.2 permits a relative
 * reference, the browser resolves it against the origin it actually
 * requested, and nothing then depends on `Host`/`X-Forwarded-Proto` being
 * threaded through the proxy correctly. Do not "tidy" these back into
 * absolute URLs.
 *
 * Built with `new Response(null, { status, headers })` rather than
 * `Response.redirect()` -- the latter requires an absolute URL *and* returns
 * a `Response` with **immutable headers**, so a `Set-Cookie` could not be
 * appended onto it afterward either.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const target = resolveTarget(url.searchParams.get("next"));

  if (!token) {
    return redirectToLogin(target);
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await auth.api.verifyOneTimeToken({ body: { token }, asResponse: true });
  } catch {
    return redirectToLogin(target);
  }
  if (!verifyResponse.ok) {
    return redirectToLogin(target);
  }

  // `target` is already a validated, same-origin *path* -- emit it as-is.
  // Do NOT pass it through `new URL(target, request.url)` to "normalize" it:
  // that is what leaked the container's own `0.0.0.0:3000` origin into this
  // header (see the module doc above).
  const headers = new Headers({ location: target });
  for (const cookie of verifyResponse.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function redirectToLogin(target: string): Response {
  // `target` is embedded here as an opaque, percent-encoded query *value*
  // (via encodeURIComponent) -- never as structural input to a URL
  // resolution -- so a leading "//" in it could not be reinterpreted as a
  // network-path reference even if `safeNextPath()` had let one through.
  const location = `/login?next=${encodeURIComponent(target)}`;
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * Resolves `rawNext` into a same-origin path via `safeNextPath()`, this
 * route's own `DEFAULT_NEXT_PATH` (`/feeds`) standing in wherever
 * `safeNextPath()` would have used its own default (`/`).
 *
 * The result is a path (`pathname + search + hash`) and stays one all the
 * way into the `Location` header -- `safeNextPath()` guarantees it starts
 * with a single `/`, which is what makes it safe to emit as a relative
 * reference: a browser resolving it against the requested origin cannot
 * leave that origin.
 */
function resolveTarget(rawNext: string | null): string {
  const safePath = safeNextPath(rawNext);
  return safePath === LOGIN_DEFAULT_NEXT_PATH ? DEFAULT_NEXT_PATH : safePath;
}
