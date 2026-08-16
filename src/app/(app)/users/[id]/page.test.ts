import { describe, expect, it, vi } from "vitest";

/**
 * The session gate and the db-backed lookup, stubbed -- and only those.
 * `EditUserPage` awaits `requireAdmin()` as its first statement (CLAUDE.md:
 * it is what opts the route out of prerendering, and it must stay first), so
 * this stub has to resolve rather than throw for the rest of the page body to
 * run and reach `getUser()`. See the equivalent comment on
 * `../../feeds/[id]/page.test.ts` for why only these two are stubbed.
 */
vi.mock("@/lib/auth/session", () => ({ requireAdmin: vi.fn(async () => undefined) }));
vi.mock("@/lib/users/queries", () => ({ getUser: vi.fn(async () => null) }));

import EditUserPage from "./page";

/**
 * `EditUserPage` awaits `getUser()` after its `requireAdmin()` gate and calls
 * the real `notFound()` when it returns nothing -- the same "detail route
 * awaits its row at the top" rule `../../feeds/[id]/page.test.ts` pins. See
 * that file's comment for where the asserted sentinel string comes from.
 */
describe("/users/[id] page", () => {
  it("throws Next's not-found sentinel for an id with no user, instead of rendering", async () => {
    await expect(
      EditUserPage({ params: Promise.resolve({ id: "does-not-exist" }) }),
    ).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});
