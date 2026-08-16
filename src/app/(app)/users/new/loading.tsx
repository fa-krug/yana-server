import { getTranslations } from "next-intl/server";

import { UserForm } from "@/components/users/user-form";

/**
 * This route's own fallback -- shown by Next while the RSC payload for a
 * **client-side soft navigation** into `/users/new` (e.g. clicking "Add user"
 * from the users list) is still in flight over the network. `NewUserPage` has
 * no data query of its own -- `requireAdmin()` and `getTranslations()` are its
 * only awaits -- but that per-request-cached read is still enough to suspend
 * the page function as one unit during a soft navigation, and without this
 * file the route fell through to `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` -- a table shape on a page that is a four-field form.
 *
 * It renders the **real form chassis in its pending state**: `<UserForm
 * pending />`, the same component `NewUserPage` itself renders once the
 * navigation lands. The email, first name, last name, role picker and
 * password fields are all on screen, disabled, from the very first frame.
 */
export default async function Loading() {
  const t = await getTranslations("users");

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <UserForm pending />
    </div>
  );
}
