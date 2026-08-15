import { connection } from "next/server";

import { buildOpenApiDocument } from "@/lib/api/docs/openapi";
import { requireUser } from "@/lib/auth/session";

/**
 * The generated OpenAPI document, signed-in only -- gated the same way
 * `src/app/media/avatars/[userId]/route.ts` gates itself, since a route
 * handler has no layout above it enforcing anything. `requireUser()`
 * redirects a signed-out caller to /login rather than answering 401, exactly
 * like the rest of `(app)` -- this is documentation reachable from inside the
 * app, not a `/api/v1/**` data endpoint, so it does not go through
 * `requireApiUser()`'s Bearer-or-cookie contract.
 *
 * `await connection()` is the literal first statement, ahead of
 * `requireUser()` -- see the `connection()` bullet in the root CLAUDE.md.
 */
export async function GET(): Promise<Response> {
  await connection();
  await requireUser();
  return Response.json(buildOpenApiDocument());
}
