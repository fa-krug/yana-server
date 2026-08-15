import { connection } from "next/server";

import { ApiReference } from "@scalar/nextjs-api-reference";

import { requireUser } from "@/lib/auth/session";

/**
 * `@scalar/nextjs-api-reference`'s `ApiReference()` is not a React component:
 * its own `dist/index.d.ts` declares
 * `(givenConfiguration) => (() => Response)` -- a factory that returns a Route
 * Handler function producing a full, standalone HTML document (Scalar's
 * reference UI, loaded from a CDN script and pointed at the given `url`). A
 * Response returned from a Route Handler bypasses every layout, sidebar chrome
 * included, so there is no benefit to a `page.tsx` here and, more to the
 * point, no way to make one typecheck against this package's real export.
 * This lives under `(app)/api-docs/` for the same URL the rest of this task
 * was written against; the group segment does not change that.
 */
const renderReference = ApiReference({ url: "/api/v1/openapi.json" });

/**
 * Signed-in-only interactive API reference, gated the same way
 * `src/app/media/avatars/[userId]/route.ts` and
 * `src/app/api/v1/openapi.json/route.ts` gate themselves: a route handler has
 * no layout above it enforcing anything, so `requireUser()` is called
 * directly rather than relied on from `(app)/layout.tsx`. Signed out, this
 * redirects to `/login` exactly like the rest of `(app)`, rather than
 * answering 401.
 *
 * `await connection()` is the literal first statement, ahead of
 * `requireUser()` -- see the `connection()` bullet in the root CLAUDE.md.
 */
export async function GET(): Promise<Response> {
  await connection();
  await requireUser();
  return renderReference();
}
