import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setRouter } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { TagForm } from "./tag-form";

const { createTag, updateTag, deleteTags } = vi.hoisted(() => ({
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTags: vi.fn(),
}));
vi.mock("@/lib/tags/actions", () => ({ createTag, updateTag, deleteTags }));

const { refresh, replace } = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
setRouter({ refresh, replace });

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess, info: vi.fn() } }));

// This form's own usage indicator is not what this test file covers.
vi.mock("./use-tag-usage", () => ({ useTagUsage: () => ({ feeds: 0 }) }));

function submit(name: string) {
  fireEvent.submit(screen.getByRole("button", { name }).closest("form")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  createTag.mockResolvedValue({ ok: true, id: 1 });
  updateTag.mockResolvedValue({ ok: true });
});

describe("<TagForm>", () => {
  it("creates a tag with the default color when no swatch was touched", async () => {
    renderWithProviders(<TagForm />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "News" } });
    submit("Create tag");

    await waitFor(() => expect(createTag).toHaveBeenCalled());
    expect(createTag).toHaveBeenCalledWith({ name: "News", color: "red" });
  });

  it("submits the swatch the operator picked", async () => {
    renderWithProviders(<TagForm />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "News" } });
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    submit("Create tag");

    await waitFor(() => expect(createTag).toHaveBeenCalled());
    expect(createTag).toHaveBeenCalledWith({ name: "News", color: "violet" });
  });

  it("preselects the tag's own color when editing", () => {
    renderWithProviders(
      <TagForm
        tag={{
          id: 1,
          name: "News",
          color: "teal",
          userId: "u1",
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
      />,
    );

    expect(screen.getByRole("radio", { name: "Teal" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Red" }).getAttribute("aria-checked")).toBe("false");
  });
});
