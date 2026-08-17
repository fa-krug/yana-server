import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

/**
 * The instant-render-no-fallback migration removed this route's real 404
 * (see `src/app/(app)/settings/page.tsx`'s doc comment, and the "detail
 * routes" section of `docs/superpowers/plans/2026-08-17-instant-render-no-fallback.md`):
 * `getFeed()` returning `null` used to throw Next's not-found sentinel from
 * an **awaited** page body, and this file used to assert exactly that
 * (`rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)`). The user was shown
 * that trade-off explicitly and chose instant rendering over real 404s, so
 * this is rewritten rather than deleted: the page body now awaits nothing,
 * and a missing/unowned id renders the same not-found state instead of
 * throwing.
 */
vi.mock("@/lib/feeds/actions", () => ({
  getFeed: vi.fn(async () => null),
  capabilitiesFor: vi.fn(async () => ({ youtube: false, reddit: false, ai: false })),
  createFeed: vi.fn(),
  updateFeed: vi.fn(),
  updateFeedsBulk: vi.fn(),
}));
vi.mock("@/lib/tags/queries", () => ({ listTags: vi.fn(async () => ({ rows: [] })) }));
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));
vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/aggregators/search", () => ({ searchFeedIdentifier: vi.fn() }));

import EditFeedPage from "./page";

describe("/feeds/[id] page", () => {
  it("returns its element tree synchronously -- no awaited row read", () => {
    const result = EditFeedPage({ params: Promise.resolve({ id: "999999" }) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders the not-found state for an id with no feed, instead of throwing", async () => {
    // `use()` suspends on the feed promise on the very first render, then
    // resumes once it settles -- a microtask-scale gap `act()` has to span,
    // or the resumed render commits outside any act scope and this assertion
    // races it (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(EditFeedPage({ params: Promise.resolve({ id: "999999" }) }));
    });

    expect(screen.getByText("Not found")).toBeTruthy();
    expect(
      screen.getByText("This item doesn't exist, or you don't have access to it."),
    ).toBeTruthy();
  });
});
