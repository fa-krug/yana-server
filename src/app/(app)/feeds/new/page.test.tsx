import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

/**
 * `capabilitiesFor()` reaches SQLite through `getSettings()`'s per-request
 * `cache()`, and `listTags()` reaches it directly -- neither belongs in a
 * jsdom test. Both are stubbed with a promise that never resolves during the
 * assertion, the same shape `SettingsPage`'s own test uses for
 * `getSettingsSummary()`. The point of this test is only that the page body
 * itself never awaits either.
 */
vi.mock("@/lib/feeds/actions", () => ({
  capabilitiesFor: () => new Promise(() => {}),
  createFeed: vi.fn(),
  updateFeed: vi.fn(),
}));
vi.mock("@/lib/tags/queries", () => ({ listTags: () => new Promise(() => {}) }));
vi.mock("@/lib/aggregators/search", () => ({ searchFeedIdentifier: vi.fn() }));

/**
 * `connection()` throws synchronously outside a real request scope (there is
 * no `workUnitAsyncStorage` store under Vitest) -- by design, the same way it
 * throws synchronously during `next build`'s static generation pass to mark
 * the route dynamic. That is exactly the behaviour the page relies on (see
 * its own comment), so it is faithful to stub it as the request-time no-op it
 * resolves to in production rather than to avoid exercising it at all.
 */
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));

// FeedForm calls useRouter() while suspended behind the never-resolving
// promises above -- the real stub module, never an inline factory. See
// src/test/next-navigation.ts.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import NewFeedPage from "./page";

describe("NewFeedPage", () => {
  it("returns its element tree synchronously -- no awaited translation", () => {
    // A page function that awaits anything returns a Promise, which
    // testing-library cannot render at all (see CLAUDE.md: "async server
    // components cannot be rendered by testing-library"). Calling it and
    // getting a plain element back, not a thenable, is what proves the body
    // has no remaining await.
    const result = NewFeedPage();

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders no page <h1> -- the breadcrumb already names the page", () => {
    const result = NewFeedPage();

    const { container } = renderWithProviders(result as ReactElement);

    expect(container.querySelector("h1")).toBeNull();
  });
});
