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

export const { signIn, signOut, signUp, useSession } = authClient;
