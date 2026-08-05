"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * The record title registered for each route that has one, keyed by pathname.
 *
 * `RouteBreadcrumbs` has no access to page data -- it is client-side chrome
 * driven only by `usePathname()`, rendered once in `(app)/layout.tsx` as a
 * sibling of every page, and it must stay that way (see the "chrome never
 * waits on data" rule in CLAUDE.md: the layout may not become route-aware or
 * start awaiting per-resource queries). A detail page, by contrast, already
 * loads the row the breadcrumb needs one field from -- this registry is the
 * seam between the two: `SetBreadcrumbTitle` writes into it, `RouteBreadcrumbs`
 * (via `useBreadcrumbTitles`) reads it.
 */
type TitleMap = Record<string, string>;

type BreadcrumbTitleContextValue = {
  titles: TitleMap;
  setTitle: (href: string, title: string) => void;
  clearTitle: (href: string) => void;
};

const noop = () => {};

/**
 * The default (no provider mounted) is a stable, inert value rather than
 * `null` -- so `useBreadcrumbTitles()` works in isolation (existing
 * `route-breadcrumbs.test.tsx` cases render `<RouteBreadcrumbs />` with no
 * provider at all, and must keep seeing "nothing registered", not a throw).
 */
const DEFAULT_VALUE: BreadcrumbTitleContextValue = { titles: {}, setTitle: noop, clearTitle: noop };

const BreadcrumbTitleContext = React.createContext<BreadcrumbTitleContextValue>(DEFAULT_VALUE);

export function BreadcrumbTitleProvider({ children }: { children: React.ReactNode }) {
  const [titles, setTitles] = React.useState<TitleMap>({});

  const setTitle = React.useCallback((href: string, title: string) => {
    setTitles((prev) => (prev[href] === title ? prev : { ...prev, [href]: title }));
  }, []);

  const clearTitle = React.useCallback((href: string) => {
    setTitles((prev) => {
      if (!(href in prev)) return prev;
      const next = { ...prev };
      delete next[href];
      return next;
    });
  }, []);

  const value = React.useMemo(
    () => ({ titles, setTitle, clearTitle }),
    [titles, setTitle, clearTitle],
  );

  return (
    <BreadcrumbTitleContext.Provider value={value}>{children}</BreadcrumbTitleContext.Provider>
  );
}

/** The titles registered so far, keyed by pathname. `{}` with no provider mounted. */
export function useBreadcrumbTitles(): TitleMap {
  return React.useContext(BreadcrumbTitleContext).titles;
}

/**
 * Registers `title` as the breadcrumb label for the current route while
 * mounted. Rendered by a detail page once it has loaded the record whose
 * name the breadcrumb should show instead of the raw id. Renders nothing.
 *
 * This registers under the full current pathname, which only coincides with a
 * breadcrumb crumb's own `href` because today's four detail routes put the
 * record id at the end of the path. A future route nesting something under a
 * detail page (e.g. a hypothetical `/articles/42/content`) would need an
 * explicit `href` prop here rather than relying on `usePathname()`.
 *
 * An empty `title` registers nothing -- a blank breadcrumb segment would be
 * worse than the id it replaces, and this is the one guard against it (see
 * the empty-title edge case in the design spec).
 */
export function SetBreadcrumbTitle({ title }: { title: string }) {
  const pathname = usePathname();
  const { setTitle, clearTitle } = React.useContext(BreadcrumbTitleContext);

  React.useEffect(() => {
    if (!title) return;
    setTitle(pathname, title);
    return () => clearTitle(pathname);
  }, [pathname, title, setTitle, clearTitle]);

  return null;
}
