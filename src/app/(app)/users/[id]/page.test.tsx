import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

/**
 * The instant-render-no-fallback migration removed this route's real 404
 * (see `src/app/(app)/settings/page.tsx`'s doc comment, and the "detail
 * routes" section of `docs/superpowers/plans/2026-08-17-instant-render-no-fallback.md`):
 * `getUser()` returning `null` -- for a nonexistent id **and** for any id at
 * all when the caller is not an admin, since `getUser()` carries its own
 * `requireAdmin()` gate -- used to throw Next's not-found sentinel from an
 * **awaited** page body, and this file used to assert exactly that
 * (`rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)`). The user was shown
 * that trade-off explicitly and chose instant rendering over both real 404s
 * and hiding a non-admin-only route's existence, so this is rewritten rather
 * than deleted: the page body now awaits nothing, and either reason for an
 * empty result renders the same not-found state instead of throwing.
 */
vi.mock("@/lib/users/queries", () => ({ getUser: vi.fn(async () => null) }));
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));
vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/users/actions", () => ({ createUser: vi.fn(), updateUser: vi.fn() }));

import EditUserPage from "./page";

describe("/users/[id] page", () => {
  it("returns its element tree synchronously -- no awaited row read", () => {
    const result = EditUserPage({ params: Promise.resolve({ id: "does-not-exist" }) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders the not-found state for an id with no user, instead of throwing", async () => {
    // `use()` suspends on the user promise on the very first render, then
    // resumes once it settles -- a microtask-scale gap `act()` has to span,
    // or the resumed render commits outside any act scope and this assertion
    // races it (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(EditUserPage({ params: Promise.resolve({ id: "does-not-exist" }) }));
    });

    expect(screen.getByText("Not found")).toBeTruthy();
    expect(
      screen.getByText("This item doesn't exist, or you don't have access to it."),
    ).toBeTruthy();
  });
});
