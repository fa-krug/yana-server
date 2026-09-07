import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { FeedsChrome } from "./feeds-chrome";

// `<SearchFilterBar>` (inside `<FeedsChrome>`) calls `usePathname()` and
// `useRouter()` -- see `src/test/next-navigation.ts` for why this is a router
// stub, not a data mock.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/feeds");
  setSearchParams("");
});

/**
 * Carries forward the assertion `src/app/(app)/feeds/loading.test.tsx` used
 * to make against this same component, before that file was deleted as part
 * of the instant-render-no-fallback migration. `FeedsChrome` is now a Client
 * Component reading `useTranslations()` directly, so it needs no
 * `next-intl/server` stub the way the old fallback test did -- it renders
 * under `renderWithProviders()`'s real `NextIntlClientProvider` like any
 * other client component here.
 *
 * The defect this guards against: `/feeds` once rendered only the "New feed"
 * link -- no Export OPML link, no `<ImportOpmlButton>`, and no filter
 * dropdowns at all. Deleting the fallback test without replacing it would
 * have reopened that hole silently, since nothing else in the suite asserts
 * on this component's own output.
 */
describe("FeedsChrome", () => {
  it("renders every header action and both filter dropdowns, but no title", () => {
    const { container } = renderWithProviders(<FeedsChrome />);

    // All three header actions.
    expect(screen.getByRole("link", { name: "Export all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import OPML" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New feed" })).toBeTruthy();

    // Both filter dropdowns, real and populated.
    expect(screen.getByRole("combobox", { name: "Aggregator" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Enabled" })).toBeTruthy();

    // The search box -- and no page heading: the breadcrumb already names
    // the page.
    expect(screen.getByRole("searchbox", { name: "Search feeds" })).toBeTruthy();
    expect(container.querySelector("h1")).toBeNull();
  });
});
