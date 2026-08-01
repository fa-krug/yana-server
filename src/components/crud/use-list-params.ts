"use client";

import { usePathname, useSearchParams } from "next/navigation";

import { parseListParams, type ListParams } from "@/lib/crud/params";

/**
 * The list state the current URL encodes, plus the pathname to build hrefs on.
 *
 * Three of the kit's components need it -- the table's sortable headers, the
 * search bar and the pagination links all call `buildListHref(pathname,
 * params, changes)`, which needs the *current* params to merge onto. None of
 * them takes it as a prop: the URL is the single source of truth for list
 * state, and a prop would let a caller hand one component a stale copy while
 * another read the real thing.
 *
 * `parseListParams` is the same function the server component uses to read
 * `searchParams`, so client and server cannot disagree about what a URL means.
 *
 * A route rendering any of these components must be dynamic. `useSearchParams`
 * makes a statically prerendered page bail out to client rendering; every page
 * in this app already opts out with `await connection()` or a Dynamic API (see
 * CLAUDE.md), so this is a constraint to remember rather than one to work
 * around.
 */
export function useListParams(): { pathname: string; params: ListParams } {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return { pathname, params: parseListParams(recordFrom(searchParams)) };
}

/**
 * `URLSearchParams` in the shape `parseListParams` reads.
 *
 * `Object.fromEntries(searchParams)` would be shorter and wrong: it keeps only
 * the *last* value of a repeated key, whereas `parseListParams` deliberately
 * takes the first (`?q=a&q=b` is `a` on the server). Handing back the array
 * lets it apply its own rule instead of quietly applying the opposite one.
 */
function recordFrom(searchParams: URLSearchParams): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    record[key] = values.length > 1 ? values : values[0];
  }
  return record;
}
