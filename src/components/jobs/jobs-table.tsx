"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/crud/data-table";
import { Pagination } from "@/components/crud/pagination";
import { Badge } from "@/components/ui/badge";
import { displayNameFor } from "@/lib/avatar";
import type { JobWithOwner } from "@/lib/jobs/queue";

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
    case "failed":
      return <Badge variant="destructive">{status}</Badge>;
    case "pending":
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

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
  const t = useTranslations("jobs");
  const [selected, setSelected] = useState<string[]>([]);

  const columns: Column<JobWithOwner>[] = [
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

  return (
    <div className="space-y-4">
      <DataTable
        rows={rows}
        columns={columns}
        rowId={(job) => String(job.id)}
        selected={selected}
        onSelectedChange={setSelected}
      />
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
