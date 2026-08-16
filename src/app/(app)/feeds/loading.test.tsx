import { screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import en from "../../../../messages/en.json";
import Loading from "./loading";

// `<SearchFilterBar>` (inside `<FeedsChrome>`) calls `usePathname()` and
// `useRouter()` -- see `src/test/next-navigation.ts` for why this is a router
// stub, not a data mock.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/feeds");
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
 * The point of this test is the drift bug this fix closes: this route's
 * fallback used to render only the "New feed" link -- no Export OPML link, no
 * `<ImportOpmlButton>`, and no filter dropdowns at all, despite a doc comment
 * claiming the filters were already reproduced. It now renders `<FeedsChrome>`,
 * the exact same component `FeedsPage` itself renders, so the two cannot
 * drift apart again.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /feeds route's loading fallback", () => {
  it("renders every header action and both filter dropdowns", async () => {
    await renderLoading();

    // All three header actions -- the defect was that only "New feed" survived.
    expect(screen.getByRole("link", { name: "Export all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import OPML" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New feed" })).toBeTruthy();

    // Both filter dropdowns, real and populated -- AGGREGATOR_SPECS is
    // static, so both are cheap to render before any query resolves.
    expect(screen.getByRole("combobox", { name: "Aggregator" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Enabled" })).toBeTruthy();

    // The search box and the page heading.
    expect(screen.getByRole("searchbox", { name: "Search feeds" })).toBeTruthy();
    expect(screen.getByText("Feeds")).toBeTruthy();

    // The pagination row's space is reserved, but offers nothing yet.
    expect(document.querySelector('nav[aria-hidden="true"]')).toBeTruthy();
  });
});
