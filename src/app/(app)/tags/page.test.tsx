import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { TagsChrome } from "@/components/tags/tags-chrome";
import { TagsListRegion } from "@/components/tags/tags-list-region";

import TagsPage from "./page";

/**
 * `TagsPage` renders two Server Components (`TagsBody`, `TagsPagination`,
 * both declared inside `page.tsx` and not exported) directly as children --
 * both remain genuinely async, unlike `/settings`' or `/`'s data regions,
 * which hide their async work behind a `promise` prop consumed with `use()`
 * inside a `"use client"` component. testing-library's `render()` goes
 * through `ReactDOM`, not the RSC renderer, and cannot mount a bare async
 * function component (see CLAUDE.md: "async server components cannot be
 * rendered by testing-library") -- so this file checks the returned element
 * tree's shape directly, without ever handing it to `render()`. See
 * `src/app/(app)/feeds/page.test.tsx` for the identical reasoning.
 */
describe("TagsPage", () => {
  it("returns its element tree synchronously -- no awaited searchParams, requireUser or translation", () => {
    // A page function that awaits anything returns a Promise, which
    // testing-library cannot render at all. Calling it and getting a plain
    // element back, not a thenable, is what proves the body has no
    // remaining await.
    const result = TagsPage({ searchParams: Promise.resolve({}) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders <TagsChrome> and <TagsListRegion>, and shares one searchParams promise between them", () => {
    const searchParams = Promise.resolve({ q: "hello" });

    const result = TagsPage({ searchParams }) as ReactElement;
    const children = (result.props as { children: ReactElement[] }).children;
    const [chrome, listRegion] = children;

    expect(chrome.type).toBe(TagsChrome);
    expect(listRegion.type).toBe(TagsListRegion);

    const { tableBody, pagination } = listRegion.props as {
      tableBody: ReactElement;
      pagination: ReactElement;
    };

    // Both Server Component elements were handed the *same* promise
    // reference -- the property `resolveParams`'s `cache()` dedupe (and,
    // downstream, `cachedListTags`'s) depends on. A page that awaited
    // `searchParams` once and passed two structurally-equal-but-distinct
    // copies down would silently cost two queries instead of one.
    expect((tableBody.props as { searchParams: unknown }).searchParams).toBe(searchParams);
    expect((pagination.props as { searchParams: unknown }).searchParams).toBe(searchParams);
  });
});
