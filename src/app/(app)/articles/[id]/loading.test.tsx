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
vi.mock("@/lib/articles/actions", () => ({
  updateArticle: vi.fn(),
  reloadArticles: vi.fn(),
}));

/**
 * `Loading` is an async Server Component, which testing-library cannot render.
 * Calling it and rendering what it resolves to is the one case where that
 * works: its output is synchronous (a translation lookup, then real client
 * components), so there is no reshaping of production code involved -- see
 * CLAUDE.md and `src/app/(app)/layout.test.tsx` for the same technique.
 *
 * The point of this test is the defect Task 7 exists to fix:
 * `/articles/[id]/loading.tsx`'s "General" section used to be a generic
 * `<TableSkeleton rows={4} columns={1} />` -- four unlabelled grey bars with
 * no relationship to `<ArticleForm>`'s actual fields. It now renders the
 * real `<ArticleForm pending />` chassis for that section, so a regression
 * back to the generic table skeleton fails here. The "Content" section's
 * `<TableSkeleton>` is intentionally unchanged (see the file's own comment:
 * a block tree has no form shape to mirror) and this test pins that it is
 * still there, still a skeleton.
 */
async function renderLoading() {
  return renderWithProviders(await Loading());
}

describe("the /articles/[id] route's loading fallback", () => {
  it("renders the real form chassis, disabled, for the general section", async () => {
    await renderLoading();

    const name = screen.getByLabelText("Title") as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(name.value).toBe("");

    const feedTrigger = screen.getByLabelText("Feed") as HTMLButtonElement;
    expect(feedTrigger.disabled).toBe(true);

    const date = screen.getByLabelText("Date") as HTMLInputElement;
    expect(date.disabled).toBe(true);
    expect(date.value).toBe("");

    expect((screen.getByLabelText("Added date") as HTMLInputElement).disabled).toBe(true);

    expect(
      (screen.getByRole("button", { name: "Save article" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reload content" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    expect(screen.getByText("Edit article")).toBeTruthy();
  });

  it("keeps the content section's generic skeleton, since a block tree has no form shape", async () => {
    await renderLoading();

    // The general section above renders no skeleton bars at all (real,
    // disabled controls only); the content section below it still does,
    // deliberately.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.getByText("Content")).toBeTruthy();
  });
});
