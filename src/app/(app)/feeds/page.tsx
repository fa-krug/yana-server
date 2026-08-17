import { cache } from "react";

import { Pagination } from "@/components/crud/pagination";
import { FeedsChrome } from "@/components/feeds/feeds-chrome";
import { FeedsListRegion } from "@/components/feeds/feeds-list-region";
import { FeedsTableBody } from "@/components/feeds/feeds-table";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";

type SearchParamsPromise = Promise<Record<string, string | string[] | undefined>>;

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListFeeds = cache(listFeeds);

// `FeedsBody` and `FeedsPagination` each receive the *same* `searchParams`
// promise reference from `FeedsPage` and parse it independently -- without
// this, they would each call `parseListParams()` and get a *different*
// `params` object, and `cachedListFeeds(params)` above would no longer
// dedupe (React's `cache()` keys on argument identity, not deep equality).
// `cache()`ing the parse itself, keyed on that shared promise reference,
// restores the single shared `params` object the dedupe above depends on.
const resolveParams = cache(async (searchParams: SearchParamsPromise): Promise<ListParams> =>
  parseListParams(await searchParams),
);

async function FeedsBody({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { rows } = await cachedListFeeds(params);
  return <FeedsTableBody rows={rows} />;
}

async function FeedsPagination({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { total } = await cachedListFeeds(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

/**
 * The instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`):
 * this page body awaits nothing, so it cannot suspend and `loading.tsx` --
 * deleted along with this rewrite -- is unreachable.
 *
 * Three things this page used to await, and where each went:
 * - `await requireUser()` is gone from here entirely. `src/app/(app)/layout.tsx`
 *   already awaits `requireUser()` for the whole route group, and
 *   `listFeeds()` (called by `FeedsBody`/`FeedsPagination` below) already
 *   scopes every row to `currentUserId()` itself -- this page's own call was
 *   redundant with both, never the only thing standing between another
 *   user's feeds and this page.
 * - `await searchParams` is never awaited **here**. It is a promise in
 *   Next 16, and awaiting it in the page body is exactly the kind of await
 *   this migration removes. Instead, the raw promise is handed down to
 *   `FeedsBody`/`FeedsPagination` -- both already-async Server Components
 *   sitting inside a `<Suspense>` boundary, where awaiting is the whole
 *   point. `<FeedsChrome>`'s search box and filter selects need the *current*
 *   params too, but read them independently, client-side, via
 *   `useListParams()` (`src/components/crud/use-list-params.ts`) -- the
 *   existing hook the search bar, filter selects and pagination links
 *   already call directly rather than taking params as a prop. `<FeedsListRegion>`
 *   uses the same hook to compute the two `<Suspense>` keys that used to be
 *   computed here from the awaited `params` -- see its own doc comment.
 * - `await getTranslations("feeds")` is gone, replaced by `<FeedsChrome>`
 *   itself becoming a Client Component reading `useTranslations("feeds")` --
 *   see its own doc comment.
 */
export default function FeedsPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  return (
    <div className="space-y-4">
      <FeedsChrome />

      <FeedsListRegion
        tableBody={<FeedsBody searchParams={searchParams} />}
        pagination={<FeedsPagination searchParams={searchParams} />}
      />
    </div>
  );
}
