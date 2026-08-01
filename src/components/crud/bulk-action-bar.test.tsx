import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { BulkActionBar, type BulkAction } from "./bulk-action-bar";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { run } = vi.hoisted(() => ({ run: vi.fn() }));

const deleteAction: BulkAction = {
  key: "delete",
  label: "Löschen",
  destructive: true,
  confirm: {
    title: "3 Benutzer löschen?",
    description: "Damit verschwinden auch 14 Feeds.",
    confirmLabel: "Löschen",
  },
  run,
};

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue(true);
});

describe("<BulkActionBar>", () => {
  it("renders nothing when nothing is selected", () => {
    // So a caller can mount it unconditionally.
    const { container } = renderWithProviders(
      <BulkActionBar count={0} actions={[deleteAction]} onClear={vi.fn()} />,
    );

    expect(container.textContent).toBe("");
  });

  it("spells out the count in the active locale", () => {
    // The operator's only check that the selection is what they think it is,
    // especially after paging.
    renderWithProviders(<BulkActionBar count={3} actions={[deleteAction]} onClear={vi.fn()} />, {
      locale: "de",
    });

    expect(screen.getByText("3 ausgewählt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Auswahl aufheben" })).toBeTruthy();
  });

  it("confirms before a destructive action instead of running it", () => {
    // The first click must open the dialog, never start the delete.
    renderWithProviders(<BulkActionBar count={3} actions={[deleteAction]} onClear={vi.fn()} />, {
      locale: "de",
    });

    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));

    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText("3 Benutzer löschen?")).toBeTruthy();
  });

  it("clears the selection on request", () => {
    const onClear = vi.fn();
    renderWithProviders(<BulkActionBar count={2} actions={[]} onClear={onClear} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(onClear).toHaveBeenCalledOnce();
  });
});
