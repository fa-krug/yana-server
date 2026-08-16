import { screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import en from "../../../../messages/en.json";
import Loading from "./loading";

// `<SearchFilterBar>` calls `usePathname()` and `useRouter()` -- see
// `src/test/next-navigation.ts` for why this is a router stub, not a data mock.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/articles");
  setSearchParams("");
});

/**
 * `next-intl/server` resolves to next-intl's non-RSC build under Vitest,
 * which has no `react-server` export condition to select the real one --
 * there, `getTranslations()` throws "not supported in Client Components" the
 * instant it is called. `createTranslator()` (from `next-intl` itself, not
 * its server entry) is the client-safe factory the real implementation
 * builds on, so this reads the real `en.json` catalog rather than inventing
 * message text -- only the request-scoped plumbing around it is stubbed. See
 * `src/app/(app)/integrations/loading.test.tsx` for the same pattern.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as never }),
}));

/**
 * `Loading` is an async Server Component, which testing-library cannot render.
 * Calling it and rendering what it resolves to is the one case where that
 * works: its output is synchronous, so there is no reshaping of production
 * code involved -- see CLAUDE.md and `src/app/(app)/layout.test.tsx` for the
 * same technique.
 *
 * This route's missing `filters` prop is deliberate and untouched -- the
 * options come from `listFeeds()`/`listTags()` DB reads this fallback must
 * not perform, see this route's own `loading.tsx` doc comment. The point of
 * this test is the one drift bug that *is* being fixed here: the pagination
 * row's space used to be omitted entirely, popping in once `ArticlesPage`
 * resolved. It now renders `<PaginationPlaceholder>`, the same reserved-height
 * row the page's own `<Suspense fallback>` for it uses.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /articles route's loading fallback", () => {
  it("reserves the pagination row's space, with filters still deliberately absent", async () => {
    await renderLoading();

    expect(screen.getByText("Articles")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search articles" })).toBeTruthy();

    // Filters are genuinely unknown here -- still absent, on purpose.
    expect(screen.queryByRole("combobox")).toBeNull();

    // The pagination row's space is reserved, but offers nothing yet.
    expect(document.querySelector('nav[aria-hidden="true"]')).toBeTruthy();
  });
});
