import { cache, Suspense } from "react";

import { Pagination, PaginationPlaceholder } from "@/components/crud/pagination";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { FeedsChrome } from "@/components/feeds/feeds-chrome";
import { FeedsTableBody, FeedsTableShell } from "@/components/feeds/feeds-table";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListFeeds = cache(listFeeds);

async function FeedsBody({ params }: { params: ListParams }) {
  const { rows } = await cachedListFeeds(params);
  return <FeedsTableBody rows={rows} />;
}

async function FeedsPagination({ params }: { params: ListParams }) {
  const { total } = await cachedListFeeds(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

export default async function FeedsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const params = parseListParams(await searchParams);

  return (
    <div className="space-y-4">
      {await FeedsChrome()}

      {/* See src/app/(app)/tags/page.tsx for why the shell takes `resetKey`
          rather than a `key`, and why only the inner Suspense is keyed. */}
      <FeedsTableShell resetKey={JSON.stringify(params)}>
        <Suspense key={JSON.stringify(params)} fallback={<TableRowsSkeleton columns={6} />}>
          <FeedsBody params={params} />
        </Suspense>
      </FeedsTableShell>

      <Suspense key={JSON.stringify(params)} fallback={<PaginationPlaceholder />}>
        <FeedsPagination params={params} />
      </Suspense>
    </div>
  );
}
