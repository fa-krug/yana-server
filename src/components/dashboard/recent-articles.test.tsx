import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import type { RecentArticle } from "@/lib/dashboard/queries";

import { RecentArticles, RecentArticlesView } from "./recent-articles";

const ARTICLES: RecentArticle[] = [
  {
    id: 1,
    name: "First article",
    date: new Date("2026-08-10T12:00:00Z"),
    feedName: "Feed One",
  },
  {
    id: 2,
    name: "Second article",
    date: new Date("2026-08-09T08:30:00Z"),
    feedName: "Feed Two",
  },
];

describe("RecentArticlesView", () => {
  it("renders the empty state when there are no articles", () => {
    // German, since the English empty-state copy differs enough on its own,
    // but asserting against the translated string keeps this test honest about
    // which catalog it read.
    const { getByText } = renderWithProviders(<RecentArticlesView articles={[]} />, {
      locale: "de",
    });

    expect(getByText("Keine ungelesenen Artikel.")).not.toBeNull();
    const cta = getByText("Feed hinzufügen");
    expect(cta.closest("a")?.getAttribute("href")).toBe("/feeds/new");
  });

  it("links each row to /articles/{id}", () => {
    const { getByText } = renderWithProviders(<RecentArticlesView articles={ARTICLES} />);

    const first = getByText("First article").closest("a");
    const second = getByText("Second article").closest("a");
    expect(first?.getAttribute("href")).toBe("/articles/1");
    expect(second?.getAttribute("href")).toBe("/articles/2");
  });

  it("shows the feed name and a UTC-formatted date beneath each title", () => {
    const { getByText } = renderWithProviders(<RecentArticlesView articles={ARTICLES} />);

    // The pinned "UTC" formatter timezone from renderWithProviders means this
    // instant renders as Aug 10, 2026 regardless of the machine running the
    // test -- not August 9 or 11, which is what an unpinned formatter risks.
    expect(getByText(/Feed One/)).not.toBeNull();
    expect(getByText(/Aug 10, 2026/)).not.toBeNull();
  });

  it("renders the card frame and heading while the list is still loading", () => {
    // The defect this whole migration exists to fix: this card used to be a
    // whole <CardSkeleton>, heading included. The frame and heading need no
    // data -- only the list does -- so they must be on screen from the first
    // frame; the list body is genuinely unknowable in length, so a skeleton
    // there is correct (same reasoning as /account's passkey/device lists).
    renderWithProviders(<RecentArticlesView pending />);

    expect(screen.getByText("Latest unread")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("No unread articles.")).toBeNull();
  });

  it("shows the resolved list once the promise settles", async () => {
    // A deferred promise, resolved under an explicit `act()` -- see
    // src/components/dashboard/stat-cards.test.tsx for why.
    let resolveArticles!: (value: RecentArticle[]) => void;
    const promise = new Promise<RecentArticle[]>((resolve) => {
      resolveArticles = resolve;
    });

    await act(async () => {
      renderWithProviders(<RecentArticles promise={promise} />);
    });

    // Pending first: real heading, no list yet.
    expect(screen.getByText("Latest unread")).toBeTruthy();
    expect(screen.queryByText("First article")).toBeNull();

    await act(async () => {
      resolveArticles(ARTICLES);
      await promise;
    });

    // Then the list fills in, with no skeleton left.
    expect(screen.getByText("First article")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });
});
