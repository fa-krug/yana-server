import { describe, expect, it, vi } from "vitest";

/**
 * The session read and the db-backed lookup, stubbed -- and only those. See
 * the equivalent comment on `../../feeds/[id]/page.test.ts` for why.
 */
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/tags/queries", () => ({ getTag: vi.fn(async () => null) }));

import EditTagPage from "./page";

/**
 * `EditTagPage` awaits `getTag()` at the top of its body and calls the real
 * `notFound()` when it returns nothing -- the same "detail route awaits its
 * row at the top" rule `../../feeds/[id]/page.test.ts` pins. See that file's
 * comment for where the asserted sentinel string comes from.
 */
describe("/tags/[id] page", () => {
  it("throws Next's not-found sentinel for an id with no tag, instead of rendering", async () => {
    await expect(EditTagPage({ params: Promise.resolve({ id: "999999" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });

  it("throws the same sentinel for a non-numeric id", async () => {
    await expect(EditTagPage({ params: Promise.resolve({ id: "not-a-number" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });
});
