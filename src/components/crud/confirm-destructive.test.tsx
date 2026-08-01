import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { renderWithProviders } from "@/test/render";

import { ConfirmDestructive } from "./confirm-destructive";

// The real `unstable_rethrow` comes through this stub, which is the point:
// faking it would make these tests prove the opposite of what they claim.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

function renderDialog(onConfirm: () => Promise<boolean>) {
  return renderWithProviders(
    <ConfirmDestructive
      trigger={<Button>Delete 3 users</Button>}
      title="Delete 3 users?"
      description="This also removes 14 feeds and 402 articles."
      confirmLabel="Delete"
      onConfirm={onConfirm}
    />,
  );
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Delete 3 users" }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("<ConfirmDestructive>", () => {
  it("shows the caller's copy rather than anything of its own", () => {
    // The kit cannot invent "402 articles", which is the whole reason the
    // confirmation exists -- so the copy is a prop, already translated.
    renderDialog(async () => true);
    open();

    expect(screen.getByText("Delete 3 users?")).toBeTruthy();
    expect(screen.getByText("This also removes 14 feeds and 402 articles.")).toBeTruthy();
  });

  it("closes once the action reports success", async () => {
    renderDialog(async () => true);
    open();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Delete 3 users?")).toBe(null));
  });

  it("stays open when the action resolves a failure", async () => {
    // **The case a real caller produces.** Every server action here goes
    // through `attempt()`, which never rejects -- it resolves
    // `{ ok: false, errorKey }`. So a failed delete arrives as a *resolved*
    // promise, and a contract keyed on throwing would close the dialog on
    // exactly the path it exists to keep open: the error toast would land over
    // a list that looks unchanged, and the operator would read the vanished
    // dialog as success.
    const onConfirm = vi.fn(async () => false);
    renderDialog(onConfirm);
    open();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(screen.getByText("Delete 3 users?")).toBeTruthy();
  });

  it("stays open when the action rejects", async () => {
    // The backstop, for a caller that forgot `attempt()`: forgetting it should
    // cost an unreported error in the console, never the dialog.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderDialog(async () => {
      throw new Error("the server said no");
    });
    open();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByText("Delete 3 users?")).toBeTruthy();
  });

  it("labels cancel from the catalog", () => {
    renderWithProviders(
      <ConfirmDestructive
        trigger={<Button>Löschen</Button>}
        title="Titel"
        description="Beschreibung"
        confirmLabel="Löschen"
        onConfirm={async () => true}
      />,
      { locale: "de" },
    );
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));

    expect(screen.getByRole("button", { name: "Abbrechen" })).toBeTruthy();
  });
});
