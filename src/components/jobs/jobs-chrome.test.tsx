import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { JobsChrome } from "./jobs-chrome";

// `<SearchFilterBar>` (inside `<JobsChrome>`) calls `usePathname()` and
// `useRouter()` -- see `src/test/next-navigation.ts` for why this is a router
// stub, not a data mock.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/jobs");
  setSearchParams("");
});

/**
 * Carries forward the assertions `src/app/(app)/jobs/loading.test.tsx` used to
 * make against this same chrome, before that file was deleted as part of the
 * instant-render-no-fallback migration (`JobsPage` can no longer suspend, so
 * its fallback was unreachable). The pagination-row assertion that test also
 * made lives in `jobs-list-region.test.tsx`, which is where
 * `<PaginationPlaceholder>` is now rendered from.
 */
describe("JobsChrome", () => {
  it("renders the kind filter box, but no title", () => {
    const { container } = renderWithProviders(<JobsChrome />);

    // The breadcrumb already names the page, so the chrome renders no <h1>.
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Filter Kind" })).toBeTruthy();
  });
});
