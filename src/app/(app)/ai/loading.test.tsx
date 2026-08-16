import { screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import en from "../../../../messages/en.json";
import Loading from "./loading";

/**
 * `next-intl/server` resolves to next-intl's non-RSC build under Vitest,
 * which has no `react-server` export condition to select the real one --
 * there, `getTranslations()` throws "not supported in Client Components" the
 * instant it is called. `createTranslator()` (from `next-intl` itself, not
 * its server entry) is the client-safe factory the real implementation
 * builds on, so this reads the real `en.json` catalog rather than inventing
 * message text -- only the request-scoped plumbing around it is stubbed. See
 * `src/app/(app)/integrations/loading.test.tsx` for the same pattern.
 */
vi.mock("next-intl/server", () => ({
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
 * The point of this test is the defect the whole migration exists to fix:
 * this route's fallback used to render both cards with a skeleton standing in
 * for every control, and the provider picker's shape guessed a provider was
 * already selected. It now renders the real `…SectionForm` chassis, disabled
 * and unselected, so a regression back to either fails here instead of only
 * being noticed in a browser.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /ai route's loading fallback", () => {
  it("renders real, disabled controls instead of skeleton bars", async () => {
    await renderLoading();

    // The provider picker: real, disabled, and fully populated once opened --
    // no query is needed for its option list, since AI_PROVIDERS is static.
    const providerTrigger = document.querySelector<HTMLButtonElement>("#ai-provider")!;
    expect(providerTrigger.disabled).toBe(true);

    // The model picker: real, disabled and empty -- which provider is active
    // is unknown while pending, so there is no honest list to guess.
    const modelTrigger = document.querySelector<HTMLButtonElement>("#ai-model")!;
    expect(modelTrigger.disabled).toBe(true);

    // The API key field: present, disabled, empty.
    const apiKey = screen.getByLabelText("API key") as HTMLInputElement;
    expect(apiKey.disabled).toBe(true);
    expect(apiKey.value).toBe("");

    // Both of the provider card's buttons, real and disabled.
    expect(
      (screen.getByRole("button", { name: "Save and verify" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true);

    // All nine tuning fields, with their real bounds, disabled and empty.
    const tuningFields = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(tuningFields).toHaveLength(9);
    expect(tuningFields.every((f) => f.disabled)).toBe(true);
    expect(tuningFields.every((f) => f.value === "")).toBe(true);
    expect(tuningFields.every((f) => f.min !== "")).toBe(true);

    // The advanced card's Save button, real and disabled.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    // No skeleton bars anywhere -- the whole point of this migration.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);

    // No status badge either: it is a probe-derived verdict, unknown while pending.
    expect(screen.queryByText("Verified")).toBe(null);
    expect(screen.queryByText("Not verified")).toBe(null);

    // The headings the shells used to guarantee are still here.
    expect(screen.getByText("AI")).toBeTruthy();
    expect(screen.getByText("Provider")).toBeTruthy();
    expect(screen.getByText("Advanced")).toBeTruthy();
  });
});
