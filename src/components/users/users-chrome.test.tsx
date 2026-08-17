import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { UsersChrome } from "./users-chrome";

// `<SearchFilterBar>` (inside `<UsersChrome>`) calls `usePathname()` and
// `useRouter()` -- see `src/test/next-navigation.ts` for why this is a router
// stub, not a data mock.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/users");
  setSearchParams("");
});

/**
 * Carries forward the assertions `src/app/(app)/users/loading.test.tsx` used to
 * make against this same chrome, before that file was deleted as part of the
 * instant-render-no-fallback migration (`UsersPage` can no longer suspend, so
 * its fallback was unreachable). Everything that test named -- the heading, the
 * New user link, the search box and the role select -- still ships, just from a
 * Client Component instead of a hand-mirrored copy of the page.
 *
 * `<FeedsChrome>`'s own test explains why this matters: deleting a fallback
 * test without carrying its assertions over is what once dropped the only
 * coverage of `/feeds`' header actions and filter dropdowns.
 *
 * The pagination-row assertion that test also made lives in
 * `users-list-region.test.tsx`, which is where `<PaginationPlaceholder>` is
 * now rendered from.
 */
describe("UsersChrome", () => {
  it("renders the heading, the New user link, the search box and the role filter", () => {
    renderWithProviders(<UsersChrome />);

    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New user" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search by name or email" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Role" })).toBeTruthy();
  });
});
