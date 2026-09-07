import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { EditUserSection, type UserRecord } from "./edit-user-section";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/users/actions", () => ({ createUser: vi.fn(), updateUser: vi.fn() }));
vi.mock("@/components/users/use-user-impact", () => ({
  useUserImpact: () => ({ feeds: 0, tags: 0, articles: 0 }),
}));

const user: UserRecord = {
  id: "user-1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  role: "user",
};

/**
 * The happy path: `edit-user-section.tsx` had only a not-found-shaped
 * verification before this (via `/users/[id]/page.test.tsx`'s mocked
 * `getUser() => null`) -- a regression that made this component always
 * render `<RecordNotFound>` regardless of what the user promise resolved to
 * would have shipped green. This pins the resolved path, including
 * `<DeleteUserSection>`, which the not-found-only coverage never reached.
 */
describe("EditUserSection", () => {
  it("renders the real form and delete section once the user promise resolves", async () => {
    // `use()` suspends on the user promise on the very first render, then
    // resumes once it settles -- a microtask-scale gap `act()` has to span
    // (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(<EditUserSection userPromise={Promise.resolve(user)} />);
    });

    // No page <h1>: the breadcrumb already names the record.
    expect(screen.queryByText("Edit user")).toBeNull();
    expect(screen.getByDisplayValue("ada@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete user" })).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it("renders the not-found state when the user promise resolves to null", async () => {
    await act(async () => {
      renderWithProviders(<EditUserSection userPromise={Promise.resolve(null)} />);
    });

    expect(screen.getByText("Not found")).toBeTruthy();
  });

  /**
   * Not a straight carry-forward of `/users/[id]/loading.test.tsx`'s deleted
   * "three skeletons" assertion: that pinned a placeholder *card* standing in
   * for `<DeleteUserSection>` while pending, and this design deliberately has
   * no such placeholder any more (see this component's own doc comment) --
   * `<DeleteUserSection>` needs a known user id, so it is simply absent while
   * pending rather than guessed at. This asserts the replacement behaviour:
   * zero skeletons, and no delete button, while the user promise is still
   * unresolved.
   */
  it("omits <DeleteUserSection> entirely while the user promise is still pending", () => {
    renderWithProviders(<EditUserSection userPromise={new Promise(() => {})} />);

    expect(screen.queryByRole("button", { name: "Delete user" })).toBeNull();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });
});
