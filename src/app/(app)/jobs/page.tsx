import { cache, Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { Pagination } from "@/components/crud/pagination";
import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { JobsTableBody, JobsTableShell } from "@/components/jobs/jobs-table";
import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listJobs } from "@/lib/jobs/queue";

// Body and Pagination below both read `{ jobs, total }` for the same
// `(params, userId)` pair -- `cache()` (per request, like `getSettings()`
// elsewhere) turns that into one query rather than two.
const cachedListJobs = cache((params: ListParams, userId: string | undefined) =>
  listJobs({
    kind: params.filters.kind,
    status: params.filters.status,
    userId,
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  }),
);

async function JobsBody({
  params,
  userId,
  admin,
}: {
  params: ListParams;
  userId: string | undefined;
  admin: boolean;
}) {
  const { jobs } = cachedListJobs(params, userId);
  return <JobsTableBody rows={jobs} showOwner={admin} />;
}

async function JobsPagination({
  params,
  userId,
}: {
  params: ListParams;
  userId: string | undefined;
}) {
  const { total } = cachedListJobs(params, userId);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const userId = admin ? undefined : user.id;

  const params = parseListParams(await searchParams);
  const t = await getTranslations("jobs");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <SearchFilterBar placeholder={t("filterKind")} />

      {/* See src/app/(app)/tags/page.tsx for why the shell takes `resetKey`
          rather than a `key`, and why only the inner Suspense is keyed. */}
      <JobsTableShell resetKey={JSON.stringify(params)} showOwner={admin}>
        <Suspense
          key={JSON.stringify(params)}
          fallback={<TableRowsSkeleton columns={admin ? 6 : 5} />}
        >
          <JobsBody params={params} userId={userId} admin={admin} />
        </Suspense>
      </JobsTableShell>

      <Suspense key={JSON.stringify(params)} fallback={null}>
        <JobsPagination params={params} userId={userId} />
      </Suspense>
    </div>
  );
}
