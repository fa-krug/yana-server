import { screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import en from "../../../messages/en.json";
import Loading from "./loading";

/**
 * `next-intl/server` resolves to next-intl's non-RSC build under Vitest,
 * which has no `react-server` export condition to select the real one --
 * there, `getTranslations()` throws "not supported in Client Components" the
 * instant it is called. `createTranslator()` (from `next-intl` itself, not
 * its server entry) is the client-safe factory the real implementation
 * builds on, so this reads the real `en.json` catalog rather than inventing
 * message text -- only the request-scoped plumbing around it is stubbed. See
 * `src/app/(app)/ai/loading.test.tsx` for the same pattern.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as never }),
}));

/**
 * `Loading` is an async Server Component, which testing-library cannot render.
 * Calling it and rendering what it resolves to is the one case where that
 * works: its output is synchronous (a translation lookup, then real client
 * components), so there is no reshaping of production code involved -- see
 * CLAUDE.md and `src/app/(app)/layout.test.tsx` for the same technique.
 *
 * The point of this test is the defect the whole migration exists to fix:
 * this route's fallback used to render five whole `<CardSkeleton>`s (titles
 * included) plus one more for the recent-articles card. It now renders the
 * real `StatCardsView`/`RecentArticlesView` chassis, with only the numbers
 * and the article list replaced -- so a regression back to a whole-card
 * skeleton fails here instead of only being noticed in a browser.
 *
 * It also covers a second, later defect: this fallback used to omit
 * `<SectionCards>` entirely, so the whole section popped in once
 * `DashboardPage` itself resolved. It now renders the non-admin subset
 * unconditionally (`isAdmin` cannot be known without a fresh, uncached
 * session read this file must not perform) -- see this file's own doc
 * comment above for why.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the dashboard's (`/`) loading fallback", () => {
  it("renders every stat card's real frame, icon and title, with only the number pending", async () => {
    await renderLoading();

    // Four real cards with their real titles. "Feeds" and "Tags" each match
    // twice once `<SectionCards>` also renders (its nav labels reuse the same
    // words), so those two are asserted by count rather than `getByText`.
    expect(screen.getByText("Unread articles")).toBeTruthy();
    expect(screen.getByText("Total articles")).toBeTruthy();
    expect(screen.getAllByText("Feeds").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Tags").length).toBeGreaterThanOrEqual(1);

    // No number is known yet -- none of the real counts render.
    expect(screen.queryByText(/^\d+$/)).toBeNull();

    // The recent-articles card's real heading is present.
    expect(screen.getByText("Latest unread")).toBeTruthy();

    // The dashboard's own heading, real.
    expect(screen.getByText("Dashboard")).toBeTruthy();

    // The deliberate exception: a skeleton stands in for each card's number
    // and for the recent-articles list body -- nowhere else.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("renders the non-admin section cards immediately, never the admin-only ones", async () => {
    await renderLoading();

    // The section-cards grid heading, and a non-admin-only entry's
    // description -- unique text, since the nav label itself ("Feeds") also
    // appears as a stat-card title.
    expect(screen.getByText("Manage")).toBeTruthy();
    expect(screen.getByText("Add, edit and organise the feeds you follow.")).toBeTruthy();

    // The admin-only entry (`/users`) never appears here, since `isAdmin`
    // cannot be known without the fresh session read this file must not
    // perform.
    expect(screen.queryByText("Manage user accounts on this instance.")).toBeNull();
  });
});
