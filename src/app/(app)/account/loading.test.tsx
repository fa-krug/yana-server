import { screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import en from "../../../../messages/en.json";
import Loading from "./loading";

// PasskeySectionForm and DeviceSectionForm both call useRouter() -- the real
// stub module, never an inline factory: it also re-exports the real
// unstable_rethrow that attempt() reaches. See src/test/next-navigation.ts.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

/**
 * `next-intl/server` resolves to next-intl's non-RSC build under Vitest,
 * which has no `react-server` export condition to select the real one --
 * there, `getTranslations()` throws "not supported in Client Components" the
 * instant it is called. Same trap `src/lib/settings/settings.test.ts`
 * documents for `getRequestConfig()`. `createTranslator()` (from `next-intl`
 * itself, not its server entry) is the client-safe factory the real
 * implementation builds on, so this reads the real `en.json` catalog rather
 * than inventing message text -- only the request-scoped plumbing around it
 * is stubbed.
 */
vi.mock("next-intl/server", () => ({
  // `namespace` is cast rather than typed against the catalog: this factory
  // stands in for the whole module, so there is no compiler-checked
  // `NamespaceKeys<Messages, …>` to satisfy here the way a real `t()` call
  // site has -- see the next-intl/next-intl.d.ts bullet in CLAUDE.md for why
  // that check exists at all.
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as never }),
}));

/**
 * `Loading` is an async Server Component, which testing-library cannot render.
 * Calling it and rendering what it resolves to is the one case where that
 * works: its output is synchronous (a translation lookup, then real client
 * components), so there is no reshaping of production code involved -- see
 * CLAUDE.md and `src/app/(app)/layout.test.tsx` for the same technique.
 *
 * The point of this test is the defect the whole migration exists to fix: this
 * route's fallback used to be `<Skeleton>` bars standing in for every control.
 * It now renders the real `…SectionForm` chassis, disabled -- so a regression
 * back to a skeleton fails here instead of only being noticed in a browser.
 * The two list regions (passkeys, devices) are the one exception: their row
 * count is genuinely unknowable, so a `<Skeleton>` there is still correct.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /account route's loading fallback", () => {
  it("renders real, disabled controls instead of skeleton bars", async () => {
    await renderLoading();

    // Profile: email/first/last inputs and Save, all present, disabled and
    // empty -- not a grey bar.
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.disabled).toBe(true);
    expect(email.value).toBe("");
    expect((screen.getByLabelText("First name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Last name") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Choose a picture" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Password: all three fields and the submit button, present and disabled.
    expect((screen.getByLabelText("Current password") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Passkeys: the add button is real and disabled.
    expect(
      (screen.getByRole("button", { name: "Add a passkey" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // The two list regions still show a skeleton -- their row count is
    // genuinely unknowable, unlike a field's value.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(2);

    // The headings the shells used to guarantee are still here.
    expect(screen.getByText("Profile")).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByText("Passkeys")).toBeTruthy();
    expect(screen.getByText("Devices")).toBeTruthy();
  });
});
