import { describe, expect, it, vi } from "vitest";

/**
 * The db-backed lookup, stubbed -- and only that. `EditUserPage` no longer
 * awaits `requireAdmin()` itself: the gate moved inside `getUser()`
 * (`src/lib/users/queries.ts`) with the instant-render-no-fallback migration,
 * and what it refuses a non-admin is covered against a real database in
 * `src/lib/users/users.test.ts`. Stubbing `getUser()` therefore stubs the gate
 * along with the read, which is the point here: this file is about what the
 * *page* does with an empty result. See the equivalent comment on
 * `../../feeds/[id]/page.test.ts` for why nothing else is stubbed.
 */
vi.mock("@/lib/users/queries", () => ({ getUser: vi.fn(async () => null) }));

import EditUserPage from "./page";

/**
 * `EditUserPage` awaits `getUser()` -- which carries the gate -- and calls
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
