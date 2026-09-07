import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

/**
 * The instant-render-no-fallback migration removed this route's real 404
 * (see `src/app/(app)/settings/page.tsx`'s doc comment, and the "detail
 * routes" section of `docs/superpowers/plans/2026-08-17-instant-render-no-fallback.md`):
 * `getTag()` returning `null` used to throw Next's not-found sentinel from an
 * **awaited** page body, and this file used to assert exactly that
 * (`rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)`). The user was shown
 * that trade-off explicitly and chose instant rendering over real 404s, so
 * this is rewritten rather than deleted: the page body now awaits nothing,
 * and a missing/unowned id renders the same not-found state instead of
 * throwing.
 */
vi.mock("@/lib/tags/queries", () => ({ getTag: vi.fn(async () => null) }));
/**
 * `connection()` throws synchronously outside a real request scope (there is
 * no `workUnitAsyncStorage` store under Vitest) -- by design, the same way it
 * throws synchronously during `next build`'s static generation pass to mark
 * the route dynamic. Stubbing it as the request-time no-op it resolves to in
 * production is what `src/app/(app)/settings/page.test.tsx` does too.
 */
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));
vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/tags/actions", () => ({
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTags: vi.fn(),
}));
vi.mock("@/components/tags/use-tag-usage", () => ({ useTagUsage: () => ({ feeds: 0 }) }));

import EditTagPage from "./page";

describe("/tags/[id] page", () => {
  it("returns its element tree synchronously -- no awaited row read", () => {
    // A page function that awaits anything returns a Promise, which
    // testing-library cannot render (see CLAUDE.md: "async server components
    // cannot be rendered by testing-library"). Calling it and getting a
    // plain element back, not a thenable, is what proves the body no longer
    // awaits `getTag()`.
    const result = EditTagPage({ params: Promise.resolve({ id: "999999" }) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders the not-found state for an id with no tag, instead of throwing", async () => {
    // `use()` suspends on the article promise on the very first render, then
    // resumes once it settles -- a microtask-scale gap `act()` has to span, or
    // the resumed render commits outside any act scope and this assertion
    // races it (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(EditTagPage({ params: Promise.resolve({ id: "999999" }) }));
    });

    expect(screen.getByText("Not found")).toBeTruthy();
    expect(
      screen.getByText("This item doesn't exist, or you don't have access to it."),
    ).toBeTruthy();
  });

  it("renders the same not-found state for a non-numeric id", async () => {
    await act(async () => {
      renderWithProviders(EditTagPage({ params: Promise.resolve({ id: "not-a-number" }) }));
    });

    expect(screen.getByText("Not found")).toBeTruthy();
  });
});
