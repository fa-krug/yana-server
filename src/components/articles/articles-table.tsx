"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { StarIcon } from "lucide-react";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTable, type Column } from "@/components/crud/data-table";
import { Pagination } from "@/components/crud/pagination";
import { Badge } from "@/components/ui/badge";
import { deleteArticles, reloadArticles, setRead, setStarred } from "@/lib/articles/actions";
import type { ArticleListRow } from "@/lib/articles/queries";
import { useTrackRun } from "@/components/jobs/active-runs-context";
import { attempt } from "@/lib/tags/result";

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
  const t = useTranslations("articles");
  const format = useFormatter();
  const router = useRouter();
  const trackRun = useTrackRun();
  const [selected, setSelected] = useState<number[]>([]);

  const columns: Column<ArticleListRow>[] = [
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

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteArticles(selected));

    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    setSelected([]);
    router.refresh();

    if (result.deleted === 0) toast.info(t("deletedNone"));
    else toast.success(t("deleted", { count: result.deleted }));
    return true;
  }

  async function handleSetRead(read: boolean): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => setRead(selected, read));

    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    setSelected([]);
    router.refresh();
    toast.success(t("updated", { count: result.updated }));
    return true;
  }

  async function handleSetStarred(starred: boolean): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => setStarred(selected, starred));

    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    setSelected([]);
    router.refresh();
    toast.success(t("updated", { count: result.updated }));
    return true;
  }

  async function handleReload(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => reloadArticles(selected));
    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    trackRun(result.runId, {
      completed: (n) => t("reloadCompleted", { count: n }),
      partial: (ok, failed) => t("reloadCompletedWithFailures", { completed: ok, failed }),
      fallback: t("saveFailed"),
    });
    setSelected([]);
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
      <BulkActionBar count={count} actions={actions} onClear={() => setSelected([])} />
      <DataTable
        rows={rows}
        columns={columns}
        rowId={(row) => String(row.id)}
        selected={selected.map(String)}
        onSelectedChange={(ids) => setSelected(ids.map(Number))}
      />
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
