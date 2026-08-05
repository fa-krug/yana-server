"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect } from "react";
import { toast } from "sonner";
import { StarIcon } from "lucide-react";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTableBody, DataTableHeader, type Column } from "@/components/crud/data-table";
import { ListSelectionProvider, useListSelection } from "@/components/crud/list-selection";
import { Pagination } from "@/components/crud/pagination";
import { Table } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { deleteArticles, reloadArticles, setRead, setStarred } from "@/lib/articles/actions";
import type { ArticleListRow } from "@/lib/articles/queries";
import { useTrackRun } from "@/components/jobs/active-runs-context";
import { attempt } from "@/lib/tags/result";

/** Shared between the header (rendered immediately) and the body (rendered once rows arrive). */
function useArticlesColumns(): Column<ArticleListRow>[] {
  const t = useTranslations("articles");
  const format = useFormatter();

  return [
    {
      key: "status",
      header: "",
      sortable: false,
      cell: (row) => (
        <div className="flex items-center space-x-1.5">
          {row.starred && (
            <StarIcon className="size-4 fill-amber-400 text-amber-500" aria-label="Starred" />
          )}
          {row.read ? (
            <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
              {t("columns.read")}
            </Badge>
          ) : (
            <Badge variant="default" className="text-xs font-medium">
              {t("columns.unread")}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "name",
      header: t("columns.title"),
      sortable: true,
      cell: (row) => (
        <Link href={`/articles/${row.id}`} className="font-medium hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      key: "feed",
      header: t("columns.feed"),
      sortable: true,
      // Lower priority than title/status/date on a phone -- hidden rather than
      // forcing the table into a horizontal scroll for every row just to show
      // the source feed.
      className: "hidden sm:table-cell",
      cell: (row) => (
        <Link href={`/feeds/${row.feedId}`} className="text-muted-foreground hover:underline">
          {row.feedName}
        </Link>
      ),
    },
    {
      key: "date",
      header: t("columns.date"),
      sortable: true,
      cell: (row) => (
        <span className="text-muted-foreground">
          {format.dateTime(row.date, { dateStyle: "full" })}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: t("columns.added"),
      sortable: true,
      // The least essential of the two dates -- hidden until there is room
      // for both, same reasoning as the "feed" column above.
      className: "hidden lg:table-cell",
      // next-intl's formatter, not toLocaleDateString(): the locale is the one
      // this request resolved and the time zone is the one configured in
      // src/i18n/request.ts, so the server and the browser print the same day
      // -- a raw toLocaleDateString() here is what caused a hydration mismatch
      // whenever the two disagreed (e.g. server "7.6.2026" vs. browser "6/7/2026").
      cell: (row) => (
        <span className="text-muted-foreground">
          {format.dateTime(row.createdAt, { dateStyle: "full" })}
        </span>
      ),
    },
  ];
}

/**
 * Chrome: the bulk action bar and the table's header row, with no dependency on
 * `rows` -- a page renders this outside its `<Suspense>` boundary so it never
 * disappears while the rows themselves are loading. `children` is the
 * `<Suspense>`-wrapped body (a `<ArticlesTableBody>` once resolved, a
 * `<TableRowsSkeleton>` fallback until then).
 *
 * **Never give this a `key` that changes with the list's params** -- pass
 * `resetKey` instead. See the doc comment on `<ListSelectionProvider>` for why.
 */
export function ArticlesTableShell({
  children,
  resetKey,
}: {
  children: React.ReactNode;
  resetKey?: string;
}) {
  return (
    <ListSelectionProvider resetKey={resetKey}>
      <ArticlesTableChrome>{children}</ArticlesTableChrome>
    </ListSelectionProvider>
  );
}

function ArticlesTableChrome({ children }: { children: React.ReactNode }) {
  const t = useTranslations("articles");
  const router = useRouter();
  const trackRun = useTrackRun();
  const { selected, onSelectedChange, pageIds } = useListSelection();
  const columns = useArticlesColumns();

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteArticles(selected.map(Number)));

    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    onSelectedChange([]);
    router.refresh();

    if (result.deleted === 0) toast.info(t("deletedNone"));
    else toast.success(t("deleted", { count: result.deleted }));
    return true;
  }

  async function handleSetRead(read: boolean): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => setRead(selected.map(Number), read));

    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    onSelectedChange([]);
    router.refresh();
    toast.success(t("updated", { count: result.updated }));
    return true;
  }

  async function handleSetStarred(starred: boolean): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => setStarred(selected.map(Number), starred));

    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    onSelectedChange([]);
    router.refresh();
    toast.success(t("updated", { count: result.updated }));
    return true;
  }

  async function handleReload(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => reloadArticles(selected.map(Number)));
    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    trackRun(result.runId, {
      completed: (n) => t("reloadCompleted", { count: n }),
      partial: (ok, failed) => t("reloadCompletedWithFailures", { completed: ok, failed }),
      fallback: t("saveFailed"),
    });
    onSelectedChange([]);
    return true;
  }

  const count = selected.length;
  const actions: BulkAction[] = [
    {
      key: "mark-read",
      label: t("bulkMarkRead"),
      destructive: false,
      run: () => handleSetRead(true),
    },
    {
      key: "mark-unread",
      label: t("bulkMarkUnread"),
      destructive: false,
      run: () => handleSetRead(false),
    },
    {
      key: "star",
      label: t("bulkStar"),
      destructive: false,
      run: () => handleSetStarred(true),
    },
    {
      key: "unstar",
      label: t("bulkUnstar"),
      destructive: false,
      run: () => handleSetStarred(false),
    },
    {
      key: "reload",
      label: t("bulkReload"),
      destructive: false,
      run: handleReload,
    },
    {
      key: "delete",
      label: t("bulkDelete"),
      destructive: true,
      confirm: {
        title: t("bulkDeleteTitle", { count }),
        description: t("bulkDeleteDescription", { count }),
        confirmLabel: t("deleteConfirm"),
      },
      run: removeSelected,
    },
  ];

  return (
    <div className="space-y-4">
      <BulkActionBar count={count} actions={actions} onClear={() => onSelectedChange([])} />
      <Table>
        <DataTableHeader
          columns={columns}
          pageIds={pageIds}
          selected={selected}
          onSelectedChange={onSelectedChange}
        />
        {children}
      </Table>
    </div>
  );
}

/** The data-dependent half: must render inside a `<ArticlesTableShell>`. */
export function ArticlesTableBody({ rows }: { rows: ArticleListRow[] }) {
  const columns = useArticlesColumns();
  const { selected, onSelectedChange, setPageIds } = useListSelection();
  const rowId = (row: ArticleListRow) => String(row.id);

  useEffect(() => {
    setPageIds(rows.map(rowId));
  }, [rows, setPageIds]);

  return (
    <DataTableBody
      rows={rows}
      columns={columns}
      rowId={rowId}
      selected={selected}
      onSelectedChange={onSelectedChange}
    />
  );
}

/**
 * The all-at-once form: everything above, composed for a caller with no
 * reason to split header from body across a `<Suspense>` boundary.
 */
export function ArticlesTable({
  rows,
  page,
  pageSize,
  total,
}: {
  rows: ArticleListRow[];
  page: number;
  pageSize: number;
  total: number;
}) {
  return (
    <div className="space-y-4">
      <ArticlesTableShell>
        <ArticlesTableBody rows={rows} />
      </ArticlesTableShell>
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
