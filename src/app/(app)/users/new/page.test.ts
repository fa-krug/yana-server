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
 *
 * The assertion below is deliberately direct, not just "the promise
 * rejected": without the mocked `requireAdmin` also asserted as called,
 * removing the gate falls through to `await getTranslations("users")`, which
 * throws its own ("`getTranslations` is not supported in Client Components")
 * inside this node test environment -- so the test would still go red, but
 * for the wrong reason, and a future reader would learn nothing about the
 * gate it exists to protect. Asserting the mock was called pins the claim to
 * the gate itself -- and it is checked *before* the rejection's message, so a
 * mutation that removes the gate fails on the call-count assertion (naming
 * `requireAdmin`) rather than on the message match, which the downstream
 * `getTranslations` throw would satisfy just as badly as a real 404 does.
 */
const { requireAdmin } = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => {
    notFound();
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireAdmin }));

import NewUserPage from "./page";

describe("/users/new page", () => {
  it("calls requireAdmin and throws Next's not-found sentinel for a non-admin", async () => {
    let caught: unknown;
    try {
      await NewUserPage();
      throw new Error("expected NewUserPage() to reject");
    } catch (error) {
      caught = error;
    }

    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(caught).toMatchObject({
      message: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });
});
