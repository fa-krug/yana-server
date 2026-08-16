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
  setPathname("/users");
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
 * The point of this test is the drift bug this fix closes: this fallback used
 * to omit `<Pagination>`'s space entirely, so that row popped in once
 * `UsersPage` resolved. It now renders `<PaginationPlaceholder>`, the same
 * reserved-height row the page's own `<Suspense fallback>` for it uses.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /users route's loading fallback", () => {
  it("reserves the pagination row's space alongside the rest of the chrome", async () => {
    await renderLoading();

    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New user" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search by name or email" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Role" })).toBeTruthy();

    // The pagination row's space is reserved, but offers nothing yet.
    expect(document.querySelector('nav[aria-hidden="true"]')).toBeTruthy();
  });
});
