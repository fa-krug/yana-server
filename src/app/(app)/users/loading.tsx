import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { buttonVariants } from "@/components/ui/button";
import { UsersTableShell } from "@/components/users/users-table";
import { ROLE_FILTER_ADMIN, ROLE_FILTER_STANDARD } from "@/lib/users/fields";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. Without this file, an
 * initial navigation to `/users` shows that unrelated fallback for however
 * long `UsersPage` takes to resolve -- title-less, header-less, nothing like
 * the table it precedes -- because the whole async page function (including
 * its synchronous chrome, and its `requireAdmin()` gate) suspends as one unit
 * until it returns.
 *
 * This mirrors `UsersPage`'s real chrome: the same title, the same role
 * filter options, the same `<UsersTableShell>` (bulk-action bar + real header
 * row, no dependency on `rows`), with `<TableRowsSkeleton>` standing in for
 * the body it wraps in a `<Suspense>` there. The filter options are static
 * values here since they need no query.
 */
export default async function Loading() {
  const t = await getTranslations("users");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Link href="/users/new" className={buttonVariants()}>
          {t("new")}
        </Link>
      </div>

      <SearchFilterBar
        placeholder={t("searchPlaceholder")}
        filters={[
          {
            key: "role",
            label: t("roleFilter"),
            options: [
              { value: "", label: t("allRoles") },
              { value: ROLE_FILTER_ADMIN, label: t("roleAdmin") },
              { value: ROLE_FILTER_STANDARD, label: t("roleStandard") },
            ],
          },
        ]}
      />

      <UsersTableShell>
        <TableRowsSkeleton columns={6} />
      </UsersTableShell>
    </div>
  );
}
