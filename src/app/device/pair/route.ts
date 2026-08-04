import { createDeviceSession } from "@/lib/auth/server";
import { requireUser } from "@/lib/auth/session";

/**
 * The native app's webview lands here right after the user signs in through
 * the ordinary `/login` form -- this route is reached inside a real browser
 * navigation carrying the cookie Better Auth just set, so it is
 * session-cookie-authenticated like every other page in `(app)`.
 * `requireUser()` is the same gate those pages use; there is no separate auth
 * mechanism for pairing.
 *
 * A signed-out caller is turned away by `requireUser()` (its `redirect()` to
 * `/login`) *before* anything below it runs, so no device session is ever
 * minted for a request with no valid cookie session.
 *
 * The redirect target is a custom URL scheme the native app registers and
 * intercepts before it ever becomes a real network request
 * (`decidePolicyForNavigationAction` on the WKWebView side) -- see the design
 * doc's client-API section for why a device *session*, not a separate "API
 * key" concept, is the credential handed over here: the token minted by
 * `createDeviceSession()` is the same Bearer token `src/lib/api/auth.ts`
 * resolves on every `/api/v1/**` request.
 *
 * `scheme` is caller-supplied on purpose -- the native app names its own
 * registered scheme -- and defaults to `"yana"` only so a manual browser hit
 * against this route (during development) produces something. `deviceName` is
 * free text the device chooses to label itself with in the device-management
 * UI (task 11); it is never used to build a filesystem path or a query
 * identifier, so it needs no allow-list the way `avatarFilePath()`'s id does.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();

  const url = new URL(request.url);
  const scheme = url.searchParams.get("scheme") || "yana";
  const deviceName = url.searchParams.get("deviceName") || "Unnamed device";

  const { token } = await createDeviceSession(user.id, deviceName);

  const callback = new URL(`${scheme}://auth-callback`);
  callback.searchParams.set("token", token);

  return Response.redirect(callback.toString(), 307);
}
