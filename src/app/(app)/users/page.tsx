import Link from "next/link";
import { cache, Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { Pagination, PaginationPlaceholder } from "@/components/crud/pagination";
import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { buttonVariants } from "@/components/ui/button";
import { UsersTableBody, UsersTableShell } from "@/components/users/users-table";
import { requireAdmin } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { ROLE_FILTER_ADMIN, ROLE_FILTER_STANDARD } from "@/lib/users/fields";
import { listUsers } from "@/lib/users/queries";

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListUsers = cache(listUsers);

/**
 * The data region: async, inside the `<Suspense>` below, with the (app) group's
 * `error.tsx` above it -- the streaming pattern, both halves. Once the shell has
 * flushed, the response is already a 200; a throw with no boundary above it
 * would truncate the stream rather than produce an error page.
 *
 * `listUsers()` calls `requireAdmin()` again, which is defence in depth and not
 * the gate: the page below has already passed it, *outside* this boundary,
 * which is the only place a `notFound()` can still become a real 404.
 *
 * Untested by design -- testing-library cannot render an async server
 * component. What the query returns is covered against a real database in
 * `src/lib/users/users.test.ts`, and what the table does with it in
 * `users-table.test.tsx`.
 */
async function UsersBody({ params }: { params: ListParams }) {
  const { rows } = await cachedListUsers(params);
  return <UsersTableBody rows={rows} />;
}

async function UsersPagination({ params }: { params: ListParams }) {
  const { total } = await cachedListUsers(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

export default async function UsersPage({
  searchParams,
}: {
  // Typed structurally, not with the generated `PageProps<"/users">` helper:
  // that type is written into `.next/types` by `next dev`/`build`, and CI runs
  // `npm run typecheck` after neither.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /**
   * **The gate, first and outside every `<Suspense>` boundary.** Inside one its
   * `notFound()` would arrive after the first byte and truncate the stream
   * instead of answering 404 -- and 404 rather than 403 is the point: a
   * non-admin has no business learning that this route exists.
   *
   * It is also what opts this route out of prerendering. `requireAdmin()`
   * awaits `headers()` before anything reaches SQLite, which is the same reason
   * `src/app/(app)/layout.tsx` needs no `connection()` call; see the
   * `connection()` bullet in CLAUDE.md, which lists these three routes.
   */
  await requireAdmin();

  const params = parseListParams(await searchParams);
  const t = await getTranslations("users");

  return (
    <div className="space-y-4">
      {/* Chrome, rendered synchronously -- it does not wait on the query. */}
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

      {/* See src/app/(app)/tags/page.tsx for why the shell takes `resetKey`
          rather than a `key`, and why only the inner Suspense is keyed. */}
      <UsersTableShell resetKey={JSON.stringify(params)}>
        <Suspense key={JSON.stringify(params)} fallback={<TableRowsSkeleton columns={6} />}>
          <UsersBody params={params} />
        </Suspense>
      </UsersTableShell>

      <Suspense key={JSON.stringify(params)} fallback={<PaginationPlaceholder />}>
        <UsersPagination params={params} />
      </Suspense>
    </div>
  );
}
