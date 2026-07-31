"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/**
 * The browser half of Better Auth. No `baseURL`: the client defaults to the
 * current origin, which is what a self-hosted single-origin deployment wants --
 * pinning one would break every install whose host is not the developer's.
 *
 * The passkey plugin is a *pair*: `passkey()` on the server adds the endpoints,
 * `passkeyClient()` here adds the `signIn.passkey` / `passkey.*` calls that
 * drive `navigator.credentials`. Registering only one side gives a client whose
 * passkey methods do not exist, with no type error to say so.
 */
export const authClient = createAuthClient({ plugins: [passkeyClient()] });

/**
 * No `signUp`. The server sets `disableSignUp`, so the endpoint behind it
 * answers BAD_REQUEST unconditionally -- re-exporting it would only invite a
 * later phase into wiring a registration form against a route that refuses.
 * Accounts come from the admin bootstrap or from admin creation in phase 5.
 * Passkey calls reach the client through `authClient.passkey` /
 * `authClient.signIn.passkey`, added by the plugin above.
 */
export const { signIn, signOut, useSession } = authClient;
