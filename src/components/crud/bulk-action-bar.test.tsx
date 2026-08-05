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
  it("disables every button while an action runs, and never renders a spinner", async () => {
    // No local spinner, ever: a fast action's feedback is the disabled state
    // alone, and a background-run action (`useTrackRun()`) reports progress
    // through the header's global indicator instead of a button-local one.
    let resolveRun: (value: boolean) => void = () => {};
    const slowRun = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const slowAction: BulkAction = {
      key: "slow",
      label: "Slow action",
      destructive: false,
      run: slowRun,
    };
    const fastAction: BulkAction = {
      key: "fast",
      label: "Fast action",
      destructive: false,
      run: vi.fn().mockResolvedValue(true),
    };

    renderWithProviders(
      <BulkActionBar count={2} actions={[slowAction, fastAction]} onClear={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Slow action" }));

    expect(
      screen.getByRole("button", { name: "Slow action" }).querySelector("svg.animate-spin"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Fast action" }).querySelector("svg.animate-spin"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Slow action" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Fast action" }).hasAttribute("disabled")).toBe(true);

    resolveRun(true);
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "Slow action" }).hasAttribute("disabled")).toBe(
        false,
      );
    });
  });

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
