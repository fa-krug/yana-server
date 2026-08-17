import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { TagsChrome } from "./tags-chrome";

// `<SearchFilterBar>` (inside `<TagsChrome>`) calls `usePathname()` and
// `useRouter()` -- see `src/test/next-navigation.ts` for why this is a router
// stub, not a data mock.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/tags");
  setSearchParams("");
});

/**
 * Carries forward the assertions `src/app/(app)/tags/loading.test.tsx` used
 * to make against this same chrome, before that file was deleted as part of
 * the instant-render-no-fallback migration. `TagsChrome` is now a Client
 * Component reading `useTranslations()` directly, so it needs no
 * `next-intl/server` stub the way the old fallback test did -- it renders
 * under `renderWithProviders()`'s real `NextIntlClientProvider` like any
 * other client component here.
 *
 * The reserved-pagination-row assertion the old fallback test also made is
 * dropped here on purpose: `<PaginationPlaceholder>` is already covered
 * directly by `src/components/crud/pagination.test.tsx`, and was only ever a
 * detail of the deleted route-level fallback, not of this chrome.
 */
describe("TagsChrome", () => {
  it("renders the title, the New tag link and the search box", () => {
    renderWithProviders(<TagsChrome />);

    expect(screen.getByText("Tags")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New tag" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search tags" })).toBeTruthy();
  });
});
