import { screen } from "@testing-library/react";
import { use } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { UsersListRegion } from "./users-list-region";

// `useListParams()` (and `<BulkActionBar>`'s selection plumbing) call
// `usePathname()`/`useSearchParams()`/`useRouter()` -- the shared router stub,
// never an inline factory. See src/test/next-navigation.ts.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/users");
  setSearchParams("");
});

/** Stands in for the async Server Components `UsersPage` passes down. */
function Pending() {
  use(new Promise(() => {}));
  return null;
}

/**
 * Carries forward the one structural assertion
 * `src/app/(app)/users/loading.test.tsx` made that is not about the chrome:
 * `<PaginationPlaceholder>`'s `nav[aria-hidden="true"]` reserving the
 * pagination row's height while the rows are still loading. That used to come
 * from a hand-mirrored `loading.tsx`; it now comes from this component's own
 * `<Suspense fallback>`, which is the same fallback the page always used for
 * its data region -- so the two can no longer disagree.
 */
describe("UsersListRegion", () => {
  it("reserves the pagination row and shows the real table header while rows load", () => {
    renderWithProviders(<UsersListRegion tableBody={<Pending />} pagination={<Pending />} />);

    // The real header row, rendered outside the boundary that is still pending.
    expect(screen.getByRole("columnheader", { name: "Email" })).toBeTruthy();
    // The pagination row's space is reserved, but offers nothing yet.
    expect(document.querySelector('nav[aria-hidden="true"]')).toBeTruthy();
  });
});
