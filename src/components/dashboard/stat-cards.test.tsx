import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import type { DashboardStats } from "@/lib/dashboard/queries";

import { StatCards, StatCardsView } from "./stat-cards";

const STATS: DashboardStats = {
  unreadArticles: 7,
  totalArticles: 42,
  enabledFeeds: 3,
  totalFeeds: 5,
  tags: 9,
};

describe("StatCardsView", () => {
  it("renders the unread count and links it to /articles?read=false", () => {
    const { getByText } = renderWithProviders(<StatCardsView stats={STATS} />);

    const value = getByText("7");
    const card = value.closest("a");
    expect(card?.getAttribute("href")).toBe("/articles?read=false");
  });

  it("renders the feeds tile as enabled of total", () => {
    const { getByText } = renderWithProviders(<StatCardsView stats={STATS} />);

    expect(getByText("3 of 5")).not.toBeNull();
  });

  it("translates the stat labels", () => {
    // German -- "Tags" is spelled the same in both catalogs, so this asserts
    // against a label that actually differs between them.
    const { getByText } = renderWithProviders(<StatCardsView stats={STATS} />, { locale: "de" });

    expect(getByText("Ungelesene Artikel")).not.toBeNull();
    expect(getByText("3 von 5")).not.toBeNull();
  });

  it("renders every card's frame and title while the count is still loading", () => {
    // The defect this whole migration exists to fix: this row used to be five
    // whole <CardSkeleton>s, titles included. The frame, icon and title need
    // no data -- only the number does -- so they must be on screen from the
    // first frame.
    renderWithProviders(<StatCardsView pending />);

    expect(screen.getByText("Unread articles")).toBeTruthy();
    expect(screen.getByText("Total articles")).toBeTruthy();
    expect(screen.getByText("Feeds")).toBeTruthy();
    expect(screen.getByText("Tags")).toBeTruthy();

    // Deliberate exception -- a skeleton stands in for each number alone.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
  });

  it("shows the resolved numbers once the promise settles", async () => {
    // A deferred promise, resolved under an explicit `act()` -- React 19's
    // `use()` registers its continuation as a bare promise `.then()`, which
    // lands outside any `act()` scope unless the resolution itself is wrapped.
    let resolveStats!: (value: DashboardStats) => void;
    const promise = new Promise<DashboardStats>((resolve) => {
      resolveStats = resolve;
    });

    await act(async () => {
      renderWithProviders(<StatCards promise={promise} />);
    });

    // Pending first: real frames, no number.
    expect(screen.getByText("Unread articles")).toBeTruthy();
    expect(screen.queryByText("7")).toBeNull();

    await act(async () => {
      resolveStats(STATS);
      await promise;
    });

    // Then the numbers fill in, with no skeleton left.
    expect(screen.getByText("7")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });
});
