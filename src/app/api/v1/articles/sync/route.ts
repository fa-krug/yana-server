import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { decodeCursor, syncArticles } from "@/lib/api/sync";

/**
 * The native client's delta-sync endpoint: three independently-cursored
 * streams (`new`/`updated`/`removed`) scoped to the caller's own feeds. All
 * the actual query logic lives in `syncArticles()` (Task 13) -- this route is
 * just the HTTP shell around it: authenticate, parse `cursor`/`limit`, and
 * translate `ApiError` into the uniform `/api/v1/**` error shape.
 *
 * `await connection()` must be the literal first statement, ahead of
 * `requireApiUser()` -- see the `connection()` bullet in the root CLAUDE.md:
 * this route has no other Dynamic API call in its path (no cookie/header
 * read is guaranteed -- a Bearer-token caller never touches `next/headers`),
 * so nothing else would opt it out of prerendering.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const user = await requireApiUser(request);

    const url = new URL(request.url);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    // `Number(null) === 0`, not `NaN` -- so an absent `limit` param must be
    // distinguished from a present-but-garbage one *before* calling Number(),
    // or the common "no limit given" case would silently take the clamp
    // branch below and get floored to 1 instead of falling through to the
    // 200 default.
    const rawLimit = url.searchParams.get("limit");
    const requestedLimit = rawLimit === null || rawLimit === "" ? NaN : Number(rawLimit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 200;

    return Response.json(syncArticles(user.id, cursor, limit));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
