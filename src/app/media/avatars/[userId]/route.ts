import fs from "node:fs/promises";

import { AVATAR_CONTENT_TYPE, avatarFilePath } from "@/lib/avatar-storage";
import { requireUser } from "@/lib/auth/session";

/**
 * `GET /media/avatars/<userId>` -- the only thing that serves the media volume.
 *
 * **This handler is the entire access control for the file it returns, and
 * nothing above it helps.** `src/proxy.ts` does run for this path (`media/` is
 * no longer exempted from the matcher and `.webp` is not on the extension
 * allow-list), but the proxy checks only that *a* session cookie is present --
 * it never verifies, decodes or looks one up, by design. And a route handler
 * has **no layout above it**: none of the `requireUser()` calls that protect
 * `src/app/(app)` are anywhere in this request's path. So the check is here or
 * it does not happen.
 *
 * **This rule binds every future `media/` route handler**, not just avatars.
 * Phase 9/11 article images are numerous, per-user, and may carry paywalled
 * content.
 *
 * Four things it gets right, each for a stated reason:
 *
 * 1. **`requireUser()`, and then an equality check against the caller.** Being
 *    signed in is not authorisation to read *another* user's avatar. Without
 *    the comparison, anyone with an account fetches any avatar by guessing an
 *    id -- and because a hit and a miss would differ (200 vs 404), the route
 *    would also be a user-id enumeration oracle.
 * 2. **The filesystem path is built from `user.id`, never from the URL**, and
 *    `avatarFilePath()` re-checks even that against the id pattern before
 *    joining it. The segment from the request is only ever *compared*. Phase
 *    4's review found an open redirect that validated its input and then
 *    returned a normalised value; the fix generalises to "validate the value
 *    you actually use", which here is the session's id.
 * 3. **Every refusal is the same 404 with no body.** "Not yours", "no such
 *    user", "not a user id at all" and "you have not uploaded one" are
 *    indistinguishable, so none of them tells a caller anything about who
 *    exists.
 * 4. **The bytes only ever come from `processAvatar()`.** Task 6's upload
 *    decodes and re-encodes to WebP before anything reaches this directory, so
 *    the fixed `Content-Type` below is a fact about the file rather than a
 *    guess about the upload -- which is what keeps an "image" upload from
 *    being served back as HTML or as an SVG carrying script.
 *
 * **A signed-out caller gets `requireUser()`'s `307 -> /login`, not a 404, and
 * that is deliberate -- do not "fix" it here.** It is the same answer
 * `src/proxy.ts` already gives for the whole `media/` prefix when no cookie is
 * present, and it is uniform across every id, so it is not an enumeration
 * oracle. Diverging in the handler alone would make one logical condition -- no
 * valid session -- answer two different ways depending only on whether a cookie
 * header happened to be present: 307 when the proxy caught it, 401/404 when the
 * handler did. A media-specific answer is a reasonable thing to want, but it
 * has to change the proxy too, in one deliberate step.
 *
 * **`next/image` cannot optimise this URL**, and that is inherent rather than a
 * bug to chase: `/_next/image?url=/media/avatars/<id>` answers 400 for
 * *everyone*, the owner included, because the optimizer refetches the URL
 * server-side and that internal request carries no session cookie. Render
 * avatars with the plain `<img>` that `<AvatarImage>` produces (it already
 * does); they are 256x256 WebP, so there is nothing to optimise anyway.
 *
 * No `connection()` call: `requireUser()` awaits `headers()` before anything
 * touches SQLite, which opts this route out of prerendering just as well --
 * the same exemption `src/app/(app)/layout.tsx` relies on.
 *
 * **`params` is a promise in Next 16** -- the synchronous object older snippets
 * destructure is gone. The context is typed structurally rather than with the
 * global `RouteContext<"/media/avatars/[userId]">` helper the route docs show:
 * that helper is *generated* into `.next/types/routes.d.ts` by `next dev`,
 * `next build` or `next typegen`, and CI runs `npm run typecheck` after none of
 * them. (It gets away with `next-env.d.ts` importing the same missing file only
 * because `skipLibCheck` swallows errors inside declaration files; a `.ts` file
 * naming the type gets no such pass.) The explicit shape is what the route docs
 * give as their first example anyway, and `next build` still validates it.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ userId: string }> },
): Promise<Response> {
  // Authenticated first, and the segment is not read until afterwards, so that
  // no answer this route gives to a signed-out caller can depend on what they
  // asked for.
  const user = await requireUser();

  const { userId } = await ctx.params;
  if (userId !== user.id) return refused();

  const file = avatarFilePath(user.id);
  if (!file) return refused();

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch {
    // Overwhelmingly ENOENT: this user has never uploaded one. Anything else
    // (EACCES on a mis-owned volume) is an operator problem that a 404 states
    // no worse than a 500 would, and a 500 here would differ from the miss.
    return refused();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      // A constant, not sniffed and not derived from the upload: everything in
      // this directory came out of processAvatar(), which emits WebP only.
      "Content-Type": AVATAR_CONTENT_TYPE,
      "Content-Length": String(bytes.byteLength),
      // Belt and braces behind that constant -- if a file ever did reach the
      // directory without being re-encoded, this stops a browser from
      // deciding for itself that it is HTML.
      "X-Content-Type-Options": "nosniff",
      // Caching is deliberately declined, and here is why. `private` because
      // the response is per-user and behind a session: a shared cache that
      // kept it could hand one user's face to the next. `no-store` on top
      // because this URL carries no version token, so any freshness lifetime
      // at all would leave a user staring at their old avatar after
      // re-uploading, with no way to bust it. The cost is small and local: a
      // 256x256 WebP off the same disk the database is on. If a later phase
      // wants real caching, give the URL a content hash first and then this
      // can become `private, max-age=31536000, immutable`.
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * The one refusal. Empty-bodied and identical for every reason, so the response
 * carries no information about which reason applied.
 */
function refused(): Response {
  return new Response(null, { status: 404 });
}
