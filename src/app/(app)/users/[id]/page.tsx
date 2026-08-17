import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { Separator } from "@/components/ui/separator";
import { DeleteUserSection } from "@/components/users/delete-user-section";
import { UserForm } from "@/components/users/user-form";
import { displayNameFor } from "@/lib/avatar";
import { getUser } from "@/lib/users/queries";

export default async function EditUserPage({
  params,
}: {
  // Structural, not the generated `PageProps<"/users/[id]">`: that type is
  // written into `.next/types` by `next dev`/`build`, and CI typechecks after
  // neither.
  params: Promise<{ id: string }>;
}) {
  /**
   * **No `requireAdmin()` here any more -- `getUser()` carries it.** The gate
   * moved into `src/lib/users/queries.ts` (see its doc comment) so that this
   * route's authorization does not depend on a page body remembering to call
   * it; a non-admin gets 404 from inside the read below, before a single
   * column of somebody else's account is projected. The record read itself is
   * unchanged and still happens here, at the top, which is what keeps
   * `notFound()` able to produce a real 404 -- and what still opts this route
   * out of prerendering, since `getUser()` awaits `headers()` before anything
   * reaches SQLite (see the `connection()` bullet in CLAUDE.md).
   */
  const { id } = await params;

  /**
   * **Read here rather than inside a `<Suspense>` boundary, and that is the
   * whole reason this page has none.** The 404 for a user who does not exist
   * depends on this row, and `notFound()` can only produce a real 404 while the
   * response status is still open -- inside a boundary, after the shell has
   * flushed, it would truncate a 200 instead. So the page awaits one indexed
   * primary-key lookup before it renders anything, and `src/app/(app)/loading.tsx`
   * is the fallback the route already has for exactly that.
   *
   * `getUser()` awaits `headers()` (through its own `requireAdmin()`) before
   * anything reaches SQLite, so the route is out of prerendering by the end of
   * this line -- no `connection()` call is needed (see the `connection()`
   * bullet in CLAUDE.md).
   */
  const user = await getUser(id);
  if (!user) notFound();

  const t = await getTranslations("users");

  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumbTitle title={displayNameFor(user)} />
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>

      {/* The columns each component renders, never the `User` row: it also
          carries `emailVerified`, the three ban columns and the timestamps, and
          both of these are client components -- everything passed is serialized
          into this page's RSC payload. */}
      <UserForm
        user={{
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        }}
      />

      <Separator />

      <DeleteUserSection
        user={{
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
        }}
      />
    </div>
  );
}
