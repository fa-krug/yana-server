import { cache } from "react";

import { ArticlesChrome, type ArticleFilterOptions } from "@/components/articles/articles-chrome";
import { ArticlesListRegion } from "@/components/articles/articles-list-region";
import { ArticlesTableBody } from "@/components/articles/articles-table";
import { Pagination } from "@/components/crud/pagination";
import { listArticles } from "@/lib/articles/queries";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

type SearchParamsPromise = Promise<Record<string, string | string[] | undefined>>;

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListArticles = cache(listArticles);

// `ArticlesBody` and `ArticlesPagination` each receive the *same*
// `searchParams` promise reference from `ArticlesPage` and parse it
// independently -- without this, they would each call `parseListParams()`
// and get a *different* `params` object, and `cachedListArticles(params)`
// above would no longer dedupe (React's `cache()` keys on argument identity,
// not deep equality). `cache()`ing the parse itself, keyed on that shared
// promise reference, restores the single shared `params` object the dedupe
// above depends on.
const resolveParams = cache(async (searchParams: SearchParamsPromise): Promise<ListParams> =>
  parseListParams(await searchParams),
);

async function ArticlesBody({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { rows } = await cachedListArticles(params);
  return <ArticlesTableBody rows={rows} />;
}

async function ArticlesPagination({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { total } = await cachedListArticles(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

/**
 * The feed/tag options `<ArticlesChrome>`'s filter selects need, projected
 * down to `{ value, label }` (plus `color` for tags) inside this `.then()` --
 * never a bare `Promise<{ rows: Feed[] }>` or `Promise<{ rows: Tag[] }>`
 * passed straight to a Client Component. React serializes a promise handed
 * to a Client Component by its *resolved value*, not its declared type, so
 * narrowing has to happen before it crosses that boundary or the whole row
 * -- a tag's `userId`, both rows' timestamps -- would still be serialized
 * into this page's flight payload. Same reasoning as `getSettingsSummary()`
 * in `src/app/(app)/settings/page.tsx`.
 *
 * Not awaited: `<ArticlesChrome>` hands this promise to a `use()`-consuming
 * child of its own, wrapped in its own `<Suspense>`, so the title and search
 * box render immediately and only the filter selects wait on it.
 */
function articleFilterOptions(): Promise<ArticleFilterOptions> {
  return Promise.all([
    listFeeds(parseListParams({ pageSize: "100" })),
    listTags(parseListParams({ pageSize: "100" })),
  ]).then(([feedsRes, tagsRes]) => ({
    feeds: feedsRes.rows.map((f) => ({ value: String(f.id), label: f.name })),
    tags: tagsRes.rows.map((t) => ({ value: String(t.id), label: t.name, color: t.color })),
  }));
}

/**
 * The instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`):
 * this page body awaits nothing, so it cannot suspend and `loading.tsx` --
 * deleted along with this rewrite -- is unreachable.
 *
 * Four things this page used to await, and where each went:
 * - `await requireUser()` is gone from here entirely. `src/app/(app)/layout.tsx`
 *   already awaits `requireUser()` for the whole route group, and
 *   `listArticles()` (called by `ArticlesBody`/`ArticlesPagination` below)
 *   already scopes every row -- and its own `count()` -- to `currentUserId()`
 *   itself (via an inner join on `feeds.userId`), so this page's own call was
 *   redundant with both, never the only thing standing between another
 *   user's articles and this page.
 * - `await searchParams` is never awaited **here**. It is a promise in
 *   Next 16, and awaiting it in the page body is exactly the kind of await
 *   this migration removes. Instead, the raw promise is handed down to
 *   `ArticlesBody`/`ArticlesPagination` -- both already-async Server
 *   Components sitting inside a `<Suspense>` boundary, where awaiting is the
 *   whole point. `<ArticlesListRegion>` uses `useListParams()` client-side to
 *   compute the two `<Suspense>` keys that used to be computed here from the
 *   awaited `params` -- see its own doc comment.
 * - `await getTranslations("articles")` is gone, replaced by `<ArticlesChrome>`
 *   itself becoming a Client Component reading `useTranslations("articles")`
 *   -- see its own doc comment.
 * - `await Promise.all([listFeeds(...), listTags(...)])`, which built the
 *   filter dropdowns' options, is gone too. `listFeeds()`/`listTags()` are
 *   still called, but their combined, **unawaited** promise
 *   (`articleFilterOptions()`) is handed to `<ArticlesChrome>`, which streams
 *   the filter selects in once it resolves rather than blocking the whole
 *   page shell on it -- the exact data dependency the old `loading.tsx`
 *   documented as the reason it rendered no filters at all.
 */
export default function ArticlesPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  return (
    <div className="space-y-4">
      <ArticlesChrome optionsPromise={articleFilterOptions()} />

      <ArticlesListRegion
        tableBody={<ArticlesBody searchParams={searchParams} />}
        pagination={<ArticlesPagination searchParams={searchParams} />}
      />
    </div>
  );
}
