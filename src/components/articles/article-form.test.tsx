import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { ArticleForm } from "./article-form";

/**
 * Carried forward from `/articles/[id]/loading.tsx`'s deleted test
 * (`loading.test.tsx`), which was the **only** coverage of
 * `<ArticleForm pending />`'s rendered output -- unlike `<FeedForm>`,
 * `<TagForm>` and `<UserForm>`, this component had no dedicated test file of
 * its own before the instant-render-no-fallback migration. `pending` is now
 * the `<Suspense>` fallback `ArticleDetailSection` (in
 * `article-detail-section.tsx`) renders while `/articles/[id]`'s article
 * promise is still resolving, replacing what `loading.tsx` used to render;
 * this file is what still proves that chassis renders every field disabled
 * and blank rather than regressing to a generic skeleton.
 */
vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/articles/actions", () => ({
  updateArticle: vi.fn(),
  reloadArticles: vi.fn(),
}));

describe("ArticleForm", () => {
  it("renders every field, disabled and blank, while pending", () => {
    renderWithProviders(<ArticleForm pending />);

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
  });
});
