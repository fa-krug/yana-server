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
 * `src/app/(app)/account/loading.test.tsx` for the same pattern.
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
 * this route's fallback used to render both credential cards with a skeleton
 * standing in for every control. It now renders the real
 * `…SectionForm` chassis, disabled -- so a regression back to a skeleton
 * fails here instead of only being noticed in a browser.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /integrations route's loading fallback", () => {
  it("renders real, disabled controls instead of skeleton bars", async () => {
    await renderLoading();

    // YouTube: the field and both buttons, present, disabled and empty.
    const apiKey = screen.getByLabelText("API key") as HTMLInputElement;
    expect(apiKey.disabled).toBe(true);
    expect(apiKey.value).toBe("");

    // Reddit: all three fields, present, disabled and empty.
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("User agent") as HTMLInputElement).disabled).toBe(true);

    // Both cards' Save and Test buttons are real and disabled.
    expect(screen.getAllByRole("button", { name: "Save and verify" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Test" })).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: "Save and verify" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    for (const button of screen.getAllByRole("button", { name: "Test" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    // No skeleton bars anywhere -- the whole point of this migration.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);

    // No status badge either: it is a probe-derived verdict, unknown while pending.
    expect(screen.queryByText("Active")).toBe(null);
    expect(screen.queryByText("Inactive")).toBe(null);

    // The headings the shells used to guarantee are still here.
    expect(screen.getByText("Integrations")).toBeTruthy();
    expect(screen.getByText("YouTube")).toBeTruthy();
    expect(screen.getByText("Reddit")).toBeTruthy();
  });
});
