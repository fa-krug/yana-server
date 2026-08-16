import { describe, expect, it, vi } from "vitest";

/**
 * The session read and the two db-backed lookups, stubbed -- and only those.
 * See the equivalent comment on `../../feeds/[id]/page.test.ts` for why.
 *
 * This is the route whose `getArticle()` 404 check Task 7 moved out of a
 * `<Suspense>`-wrapped section and into the awaited page body -- the
 * previous placement could have truncated a 200 instead of answering 404
 * once the shell had flushed (CLAUDE.md's "notFound() must be awaited before
 * any Suspense" rule). This test is what keeps that fix from regressing
 * silently.
 */
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/articles/queries", () => ({
  getArticle: vi.fn(async () => null),
  getBlockTree: vi.fn(async () => []),
}));
vi.mock("@/lib/feeds/actions", () => ({ listFeeds: vi.fn(async () => ({ rows: [] })) }));

import ArticleDetailPage from "./page";

/**
 * `ArticleDetailPage` awaits `getArticle()` at the top of its body and calls
 * the real `notFound()` when it returns nothing -- the same "detail route
 * awaits its row at the top" rule `../../feeds/[id]/page.test.ts` pins. See
 * that file's comment for where the asserted sentinel string comes from.
 */
describe("/articles/[id] page", () => {
  it("throws Next's not-found sentinel for an id with no article, instead of rendering", async () => {
    await expect(ArticleDetailPage({ params: Promise.resolve({ id: "999999" }) })).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });

  it("throws the same sentinel for a non-numeric id", async () => {
    await expect(
      ArticleDetailPage({ params: Promise.resolve({ id: "not-a-number" }) }),
    ).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});
