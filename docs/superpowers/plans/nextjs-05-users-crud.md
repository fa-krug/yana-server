# Phase 5: Users CRUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only users tab: searchable, filterable list with bulk selection and bulk delete behind a confirmation, create and edit as subpages, and a delete button on the edit page.

**Architecture:** This phase builds the **reusable CRUD kit** that phases 8, 9 and 10 consume — a generic `DataTable` with selection, a search-and-filter bar driven by URL search params, a bulk-action bar, and a confirm-destructive dialog. Users is the first consumer because it is the simplest entity. Filter and search state lives in the URL, not component state, so a filtered view is linkable and reflects in breadcrumbs as phase 3 requires.

**Tech Stack:** Next.js App Router, shadcn table + checkbox + alert-dialog, Zod, Drizzle.

## Global Constraints

- **Every route in this phase is admin-only**, enforced by `requireAdmin()` from phase 4 — which 404s rather than 403s.
- Search and filter state lives in **URL search params**. A component-state filter is a defect: it breaks linkability and back-navigation.
- **Destructive actions always confirm**, naming what will be affected and how many.
- An admin **cannot delete their own account** and cannot remove their own admin flag — both would be a self-lockout. Also refuse to delete the last remaining admin.
- Deleting a user cascades to their feeds, tags, articles and settings. The confirmation must state this, with counts.
- The CRUD kit is generic. Any user-specific logic inside `src/components/crud/` is misplaced.
- List queries are paginated — never `SELECT *` unbounded. Default page size 25.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/components/crud/data-table.tsx` | Generic table: columns, rows, selection |
| `src/components/crud/search-filter-bar.tsx` | URL-param search + filter controls |
| `src/components/crud/bulk-action-bar.tsx` | Appears when rows are selected |
| `src/components/crud/confirm-destructive.tsx` | AlertDialog wrapper |
| `src/components/crud/pagination.tsx` | URL-param pagination |
| `src/lib/crud/params.ts` | Parse/serialize list params |
| `src/lib/users/queries.ts` | `listUsers`, `getUser` |
| `src/lib/users/actions.ts` | `createUser`, `updateUser`, `deleteUsers` |
| `src/app/(app)/users/page.tsx` | List |
| `src/app/(app)/users/new/page.tsx` | Create |
| `src/app/(app)/users/[id]/page.tsx` | Edit + delete |

---

### Task 1: List parameter parsing

**Interfaces:**
- Produces:
  - `type ListParams = { q: string; page: number; pageSize: number; sort: string; dir: "asc" | "desc"; filters: Record<string, string> }`
  - `parseListParams(searchParams: Record<string, string | string[] | undefined>, defaults?: Partial<ListParams>): ListParams`
  - `buildListHref(pathname: string, params: Partial<ListParams>): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/crud/params.test.ts
import { describe, expect, it } from "vitest";

import { buildListHref, parseListParams } from "./params";

describe("parseListParams", () => {
  it("applies defaults for an empty query", () => {
    expect(parseListParams({})).toEqual({
      q: "", page: 1, pageSize: 25, sort: "", dir: "asc", filters: {},
    });
  });

  it("clamps a page below one", () => {
    expect(parseListParams({ page: "0" }).page).toBe(1);
    expect(parseListParams({ page: "-3" }).page).toBe(1);
    expect(parseListParams({ page: "abc" }).page).toBe(1);
  });

  it("caps pageSize so a crafted URL cannot request everything", () => {
    expect(parseListParams({ pageSize: "100000" }).pageSize).toBe(100);
  });

  it("collects unrecognized params as filters", () => {
    expect(parseListParams({ role: "admin", q: "ada" })).toMatchObject({
      q: "ada", filters: { role: "admin" },
    });
  });

  it("takes the first value of a repeated param", () => {
    expect(parseListParams({ q: ["a", "b"] }).q).toBe("a");
  });
});

