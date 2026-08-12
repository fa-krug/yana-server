import { and, eq, gt } from "drizzle-orm";

import { auth } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { sessions, users, type User } from "@/lib/db/schema";

/**
 * Every `/api/v1/**` route's uniform failure shape. `status` is the HTTP
 * status the route answers with; `code` is a stable machine-readable string
 * the native client can branch on (never prose -- see the no-echo rule this
 * mirrors from `src/lib/integrations/probe.ts`'s `ProbeResult.detail`: a
 * message here is written by us, for us, and must not carry anything the
 * caller submitted).
 */
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** The one place an `ApiError` becomes an HTTP `Response`. */
export function apiErrorResponse(error: ApiError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

/**
 * The user behind a live, unexpired device session token, or `null`.
 *
 * A join rather than two selects: `sessions.token` is unique-indexed and
 * `sessions.userId` -> `users.id` is the FK Better Auth's own adapter reads,
 * so this is one indexed lookup, not two round trips. `gt(expiresAt, now)`
 * excludes an expired row -- Better Auth does not delete a session on expiry,
 * only refuses to extend it, so an unfiltered lookup would keep authenticating
 * a token for a session that lapsed. `now` is captured once so a session whose
 * `expiresAt` sits exactly at the current tick isn't accepted or rejected
 * depending on how long the query takes to run.
 */
function userForBearerToken(token: string): User | null {
  const now = new Date();
  const row = getDb()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, now)))
    .get();
  return row?.user ?? null;
}

/**
 * Resolve the caller of an `/api/v1/**` request. Throws `ApiError(401, ...)`
 * on any failure to authenticate -- never returns `null` -- so every route
 * from Task 14 on can `await requireApiUser(request)` and use the result
 * unconditionally; a caller that wants the `Response` catches this and passes
 * it to `apiErrorResponse()` (see the route-level try/catch convention those
 * tasks establish).
 *
 * **Bearer first, cookie second, and the two are not tried together.** A
 * Bearer token is the native client's device session, minted by
 * `/device/pair` (Task 9) and never expected to also carry a browser's session
 * cookie -- but if a request somehow carries both, a bad or expired Bearer
 * token must not silently fall through to whatever cookie happens to be
 * attached (e.g. a stale browser cookie replayed by a proxy). So an
 * `Authorization: Bearer ...` header is authoritative the moment it is
 * present: it resolves to a user or the request is rejected, full stop.
 * Falling back to the ordinary session cookie only when there is *no*
 * Authorization header at all is what lets `/api/v1/images/:hash` (Task 23)
 * serve the same feed-logo and article-image bytes to the web UI's own
 * `<img>` tags, through the same route the native client uses, without a
 * second image-serving mechanism.
 *
 * A non-Bearer `Authorization` scheme (e.g. `Basic ...`) is treated the same
 * as a bad Bearer token -- rejected outright, no cookie fallback -- for the
 * same reason: the header's presence is what makes bearer auth authoritative,
 * not its exact scheme spelling.
 */
export async function requireApiUser(request: Request): Promise<User> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== null) {
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      throw new ApiError(401, "unauthorized", "Unsupported authorization scheme.");
    }
    const token = authHeader.slice("bearer ".length).trim();
    const user = token ? userForBearerToken(token) : null;
    if (!user) throw new ApiError(401, "unauthorized", "Invalid or expired token.");
    return user;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new ApiError(401, "unauthorized", "Sign in required.");
  return session.user as User;
}

/**
 * Like `requireApiUser`, but only accepts a Bearer device session -- never
 * falls back to a browser cookie -- and returns the raw session token
 * alongside the user. For endpoints that need the token itself, not just the
 * identity it resolves to: minting a webview-session bootstrap token
 * (`src/lib/auth/webview-session.ts`) has to bind the resulting one-time
 * token to this *exact* session, not a freshly created one, so the WKWebView
 * ends up sharing literally the same session a revoked/unpaired device loses
 * access to as well.
 */
export async function requireApiBearerSession(
  request: Request,
): Promise<{ user: User; token: string }> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.toLowerCase().startsWith("bearer ")) {
    throw new ApiError(401, "unauthorized", "Bearer token required.");
  }
  const token = authHeader.slice("bearer ".length).trim();
  const user = token ? userForBearerToken(token) : null;
  if (!user) throw new ApiError(401, "unauthorized", "Invalid or expired token.");
  return { user, token };
}
