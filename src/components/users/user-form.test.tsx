import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setRouter } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { UserForm, type EditableUser } from "./user-form";

const { createUser, updateUser } = vi.hoisted(() => ({
  createUser: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock("@/lib/users/actions", () => ({ createUser, updateUser }));

// The shared router stub, never an inline factory: `vi.mock` replaces the whole
// module, so a hand-rolled `{ useRouter }` dies the moment the tree reaches
// `unstable_rethrow` -- which `attempt()` calls on every failure.
const { refresh, replace } = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
setRouter({ refresh, replace });

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess, info: vi.fn() } }));

/** A user whose role is a comma *list* -- the shape phase 4's review pinned. */
const ADA: EditableUser = {
  id: "u-ada",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  role: "user,admin",
};

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit(name: string) {
  fireEvent.submit(screen.getByRole("button", { name }).closest("form")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  createUser.mockResolvedValue({ ok: true, id: "u-new" });
  updateUser.mockResolvedValue({ ok: true });
});

describe("<UserForm>", () => {
  it("offers a password when creating", () => {
    renderWithProviders(<UserForm />, { locale: "de" });

    expect(screen.getByLabelText("Passwort")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Benutzer anlegen" })).toBeTruthy();
  });

  it("offers no password when editing, and says why", () => {
    // The absence is deliberate -- with no mail transport an administrator
    // setting a password would have to convey it out of band -- so the page
    // states it rather than leaving "where do I reset their password" hanging.
    renderWithProviders(<UserForm user={ADA} />, { locale: "de" });

    expect(screen.queryByLabelText("Passwort")).toBe(null);
    expect(
      screen.getByText(/Das Passwort ändert der Kontoinhaber selbst auf seiner Kontoseite/),
    ).toBeTruthy();
  });

  it("refuses a short password without a round trip", async () => {
    // Asserted against de.json: the message has to come from a catalog, and it
    // has to carry the *number*, not the raw `{min}` placeholder.
    renderWithProviders(<UserForm />, { locale: "de" });

    fill("E-Mail", "grace@example.com");
    fill("Passwort", "short");
    submit("Benutzer anlegen");

    expect(createUser).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Ein Passwort muss mindestens 8 Zeichen lang sein.");
  });

  it("creates the user and replaces the spent form with the new record", async () => {
    renderWithProviders(<UserForm />);

    fill("Email", "grace@example.com");
    fill("First name", "Grace");
    fill("Last name", "Hopper");
    fill("Password", "correct horse battery");
    submit("Create user");

    await waitFor(() => expect(createUser).toHaveBeenCalled());
    expect(createUser).toHaveBeenCalledWith({
      email: "grace@example.com",
      firstName: "Grace",
      lastName: "Hopper",
      // The standard role, because nothing touched the select.
      role: "user",
      password: "correct horse battery",
    });
    // `replace`, so Back does not return to a form that would re-submit an
    // address the server has just taken.
    expect(replace).toHaveBeenCalledWith("/users/u-new");
  });

  it("reads a comma-list role the way isAdminRole does", async () => {
    // "user,admin" is an administrator to every Better Auth endpoint, so the
    // control has to say "Administrator" rather than compare the whole string.
    renderWithProviders(<UserForm user={ADA} />, { locale: "de" });

    expect(screen.getByLabelText("Rolle").textContent).toContain("Administrator");
  });

  it("sends a comma-list role back untouched when the select was not used", async () => {
    // Editing a last name must not rewrite the role column. Collapsing
    // "user,admin" onto the select's two options and submitting *that* is a
    // write the operator did not ask for -- silent, and lossy the moment a
    // phase puts a third part in the list.
    renderWithProviders(<UserForm user={ADA} />);

    fill("Last name", "King");
    submit("Save user");

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser).toHaveBeenCalledWith("u-ada", {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "King",
      role: "user,admin",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("replaces the stored role once the operator actually picks one", async () => {
    // The control for the test above: a form that never sent the select's
    // value would pass it and be unable to change anybody's role.
    renderWithProviders(<UserForm user={ADA} />, { locale: "de" });

    fireEvent.click(screen.getByLabelText("Rolle"));
    // Base UI commits a selection on the pointer *up* inside the item, not on
    // a bare click -- jsdom dispatches neither for us.
    const standard = await screen.findByRole("option", { name: "Standard" });
    fireEvent.pointerDown(standard);
    fireEvent.pointerUp(standard);
    fireEvent.click(standard);
    submit("Benutzer speichern");

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser).toHaveBeenCalledWith("u-ada", {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      role: "user",
    });
  });

  it("reports the action's catalog key, never a driver message", async () => {
    updateUser.mockResolvedValue({ ok: false, errorKey: "emailTaken" });
    renderWithProviders(<UserForm user={ADA} />, { locale: "de" });

    submit("Benutzer speichern");

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Ein anderes Konto verwendet diese E-Mail-Adresse bereits.",
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("survives an action that never returns", async () => {
    // The failure `attempt()` exists for: unhandled, this rejection escalates
    // out of the transition to the (app) error boundary and takes the
    // half-filled form with it. The session probe answers "still signed in"
    // (src/test/setup.ts), so the reported failure is requestFailed.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    updateUser.mockRejectedValue(new Error("the container restarted"));
    renderWithProviders(<UserForm user={ADA} />, { locale: "de" });

    submit("Benutzer speichern");

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Der Server hat nicht geantwortet. Prüfe deine Verbindung und versuche es erneut.",
      ),
    );
    // Still a form, not an error boundary -- and the typed values are still in it.
    expect(screen.getByRole("button", { name: "Benutzer speichern" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Vorname").value).toBe("Ada");
    expect(consoleError).toHaveBeenCalled();
  });

  it("renders every field, disabled, while pending", () => {
    // The defect this migration exists to fix: `/users/new`'s fallback used to
    // be the unrelated generic table skeleton. The real chassis now renders
    // disabled instead, with no value -- see `/users/new/loading.tsx`. `user`
    // is absent (create mode), so the password field is present too.
    renderWithProviders(<UserForm pending />);

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.disabled).toBe(true);
    expect(email.value).toBe("");

    expect((screen.getByLabelText("First name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Last name") as HTMLInputElement).disabled).toBe(true);

    const roleTrigger = screen.getByLabelText("Role") as HTMLButtonElement;
    expect(roleTrigger.disabled).toBe(true);

    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.disabled).toBe(true);
    expect(password.value).toBe("");

    expect(
      (screen.getByRole("button", { name: "Create user" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
