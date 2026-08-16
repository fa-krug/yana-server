import { screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import en from "../../../../../messages/en.json";
import Loading from "./loading";

/**
 * `next-intl/server` resolves to next-intl's non-RSC build under Vitest,
 * which has no `react-server` export condition to select the real one --
 * there, `getTranslations()` throws "not supported in Client Components" the
 * instant it is called. `createTranslator()` (from `next-intl` itself, not
 * its server entry) is the client-safe factory the real implementation
 * builds on, so this reads the real `en.json` catalog rather than inventing
 * message text -- only the request-scoped plumbing around it is stubbed. See
 * `src/app/(app)/ai/loading.test.tsx` for the same pattern.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as never }),
}));

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/users/actions", () => ({ createUser: vi.fn(), updateUser: vi.fn() }));

/**
 * `Loading` is an async Server Component, which testing-library cannot render.
 * Calling it and rendering what it resolves to is the one case where that
 * works: its output is synchronous (a translation lookup, then real client
 * components), so there is no reshaping of production code involved -- see
 * CLAUDE.md and `src/app/(app)/layout.test.tsx` for the same technique.
 *
 * The point of this test is the defect Task 7 exists to fix:
 * `/users/[id]/loading.tsx` used to be four hand-placed `<Skeleton>` bars
 * approximating `<UserForm>`'s four fields, plus a placeholder card for
 * `<DeleteUserSection>`. The form half is now the real
 * `<UserForm pending />` chassis, so a regression back to hand-placed bars
 * for the form fails here; the delete card stays a placeholder on purpose
 * (see the file's own comment) and this test pins that it still renders.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /users/[id] route's loading fallback", () => {
  it("renders the real form chassis, disabled, instead of hand-placed skeleton bars", async () => {
    await renderLoading();

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.disabled).toBe(true);
    expect(email.value).toBe("");

    expect((screen.getByLabelText("First name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Last name") as HTMLInputElement).disabled).toBe(true);

    const roleTrigger = screen.getByLabelText("Role") as HTMLButtonElement;
    expect(roleTrigger.disabled).toBe(true);

    // No user is known yet, so the form is in create mode -- no password
    // field is offered on edit, but it is here because `pending` with no
    // `user` prop is indistinguishable from create mode, same as `<TagForm>`
    // and `<FeedForm>`.
    expect(screen.getByLabelText("Password")).toBeTruthy();

    expect(
      (screen.getByRole("button", { name: "Create user" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // The title is static, so it renders for real. Exactly the three
    // placeholder bars of the still-unresolved `<DeleteUserSection>` card
    // remain -- none stand in for a form control.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
    expect(screen.getByText("Edit user")).toBeTruthy();
  });
});
