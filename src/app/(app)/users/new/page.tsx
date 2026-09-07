import { UserForm } from "@/components/users/user-form";
import { requireAdmin } from "@/lib/auth/session";

/**
 * Creating a user is a real route, not a dialog on the list.
 *
 * That is what gives it a URL, a Back button and a breadcrumb with no wiring at
 * all: `breadcrumbsFor()` derives them from the path, and `ACTION_LABELS`
 * already maps the `new` segment to `common.new`.
 */
export default async function NewUserPage() {
  /**
   * The gate, first -- and there is no `<Suspense>` here for it to be inside
   * of. It also opts the route out of prerendering: `requireAdmin()` awaits
   * `headers()` before anything can reach SQLite, so no `connection()` call is
   * needed (see the `connection()` bullet in CLAUDE.md).
   */
  await requireAdmin();

  return (
    <div className="max-w-2xl space-y-6">
      {/* No data region, so no Suspense boundary: the form starts empty. */}
      <UserForm />
    </div>
  );
}
