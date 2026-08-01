"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTable, type Column } from "@/components/crud/data-table";
import { Pagination } from "@/components/crud/pagination";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/user-avatar";
import { useUserImpact } from "@/components/users/use-user-impact";
import { isAdminRole } from "@/lib/auth/roles";
import { displayNameFor } from "@/lib/avatar";
import { deleteUsers } from "@/lib/users/actions";
import { attempt } from "@/lib/users/result";

/**
 * The columns this table renders, spelled out here rather than imported from
 * `@/lib/users/queries`.
 *
 * `UserListRow` is already the right projection, and the list page passes one
 * straight in -- structural typing checks the two against each other, so a
 * column disappearing from the query is a `npm run typecheck` failure at the
 * page.
 *
 * This predates the fix wave that added a `queries`-module pattern to
 * `eslint.config.mjs`'s restricted-imports group with `allowTypeImports` on.
 * `import type { UserListRow } from "@/lib/users/queries"` is now both legal
 * -- a type import is erased before bundling, so it cannot drag
 * `better-sqlite3` into the browser -- and the form that `eslint.config.mjs`'s
 * own comment names as preferred, calling a structural re-declaration like
 * this one "the fallback, not the model to copy" for a phase writing a new
 * list table. Left structural here rather than converted: nothing about this
 * table depends on which form is used, and a column disappearing from the
 * query still fails `npm run typecheck` at this file either way.
 */
export type UserRow = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  image: string | null;
  role: string;
  createdAt: Date;
};

/**
 * The users list: the table, the selection it owns, and the one bulk action.
 *
 * **The selection lives here and nowhere else.** `<DataTable>` is controlled,
 * `<BulkActionBar>` renders from the count, and the confirmation copy is built
 * from the same array -- one owner, so the three cannot disagree about what is
 * about to be deleted. It deliberately does **not** survive a page change: the
 * ids do (`toggleAll` only ever touches the current page's), but this component
 * remounts on navigation and the operator starts clean, which is the safer of
 * the two defaults for a destructive action.
 *
 * `page`/`pageSize`/`total` are props rather than another `useListParams()`
 * read, because `total` can only come from the server anyway and the three
 * belong to one answer -- reading two of them from the URL and one from a prop
 * is how a range label ends up describing a different query than the rows.
 */
export function UsersTable({
  rows,
  page,
  pageSize,
  total,
}: {
  rows: UserRow[];
  page: number;
  pageSize: number;
  total: number;
}) {
  const t = useTranslations("users");
  const format = useFormatter();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const impact = useUserImpact(selected);

  const columns: Column<UserRow>[] = [
    {
      key: "avatar",
      header: t("columns.avatar"),
      // Five named fields, not the row: `<UserAvatar>` reads exactly these, and
      // it renders other people's records in this administrator's browser --
      // which is also why `safeAvatarSrc()` inside it, rather than `user.image`
      // here, decides whether the stored URL is served at all.
      cell: (row) => (
        <UserAvatar
          user={{
            id: row.id,
            firstName: row.firstName,
            lastName: row.lastName,
            email: row.email,
            image: row.image,
          }}
          size="sm"
        />
      ),
    },
    {
      key: "name",
      header: t("columns.name"),
      sortable: true,
      // The link to the record, on the column an operator reaches for. Editing
      // is a real route (`/users/[id]`), so this is an ordinary navigation --
      // no dialog state, and the breadcrumb comes for free.
      cell: (row) => (
        <Link href={`/users/${row.id}`} className="font-medium hover:underline">
          {displayNameFor(row)}
        </Link>
      ),
    },
    { key: "email", header: t("columns.email"), sortable: true, cell: (row) => row.email },
    {
      key: "role",
      header: t("columns.role"),
      sortable: true,
      // `isAdminRole()`, never `role === "admin"`: the column holds a
      // comma-separated list, and "user,admin" is an administrator to every
      // Better Auth endpoint. A badge that disagreed would tell this page's
      // operator the opposite of what the library enforces.
      cell: (row) =>
        isAdminRole(row.role) ? (
          <Badge>{t("roleAdmin")}</Badge>
        ) : (
          <Badge variant="outline">{t("roleStandard")}</Badge>
        ),
    },
    {
      key: "createdAt",
      header: t("columns.created"),
      sortable: true,
      // next-intl's formatter, not toLocaleDateString(): the locale is the
      // one this request resolved and the time zone is the one configured in
      // `src/i18n/request.ts`, so the server and the browser print the same day.
      cell: (row) => format.dateTime(row.createdAt, { dateStyle: "medium" }),
    },
  ];

  /**
   * Delete everything selected.
   *
   * Returns `true` only on success, which is what closes `<ConfirmDestructive>`
   * -- a failure has to leave the dialog standing over the list it refers to.
   *
   * `attempt()`, never a bare await: a rejected action inside the dialog's
   * transition would otherwise escalate to the (app) error boundary and replace
   * the whole page.
   */
  async function removeSelected(): Promise<boolean> {
    const result = await attempt(() => deleteUsers(selected));

    if (!result.ok) {
      // None of the keys `deleteUsers()` (or `attempt()`) can return takes an
      // ICU argument -- noneSelected, deleteSelf, lastAdmin, sessionEnded,
      // requestFailed. A key that needs one has to be interpolated here.
      toast.error(result.errorKey ? t(result.errorKey) : t("deleteFailed"));
      return false;
    }

    setSelected([]);
    // The action revalidated `/users`; this is what makes the router refetch it.
    router.refresh();

    /**
     * **A selection of ids that no longer exist deletes nothing, and the toast
     * must not claim otherwise.** `deleteUsers()` reports `{ ok: true,
     * deleted: 0 }` for that case -- the call succeeded, so the dialog closes,
     * but "3 users deleted" would be a straight fabrication.
     */
    if (result.deleted === 0) toast.info(t("deletedNone"));
    else toast.success(t("deleted", { count: result.deleted }));
    return true;
  }

  const count = selected.length;
  const actions: BulkAction[] = [
    {
      key: "delete",
      label: t("bulkDelete"),
      destructive: true,
      confirm: {
        title: t("bulkDeleteTitle", { count }),
        // The counts if they have arrived, an honest description of the cascade
        // if they have not -- never zeros standing in for "not yet known".
        description: impact
          ? t("bulkDeleteDescription", {
              count,
              feeds: impact.feeds,
              tags: impact.tags,
              articles: impact.articles,
            })
          : t("bulkDeleteDescriptionPending", { count }),
        confirmLabel: t("deleteConfirm"),
      },
      run: removeSelected,
    },
  ];

  return (
    <div className="space-y-4">
      <BulkActionBar count={count} actions={actions} onClear={() => setSelected([])} />
      <DataTable
        rows={rows}
        columns={columns}
        rowId={(row) => row.id}
        selected={selected}
        onSelectedChange={setSelected}
      />
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
