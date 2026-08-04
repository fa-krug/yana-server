# Breadcrumb Record Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detail-page breadcrumbs (`/articles/42`, `/feeds/7`, `/tags/3`, `/users/<id>`) show the record's own title/name instead of its raw id, truncated with an ellipsis and a full-text tooltip.

**Architecture:** A new client-side context, `BreadcrumbTitleProvider` (in `src/components/breadcrumb-title.tsx`), holds a `{ href: title }` map. Each detail page renders a small `<SetBreadcrumbTitle title="..." />` client component once it has loaded its row, registering the title under the current pathname. `RouteBreadcrumbs` reads the map and, for the one kind of crumb that has no catalog label (a raw record id), prefers the registered title over the id -- falling back to the id, exactly as today, when nothing was registered. `(app)/layout.tsx` wraps the header and page content in the provider.

**Tech Stack:** Next.js 16 App Router (client components, `usePathname`), React context/state, Tailwind CSS truncation utilities, Vitest + Testing Library (jsdom project, `.test.tsx`).

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns formatting -- run `npm run format` if unsure, but write code already in this style).
- `@/*` resolves to `src/*`.
- Component/DOM tests are `.test.tsx` files in the jsdom vitest project; they use `@testing-library/react` and vitest's own `expect` -- **no `jest-dom` matchers** (no `toHaveClass`, `toBeInTheDocument`, etc). Assert classes with `element.classList.contains("...")`, following `src/components/crud/data-table.test.tsx:84`.
- `next/navigation` is mocked per test file with `vi.mock("next/navigation", () => import("@/test/next-navigation"))`, and the pathname is set with `setPathname(...)` from that module before rendering.
- No new i18n catalog keys are needed for this feature -- a record's title is its own data, never translated text.
- Before committing, the full CI check is `npm run lint && npm run format:check && npm run typecheck && npm test`. Each task below runs the narrower, fast checks; Task 7 runs the full set.

---

### Task 1: `breadcrumb-title.tsx` -- the title registry

**Files:**
- Create: `src/components/breadcrumb-title.tsx`
- Test: `src/components/breadcrumb-title.test.tsx`

**Interfaces:**
- Consumes: nothing project-specific -- `usePathname` from `next/navigation`, React.
- Produces (used by Tasks 2-6):
  - `BreadcrumbTitleProvider({ children }: { children: React.ReactNode })` -- a component.
  - `useBreadcrumbTitles(): Record<string, string>` -- read hook, returns `{}` when no provider is mounted.
  - `SetBreadcrumbTitle({ title }: { title: string })` -- renders nothing; registers `title` under the current pathname while mounted, clears it on unmount or when `title`/pathname changes. A falsy `title` (empty string) registers nothing.

- [ ] **Step 1: Write the failing test**

Create `src/components/breadcrumb-title.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { setPathname } from "@/test/next-navigation";

import {
  BreadcrumbTitleProvider,
  SetBreadcrumbTitle,
  useBreadcrumbTitles,
} from "./breadcrumb-title";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function Reader() {
  const titles = useBreadcrumbTitles();
  return <div data-testid="titles">{JSON.stringify(titles)}</div>;
}

function readTitles(testId: HTMLElement) {
  return JSON.parse(testId.textContent ?? "{}");
}

describe("BreadcrumbTitleProvider / SetBreadcrumbTitle / useBreadcrumbTitles", () => {
  it("registers a title for the current pathname", () => {
    setPathname("/articles/42");
    const { getByTestId } = render(
      <BreadcrumbTitleProvider>
        <SetBreadcrumbTitle title="My Article" />
        <Reader />
      </BreadcrumbTitleProvider>,
    );

    expect(readTitles(getByTestId("titles"))).toEqual({ "/articles/42": "My Article" });
  });

  it("clears the title when the registering component unmounts", () => {
    setPathname("/articles/42");
    function Wrapper({ show }: { show: boolean }) {
      return (
        <BreadcrumbTitleProvider>
          {show && <SetBreadcrumbTitle title="My Article" />}
          <Reader />
        </BreadcrumbTitleProvider>
      );
    }
    const { getByTestId, rerender } = render(<Wrapper show={true} />);
    expect(readTitles(getByTestId("titles"))).toEqual({ "/articles/42": "My Article" });

    rerender(<Wrapper show={false} />);
    expect(readTitles(getByTestId("titles"))).toEqual({});
  });

  it("last write wins when two components register the same href", () => {
    setPathname("/articles/42");
    const { getByTestId } = render(
      <BreadcrumbTitleProvider>
        <SetBreadcrumbTitle title="First" />
        <SetBreadcrumbTitle title="Second" />
        <Reader />
      </BreadcrumbTitleProvider>,
    );

    expect(readTitles(getByTestId("titles"))).toEqual({ "/articles/42": "Second" });
  });

  it("returns no titles when nothing is registered and no provider is mounted", () => {
    const { getByTestId } = render(<Reader />);
    expect(readTitles(getByTestId("titles"))).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/breadcrumb-title.test.tsx`
