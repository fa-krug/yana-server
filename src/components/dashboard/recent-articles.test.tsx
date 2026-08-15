import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { RecentArticles } from "./recent-articles";

const ARTICLES = [
  {
    id: 1,
    name: "First article",
    date: new Date("2026-08-10T12:00:00Z"),
    feedId: 1,
    feedName: "Feed One",
  },
  {
    id: 2,
    name: "Second article",
    date: new Date("2026-08-09T08:30:00Z"),
    feedId: 2,
    feedName: "Feed Two",
  },
];

describe("RecentArticles", () => {
  it("renders the empty state when there are no articles", () => {
    // German, since the English empty-state copy differs enough on its own,
    // but asserting against the translated string keeps this test honest about
    // which catalog it read.
    const { getByText } = renderWithProviders(<RecentArticles articles={[]} />, { locale: "de" });

    expect(getByText("Noch keine ungelesenen Artikel.")).not.toBeNull();
    const cta = getByText("Feed hinzufügen");
    expect(cta.closest("a")?.getAttribute("href")).toBe("/feeds/new");
  });

  it("links each row to /articles/{id}", () => {
    const { getByText } = renderWithProviders(<RecentArticles articles={ARTICLES} />);

    const first = getByText("First article").closest("a");
    const second = getByText("Second article").closest("a");
    expect(first?.getAttribute("href")).toBe("/articles/1");
    expect(second?.getAttribute("href")).toBe("/articles/2");
  });

  it("shows the feed name and a UTC-formatted date beneath each title", () => {
    const { getByText } = renderWithProviders(<RecentArticles articles={ARTICLES} />);

    // The pinned "UTC" formatter timezone from renderWithProviders means this
    // instant renders as Aug 10, 2026 regardless of the machine running the
    // test -- not August 9 or 11, which is what an unpinned formatter risks.
    expect(getByText(/Feed One/)).not.toBeNull();
    expect(getByText(/Aug 10, 2026/)).not.toBeNull();
  });
});
