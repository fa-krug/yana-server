import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { StatCards } from "./stat-cards";

const STATS = {
  unreadArticles: 7,
  totalArticles: 42,
  enabledFeeds: 3,
  totalFeeds: 5,
  tags: 9,
  activeJobs: 1,
};

describe("StatCards", () => {
  it("renders the unread count and links it to /articles?read=false", () => {
    const { getByText } = renderWithProviders(<StatCards stats={STATS} />);

    const value = getByText("7");
    const card = value.closest("a");
    expect(card?.getAttribute("href")).toBe("/articles?read=false");
  });

  it("renders the feeds tile as enabled of total", () => {
    const { getByText } = renderWithProviders(<StatCards stats={STATS} />);

    expect(getByText("3 of 5")).not.toBeNull();
  });

  it("translates the stat labels", () => {
    // German -- "Tags" is spelled the same in both catalogs, so this asserts
    // against a label that actually differs between them.
    const { getByText } = renderWithProviders(<StatCards stats={STATS} />, { locale: "de" });

    expect(getByText("Ungelesene Artikel")).not.toBeNull();
    expect(getByText("3 von 5")).not.toBeNull();
  });
});
