"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { toast } from "sonner";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTableBody, DataTableHeader, type Column } from "@/components/crud/data-table";
import { ListSelectionProvider, useListSelection } from "@/components/crud/list-selection";
import { Pagination } from "@/components/crud/pagination";
import { Table } from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TagBadge } from "@/components/tags/tag-badge";
import { CheckIcon, XIcon } from "lucide-react";
import { attempt } from "@/lib/tags/result";
import { deleteFeeds, refreshLogos, updateFeedsBulk } from "@/lib/feeds/actions";
import { useTrackRun } from "@/components/jobs/active-runs-context";
import { AGGREGATOR_SPECS } from "@/lib/aggregators/specs";
import type { Feed, Tag } from "@/lib/db/schema";

type FeedListRow = Feed & { tags: Tag[]; articleCount: number };

/** Shared between the header (rendered immediately) and the body (rendered once rows arrive). */
function useFeedsColumns(): Column<FeedListRow>[] {
  const t = useTranslations("feeds");

  return [
    {
      key: "logo",
      header: t("columns.logo"),
      sortable: false,
      cell: (row) => (
        <Avatar size="sm">
          {row.logoImageHash ? (
            <AvatarImage src={`/api/v1/images/${row.logoImageHash}`} alt={row.name} />
          ) : null}
          <AvatarFallback>{row.name.substring(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ),
    },
    {
      key: "name",
      header: t("columns.name"),
      sortable: true,
      cell: (row) => (
        <Link href={`/feeds/${row.id}`} className="font-medium hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      key: "aggregator",
      header: t("columns.aggregator"),
      sortable: true,
      cell: (row) => {
        const spec = AGGREGATOR_SPECS[row.aggregator as keyof typeof AGGREGATOR_SPECS];
        return spec ? spec.label : row.aggregator;
      },
    },
    {
      key: "tags",
      header: t("columns.tags"),
      sortable: false,
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <TagBadge
              key={tag.id}
              name={tag.name}
              color={tag.color}
              className="text-xs font-normal px-1.5 py-0 h-5"
            />
          ))}
        </div>
      ),
    },
    {
      key: "articleCount",
      header: t("columns.articles"),
      sortable: false,
      cell: (row) => <span className="text-muted-foreground">{row.articleCount}</span>,
    },
    {
      key: "enabled",
      header: t("columns.enabled"),
      sortable: false,
      cell: (row) => (
        <div className="flex items-center">
          {row.enabled ? (
            <CheckIcon className="size-4 text-green-500" />
          ) : (
            <XIcon className="size-4 text-muted-foreground" />
          )}
        </div>
      ),
    },
  ];
}

/**
 * Chrome: the bulk action bar and the table's header row, with no dependency on
 * `rows` -- a page renders this outside its `<Suspense>` boundary so it never
 * disappears while the rows themselves are loading. `children` is the
 * `<Suspense>`-wrapped body (a `<FeedsTableBody>` once resolved, a
 * `<TableRowsSkeleton>` fallback until then).
 *
 * **Never give this a `key` that changes with the list's params** -- pass
 * `resetKey` instead. See the doc comment on `<ListSelectionProvider>` for why.
 */
export function FeedsTableShell({
  children,
  resetKey,
}: {
  children: React.ReactNode;
  resetKey?: string;
}) {
  return (
    <ListSelectionProvider resetKey={resetKey}>
      <FeedsTableChrome>{children}</FeedsTableChrome>
    </ListSelectionProvider>
  );
}

function FeedsTableChrome({ children }: { children: React.ReactNode }) {
  const t = useTranslations("feeds");
  const router = useRouter();
  const trackRun = useTrackRun();
  const { selected, onSelectedChange, pageIds } = useListSelection();
  const columns = useFeedsColumns();

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteFeeds(selected.map(Number)));

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

  async function updateSelectedLogos(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => refreshLogos(selected.map(Number)));
    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    // Progress and the outcome toast are the floating indicator's job now
    // (`useTrackRun()`, mounted app-wide in `(app)/layout.tsx`) -- it outlives
    // this component, so the selection can clear right away instead of
    // staying around only to keep a spinner on screen.
    trackRun(result.runId, {
      completed: (n) => t("logoUpdateCompleted", { count: n }),
      partial: (ok, failed) => t("logoUpdateCompletedWithFailures", { completed: ok, failed }),
      fallback: t("saveFailed"),
    });
    onSelectedChange([]);
    return true;
  }

  async function runAggregation(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => updateFeedsBulk(selected.map(Number)));
    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    trackRun(result.runId, {
      completed: (n) => t("aggregationCompleted", { count: n }),
      partial: (ok, failed) => t("aggregationCompletedWithFailures", { completed: ok, failed }),
      fallback: t("saveFailed"),
    });
    onSelectedChange([]);
    return true;
  }

  function exportSelected(): Promise<boolean> {
    if (selected.length === 0) return Promise.resolve(false);
    const params = new URLSearchParams({ ids: selected.join(",") });
    window.location.href = `/api/feeds/export?${params.toString()}`;
    onSelectedChange([]);
    return Promise.resolve(true);
  }

  const count = selected.length;
  const actions: BulkAction[] = [
    {
      key: "update-logo",
      label: t("bulkUpdateLogo"),
      destructive: false,
      run: updateSelectedLogos,
    },
    {
      key: "run-aggregation",
      label: t("bulkRunAggregation"),
      destructive: false,
      run: runAggregation,
    },
    {
      key: "export-opml",
      label: t("bulkExportOpml"),
      destructive: false,
      run: exportSelected,
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

/** The data-dependent half: must render inside a `<FeedsTableShell>`. */
export function FeedsTableBody({ rows }: { rows: FeedListRow[] }) {
  const columns = useFeedsColumns();
  const { selected, onSelectedChange, setPageIds } = useListSelection();
  const rowId = (row: FeedListRow) => String(row.id);

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
export function FeedsTable({
  rows,
  page,
  pageSize,
  total,
}: {
  rows: FeedListRow[];
  page: number;
  pageSize: number;
  total: number;
}) {
  return (
    <div className="space-y-4">
      <FeedsTableShell>
        <FeedsTableBody rows={rows} />
      </FeedsTableShell>
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
