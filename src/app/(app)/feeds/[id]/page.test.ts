import { describe, expect, it, vi } from "vitest";

/**
 * The session read and the two db-backed lookups, stubbed -- and only those.
 * `@/lib/auth/session` is request-scoped plumbing over a native SQLite
 * driver, which does not belong in this test; `getFeed()` returning `null` is
 * the one thing this test is about. `capabilitiesFor()`/`listTags()` are
 * never reached on this path (the page's own `notFound()` throws before
 * either is called), but the module import still has to resolve, so they are
 * stubbed too rather than left to hit a real, unmigrated database.
 */
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/feeds/actions", () => ({
  getFeed: vi.fn(async () => null),
  capabilitiesFor: vi.fn(async () => ({ youtube: false, reddit: false, ai: false })),
}));
vi.mock("@/lib/tags/queries", () => ({ listTags: vi.fn(async () => ({ rows: [] })) }));

import EditFeedPage from "./page";

/**
 * `EditFeedPage` awaits `getFeed()` at the top of its body and calls the real
 * `notFound()` (from `next/navigation`) when it returns nothing -- CLAUDE.md's
 * "detail route awaits its row at the top" rule, which Task 7 preserved while
 * rewriting this route's `loading.tsx`. `notFound()` throws rather than
 * returning, so the regression this pins is "the page starts rendering a form
 * around a missing feed" -- which would surface as a resolved value here
 * instead of a rejection.
 *
 * The assertion is against the real sentinel Next 16 throws, confirmed by
 * reading `node_modules/next/dist/client/components/not-found.js`: the
 * thrown `Error`'s message (and `.digest`) is
 * `` `${HTTP_ERROR_FALLBACK_ERROR_CODE};404` ``, i.e. exactly
 * `"NEXT_HTTP_ERROR_FALLBACK;404"`.
 */
describe("/feeds/[id] page", () => {
  it("throws Next's not-found sentinel for an id with no feed, instead of rendering", async () => {
    await expect(EditFeedPage({ params: Promise.resolve({ id: "999999" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });
});
