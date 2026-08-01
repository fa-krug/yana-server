import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setRouter } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { DeleteUserSection } from "./delete-user-section";

const { deleteUsers, userImpact } = vi.hoisted(() => ({
  deleteUsers: vi.fn(),
  userImpact: vi.fn(),
}));
vi.mock("@/lib/users/actions", () => ({ deleteUsers, userImpact }));

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
setRouter({ replace });

const { toastError, toastInfo, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}));

const ADA = {
  id: "u-ada",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
};

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Benutzer löschen" }));
}

/** The popup, so the confirm button is not confused with the trigger. */
function confirmDelete() {
  const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!popup) throw new Error("no confirmation dialog is open");
  fireEvent.click(within(popup).getByRole("button", { name: "Löschen" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteUsers.mockResolvedValue({ ok: true, deleted: 1 });
  userImpact.mockResolvedValue({ feeds: 3, tags: 1, articles: 91 });
});

describe("<DeleteUserSection>", () => {
  it("names the user and the cascade before anything is deleted", async () => {
    renderWithProviders(<DeleteUserSection user={ADA} />, { locale: "de" });

    await waitFor(() => expect(userImpact).toHaveBeenCalledWith(["u-ada"]));
    openDialog();

    expect(screen.getByText("Ada Lovelace löschen?")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/3 Feeds, 1 Tag und 91 Artikel/)).toBeTruthy());
  });

  it("falls back to the address when the account has no name", async () => {
    // Both name columns default to "", so this is the bootstrap administrator's
    // shape -- "Delete ?" would be the alternative.
    renderWithProviders(<DeleteUserSection user={{ ...ADA, firstName: "", lastName: "" }} />, {
      locale: "de",
    });
    openDialog();

    expect(screen.getByText("ada@example.com löschen?")).toBeTruthy();
  });

  it("deletes the user and leaves the record that no longer exists", async () => {
    renderWithProviders(<DeleteUserSection user={ADA} />, { locale: "de" });
    openDialog();

    confirmDelete();

    await waitFor(() => expect(deleteUsers).toHaveBeenCalledWith(["u-ada"]));
    expect(toastSuccess).toHaveBeenCalledWith("1 Benutzer gelöscht");
    // `replace`, so Back does not return to an edit form for a deleted user.
    expect(replace).toHaveBeenCalledWith("/users");
  });

  it("keeps the dialog open when the delete is refused", async () => {
    deleteUsers.mockResolvedValue({ ok: false, errorKey: "lastAdmin", deleted: 0 });
    renderWithProviders(<DeleteUserSection user={ADA} />, { locale: "de" });
    openDialog();

    confirmDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Das ist das letzte Administratorkonto, das sich noch anmelden kann. Ernenne zuerst jemand anderen.",
      ),
    );
    expect(screen.getByText("Ada Lovelace löschen?")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("survives an action that never returns", async () => {
    // Unhandled, this rejection escalates to the (app) error boundary. The
    // dialog must stay open and the failure must be reported.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteUsers.mockRejectedValue(new Error("the container restarted"));
    renderWithProviders(<DeleteUserSection user={ADA} />, { locale: "de" });
    openDialog();

    confirmDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Der Server hat nicht geantwortet. Prüfe deine Verbindung und versuche es erneut.",
      ),
    );
    expect(screen.getByText("Ada Lovelace löschen?")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});
