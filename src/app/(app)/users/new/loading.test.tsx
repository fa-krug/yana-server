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
 * The point of this test is the defect Task 6 exists to fix: `/users/new` had
 * no `loading.tsx` at all, so a soft navigation into it showed
 * `(app)/loading.tsx`'s generic `<TableSkeleton>` -- a table shape on a page
 * that is a four-field form. It now renders the real `<UserForm pending />`
 * chassis instead, so a regression back to the generic fallback fails here.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /users/new route's loading fallback", () => {
  it("renders the real form chassis, disabled, instead of the generic table skeleton", async () => {
    await renderLoading();

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.disabled).toBe(true);
    expect(email.value).toBe("");

    expect((screen.getByLabelText("First name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Last name") as HTMLInputElement).disabled).toBe(true);

    const roleTrigger = screen.getByLabelText("Role") as HTMLButtonElement;
    expect(roleTrigger.disabled).toBe(true);

    // Create mode (no `user`), so the password field is present too.
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.disabled).toBe(true);
    expect(password.value).toBe("");

    expect(
      (screen.getByRole("button", { name: "Create user" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);

    expect(screen.getByText("New user")).toBeTruthy();
  });
});
