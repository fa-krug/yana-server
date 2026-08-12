import { randomBytes } from "node:crypto";

import { auth } from "./server";

const ONE_TIME_TOKEN_IDENTIFIER_PREFIX = "one-time-token:";
const WEBVIEW_TOKEN_TTL_MS = 60_000;

/**
 * Mints a one-time bootstrap token that `GET /webview-session` (the wrapper
 * route `ManagementWebView` on the native client loads) exchanges for the
 * *same* session `sessionToken` already authenticates as a device Bearer
 * token -- not a freshly created one. Writes directly into the storage
 * convention the installed `oneTimeToken()` plugin's own
 * `/one-time-token/verify` endpoint reads
 * (`verifications.identifier = "one-time-token:<token>"`,
 * `verifications.value = <session token>`, see
 * `node_modules/better-auth/dist/plugins/one-time-token/index.mjs`), so that
 * plugin's own verify handler -- which sets the real session cookie via
 * `setSessionCookie()` -- does the actual login unmodified.
 *
 * Revoking the underlying device session invalidates any web session minted
 * from it too, but not instantly: Better Auth's 5-minute signed
 * session-cookie cache (`cookieCache` in `./server.ts`) can keep serving an
 * already-established browser session without a database read for up to
 * that long after the device session is revoked.
 *
 * Written by hand rather than calling `auth.api.generateOneTimeToken()`
 * because that endpoint resolves its caller via `sessionMiddleware`
 * (cookie-only), and this app has no `bearer()` plugin installed -- it would
 * never see a device's `Authorization: Bearer` header, only a browser
 * session cookie. `ONE_TIME_TOKEN_PLUGIN_PATHS` in `./server` closes that
 * endpoint over HTTP for exactly this reason, so this function is the only
 * mint path that exists.
 */
export async function mintWebviewSessionToken(
  sessionToken: string,
): Promise<{ token: string; expiresAt: Date }> {
  const ctx = await auth.$context;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WEBVIEW_TOKEN_TTL_MS);
  await ctx.internalAdapter.createVerificationValue({
    value: sessionToken,
    identifier: `${ONE_TIME_TOKEN_IDENTIFIER_PREFIX}${token}`,
    expiresAt,
  });
  return { token, expiresAt };
}
