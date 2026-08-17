import { connection } from "next/server";
import { cache } from "react";

import { Pagination } from "@/components/crud/pagination";
import { UsersChrome } from "@/components/users/users-chrome";
import { UsersListRegion } from "@/components/users/users-list-region";
import { UsersTableBody } from "@/components/users/users-table";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listUsers } from "@/lib/users/queries";

type SearchParamsPromise = Promise<Record<string, string | string[] | undefined>>;

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListUsers = cache(listUsers);

// Both data regions receive the *same* `searchParams` promise reference and
// parse it independently; `cache()`ing the parse keyed on that reference is
// what keeps `cachedListUsers` deduping (React's `cache()` keys on argument
// identity, not deep equality). See `src/app/(app)/feeds/page.tsx`.
const resolveParams = cache(async (searchParams: SearchParamsPromise): Promise<ListParams> =>
  parseListParams(await searchParams),
);

/**
 * The data region: async, inside `<UsersListRegion>`'s `<Suspense>`, with the
 * (app) group's `error.tsx` above it.
 *
 * **`listUsers()` is now the gate, not defence in depth.** It calls
 * `requireAdmin()` itself, which is what still refuses a non-admin every row
 * here -- see `src/lib/users/queries.ts`. Its `notFound()` no longer produces a
 * real 404, because this boundary has already flushed the shell; the plan this
 * migration implements accepted that trade deliberately (`/users` no longer
 * hides its existence), and what matters is that the *rows* never arrive.
 *
 * Untested by design -- testing-library cannot render an async server
 * component. What the query returns is covered against a real database in
 * `src/lib/users/users.test.ts`, and what the table does with it in
 * `users-table.test.tsx`.
 */
async function UsersBody({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { rows } = await cachedListUsers(params);
  return <UsersTableBody rows={rows} />;
}

async function UsersPagination({ searchParams }: { searchParams: SearchParamsPromise }) {
  const params = await resolveParams(searchParams);
  const { total } = await cachedListUsers(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

/**
 * The admin-only users tab.
 *
 * The instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`):
 * this page body awaits nothing, so it cannot suspend and `loading.tsx` --
 * deleted along with this rewrite -- is unreachable.
 *
 * Three awaits left, and where each went:
 * - **`await requireAdmin()` moved into `listUsers()`**, which is where the
 *   rows are read. That move is the whole of Task 3 of the plan: authorization
 *   that lived in this page body would otherwise have simply disappeared, and
 *   every account on the instance with it. `src/app/(app)/layout.tsx` still
 *   awaits `requireUser()` for the whole group, so an unauthenticated request
 *   never reaches this file at all.
 * - `await searchParams` is never awaited here; the raw promise goes to the two
 *   async data regions, which are inside a `<Suspense>` boundary where awaiting
 *   is the point. `<UsersChrome>`'s search box and role select read the current
 *   params client-side via `useListParams()`, as does `<UsersListRegion>` for
 *   the two `<Suspense>` keys.
 * - `await getTranslations("users")` is gone: `<UsersChrome>` is a Client
 *   Component reading `useTranslations("users")` with a literal namespace.
 *
 * `connection()` is called but **not awaited** -- calling it is what interrupts
 * static generation, so `rm -rf data/ && npm run build` still cannot bake this
 * page against a `data/` directory that does not exist yet. See
 * `SettingsPage`'s identical comment for the full reasoning. It is no longer
 * `requireAdmin()`'s awaited `headers()` read that opts this route out, because
 * this body no longer performs one.
 */
export default function UsersPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  connection();

  return (
    <div className="space-y-4">
      <UsersChrome />

      <UsersListRegion
        tableBody={<UsersBody searchParams={searchParams} />}
        pagination={<UsersPagination searchParams={searchParams} />}
      />
    </div>
  );
}
