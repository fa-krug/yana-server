export type ListParams = {
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  dir: "asc" | "desc";
  filters: Record<string, string>;
};

const DEFAULTS: ListParams = { q: "", page: 1, pageSize: 25, sort: "", dir: "asc", filters: {} };
const RESERVED = new Set(["q", "page", "pageSize", "sort", "dir"]);
const MAX_PAGE_SIZE = 100;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * What a URL's query string means, as list state.
 *
 * **There is one set of defaults, and it is this module's.** A
 * `defaults: Partial<ListParams>` parameter used to sit here; it was never
 * plumbed anywhere and is deleted rather than finished, because it is only half
 * of a two-half contract and the missing half fails silently:
 *
 * - the *server* page reads the URL through this function, while every kit
 *   component reads it through `useListParams()`, which has no way to be handed
 *   the same object -- so with a page default of `sort: "publishedAt"` the
 *   header renders `aria-sort="none"` over a list that is sorted, and its link
 *   offers an ascending sort as if the column were untouched;
 * - and `buildListHref()` below decides *which values to omit* from the URL
 *   against this same constant. A page default of `pageSize: 50` makes the
 *   builder emit `?pageSize=50` and omit `?pageSize=25`, so the user's choice
 *   of 25 produces a URL that parses back as 50 -- the two halves disagree in
 *   opposite directions, and nothing raises a type error.
 *
 * **Do not put a default sort in a `NAV_ITEMS` href** (`/articles?sort=publishedAt&dir=desc`
 * from the navigation) -- it looks like the natural fix and breaks two things instead.
 * `src/lib/nav.ts`'s `LABELS` map is keyed on the exact href string, and `breadcrumbsFor()`
 * looks up hrefs it rebuilds from the pathname alone, so a query-bearing href never matches
 * and the breadcrumb prints the raw segment ("articles") instead of its translated label.
 * `src/components/app-sidebar.tsx` matches the active item with
 * `isNavItemActive()`, which compares `pathname` alone and never sees the query string
 * either, so the item never highlights.
 *
 * **The honest state: a feature's own `queries.ts` already owns the default ordering**, and
 * that already covers the common case for free. `listUsers()` in `src/lib/users/queries.ts`
 * falls back to `users.createdAt` whenever `params.sort` is empty
 * (`SORTABLE[params.sort] ?? users.createdAt`), so a bare `/users` visit is sorted sensibly
 * with nothing configured here or in the URL. What that leaves open: `<DataTable>` computes
 * `aria-sort` from `params.sort` alone (`src/components/crud/data-table.tsx`), which is `""`
 * on that same bare visit, so the header reports `"none"` on the column that is actually
 * driving the order -- the client and the server each picked a default independently, and
 * nothing makes the two agree. No phase has closed that gap. Closing it for real needs one
 * defaults object read by this function, `useListParams()`, all three kit components *and*
 * `buildListHref()` -- the same five call sites the deleted parameter would have needed, with
 * the same requirement that all five read the same value or `buildListHref()`'s parse/emit
 * round trip stops being inverse.
 */
export function parseListParams(
  searchParams: Record<string, string | string[] | undefined>,
): ListParams {
  const page = Number.parseInt(first(searchParams.page), 10);
  const pageSize = Number.parseInt(first(searchParams.pageSize), 10);

  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    if (!RESERVED.has(key)) {
      const single = first(value);
      if (single) filters[key] = single;
    }
  }

  return {
    q: first(searchParams.q) || DEFAULTS.q,
    // A crafted pageSize must not be able to request the whole table.
    page: Number.isFinite(page) && page > 0 ? page : DEFAULTS.page,
    pageSize:
      Number.isFinite(pageSize) && pageSize > 0
        ? Math.min(pageSize, MAX_PAGE_SIZE)
        : DEFAULTS.pageSize,
    sort: first(searchParams.sort) || DEFAULTS.sort,
    dir: first(searchParams.dir) === "desc" ? "desc" : DEFAULTS.dir,
    filters,
  };
}

// True when any key in either filter set carries a different value than the
// other -- covers a value changing, a key being added, and a key disappearing.
function filtersChanged(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return true;
  }
  return false;
}

/**
 * The URL that applies `changes` on top of the state `current` describes.
 *
 * **`changes.filters` merges per key** -- `{ filters: { role: "admin" } }` sets
 * the role filter and leaves every other one standing. It replaced the whole
 * record until phase 5's review: the only caller
 * (`src/components/crud/search-filter-bar.tsx`) already had to spread
 * `current.filters` back in by hand, which is a workaround for a trap rather
 * than a use of an API, and three phases inherit this function. **A filter is
 * cleared by setting it to `""`**, which is also what the filter selects
 * submit for their "all" option: an empty value is omitted from the query
 * string below, so the URL carries no key at all rather than `?role=`.
 */
export function buildListHref(
  pathname: string,
  current: ListParams,
  changes: Partial<ListParams>,
): string {
  // A key missing from `changes` falls through to `current` via the spread;
  // no explicit fallback is needed for any individual field. `filters` is the
  // exception and is merged a level deeper, per the note above.
  const merged: ListParams = {
    ...current,
    ...changes,
    filters: { ...current.filters, ...changes.filters },
  };

  // Merge-and-reset: q, pageSize and filters all change *what* the list
  // shows, so the page the caller was on may no longer exist -- reset to
  // page one whenever any of them actually changed value. `sort`/`dir` are
  // deliberately excluded: re-ordering the same result set does not invalidate
  // the current page.
  const valueChanged =
    merged.q !== current.q ||
    merged.pageSize !== current.pageSize ||
    filtersChanged(merged.filters, current.filters);

  // An explicit `changes.page` (a pagination link) is honoured only when
  // nothing else changed. If both a filter/query/pageSize change *and* an
  // explicit page are supplied in the same call, the reset wins -- the
  // supplied page number was computed against the *old* result set and is
  // meaningless against the new one.
  const page = valueChanged ? 1 : (changes.page ?? current.page);

  const search = new URLSearchParams();

  if (merged.q) search.set("q", merged.q);
  if (page > 1) search.set("page", String(page));
  if (merged.pageSize !== DEFAULTS.pageSize) search.set("pageSize", String(merged.pageSize));
  if (merged.sort) search.set("sort", merged.sort);
  if (merged.dir === "desc") search.set("dir", "desc");
  for (const [key, value] of Object.entries(merged.filters)) {
    if (value) search.set(key, value);
  }

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}
