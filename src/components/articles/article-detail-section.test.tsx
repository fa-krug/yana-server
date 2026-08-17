import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import type { Article, Feed } from "@/lib/db/schema";

import { ArticleDetailSection } from "./article-detail-section";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/articles/actions", () => ({
  updateArticle: vi.fn(),
  reloadArticles: vi.fn(),
}));

const feed: Feed = {
  id: 5,
  name: "Example feed",
  aggregator: "full_website",
  identifier: "https://example.com",
  dailyLimit: 20,
  updateIntervalMinutes: 30,
  concurrency: 4,
  maxArticleAgeDays: 30,
  enabled: true,
  userId: "user-1",
  redditSubredditId: null,
  youtubeChannelId: null,
  options: {},
  logoSourceUrl: "",
  logoImageHash: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const article: Article & { feed: Feed } = {
  id: 1,
  name: "Example article",
  identifier: "https://example.com/a",
  rawContent: "",
  plainText: "",
  contentHash: null,
  date: new Date("2026-01-01T00:00:00Z"),
  read: false,
  starred: false,
  author: "",
  icon: null,
  feedId: 5,
  createdAt: new Date("2026-01-02T00:00:00Z"),
  updatedAt: new Date("2026-01-03T00:00:00Z"),
  feed,
};

/**
 * Carried forward from `/articles/[id]/loading.tsx`'s deleted test: "keeps
 * the content section's generic skeleton, since a block tree has no form
 * shape to mirror". The general section above it no longer renders any
 * skeleton bars once the article itself is known (it renders the real,
 * already-filled-in form instead -- see `article-form.test.tsx` for its
 * `pending` counterpart), so this pins that the content section is the one
 * place a plain `<TableSkeleton>` still legitimately appears.
 */
describe("ArticleDetailSection", () => {
  it("renders the not-found state when the article promise resolves to null", async () => {
    // `use()` suspends on the article promise on the very first render, then
    // resumes once it settles -- a microtask-scale gap `act()` has to span,
    // or the resumed render commits outside any act scope and this assertion
    // races it (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(
        <ArticleDetailSection
          articlePromise={Promise.resolve(null)}
          feedsPromise={Promise.resolve([])}
          blockTreePromise={Promise.resolve([])}
        />,
      );
    });

    expect(screen.getByText("Not found")).toBeTruthy();
  });

  it("shows the block tree's generic skeleton while it streams in, once the article is known", async () => {
    await act(async () => {
      renderWithProviders(
        <ArticleDetailSection
          articlePromise={Promise.resolve(article)}
          feedsPromise={Promise.resolve([{ id: 5, name: "Example feed" }])}
          blockTreePromise={new Promise(() => {})}
        />,
      );
    });

    expect(screen.getByDisplayValue("Example article")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.getByText("Content")).toBeTruthy();
  });
});
