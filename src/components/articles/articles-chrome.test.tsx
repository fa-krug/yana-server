import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { ArticlesChrome, type ArticleFilterOptions } from "./articles-chrome";

// `<SearchFilterBar>` (inside `<ArticlesChrome>`) calls `usePathname()` and
// `useRouter()` -- see `src/test/next-navigation.ts` for why this is a router
// stub, not a data mock.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/articles");
  setSearchParams("");
});

const OPTIONS: ArticleFilterOptions = {
  feeds: [{ value: "1", label: "A Feed" }],
  tags: [{ value: "2", label: "A Tag", color: "blue" }],
};

/**
 * Carries forward two assertions `src/app/(app)/articles/loading.test.tsx`
 * used to make, before that file was deleted as part of the
 * instant-render-no-fallback migration: the search box renders, and
 * -- while the filter options are still unresolved -- no filter dropdowns are
 * shown at all, rather than a placeholder guess. That reasoning now lives in
 * a real `<Suspense>` boundary instead of a route-level fallback (see
 * `articles-chrome.tsx`'s own doc comment), so this test drives it with a
 * deferred promise instead of rendering a separate fallback component.
 *
 * The reserved-pagination-row assertion the old fallback test also made is
 * dropped here on purpose: `<PaginationPlaceholder>` is already covered
 * directly by `src/components/crud/pagination.test.tsx`, and was only ever a
 * detail of the deleted route-level fallback, not of this chrome.
 */
describe("ArticlesChrome", () => {
  it("renders the search box immediately, with no title and no filters until resolved", async () => {
    // A deferred promise, resolved under an explicit `act()` -- React 19's
    // `use()` registers its continuation as a bare promise `.then()`, which
    // lands outside any `act()` scope unless the resolution itself is
    // wrapped. See `src/components/dashboard/stat-cards.test.tsx` for the
    // identical pattern.
    let resolveOptions!: (value: ArticleFilterOptions) => void;
    const promise = new Promise<ArticleFilterOptions>((resolve) => {
      resolveOptions = resolve;
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = renderWithProviders(<ArticlesChrome optionsPromise={promise} />));
    });

    // Pending first: the search box is real, no title (the breadcrumb
    // already names the page) and no filters guessed at.
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search articles" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();

    await act(async () => {
      resolveOptions(OPTIONS);
      await promise;
    });

    // Then all four filter selects appear, populated with the real options.
    expect(screen.getByRole("combobox", { name: "Feed" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Read state" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Starred state" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Tag" })).toBeTruthy();
  });
});