describe("buildListHref", () => {
  it("omits defaults to keep URLs clean", () => {
    expect(buildListHref("/users", { page: 1, q: "" })).toBe("/users");
  });

  it("resets to page one when the query changes", () => {
    // Otherwise a search from page 5 lands on an empty page.
    expect(buildListHref("/users", { q: "ada", page: 5 })).toBe("/users?q=ada");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails, then implement**

```ts
// src/lib/crud/params.ts
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

export function buildListHref(pathname: string, params: Partial<ListParams>): string {
  const search = new URLSearchParams();

  // A query change must reset paging, or a search from page 5 lands on nothing.
  const page = params.q !== undefined ? 1 : (params.page ?? 1);

  if (params.q) search.set("q", params.q);
  if (page > 1) search.set("page", String(page));
  if (params.pageSize && params.pageSize !== DEFAULTS.pageSize) {
    search.set("pageSize", String(params.pageSize));
  }
  if (params.sort) search.set("sort", params.sort);
  if (params.dir === "desc") search.set("dir", "desc");
  for (const [key, value] of Object.entries(params.filters ?? {})) {
    if (value) search.set(key, value);
  }

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}
```

- [ ] **Step 3: Run the tests and commit**

```bash
cd yana-next && npm test -- params
cd .. && git add yana-next && git commit -m "feat(next): Add URL-param list state parsing

List state lives in the URL so filtered views are linkable and back-navigation
works. pageSize is capped at 100 -- otherwise a crafted URL requests the entire
table. Changing the query resets to page one, or a search from page 5 lands on an
empty page."
```

---

### Task 2: The generic CRUD kit

**Interfaces:**
- Produces:
  - `DataTable<T>` with props `{ rows: T[]; columns: Column<T>[]; rowId: (row: T) => string; selected: string[]; onSelectedChange: (ids: string[]) => void }`, where `Column<T> = { key: string; header: string; cell: (row: T) => React.ReactNode; sortable?: boolean }`.
  - `SearchFilterBar` with `{ placeholder: string; filters?: FilterSpec[] }` where `FilterSpec = { key: string; label: string; options: { value: string; label: string }[] }`.
  - `BulkActionBar` with `{ count: number; actions: BulkAction[]; onClear: () => void }` where `BulkAction = { key: string; label: string; destructive?: boolean; run: () => Promise<void> }`.
  - `ConfirmDestructive` with `{ trigger: React.ReactNode; title: string; description: string; confirmLabel: string; onConfirm: () => Promise<void> }`.
  - `Pagination` with `{ page: number; pageSize: number; total: number }`.

- [ ] **Step 1: Write the table**

Key behaviours, each of which needs to be right because four phases depend on it:

- The header checkbox reflects three states — none, some (indeterminate), all — and toggling it selects or clears **only the rows currently on the page**, never the whole filtered set. Selecting invisible rows is how a bulk delete removes more than the operator saw.
- `rowId` is a prop rather than assuming `row.id`, because phase 10's articles and phase 8's tags key differently.
- Sortable headers render as links built with `buildListHref`, so sorting is a navigation and stays in the URL.

- [ ] **Step 2: Write the search-and-filter bar**

A debounced (300ms) text input plus one `Select` per `FilterSpec`. Every change calls `router.replace(buildListHref(pathname, next))` — `replace`, not `push`, so typing a search does not fill the back stack with every keystroke.

- [ ] **Step 3: Write the bulk-action bar and confirm dialog**

`BulkActionBar` renders only when `count > 0`, is sticky at the bottom on mobile and inline on desktop, and shows the count explicitly. Destructive actions route through `ConfirmDestructive`.

`ConfirmDestructive` wraps shadcn's `AlertDialog`, disables the confirm button while the promise is pending, and closes only on resolve — so a failed delete leaves the dialog open with the error visible rather than silently dismissing.

- [ ] **Step 4: Write a test for the selection edge case**

```ts
// src/components/crud/selection.test.ts
import { describe, expect, it } from "vitest";

import { toggleAll } from "./data-table";

describe("toggleAll", () => {
  const pageIds = ["a", "b", "c"];

  it("selects only the current page's rows", () => {
    // Rows from another page stay selected but are not added to blindly.
    expect(toggleAll(pageIds, ["z"])).toEqual(["z", "a", "b", "c"]);
  });

  it("clears only the current page's rows", () => {
    expect(toggleAll(pageIds, ["z", "a", "b", "c"])).toEqual(["z"]);
  });

  it("treats a partial selection as 'select all'", () => {
    expect(toggleAll(pageIds, ["a"])).toEqual(["a", "b", "c"]);
  });
});
```

Extract `toggleAll(pageIds: string[], selected: string[]): string[]` as a pure function so this is testable without rendering.

- [ ] **Step 5: Commit**

```bash
cd .. && git add yana-next && git commit -m "feat(next): Add the generic CRUD kit

Four phases consume this, so two behaviours matter more than they look:
select-all covers only the current page (selecting invisible rows is how a bulk
delete removes more than the operator saw), and the confirm dialog stays open on
failure rather than dismissing silently.

Search uses router.replace so typing does not fill the back stack."
```

---

### Task 3: User queries and actions

**Interfaces:**
- Produces:
  - `listUsers(params: ListParams): Promise<{ rows: User[]; total: number }>`
  - `getUser(id: string): Promise<User | null>`
  - `createUser(input: unknown): Promise<{ ok: boolean; error?: string; id?: string }>`
  - `updateUser(id: string, input: unknown): Promise<{ ok: boolean; error?: string }>`
  - `deleteUsers(ids: string[]): Promise<{ ok: boolean; error?: string; deleted: number }>`
  - `userImpact(ids: string[]): Promise<{ feeds: number; tags: number; articles: number }>` — powers the confirmation copy.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/users/actions.test.ts
import { describe, expect, it } from "vitest";

import { deleteUsers, updateUser } from "./actions";

describe("deleteUsers", () => {
  it("refuses to delete the acting admin", async () => {
    // Self-deletion is an immediate lockout.
    const result = await deleteUsers([await currentAdminId()]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/own account/i);
  });

  it("refuses to delete the last admin", async () => {
    const result = await deleteUsers([await onlyOtherAdminId()]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/last admin/i);
  });

  it("reports how many rows it deleted", async () => {
    const result = await deleteUsers([await someNonAdminId()]);
    expect(result).toMatchObject({ ok: true, deleted: 1 });
  });
});

describe("updateUser", () => {
  it("refuses to clear the acting admin's own admin flag", async () => {
    const result = await updateUser(await currentAdminId(), { isAdmin: false });
    expect(result.ok).toBe(false);
  });

  it("rejects an email already taken by another user", async () => {
    const result = await updateUser(await someNonAdminId(), { email: "admin@admin.com" });
    expect(result.ok).toBe(false);
  });
});
```

Write the three helpers (`currentAdminId`, `onlyOtherAdminId`, `someNonAdminId`) as fixtures in the test file that seed the database directly.

- [ ] **Step 2: Implement**

`listUsers` builds a Drizzle query with `like` on email/firstName/lastName for `q`, an `isAdmin` equality when `filters.role` is set, `limit`/`offset` from paging, and a separate `count()` for `total`. Both queries run in the same read — do not paginate in JavaScript.

`createUser` goes through `auth.api.signUpEmail` so hashing matches, then applies `isAdmin` and seeds a `userSettings` row.

`deleteUsers` refuses in this order, before deleting anything: acting user in the set → last admin in the set → otherwise delete. The FK cascades from phase 2 handle feeds/tags/articles/settings, which is why `foreign_keys=ON` is load-bearing here.

- [ ] **Step 3: Run the tests and commit**

```bash
cd yana-next && npm test -- users
cd .. && git add yana-next && git commit -m "feat(next): Add user queries and actions

Three refusals, all checked before anything is deleted: the acting admin cannot
delete themselves, cannot clear their own admin flag, and the last admin cannot be
removed. Each is a permanent lockout otherwise.

Cascade deletion relies on foreign_keys=ON from phase 1 -- without that PRAGMA,
deleting a user would orphan their feeds and articles silently."
```

---

### Task 4: The three routes

- [ ] **Step 1: The list page**

`src/app/(app)/users/page.tsx` — a server component reading `searchParams`, parsing with `parseListParams`, rendering `<SearchFilterBar>` and a `<Suspense>`-wrapped async `<UsersTable>` with a `<TableSkeleton>` fallback, per phase 3's pattern. `requireAdmin()` first.

Filter spec: role (`all` / `admin` / `standard`). Columns: avatar, name, email, admin badge, created date.

- [ ] **Step 2: Create and edit subpages**

`/users/new` and `/users/[id]` — real routes, so breadcrumbs work with no extra wiring (phase 3 Task 3). The edit page renders the same form component as create, plus a destructive delete at the bottom behind `ConfirmDestructive`, whose description names the user and their cascade counts from `userImpact`.

- [ ] **Step 3: Wire bulk delete**

Selected ids feed `BulkActionBar` with one action: delete. Its `run` calls `userImpact` first to build the confirmation copy — "Delete 3 users? This also removes 14 feeds and 402 articles." — then `deleteUsers`, then `router.refresh()` and a toast reporting the count.

- [ ] **Step 4: Verify by hand**

Non-admin gets 404 on every route. Search narrows and stays in the URL. Filtering by role works and is linkable. Select-all on page 2 does not select page 1. Bulk delete confirms with real counts. Self-delete is refused with a clear message. At 375px the table scrolls horizontally rather than overflowing the page.

- [ ] **Step 5: Run every check and commit**

```bash
cd yana-next && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
cd .. && git add yana-next && git commit -m "feat(next): Add the admin-only users tab

Create and edit are real subpages rather than dialogs, so the URL and breadcrumbs
reflect them for free -- phase 3's breadcrumbs derive from the path.

The bulk delete confirmation names actual cascade counts rather than a generic
warning, because the operator cannot otherwise tell that removing 3 users also
removes 402 articles."
```

---

## Self-Review

**Spec coverage.** Against bullet 5:

| Requirement | Task |
|---|---|
| Admin-only | 4 (`requireAdmin` on every route) |
| List with search and filter | 1, 2, 4 |
| Create/edit as subpages | 4 |
| Bulk select | 2 |
| Bulk delete | 3, 4 |
| Confirm before delete | 2, 4 |
| Delete on the edit page | 4 |

**Placeholder scan.** Tasks 2 and 4 specify components by interface and behaviour rather than full JSX. The interfaces are exact, and every non-obvious decision is stated: page-scoped select-all, `replace` over `push`, dialog stays open on failure, confirmation carries real counts. What remains is mechanical. Task 1 and Task 3 — the parts with real logic and real failure modes — carry complete code and tests.

**Type consistency.** `ListParams` is defined once in Task 1 and consumed by `listUsers` (Task 3) and the list page (Task 4). `DataTable<T>`'s `rowId` returns `string`, matching `users.id`'s type and the `selected: string[]` contract; phase 10's integer ids will need `String(row.id)`, which the generic signature already permits. `{ ok, error? }` matches phase 3's action convention exactly.

**One thing deliberately not built.** No per-user "impersonate" or "reset password" admin action. Neither is in the bullet, and a password reset without mail transport would mean an admin setting a password they then have to convey out of band.
