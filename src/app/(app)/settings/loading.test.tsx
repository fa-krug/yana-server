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
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /settings route's loading fallback", () => {
  it("renders real, disabled controls instead of skeleton bars", async () => {
    await renderLoading();

    // The theme Select: present and disabled, not a grey bar.
    expect((document.querySelector("#theme") as HTMLButtonElement).disabled).toBe(true);
    // The library retention input: present, disabled, and empty.
    const retention = screen.getByLabelText("Article retention") as HTMLInputElement;
    expect(retention.disabled).toBe(true);
    expect(retention.value).toBe("");
    // No skeleton anywhere on this route's fallback.
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
    // The static <AboutSection>, unaffected by any of this.
    expect(screen.getByText("About")).toBeTruthy();
  });
});
