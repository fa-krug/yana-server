import { and, eq, gt, isNull } from "drizzle-orm";

import { createDeviceSession } from "@/lib/auth/server";
import { requireUser } from "@/lib/auth/session";
import { writeTransaction } from "@/lib/db/client";
import { devicePairingStates } from "@/lib/db/schema";

/**
 * The only scheme a real device registers today. A fixed allow-list rather
 * than accepting whatever the caller sends -- see the module doc below.
 */
const ALLOWED_SCHEMES = new Set(["yana"]);

/**
 * The webview's landing point right after the user signs in through the
 * ordinary `/login` form (whose `next` param carries this route's full query
 * string through unchanged) -- session-cookie-authenticated like every other
 * page in `(app)`. There is no separate auth mechanism for pairing.
 *
 * **Why a `state` token, not just the cookie.** A bare cookie-gated GET here
 * would be a CSRF hazard: `sessions`' cookie is `SameSite=Lax`, which still
 * attaches on a cross-site *top-level navigation* (a link a signed-in user
 * clicks from another site) even though it blocks cross-site
 * `<img>`/`fetch`. Without a state check, that link alone mints a real,
 * live, 30-day Bearer credential using the victim's own cookie -- the
 * attacker never needs to see the cookie or the response, only to get the
 * victim to click a URL naming this path. `/device/pair/start` mints a
 * value nobody else can know in advance, and this route accepts it exactly
 * once; an attacker's link cannot supply a `state` it was never given, so the
 * request is refused *before anything is written*, not merely discarded
 * after a session already exists.
 *
 * **Order of operations, and why it is this order:**
 * 1. `requireUser()` first -- the same principle the avatar route documents:
 *    no answer this route gives to a signed-out caller may depend on what
 *    they asked for, including whether their `state` happens to be valid.
 * 2. The `state` is looked up, checked (exists, unexpired, unused) and
 *    consumed in one transaction -- single-use, race-safe (see the update
 *    below), so a replayed or guessed value is refused outright.
 * 3. `scheme` is checked against `ALLOWED_SCHEMES`, never accepted as an
 *    arbitrary client-supplied value -- restricting *where* the token can be
 *    redirected to, on top of restricting *whether* one gets minted at all.
 * 4. The redirect URL is built and validated.
 * 5. **Only then** is the device session minted. This ordering closes a
 *    mint-then-fail hazard: minting first and validating after would let a
 *    malformed `scheme` leave an orphaned-but-valid, never-delivered session
 *    row behind on a failed request.
 *
 * The redirect target is a custom URL scheme the native app registers and
 * intercepts before it ever becomes a real network request
 * (`decidePolicyForNavigationAction` on the WKWebView side). The minted
 * token is a genuine, independent Better Auth session -- the same credential
 * `src/lib/api/auth.ts` resolves on every `/api/v1/**` request -- not a
 * separate "API key" concept; see
 * `docs/superpowers/specs/2026-08-03-client-api-design.md` §1.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();

  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  const scheme = url.searchParams.get("scheme") || "yana";
  const deviceName = url.searchParams.get("deviceName") || "Unnamed device";

  if (!stateParam || !ALLOWED_SCHEMES.has(scheme)) {
    return new Response(null, { status: 400 });
  }

  /**
   * Single-use enforcement that is race-safe against two concurrent requests
   * for the same `state`: the `UPDATE ... WHERE id = ? AND used_at IS NULL`
   * runs inside the same transaction as the read, and only one concurrent
   * writer can win it -- `writeTransaction()`'s `BEGIN IMMEDIATE` serializes
   * writers, so the second transaction's `UPDATE` sees the first's committed
   * `usedAt` and its `result.changes` is 0. Checking `result.changes === 1`
   * rather than trusting the earlier `SELECT` is what makes this atomic
   * rather than a check-then-act gap.
   */
  const consumed = writeTransaction((tx) => {
    const now = new Date();
    const row = tx
      .select()
      .from(devicePairingStates)
      .where(
        and(
          eq(devicePairingStates.state, stateParam),
          isNull(devicePairingStates.usedAt),
          gt(devicePairingStates.expiresAt, now),
        ),
      )
      .get();
    if (!row) return false;

    const result = tx
      .update(devicePairingStates)
      .set({ usedAt: now })
      .where(and(eq(devicePairingStates.id, row.id), isNull(devicePairingStates.usedAt)))
      .run();
    return result.changes === 1;
  });

  if (!consumed) {
    return new Response(null, { status: 400 });
  }

  let callback: URL;
  try {
    // `scheme` is already restricted to `ALLOWED_SCHEMES` above, so this can
    // only fail if a future allow-list entry turns out not to parse as a URL
    // scheme -- kept as defense-in-depth against that, not because "yana"
    // itself can fail here today.
    callback = new URL(`${scheme}://auth-callback`);
  } catch {
    return new Response(null, { status: 400 });
  }

  const { token } = await createDeviceSession(user.id, deviceName);
  callback.searchParams.set("token", token);

  return Response.redirect(callback.toString(), 307);
}
