import { cache } from "react";

import { Pagination } from "@/components/crud/pagination";
import { TagsChrome } from "@/components/tags/tags-chrome";
import { TagsListRegion } from "@/components/tags/tags-list-region";
import { TagsTableBody } from "@/components/tags/tags-table";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listTags } from "@/lib/tags/queries";

type SearchParamsPromise = Promise<Record<string, string | string[] | undefined>>;

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListTags = cache(listTags);

// `TagsBody` and `TagsPagination` each receive the *same* `searchParams`
// promise reference from `TagsPage` and parse it independently -- without
// this, they would each call `parseListParams()` and get a *different*
// `params` object, and `cachedListTags(params)` above would no longer dedupe
// (React's `cache()` keys on argument identity, not deep equality).
// `cache()`ing the parse itself, keyed on that shared promise reference,
// restores the single shared `params` object the dedupe above depends on.
const resolveParams = cache(async (searchParams: SearchParamsPromise): Promise<ListParams> =>
  parseListParams(await searchParams),
);

async function TagsBody({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { rows } = await cachedListTags(params);
  return <TagsTableBody rows={rows} />;
}

async function TagsPagination({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { total } = await cachedListTags(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

/**
 * The instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`):
 * this page body awaits nothing, so it cannot suspend and `loading.tsx` --
 * deleted along with this rewrite -- is unreachable.
 *
 * Three things this page used to await, and where each went:
 * - `await requireUser()` is gone from here entirely. `src/app/(app)/layout.tsx`
 *   already awaits `requireUser()` for the whole route group, and `listTags()`
 *   (called by `TagsBody`/`TagsPagination` below) already scopes every row --
 *   and its own `count()` -- to `requireUser()`'s own session id itself, so
 *   this page's own call was redundant with both, never the only thing
 *   standing between another user's tags and this page.
 * - `await searchParams` is never awaited **here**. It is a promise in
 *   Next 16, and awaiting it in the page body is exactly the kind of await
 *   this migration removes. Instead, the raw promise is handed down to
 *   `TagsBody`/`TagsPagination` -- both already-async Server Components
 *   sitting inside a `<Suspense>` boundary, where awaiting is the whole
 *   point. `<TagsChrome>`'s search box needs the *current* params too, but
 *   reads them independently, client-side, via `useListParams()`
 *   (`src/components/crud/use-list-params.ts`) -- the existing hook the
 *   search bar and pagination links already call directly rather than taking
 *   params as a prop. `<TagsListRegion>` uses the same hook to compute the
 *   two `<Suspense>` keys that used to be computed here from the awaited
 *   `params` -- see its own doc comment.
 * - `await getTranslations("tags")` is gone, replaced by `<TagsChrome>`
 *   itself becoming a Client Component reading `useTranslations("tags")` --
 *   see its own doc comment.
 */
export default function TagsPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  return (
    <div className="space-y-4">
      <TagsChrome />

      <TagsListRegion
        tableBody={<TagsBody searchParams={searchParams} />}
        pagination={<TagsPagination searchParams={searchParams} />}
      />
    </div>
  );
}
