import { connection } from "next/server";
import { cache } from "react";

import { Pagination } from "@/components/crud/pagination";
import { JobsChrome } from "@/components/jobs/jobs-chrome";
import { JobsListRegion } from "@/components/jobs/jobs-list-region";
import { JobsTableBody } from "@/components/jobs/jobs-table";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listJobsForCurrentUser } from "@/lib/jobs/queries";

type SearchParamsPromise = Promise<Record<string, string | string[] | undefined>>;

// Body, Pagination and the owner-column decision below all read the same
// `{ jobs, total, showOwner }` for the same `params` object -- `cache()` (per
// request, like `getSettings()` elsewhere) turns that into one query and one
// session read rather than three.
const cachedListJobs = cache(listJobsForCurrentUser);

// Each data region receives the *same* `searchParams` promise reference and
// parses it independently; `cache()`ing the parse keyed on that reference is
// what keeps `cachedListJobs` deduping (React's `cache()` keys on argument
// identity, not deep equality). See `src/app/(app)/feeds/page.tsx`.
const resolveParams = cache(async (searchParams: SearchParamsPromise): Promise<ListParams> =>
  parseListParams(await searchParams),
);

async function JobsBody({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { jobs, showOwner } = await cachedListJobs(params);
  return <JobsTableBody rows={jobs} showOwner={showOwner} />;
}

async function JobsPagination({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { total } = await cachedListJobs(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

/**
 * The jobs tab: every user's own background jobs, and for an admin everyone's.
 *
 * The instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`):
 * this page body awaits nothing, so it cannot suspend and `loading.tsx` --
 * deleted along with this rewrite -- is unreachable.
 *
 * Three awaits left, and where each went:
 * - **`await requireUserFreshRole()` moved into `listJobsForCurrentUser()`**
 *   (`src/lib/jobs/queries.ts`), which is where the rows are read and where the
 *   `userId` filter is now decided. This page used to derive `admin` and
 *   `userId` here and pass them down; removing the await without moving the
 *   decision would have handed every caller an unfiltered read of every user's
 *   jobs. `src/app/(app)/layout.tsx` still awaits `requireUser()` for the whole
 *   group, so an unauthenticated request never reaches this file.
 * - `await searchParams` is never awaited here; the raw promise goes to the two
 *   async data regions, which sit inside `<JobsListRegion>`'s `<Suspense>`
 *   boundaries where awaiting is the point. The search bar and the two
 *   `<Suspense>` keys read the current params client-side via
 *   `useListParams()`.
 * - `await getTranslations("jobs")` is gone: `<JobsChrome>` is a Client
 *   Component reading `useTranslations("jobs")` with a literal namespace.
 *
 * `showOwner` is **derived from the query's own result**, not from a second
 * role read: `cachedListJobs` returns it, so the header's column set and the
 * body's cannot disagree about whether there is an owner column -- and only a
 * `Promise<boolean>` crosses into the Client Component, never the `User` row
 * the gate returns (see `<JobsListRegion>`'s own comment for why that
 * distinction is a serialization rule, not a typing one).
 *
 * `connection()` is called but **not awaited** -- calling it is what interrupts
 * static generation, so `rm -rf data/ && npm run build` still cannot bake this
 * page against a `data/` directory that does not exist yet. See
 * `SettingsPage`'s identical comment for the full reasoning.
 */
export default function JobsPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  connection();

  const showOwner = resolveParams(searchParams)
    .then((params) => cachedListJobs(params))
    .then((page) => page.showOwner);

  return (
    <div className="space-y-4">
      <JobsChrome />

      <JobsListRegion
        showOwner={showOwner}
        tableBody={<JobsBody searchParams={searchParams} />}
        pagination={<JobsPagination searchParams={searchParams} />}
      />
    </div>
  );
}
