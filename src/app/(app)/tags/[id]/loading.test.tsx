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
vi.mock("@/lib/tags/actions", () => ({
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTags: vi.fn(),
}));
vi.mock("@/components/tags/use-tag-usage", () => ({ useTagUsage: () => ({ feeds: 0 }) }));

/**
 * `Loading` is an async Server Component, which testing-library cannot render.
 * Calling it and rendering what it resolves to is the one case where that
 * works: its output is synchronous (a translation lookup, then real client
 * components), so there is no reshaping of production code involved -- see
 * CLAUDE.md and `src/app/(app)/layout.test.tsx` for the same technique.
 *
 * The point of this test is the defect Task 7 exists to fix:
 * `/tags/[id]/loading.tsx` used to be two hand-placed `<Skeleton>` bars
 * approximating `<TagForm>`'s two fields. It now renders the real
 * `<TagForm pending />` chassis instead, so a regression back to hand-placed
 * bars fails here.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /tags/[id] route's loading fallback", () => {
  it("renders the real form chassis, disabled, instead of hand-placed skeleton bars", async () => {
    await renderLoading();

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(name.value).toBe("");

    for (const swatch of screen.getAllByRole("radio")) {
      expect((swatch as HTMLButtonElement).disabled).toBe(true);
    }

    // Edit mode is unknowable at this point (no tag has been read yet), so
    // the form falls back to its create-mode action label -- true of
    // `<TagForm pending />` with no `tag` prop.
    expect((screen.getByRole("button", { name: "Create tag" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // The title is static, so it renders for real, and no skeleton bars
    // stand in for it or for any control.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
    expect(screen.getByText("Edit tag")).toBeTruthy();
  });
});
