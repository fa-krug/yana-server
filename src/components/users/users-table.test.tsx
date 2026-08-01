import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setPathname, setRouter, setSearchParams } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { UsersTable, type UserRow } from "./users-table";

const { deleteUsers, userImpact } = vi.hoisted(() => ({
  deleteUsers: vi.fn(),
  userImpact: vi.fn(),
}));
vi.mock("@/lib/users/actions", () => ({ deleteUsers, userImpact }));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
setRouter({ refresh });

const { toastError, toastInfo, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}));

/** `role` is a comma *list* here, which Better Auth reads as an administrator. */
const ADA: UserRow = {
  id: "u-ada",
  name: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  image: null,
  role: "user,admin",
  createdAt: new Date("2026-03-14T09:00:00Z"),
};

const GRACE: UserRow = {
  id: "u-grace",
  name: "Grace Hopper",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  image: null,
  role: "user",
  createdAt: new Date("2026-05-02T00:00:00Z"),
};

function renderTable(rows: UserRow[] = [ADA, GRACE]) {
  return renderWithProviders(
    <UsersTable rows={rows} page={1} pageSize={25} total={rows.length} />,
    { locale: "de" },
  );
}

/** Tick the first row, which is what makes the bulk bar appear. */
function selectFirstRow() {
  fireEvent.click(screen.getAllByRole("checkbox", { name: "Diese Zeile auswählen" })[0]!);
}

function openDeleteDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
}

/**
 * The dialog itself, so the *confirm* button can be told from the trigger that
 * opened it -- both are labelled "Löschen", which is what the operator sees and
 * therefore what the test has to disambiguate rather than rename.
 */
function dialog(): HTMLElement {
  const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!popup) throw new Error("no confirmation dialog is open");
  return popup;
}

function confirmDelete() {
  fireEvent.click(within(dialog()).getByRole("button", { name: "Löschen" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setPathname("/users");
  setSearchParams("");
  deleteUsers.mockResolvedValue({ ok: true, deleted: 1 });
  userImpact.mockResolvedValue({ feeds: 14, tags: 2, articles: 402 });
});

describe("<UsersTable>", () => {
  it("renders each user, badging a comma-list role as an administrator", () => {
    // `isAdminRole()`, not `role === "admin"`: "user,admin" is an administrator
    // to every Better Auth endpoint, and a badge that said otherwise would tell
    // this page's operator the opposite of what the library enforces.
    renderTable();

    expect(screen.getByRole("link", { name: "Ada Lovelace" }).getAttribute("href")).toBe(
      "/users/u-ada",
    );
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Administrator")).toBeTruthy();
    expect(screen.getByText("Standard")).toBeTruthy();
    // German for the same instant an English catalog writes "Mar 14, 2026" --
    // proof the date goes through next-intl's formatter and the pinned UTC,
    // not through toLocaleDateString().
    expect(screen.getByText("14.03.2026")).toBeTruthy();
  });

  it("names the real cascade counts in the confirmation", async () => {
    // The entire reason the confirmation exists: an operator cannot otherwise
    // tell that removing one account also removes 402 articles.
    renderTable();
    selectFirstRow();

    await waitFor(() => expect(userImpact).toHaveBeenCalledWith(["u-ada"]));
    expect(screen.getByText("1 ausgewählt")).toBeTruthy();

    openDeleteDialog();

    expect(screen.getByText("Diesen Benutzer löschen?")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/14 Feeds, 2 Tags und 402 Artikel/)).toBeTruthy());
  });

  it("declines to invent counts while they are still unknown", async () => {
    // A confirmation claiming "0 Artikel" while the read is in flight is worse
    // than one that describes the cascade without numbering it.
    userImpact.mockReturnValue(new Promise(() => {}));
    renderTable();
    selectFirstRow();
    openDeleteDialog();

    expect(screen.getByText(/Feeds, Tags und Artikel/)).toBeTruthy();
    expect(screen.queryByText(/402/)).toBe(null);
  });

  it("deletes the selection, refreshes, and reports how many went", async () => {
    renderTable();
    selectFirstRow();
    openDeleteDialog();

    confirmDelete();

    await waitFor(() => expect(deleteUsers).toHaveBeenCalledWith(["u-ada"]));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("1 Benutzer gelöscht"));
    expect(refresh).toHaveBeenCalled();
    // Closed, which is what an operator reads as "it worked".
    await waitFor(() => expect(screen.queryByText("Diesen Benutzer löschen?")).toBe(null));
  });

  it("does not claim a deletion that did not happen", async () => {
    // A selection of ids that are already gone succeeds and removes nothing.
    deleteUsers.mockResolvedValue({ ok: true, deleted: 0 });
    renderTable();
    selectFirstRow();
    openDeleteDialog();

    confirmDelete();

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        "Es wurde nichts gelöscht — diese Konten gibt es nicht mehr.",
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and translates a refusal", async () => {
    // The dialog vanishing reads as success, so a refusal has to leave it
    // standing -- and the message is the action's catalog key, never prose.
    deleteUsers.mockResolvedValue({ ok: false, errorKey: "deleteSelf", deleted: 0 });
    renderTable();
    selectFirstRow();
    openDeleteDialog();

    confirmDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Du kannst dein eigenes Konto nicht löschen. Bitte eine andere Administratorin oder einen anderen Administrator darum.",
      ),
    );
    expect(screen.getByText("Diesen Benutzer löschen?")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
