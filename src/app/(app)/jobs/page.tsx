import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableSkeleton } from "@/components/data-skeleton";
import { JobsTable } from "@/components/jobs/jobs-table";
import { isAdminRole } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listJobs } from "@/lib/jobs/queue";

async function JobsData({ params, userId }: { params: ListParams; userId?: string }) {
  const { jobs, total } = listJobs({
    kind: params.filters.kind,
    status: params.filters.status,
    userId,
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  });

  return <JobsTable rows={jobs} page={params.page} pageSize={params.pageSize} total={total} />;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const admin = isAdminRole(user.role);

  const params = parseListParams(await searchParams);
  const t = await getTranslations("jobs");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <SearchFilterBar placeholder={t("filterKind")} />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton columns={6} />}>
        <JobsData params={params} userId={admin ? undefined : user.id} />
      </Suspense>
    </div>
  );
}
