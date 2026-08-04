import crypto from "node:crypto";
import { connection } from "next/server";

import { writeTransaction } from "@/lib/db/client";
import { devicePairingStates } from "@/lib/db/schema";

/**
 * 10 minutes -- long enough for a user to complete a sign-in inside the
 * webview `/device/pair`'s caller opens right after this call, short enough
 * that a `state` an attacker somehow observed (this response is unauthenticated
 * and carries no secret about *who* is pairing, only a value nobody else has
 * yet) is worthless well before anyone could act on it.
 */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Mint a single-use, short-lived CSRF token for the device-pairing flow.
 *
 * Deliberately unauthenticated -- the native app calls this *before* it ever
 * shows sign-in UI, so there is no session to require, and nothing about who
 * this pairing is for is known yet (that only becomes true once `/device/pair`
 * itself runs behind `requireUser()`). This is why the state carries no user
 * association at mint time: see
 * `docs/superpowers/specs/2026-08-03-client-api-design.md` §1.
 *
 * The state is opaque random bytes, not a value anything could predict or
 * enumerate -- `crypto.randomBytes(32)` is 256 bits, the same order of
 * magnitude as a session token. `/device/pair` is what makes this valuable:
 * it is the CSRF guard closing the gap a bare cookie-gated GET would leave
 * (`sessions`' `SameSite=Lax` cookie still attaches on a cross-site top-level
 * navigation), so minting it is the one thing this route does.
 */
export async function GET(): Promise<Response> {
  await connection();

  const state = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);

  writeTransaction((tx) => {
    tx.insert(devicePairingStates).values({ state, expiresAt }).run();
  });

  return Response.json({ state, expiresAt: expiresAt.toISOString() });
}
