# Breadcrumb record titles

Detail-page breadcrumbs show the record's title instead of its raw id, truncated.

## Problem

`breadcrumbsFor()` (`src/lib/nav.ts`) builds breadcrumbs from the URL path alone.
A segment with no catalog label -- a record id, e.g. `/articles/42` -- is shown
verbatim. That is correct as a fallback but not useful: the breadcrumb for an
article detail page reads ".../Articles/42" instead of naming the article.

## Design

### Mechanism: a client-side title registry, populated by each detail page

`RouteBreadcrumbs` is a client component (`usePathname()`-driven) rendered once
in `src/app/(app)/layout.tsx`, a sibling of `{children}` under the same
`<SidebarProvider>`. It has no access to page data and must not gain any --
the layout is shared chrome for every route and must not become route-aware or
start awaiting per-resource queries (see "chrome never waits on data" in
CLAUDE.md). Each detail page, however, already loads the row the breadcrumb
needs a field from.

So: a new client module, `src/components/breadcrumb-title.tsx`, exports:

- `BreadcrumbTitleProvider` -- wraps a `Record<href, title>` in `useState`,
  exposes `setTitle(href, title)` / `clearTitle(href)` via context.
- `useBreadcrumbTitles()` -- read hook, used by `RouteBreadcrumbs`.
- `SetBreadcrumbTitle({ title }: { title: string })` -- a small client
  component a detail page renders once it has its row. On mount (`useEffect`)
  it registers `title` under the current `usePathname()`; on unmount, or
  whenever `title` changes, it clears the old entry first. Renders nothing.

`src/app/(app)/layout.tsx` wraps `<RouteBreadcrumbs />` and `{children}` in
`<BreadcrumbTitleProvider>` (inside `<SidebarInset>`, so both are still
siblings under the same provider).

`RouteBreadcrumbs` (`src/components/route-breadcrumbs.tsx`): for a crumb that
carries a plain `label` (today's id-verbatim branch -- see `Crumb` in
`src/lib/nav.ts`), look up `href` in the registry from `useBreadcrumbTitles()`.
If present, render that title instead of the raw segment; if absent (no detail
page registered one, or it hasn't mounted yet), fall back to the id exactly as
today. A crumb with a `labelKey` (a known route or action segment) is
unaffected -- this only ever replaces the "unmatched segment" fallback, never a
translated label.

This keeps `breadcrumbsFor()` itself pure and pathname-only; it does not gain
an id-to-title lookup or any data dependency.

### Truncation

CSS ellipsis, not a character-count cutoff -- the existing pattern in
`src/components/jobs/jobs-table.tsx` (`className="truncate max-w-xs"` plus a
`title={fullValue}` tooltip). Applied to the rendered label: a fixed
`max-w-[...]` + `truncate` on the span inside `BreadcrumbLink`/`BreadcrumbPage`,
with the untruncated title as the `title` attribute so the full value is one
hover away. This adapts to available width instead of an arbitrary character
count, and needs no new truncation utility.

### Wiring: the four detail pages

Only four routes have an `[id]` segment today (confirmed by directory
listing); no other route needs this.

| Route | Title source |
|---|---|
| `src/app/(app)/articles/[id]/page.tsx` | `article.name` (from `getArticle()` -- the `articles` table's human-readable title column is named `name`, not `title`) |
| `src/app/(app)/feeds/[id]/page.tsx` | `feed.name` (from `getFeed()`) |
| `src/app/(app)/tags/[id]/page.tsx` | `tag.name` (from `getTag()`) |
| `src/app/(app)/users/[id]/page.tsx` | `displayNameFor(user)` (`src/lib/avatar.ts`, already imported by other user-facing components) |

Each page renders `<SetBreadcrumbTitle title={...} />` once its row is loaded
(after its own `notFound()` check, so it never registers a title for a 404).

### Error / edge cases

- **No detail page for a segment** (a route not in the table above): registry
  has no entry, breadcrumb shows the id verbatim -- unchanged behavior.
- **Row not found**: page calls `notFound()` before rendering
  `SetBreadcrumbTitle`, so nothing is registered and the 404 page's own
  breadcrumb (if any) shows the id.
- **Navigating away**: `SetBreadcrumbTitle`'s cleanup clears its entry on
  unmount, so the registry doesn't accumulate stale titles for routes no
  longer mounted.
- **Empty title** (should not happen -- `name`/`title` columns are required --
  but if a future schema allowed it): an empty string is falsy-ish for display
  purposes; treat "registered but empty" the same as "not registered" (fall
  back to the id) to avoid a blank breadcrumb segment.

## Testing

- `route-breadcrumbs.test.tsx`: existing tests (unmatched segment shown
  verbatim, known routes translated) must keep passing unchanged -- they never
  wrap the component in `BreadcrumbTitleProvider`, which is the "nothing
  registered" case. New test: with a title registered for the current path
  (render `SetBreadcrumbTitle` alongside `RouteBreadcrumbs`, both inside
  `BreadcrumbTitleProvider`), the breadcrumb shows the title, not the id.
- `breadcrumb-title.tsx` gets its own `.test.tsx`: set on mount, cleared on
  unmount, last-write-wins if two components somehow register the same href.
- No change needed to `src/lib/nav.ts` or its tests -- `breadcrumbsFor()` is
  untouched.

## Out of scope

- No server-side/SSR rendering of the real title on first paint -- the id
  shows briefly (or not at all, given how fast client hydration + effect fire
  in practice) until `SetBreadcrumbTitle` mounts. Given the whole page is
  already client-rendered chrome around server-streamed content, this is
  consistent with how the rest of the shell behaves and not worth a
  server-side plumbing change for a breadcrumb.
- No new generic truncation utility -- reuses the existing CSS pattern.
