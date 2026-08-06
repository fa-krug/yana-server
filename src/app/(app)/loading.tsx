import { TableSkeleton } from "@/components/data-skeleton";

/**
 * The fallback for every route in this group whose own top-level render is
 * awaited outside a `<Suspense>` boundary -- by design, for the routes that
 * authorize and load their record before returning anything (see the
 * `connection()`/streaming-pattern bullets in CLAUDE.md; `src/app/(app)/users/[id]/page.tsx`
 * is the precedent this file backs).
 *
 * The `(app)/layout.tsx` chrome (sidebar, header, breadcrumbs) is the parent
 * segment and has already rendered by the time this fallback shows, so it never
 * disappears while a page is loading -- only the content area falls back to
 * this skeleton.
 *
 * A list or card page that already wraps its slow query in its own local
 * `<Suspense>` (every page under this group does) never actually shows this:
 * its own fallback wins as soon as the page function itself returns. This one
 * only fires for the top-level await itself -- session/role checks that are
 * normally cache-fast, and the one indexed record lookup a detail route makes
 * before it can decide between its form and `notFound()`.
 */
export default function Loading() {
  return <TableSkeleton />;
}
