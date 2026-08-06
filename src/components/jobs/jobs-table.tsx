"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTableBody, DataTableHeader, type Column } from "@/components/crud/data-table";
import { ListSelectionProvider, useListSelection } from "@/components/crud/list-selection";
import { Pagination } from "@/components/crud/pagination";
import { Table } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useTrackBackgroundTask } from "@/components/jobs/active-runs-context";
import { displayNameFor } from "@/lib/avatar";
import { cancelJobs, deleteJobs } from "@/lib/jobs/actions";
import type { JobWithOwner } from "@/lib/jobs/queue";
import { attempt } from "@/lib/jobs/result";
import { waitForJobsTerminal } from "@/lib/jobs/wait-for-jobs-terminal";

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge
          variant="outline"
          className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200"
        >
          {status}
        </Badge>
      );
    case "running":
      return (
        <Badge
          variant="outline"
          className="bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border-blue-200"
        >
          {status}
        </Badge>
      );
    case "cancelling":
      return (
        <Badge
          variant="outline"
          className="bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border-amber-200"
        >
          {status}
        </Badge>
      );
    case "cancelled":
      return (
        <Badge
          variant="outline"
          className="bg-slate-50 text-slate-600 dark:bg-slate-900 dark:text-slate-400 border-slate-200"
        >
          {status}
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">{status}</Badge>;
    case "pending":
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

/**
 * Shared between the header (rendered immediately) and the body (rendered
 * once rows arrive). `showOwner` is only known to the page (an admin sees
 * every job's owner, a non-admin does not), so both the shell and the body
 * take it as a prop and build the identical column set from it.
 */
function useJobsColumns(showOwner: boolean): Column<JobWithOwner>[] {
  const t = useTranslations("jobs");

  return [
    {
      key: "kind",
      header: t("kind"),
      cell: (job) => (
        <Link href={`/jobs/${job.id}`} className="font-mono text-sm hover:underline">
          {job.kind}
        </Link>
      ),
    },
    ...(showOwner
      ? [
          {
            key: "owner",
            header: t("owner"),
            cell: (job: JobWithOwner) =>
              job.ownerEmail ? (
                <span className="text-sm">
                  {displayNameFor({
                    firstName: job.ownerFirstName ?? "",
                    lastName: job.ownerLastName ?? "",
                    email: job.ownerEmail,
                  })}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">{t("systemOwner")}</span>
              ),
          },
        ]
      : []),
    {
      key: "status",
      header: t("status"),
      cell: (job) => <StatusBadge status={job.status} />,
    },
    {
      key: "attempts",
      header: t("attempts"),
      cell: (job) => (
        <span>
          {job.attempts} / {job.maxAttempts}
        </span>
      ),
    },
    {
      key: "progress",
      header: t("progress"),
      cell: (job) => <span>{job.progress}%</span>,
    },
    {
      key: "error",
      header: t("error"),
      cell: (job) => (
        <span className="text-xs text-destructive truncate max-w-xs block" title={job.error}>
          {job.error || "—"}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: t("createdAt"),
      cell: (job) => (
        <span className="text-xs text-muted-foreground">
          {new Date(job.createdAt).toLocaleString()}
        </span>
      ),
    },
  ];
}

/**
 * Chrome: the bulk action bar and the table's header row, with no dependency
 * on `rows` -- a page renders this outside its `<Suspense>` boundary so it
 * never disappears while the rows themselves are loading. `children` is the
 * `<Suspense>`-wrapped body (a `<JobsTableBody>` once resolved, a
 * `<TableRowsSkeleton>` fallback until then).
 *
 * **Never give this a `key` that changes with the list's params** -- pass
 * `resetKey` instead. See the doc comment on `<ListSelectionProvider>` for why.
 */
export function JobsTableShell({
  children,
  showOwner = false,
  resetKey,
}: {
  children: React.ReactNode;
  showOwner?: boolean;
  resetKey?: string;
}) {
  return (
    <ListSelectionProvider resetKey={resetKey}>
      <JobsTableChrome showOwner={showOwner}>{children}</JobsTableChrome>
    </ListSelectionProvider>
  );
}

function JobsTableChrome({
  children,
  showOwner,
}: {
  children: React.ReactNode;
  showOwner: boolean;
}) {
  const t = useTranslations("jobs");
  const router = useRouter();
  const trackBackgroundTask = useTrackBackgroundTask();
  const { selected, onSelectedChange, pageIds } = useListSelection();
  const columns = useJobsColumns(showOwner);

  async function cancelSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => cancelJobs(selected.map(Number)));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return false;
    }

    onSelectedChange([]);
    router.refresh();
    if (result.affected === 0) toast.info(t("cancelNone"));
    else toast.success(t("cancelRequested", { count: result.affected }));
    return true;
  }

  /**
   * The follow-up for jobs `deleteJobs()` could only ask to stop (`stopping`)
   * -- run detached from `removeSelected()`'s own promise, tracked via
   * `trackBackgroundTask()` so the header's spinner shows it the same way it
   * shows a reload or aggregation run, rather than the confirmation dialog
   * staying open for as long as the slowest job takes to actually stop.
   */
  async function finishStoppingDeletion(
    stoppingIds: number[],
    alreadyDeleted: number,
  ): Promise<void> {
    const stopped = await waitForJobsTerminal(stoppingIds);
    if (!stopped) {
      toast.error(t("requestFailed"));
      return;
    }
    const second = await attempt(() => deleteJobs(stoppingIds));
    if (!second.ok) {
      toast.error(t(second.errorKey));
      return;
    }
    router.refresh();
    toast.success(t("deleted", { count: alreadyDeleted + second.deleted }));
  }

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteJobs(selected.map(Number)));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return false;
    }

    onSelectedChange([]);
    router.refresh();

    if (result.stopping.length > 0) {
      trackBackgroundTask(finishStoppingDeletion(result.stopping, result.deleted));
    } else {
      toast.success(t("deleted", { count: result.deleted }));
    }
    return true;
  }

  const count = selected.length;
  const actions: BulkAction[] = [
    {
      key: "cancel",
      label: t("bulkCancel"),
      destructive: false,
      run: cancelSelected,
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

/** The data-dependent half: must render inside a `<JobsTableShell>` with the same `showOwner`. */
export function JobsTableBody({
  rows,
  showOwner = false,
}: {
  rows: JobWithOwner[];
  showOwner?: boolean;
}) {
  const columns = useJobsColumns(showOwner);
  const { selected, onSelectedChange, setPageIds } = useListSelection();
  const rowId = (job: JobWithOwner) => String(job.id);

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
export function JobsTable({
  rows,
  page,
  pageSize,
  total,
  showOwner = false,
}: {
  rows: JobWithOwner[];
  page: number;
  pageSize: number;
  total: number;
  /** Only an admin sees jobs across every user, so only an admin needs the column that says whose. */
  showOwner?: boolean;
}) {
  return (
    <div className="space-y-4">
      <JobsTableShell showOwner={showOwner}>
        <JobsTableBody rows={rows} showOwner={showOwner} />
      </JobsTableShell>
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
