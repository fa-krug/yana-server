import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ArticlesChrome } from "@/components/articles/articles-chrome";
import { ArticlesListRegion } from "@/components/articles/articles-list-region";

/**
 * `ArticlesPage` calls `articleFilterOptions()` eagerly (to build the
 * promise it hands to `<ArticlesChrome>`) even though it never awaits it --
 * the `Promise.all([listFeeds(...), listTags(...)])` executor still runs
 * synchronously. Both real functions call `requireUser()`/`currentUserId()`,
 * which reach `headers()` outside any request scope under Vitest and reject
 * -- the same hazard `getDashboardStats()`/`getRecentUnreadArticles()` are
 * stubbed against in `src/app/(app)/page.test.tsx`. Never-resolving promises,
 * since this test only checks the page body's own shape, never what either
 * query returns.
 */
vi.mock("@/lib/feeds/actions", () => ({
  listFeeds: () => new Promise(() => {}),
}));
vi.mock("@/lib/tags/queries", () => ({
  listTags: () => new Promise(() => {}),
}));

import ArticlesPage from "./page";

/**
 * `ArticlesPage` renders two Server Components (`ArticlesBody`,
 * `ArticlesPagination`, both declared inside `page.tsx` and not exported)
 * directly as children -- both remain genuinely async, unlike `/settings`' or
 * `/`'s data regions, which hide their async work behind a `promise` prop
 * consumed with `use()` inside a `"use client"` component. testing-library's
 * `render()` goes through `ReactDOM`, not the RSC renderer, and cannot mount a
 * bare async function component (see CLAUDE.md: "async server components
 * cannot be rendered by testing-library") -- so this file checks the returned
 * element tree's shape directly, without ever handing it to `render()`. See
 * `src/app/(app)/feeds/page.test.tsx` for the identical reasoning.
 */
describe("ArticlesPage", () => {
  it("returns its element tree synchronously -- no awaited searchParams, requireUser, translation or filter options", () => {
    // A page function that awaits anything returns a Promise, which
    // testing-library cannot render at all. Calling it and getting a plain
    // element back, not a thenable, is what proves the body has no
    // remaining await.
    const result = ArticlesPage({ searchParams: Promise.resolve({}) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders <ArticlesChrome> and <ArticlesListRegion>, and shares one searchParams promise between them", () => {
    const searchParams = Promise.resolve({ q: "hello" });

    const result = ArticlesPage({ searchParams }) as ReactElement;
    const children = (result.props as { children: ReactElement[] }).children;
    const [chrome, listRegion] = children;

    expect(chrome.type).toBe(ArticlesChrome);
    expect(listRegion.type).toBe(ArticlesListRegion);

    // <ArticlesChrome> gets its own, separate `optionsPromise` -- it has no
    // reason to share identity with `searchParams` the way `tableBody`/
    // `pagination` share one below, since `listFeeds()`/`listTags()` (the
    // filter options) are cached by `cache()` internally on their own
    // arguments, not on this promise's identity.
    expect((chrome.props as { optionsPromise: unknown }).optionsPromise).toBeInstanceOf(Promise);

    const { tableBody, pagination } = listRegion.props as {
      tableBody: ReactElement;
      pagination: ReactElement;
    };

    // Both Server Component elements were handed the *same* promise
    // reference -- the property `resolveParams`'s `cache()` dedupe (and,
    // downstream, `cachedListArticles`'s) depends on. A page that awaited
    // `searchParams` once and passed two structurally-equal-but-distinct
    // copies down would silently cost two queries instead of one.
    expect((tableBody.props as { searchParams: unknown }).searchParams).toBe(searchParams);
    expect((pagination.props as { searchParams: unknown }).searchParams).toBe(searchParams);
  });
});