Expected: FAIL -- `Cannot find module './breadcrumb-title'` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/components/breadcrumb-title.tsx`:

```tsx
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/breadcrumb-title.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/breadcrumb-title.tsx src/components/breadcrumb-title.test.tsx
git commit -m "feat(breadcrumbs): add a client-side record-title registry"
```

---

### Task 2: Wire the registry into `RouteBreadcrumbs` and the app layout

**Files:**
- Modify: `src/components/route-breadcrumbs.tsx`
- Modify: `src/app/(app)/layout.tsx`
- Test: `src/components/route-breadcrumbs.test.tsx`

**Interfaces:**
- Consumes: `useBreadcrumbTitles`, `BreadcrumbTitleProvider`, `SetBreadcrumbTitle` from `@/components/breadcrumb-title` (Task 1).
- Produces: no new exports -- `RouteBreadcrumbs`'s own props/behavior are unchanged from the outside (still `<RouteBreadcrumbs />`, no props). Tasks 3-6 depend only on `SetBreadcrumbTitle` from Task 1, not on anything in this task.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/route-breadcrumbs.test.tsx` (keep the three existing tests as-is; add these, and add the new imports at the top of the file):

```tsx
import { setPathname } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { BreadcrumbTitleProvider, SetBreadcrumbTitle } from "./breadcrumb-title";
import { RouteBreadcrumbs } from "./route-breadcrumbs";
```

(Replace the existing top-of-file imports with the above -- it is the same two imports plus the new `breadcrumb-title` one.)

Then add, inside the existing `describe("RouteBreadcrumbs", ...)` block:

```tsx
  it("shows a registered record title instead of the raw id", () => {
    setPathname("/articles/42");
    const { container } = renderWithProviders(
      <BreadcrumbTitleProvider>
        <SetBreadcrumbTitle title="A very specific article title" />
        <RouteBreadcrumbs />
      </BreadcrumbTitleProvider>,
    );

    expect(itemTexts(container)).toEqual(["Articles", "A very specific article title"]);

    const truncated = container.querySelector('[title="A very specific article title"]');
    expect(truncated).not.toBeNull();
    expect(truncated?.classList.contains("truncate")).toBe(true);
  });

  it("falls back to the raw id when no title is registered", () => {
    setPathname("/articles/42");
    const { container } = renderWithProviders(
      <BreadcrumbTitleProvider>
        <RouteBreadcrumbs />
      </BreadcrumbTitleProvider>,
    );

    expect(itemTexts(container)).toEqual(["Articles", "42"]);
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/components/route-breadcrumbs.test.tsx`
Expected: the four pre-existing tests still PASS; the two new tests FAIL (the title is not yet read from any registry, so the breadcrumb still shows "42").

- [ ] **Step 3: Update `RouteBreadcrumbs`**

Replace the full contents of `src/components/route-breadcrumbs.tsx` with:

```tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { useBreadcrumbTitles } from "@/components/breadcrumb-title";
import { breadcrumbsFor } from "@/lib/nav";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export function RouteBreadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations();
  const titles = useBreadcrumbTitles();
  const crumbs = breadcrumbsFor(pathname);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          // A crumb carries either a catalog key (a known route) or a literal
          // record id that must not be translated -- see Crumb in lib/nav.ts.
          // Discriminating on the field name rather than on "does the string
          // contain a dot?" is both typecheckable and correct for an id that
          // happens to contain one.
          const isRecordSegment = !("labelKey" in crumb);
          // A detail page may have registered the record's own title for this
          // href (see SetBreadcrumbTitle in breadcrumb-title.tsx); fall back
          // to the raw segment (the id) when nothing was registered.
          const registeredTitle = isRecordSegment ? titles[crumb.href] : undefined;
          const label = "labelKey" in crumb ? t(crumb.labelKey) : registeredTitle ?? crumb.label;
          const content = registeredTitle ? (
            <span className="inline-block max-w-40 truncate align-bottom" title={label}>
              {label}
            </span>
          ) : (
            label
          );
          return (
            // BreadcrumbSeparator is a sibling of BreadcrumbItem here, not a
            // child of it -- both render an <li>, and nesting one inside the
            // other is invalid HTML that the browser silently reparents,
            // producing a hydration mismatch (server tree vs. the DOM the
            // browser actually built).
            <React.Fragment key={crumb.href}>
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{content}</BreadcrumbPage>
                ) : (
                  // Base UI's render prop, not Radix's asChild -- see app-sidebar.tsx.
                  <BreadcrumbLink render={<Link href={crumb.href} />}>{content}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
```

- [ ] **Step 4: Wrap the layout's chrome in the provider**

In `src/app/(app)/layout.tsx`, add the import:

```tsx
import { BreadcrumbTitleProvider } from "@/components/breadcrumb-title";
```

Then change the returned JSX so `<SidebarInset>`'s children are wrapped in the provider (only the `<header>` and the content `<div>` move inside it -- `SidebarProvider`, `AppSidebar` and `SidebarInset` itself are unchanged):

```tsx
      <SidebarInset>
        <BreadcrumbTitleProvider>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
            <SidebarTrigger />
            <RouteBreadcrumbs />
          </header>
          {/* A <div>, deliberately not a <main>: SidebarInset already renders the
              <main> landmark (see src/components/ui/sidebar.tsx), and nesting a
              second one is non-conforming HTML that hands assistive tech two
              "main" regions to choose between. It produces no hydration warning
              and no lint error, so nothing catches it automatically. The padding
              lives here rather than on SidebarInset's className because the
              header above must stay flush with the border. */}
          <div className="flex-1 p-3 md:p-6">{children}</div>
        </BreadcrumbTitleProvider>
      </SidebarInset>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/route-breadcrumbs.test.tsx src/components/breadcrumb-title.test.tsx`
