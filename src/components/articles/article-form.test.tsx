import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { ArticleForm, type ArticleDetailRow } from "./article-form";

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

const article: ArticleDetailRow = {
  id: 1,
  name: "Example article",
  identifier: "https://example.com/a",
  feedId: 5,
  date: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-02T00:00:00Z"),
};

/** jsdom has no clipboard API at all, so every test that needs one installs it. */
function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

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

    const source = screen.getByLabelText("Source URL") as HTMLButtonElement;
    expect(source.disabled).toBe(true);
    expect(source.textContent).toBe("");

    expect((screen.getByLabelText("Added date") as HTMLInputElement).disabled).toBe(true);

    expect(
      (screen.getByRole("button", { name: "Save article" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reload content" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the source URL and copies it when pressed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    renderWithProviders(<ArticleForm article={article} feeds={[{ id: 5, name: "Example" }]} />);

    const source = screen.getByLabelText("Source URL") as HTMLButtonElement;
    expect(source.disabled).toBe(false);
    expect(source.textContent).toContain("https://example.com/a");
    // The full URL stays reachable when the visible text is truncated.
    expect(source.title).toBe("https://example.com/a");

    await act(async () => {
      fireEvent.click(source);
    });

    expect(writeText).toHaveBeenCalledWith("https://example.com/a");
  });

  it("disables the source field for an article that carries no link", () => {
    renderWithProviders(<ArticleForm article={{ ...article, identifier: "" }} feeds={[]} />);

    expect((screen.getByLabelText("Source URL") as HTMLButtonElement).disabled).toBe(true);
  });
});
