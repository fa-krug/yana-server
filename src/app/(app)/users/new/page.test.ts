import { notFound } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

/**
 * `/users/new` is the one route the instant-render-no-fallback migration left
 * with its own awaited gate (see the page's own doc comment): unlike
 * `/users` and `/users/[id]`, which moved `requireAdmin()` into the data
 * layer (`listUsers()`/`getUser()`), this page has no data read to carry the
 * gate for it -- the create form starts empty -- so `await requireAdmin()`
 * is still the page body's first statement, and it still throws Next's
 * real not-found sentinel for a non-admin, exactly like every route did
 * before this migration (see the pre-migration shape this file is modelled
 * on: `git show c4af7a9b^:"src/app/(app)/users/[id]/page.test.ts"`).
 *
 * This file exists because it was deleted with no replacement when
 * `loading.tsx` was removed (`src/app/(app)/users/new/loading.test.tsx`
 * covered the fallback, not the gate) -- leaving `/users/new` as the one
 * page in the app whose authorization gate had no test at all. Mutate the
 * page to drop `await requireAdmin()` and this fails.
 */
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: vi.fn(async () => {
    notFound();
  }),
}));

import NewUserPage from "./page";

describe("/users/new page", () => {
  it("throws Next's not-found sentinel for a non-admin, instead of rendering the form", async () => {
    await expect(NewUserPage()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});
