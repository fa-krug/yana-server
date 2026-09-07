import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { JobsListRegion } from "./jobs-list-region";

// `useListParams()` (and `<BulkActionBar>`'s selection plumbing) call
// `usePathname()`/`useSearchParams()`/`useRouter()` -- the shared router stub,
// never an inline factory. See src/test/next-navigation.ts.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/jobs");
  setSearchParams("");
});

/**
 * Two things this covers, and both were previously only covered -- partly --
 * by `src/app/(app)/jobs/loading.test.tsx`, deleted with the fallback it
 * tested:
 *
 * 1. The reserved pagination row. That test's one structural assertion was
 *    `nav[aria-hidden="true"]`, `<PaginationPlaceholder>`'s marker, which is
 *    now rendered from this component's pending branch rather than from a
 *    hand-mirrored `loading.tsx`.
 * 2. The owner column, which the old fallback rendered as the non-admin shape
 *    unconditionally and could never correct. Here it is driven by the same
 *    fresh-role read that scopes the rows (`listJobsForCurrentUser()`), so the
 *    pending branch shows the non-admin column set and an admin's resolved
 *    branch gains the owner column -- the guarantee being that the *header*
 *    never claims an owner column the server did not grant.
 *
 * The role promise is deferred and resolved under an explicit `act()`, the
 * same reason `<SectionCardsGate>`'s test does: React 19's `use()` registers
 * its continuation as a bare `.then()`, which lands outside any `act()` scope
 * unless the resolution itself is wrapped.
 */
describe("JobsListRegion", () => {
  it("renders the full non-admin chrome while the role is still resolving, then adds the owner column for an admin", async () => {
    let resolveShowOwner!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveShowOwner = resolve;
    });

    await act(async () => {
      renderWithProviders(
        <JobsListRegion showOwner={promise} tableBody={<tbody />} pagination={<div />} />,
      );
    });

    // Pending: the real header row, not a chrome-less skeleton.
    expect(screen.getByRole("columnheader", { name: "Kind" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    // ...in the lower-privilege shape: no owner column until the server says so.
    expect(screen.queryByRole("columnheader", { name: "User" })).toBeNull();
    // The pagination row's space is reserved, but offers nothing yet.
    expect(document.querySelector('nav[aria-hidden="true"]')).toBeTruthy();

    await act(async () => {
      resolveShowOwner(true);
      await promise;
    });

    expect(screen.getByRole("columnheader", { name: "User" })).toBeTruthy();
  });

  it("keeps the owner column out when the role resolves to a non-admin", async () => {
    const promise = Promise.resolve(false);

    await act(async () => {
      renderWithProviders(
        <JobsListRegion
          showOwner={promise}
          tableBody={<tbody data-testid="rows" />}
          pagination={<div />}
        />,
      );
      await promise;
    });

    expect(screen.getByTestId("rows")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "User" })).toBeNull();
  });
});
