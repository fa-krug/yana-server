"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { buttonVariants } from "@/components/ui/button";
import { ROLE_FILTER_ADMIN, ROLE_FILTER_STANDARD } from "@/lib/users/fields";

/**
 * The `/users` header (the New user link -- no title: the breadcrumb already
 * names the page) and the search/role-filter bar beneath it.
 *
 * A Client Component reading `useTranslations("users")` -- a **literal**
 * namespace, so every key below stays compiler-checked against the catalogs --
 * rather than an async Server Component awaiting `getTranslations()`. The
 * instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`)
 * needs `UsersPage`'s body to await nothing, and that awaited translation was
 * one of the two things standing in the way; the other was the page's own
 * `requireAdmin()` gate, which moved into `listUsers()`/`getUser()`
 * (`src/lib/users/queries.ts`) where the rows are actually read.
 *
 * Nothing here is admin-only *information*: the title, the New link and the
 * filter options are static text, and the plan this migration implements
 * accepted that `/users` no longer hides its existence from a non-admin. What
 * a non-admin still cannot get is any **row** -- `listUsers()` answers 404 to
 * them, so the table body below this stays empty.
 *
 * `ROLE_FILTER_*` come from `@/lib/users/fields`, which imports only
 * `@/lib/auth/roles`. Importing them from `@/lib/users/queries` would pull
 * `better-sqlite3` into the browser bundle -- the split that module's doc
 * comment exists for.
 *
 * There used to be a hand-mirrored copy of all of this in `loading.tsx`, which
 * is deleted now that `UsersPage` cannot suspend and the fallback is
 * unreachable -- so the two can no longer drift.
 */
export function UsersChrome() {
  const t = useTranslations("users");

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
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
              // `""`, not "all": an empty value clears the filter, so "All
              // roles" produces a URL with no `role` at all rather than
              // `?role=all` that `listUsers()` would have to know about.
              { value: "", label: t("allRoles") },
              { value: ROLE_FILTER_ADMIN, label: t("roleAdmin") },
              { value: ROLE_FILTER_STANDARD, label: t("roleStandard") },
            ],
          },
        ]}
      />
    </>
  );
}