Expected: PASS (6 + 4 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/route-breadcrumbs.tsx src/components/route-breadcrumbs.test.tsx src/app/\(app\)/layout.tsx
git commit -m "feat(breadcrumbs): prefer a registered record title over the raw id"
```

---

### Task 3: Wire the tags detail page

**Files:**
- Modify: `src/app/(app)/tags/[id]/page.tsx`

**Interfaces:**
- Consumes: `SetBreadcrumbTitle` from `@/components/breadcrumb-title` (Task 1). `tag.name: string` from `getTag()` (existing).

This page has no colocated test today (it is an async server component -- see CLAUDE.md's "async server components cannot be rendered by testing-library"), so this task is verified by typecheck and a manual check, not a new automated test.

- [ ] **Step 1: Add the import and the registration**

In `src/app/(app)/tags/[id]/page.tsx`, add the import:

```tsx
import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
```

Then add `<SetBreadcrumbTitle title={tag.name} />` as the first child of the returned `<div>`:

```tsx
  return (
    <div className="space-y-4">
      <SetBreadcrumbTitle title={tag.name} />
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>
      <TagForm tag={tag} />
    </div>
  );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/tags/[id]/page.tsx"
git commit -m "feat(breadcrumbs): show the tag name in its breadcrumb"
```

---

### Task 4: Wire the feeds detail page

**Files:**
- Modify: `src/app/(app)/feeds/[id]/page.tsx`

**Interfaces:**
- Consumes: `SetBreadcrumbTitle` from `@/components/breadcrumb-title` (Task 1). `feed.name: string` from `getFeed()` (existing -- already used in this page's `<h1>`).

- [ ] **Step 1: Add the import and the registration**

In `src/app/(app)/feeds/[id]/page.tsx`, add the import:

```tsx
import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
```

Then add `<SetBreadcrumbTitle title={feed.name} />` as the first child of the returned `<div>`:

```tsx
  return (
    <div className="space-y-4">
      <SetBreadcrumbTitle title={feed.name} />
      <h1 className="text-2xl font-semibold">{t("editTitle", { name: feed.name })}</h1>
      <FeedForm feed={feed} capabilities={capabilities} allTags={allTags.rows} />
    </div>
  );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/feeds/[id]/page.tsx"
git commit -m "feat(breadcrumbs): show the feed name in its breadcrumb"
```

---

### Task 5: Wire the users detail page

**Files:**
- Modify: `src/app/(app)/users/[id]/page.tsx`

**Interfaces:**
- Consumes: `SetBreadcrumbTitle` from `@/components/breadcrumb-title` (Task 1). `displayNameFor` from `@/lib/avatar` (existing) -- takes `Pick<AvatarUser, "firstName" | "lastName" | "email">`, all present on the `user` row this page already loads via `getUser()`.

- [ ] **Step 1: Add the imports and the registration**

In `src/app/(app)/users/[id]/page.tsx`, add the imports:

```tsx
import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { displayNameFor } from "@/lib/avatar";
```

Then add `<SetBreadcrumbTitle title={displayNameFor(user)} />` as the first child of the returned `<div>`:

```tsx
  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumbTitle title={displayNameFor(user)} />
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>
```

(Leave the rest of the JSX -- `UserForm`, `Separator`, `DeleteUserSection` -- untouched.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/users/[id]/page.tsx"
git commit -m "feat(breadcrumbs): show the user's display name in its breadcrumb"
```

---

### Task 6: Wire the articles detail page

**Files:**
- Modify: `src/app/(app)/articles/[id]/page.tsx`

**Interfaces:**
- Consumes: `SetBreadcrumbTitle` from `@/components/breadcrumb-title` (Task 1). `article.name: string` from `getArticle()` -- **the articles table's human-readable title column is named `name`**, not `title` (confirmed in `src/lib/db/schema/articles.ts` and used as the label in `src/components/articles/article-form.tsx`).

Unlike the other three pages, this page's row is loaded inside `GeneralSection`, an async component rendered inside a `<Suspense>` boundary -- not at the top of the page. `SetBreadcrumbTitle` is registered there, once the article has resolved (and after the existing `notFound()` check), not in the page's top-level JSX.

- [ ] **Step 1: Add the import and the registration**

In `src/app/(app)/articles/[id]/page.tsx`, add the import:

```tsx
import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
```

Then update `GeneralSection` to render it alongside the form:

```tsx
async function GeneralSection({ id }: { id: number }) {
  const [article, feedsRes] = await Promise.all([
    getArticle(id),
    listFeeds(parseListParams({ pageSize: "100" })),
  ]);

  if (!article) {
    notFound();
  }

  return (
    <>
      <SetBreadcrumbTitle title={article.name} />
      <ArticleForm article={article} feeds={feedsRes.rows} />
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/articles/[id]/page.tsx"
git commit -m "feat(breadcrumbs): show the article name in its breadcrumb"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full CI check**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all four pass. If `format:check` fails, run `npm run format` and re-stage the affected files from Tasks 1-6 (do not hand-fix formatting).

- [ ] **Step 2: Manual check in the dev server**

Run: `npm run dev`, then in a browser (or the Browser pane's preview tools):
- Sign in, open a feed, click into one of its articles. Confirm the breadcrumb reads ".../Feeds/\<feed name\>/Articles/\<article name\>" (article breadcrumbs sit under `/articles`, not nested under the feed, per `NAV_ITEMS` -- just confirm `/articles/<id>` itself shows the article's name).
- Open a tag and a feed directly from their list pages; confirm each breadcrumb shows the tag/feed name, not the numeric id.
- As an admin, open a user's edit page; confirm the breadcrumb shows their display name (first + last name, or email if both are blank).
- Give one record a long name (30+ characters) and confirm the breadcrumb segment truncates with an ellipsis and shows the full name on hover (via the `title` attribute).
- Navigate from a detail page back to its list page and confirm the breadcrumb does not keep showing the old title for the list page's own segment (the registry entry is scoped to the detail page's href, so this should already hold -- this step is a sanity check, not a fix).

- [ ] **Step 3: Report results**

No commit for this task -- it verifies Tasks 1-6, which are already committed. If anything fails, fix it within the task where it belongs and re-run that task's checks before re-running Task 7.
