import { eq } from "drizzle-orm";
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { serializeTag } from "@/lib/api/serializers";
import { getDb } from "@/lib/db/client";
import { tags } from "@/lib/db/schema";

/**
 * The native client's tag list, scoped to the caller's own tags.
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
    const tagRows = getDb().select().from(tags).where(eq(tags.userId, user.id)).all();
    return Response.json({ tags: tagRows.map(serializeTag) });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
