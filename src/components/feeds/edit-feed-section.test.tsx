import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { EditFeedSection } from "./edit-feed-section";
import type { FeedListRow } from "./feed-form";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/feeds/actions", () => ({
  createFeed: vi.fn(),
  updateFeed: vi.fn(),
  updateFeedsBulk: vi.fn(),
}));
vi.mock("@/lib/aggregators/search", () => ({ searchFeedIdentifier: vi.fn() }));

const feed: FeedListRow = {
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
  tags: [],
};

/**
 * The happy path: `edit-feed-section.tsx` had only a not-found-shaped
 * verification before this (via `/feeds/[id]/page.test.tsx`'s mocked
 * `getFeed() => null`) -- a regression that made this component always
 * render `<RecordNotFound>` regardless of what the feed promise resolved to
 * would have shipped green. This pins the resolved path: a real feed renders
 * the real, already-filled-in form and its interpolated title, not the
 * not-found state.
 */
describe("EditFeedSection", () => {
  it("renders the real form and the feed-name title once the feed promise resolves", async () => {
    // `use()` suspends on the feed promise on the very first render, then
    // resumes once it settles -- a microtask-scale gap `act()` has to span
    // (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(
        <EditFeedSection
          feedPromise={Promise.resolve(feed)}
          capabilitiesPromise={Promise.resolve({ youtube: false, reddit: false, ai: false })}
          allTagsPromise={Promise.resolve([])}
        />,
      );
    });

    // The catalog's `feeds.editTitle` ("Edit feed") carries no `{name}`
    // placeholder -- the `t("editTitle", { name: feed.name })` call's extra
    // argument is ignored by next-intl -- so the interpolation this
    // component's own doc comment describes is aspirational for this key; the
    // real assertion is that the resolved feed's own name reaches the form.
    expect(screen.getByText("Edit feed")).toBeTruthy();
    expect(screen.getByDisplayValue("Example feed")).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it("renders the not-found state when the feed promise resolves to null", async () => {
    await act(async () => {
      renderWithProviders(
        <EditFeedSection
          feedPromise={Promise.resolve(null)}
          capabilitiesPromise={Promise.resolve({ youtube: false, reddit: false, ai: false })}
          allTagsPromise={Promise.resolve([])}
        />,
      );
    });

    expect(screen.getByText("Not found")).toBeTruthy();
  });
});
