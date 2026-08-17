import { connection } from "next/server";

import { EditUserSection, type UserRecord } from "@/components/users/edit-user-section";
import { getUser } from "@/lib/users/queries";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * `await getUser(id)`, which used to decide a real `notFound()` (both for a
 * nonexistent id and, via `getUser()`'s own `requireAdmin()` gate, for a
 * non-admin caller), is now a promise handed to `<EditUserSection>` and
 * consumed with `use()` there. **This route therefore no longer answers
 * 404** -- a missing id and a non-admin caller both render the same
 * not-found state once the promise resolves to `null`, rather than
 * truncating a 200 the way calling `notFound()` after the shell has flushed
 * would (see CLAUDE.md's `connection()`/detail-route rules). This was a
 * deliberate, explicitly-approved trade-off, not an oversight.
 *
 * `await getTranslations("users")` is gone too; `<EditUserSection>` reads
 * `useTranslations("users")` client-side once the user is known.
 *
 * The projection into `UserRecord` (id/email/firstName/lastName/role) still
 * happens **here**, in this `.then()`, before the promise crosses into the
 * Client Component tree -- never the whole `User` row, which also carries
 * `emailVerified`, the three ban columns and the timestamps (see
 * CLAUDE.md's "a component gets the columns it renders, never the row" and
 * the plaintext-credential-leak precedent this branch already produced once
 * from getting that wrong).
 */
export default function EditUserPage({
  params,
}: {
  // Structural, not the generated `PageProps<"/users/[id]">` -- see the
  // comment this page used to carry, and `src/app/(app)/jobs/[id]/page.tsx`,
  // for why.
  params: Promise<{ id: string }>;
}) {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage`/`AccountPage` do: `getUser()` below is never awaited by
   * this page body, so there is no other awaited Dynamic API left here to do
   * this job.
   */
  connection();

  // Not awaited: chained onto the `params` promise instead, so this page
  // body still awaits nothing.
  const userPromise: Promise<UserRecord | null> = params.then(async ({ id }) => {
    const user = await getUser(id);
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    };
  });

  return (
    <div className="max-w-2xl space-y-6">
      <EditUserSection userPromise={userPromise} />
    </div>
  );
}
