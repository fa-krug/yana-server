import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

/**
 * `connection()` throws synchronously outside a real request scope (there is
 * no `workUnitAsyncStorage` store under Vitest) -- by design, the same way it
 * throws synchronously during `next build`'s static generation pass to mark
 * the route dynamic. That is exactly the behaviour the page relies on (see
 * its own comment), so it is faithful to stub it as the request-time no-op it
 * resolves to in production rather than to avoid exercising it at all.
 */
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));

// TagForm calls useRouter(), useTagUsage() and the tags actions unconditionally
// -- none of which belong in a jsdom test. The real router stub, never an
// inline factory. See src/test/next-navigation.ts.
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/tags/actions", () => ({
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTags: vi.fn(),
}));
vi.mock("@/components/tags/use-tag-usage", () => ({ useTagUsage: () => ({ feeds: 0 }) }));

import NewTagPage from "./page";

describe("NewTagPage", () => {
  it("returns its element tree synchronously -- no awaited translation", () => {
    // A page function that awaits anything returns a Promise, which
    // testing-library cannot render at all (see CLAUDE.md: "async server
    // components cannot be rendered by testing-library"). Calling it and
    // getting a plain element back, not a thenable, is what proves the body
    // has no remaining await.
    const result = NewTagPage();

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders no page <h1> -- the breadcrumb already names the page", () => {
    const result = NewTagPage();

    const { container } = renderWithProviders(result as ReactElement);

    expect(container.querySelector("h1")).toBeNull();
  });
});
