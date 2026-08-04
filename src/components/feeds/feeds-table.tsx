"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTable, type Column } from "@/components/crud/data-table";
import { Pagination } from "@/components/crud/pagination";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TagBadge } from "@/components/tags/tag-badge";
import { CheckIcon, XIcon } from "lucide-react";
import { attempt } from "@/lib/tags/result";
import { deleteFeeds, refreshLogos } from "@/lib/feeds/actions";
import { AGGREGATOR_SPECS } from "@/lib/aggregators/specs";
import type { Feed, Tag } from "@/lib/db/schema";

type FeedListRow = Feed & { tags: Tag[]; articleCount: number };

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
  const t = useTranslations("feeds");
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]);

  const columns: Column<FeedListRow>[] = [
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

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteFeeds(selected));

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

  async function updateSelectedLogos(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => refreshLogos(selected));

    if (!result.ok) {
      toast.error(t("saveFailed"));
      return false;
    }

    setSelected([]);
    toast.success(t("logosEnqueued", { count: result.enqueued }));
    return true;
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
