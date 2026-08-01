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

export function parseListParams(
  searchParams: Record<string, string | string[] | undefined>,
  defaults: Partial<ListParams> = {},
): ListParams {
  const base = { ...DEFAULTS, ...defaults };

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
    q: first(searchParams.q) || base.q,
    // A crafted pageSize must not be able to request the whole table.
    page: Number.isFinite(page) && page > 0 ? page : base.page,
    pageSize:
      Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, MAX_PAGE_SIZE) : base.pageSize,
    sort: first(searchParams.sort) || base.sort,
    dir: first(searchParams.dir) === "desc" ? "desc" : base.dir,
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

export function buildListHref(
  pathname: string,
  current: ListParams,
  changes: Partial<ListParams>,
): string {
  // A key missing from `changes` falls through to `current` via the spread;
  // no explicit fallback is needed for any individual field.
  const merged: ListParams = { ...current, ...changes };

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
