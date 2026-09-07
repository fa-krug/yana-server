import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountOverview } from "@/lib/account/queries";
import { renderWithProviders } from "@/test/render";

import { PasswordSection, PasswordSectionForm } from "./password-section";

const { changePassword } = vi.hoisted(() => ({ changePassword: vi.fn() }));
vi.mock("@/lib/account/actions", () => ({ changePassword }));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

function fill(labels: Record<string, string>): void {
  for (const [label, value] of Object.entries(labels)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

describe("<PasswordSection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    changePassword.mockResolvedValue({ ok: true });
  });

  it("catches a mismatched confirmation without spending a round trip", async () => {
    // The one validation the server cannot make -- the second field is never
    // sent -- so it has to happen here or not at all. Sending anyway would also
    // burn the user's current password on a request that could not succeed.
    renderWithProviders(<PasswordSectionForm hasPassword />);

    fill({
      "Current password": "correct horse battery staple",
      "New password": "a brand new password",
      "Confirm new password": "a brand new pasword",
    });
    fireEvent.submit(screen.getByLabelText("New password").closest("form")!);

    expect(changePassword).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("The two new passwords do not match.");
  });

  it("sends only the two fields the action takes, and clears the form on success", async () => {
    renderWithProviders(<PasswordSectionForm hasPassword />);

    fill({
      "Current password": "correct horse battery staple",
      "New password": "a brand new password",
      "Confirm new password": "a brand new password",
    });
    fireEvent.submit(screen.getByLabelText("New password").closest("form")!);

    await vi.waitFor(() => expect(changePassword).toHaveBeenCalled());
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "correct horse battery staple",
      newPassword: "a brand new password",
    });
    await vi.waitFor(() =>
      expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(""),
    );
  });

  it("keeps what was typed when the current password was wrong", async () => {
    // Clearing everything on failure makes the retry three fields instead of
    // one, for a mistake that is almost always in the first field.
    changePassword.mockResolvedValue({ ok: false, errorKey: "password.wrongCurrent" });
    renderWithProviders(<PasswordSectionForm hasPassword />, { locale: "de" });

    fill({
      "Aktuelles Passwort": "wrong",
      "Neues Passwort": "a brand new password",
      "Neues Passwort bestätigen": "a brand new password",
    });
    fireEvent.submit(screen.getByLabelText("Neues Passwort").closest("form")!);

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Das ist nicht dein aktuelles Passwort."),
    );
    expect((screen.getByLabelText("Neues Passwort") as HTMLInputElement).value).toBe(
      "a brand new password",
    );
  });

  it("interpolates the minimum length rather than printing the placeholder", async () => {
    // `password.tooShort` carries `{min}`, and next-intl renders the raw
    // placeholder when no value is supplied -- so the toast has to pass one.
    changePassword.mockResolvedValue({ ok: false, errorKey: "password.tooShort" });
    renderWithProviders(<PasswordSectionForm hasPassword />);

    fill({
      "Current password": "correct horse battery staple",
      "New password": "short",
      "Confirm new password": "short",
    });
    fireEvent.submit(screen.getByLabelText("New password").closest("form")!);

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("A password must be at least 8 characters."),
    );
  });

  it("survives a change request that rejects instead of returning", async () => {
    // Same cliff as the profile card, with three filled password fields on it.
    changePassword.mockRejectedValue(new Error("Failed to fetch"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderWithProviders(<PasswordSectionForm hasPassword />);
      fill({
        "Current password": "correct horse battery staple",
        "New password": "a brand new password",
        "Confirm new password": "a brand new password",
      });
      fireEvent.submit(screen.getByLabelText("New password").closest("form")!);

      await vi.waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      // Nothing was cleared: the request never happened, so the retry is one
      // click and not three fields.
      expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(
        "correct horse battery staple",
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("offers no form at all to an account with no password credential", () => {
    // Phase 5 can provision a passkey-only account. A form here would return
    // CREDENTIAL_ACCOUNT_NOT_FOUND on every submission.
    const { container } = renderWithProviders(<PasswordSectionForm hasPassword={false} />, {
      locale: "de",
    });

    expect(container.querySelector("form")).toBe(null);
    expect(container.textContent).toContain("ausschließlich mit Passkeys");
  });

  it("renders the real three fields and submit button while hasPassword is still loading", () => {
    // The common case (a password exists) is the best guess for the pending
    // form, the same choice the shell it replaced made for its own fallback.
    renderWithProviders(<PasswordSectionForm pending />);

    expect((screen.getByLabelText("Current password") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("New password") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Confirm new password") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Password")).toBeTruthy();
  });

  it("shows the resolved hasPassword flag once the promise settles", async () => {
    // A deferred promise, resolved under an explicit `act()` -- React 19's
    // `use()` registers its continuation as a bare promise `.then()`, which
    // lands outside any `act()` scope unless the resolution itself is wrapped.
    let resolveOverview!: (value: AccountOverview) => void;
    const promise = new Promise<AccountOverview>((resolve) => {
      resolveOverview = resolve;
    });

    await act(async () => {
      renderWithProviders(<PasswordSection promise={promise} />);
    });

    expect((screen.getByLabelText("Current password") as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      resolveOverview({ hasPassword: false } as unknown as AccountOverview);
      await promise;
    });

    // No password credential: the form is gone entirely, not merely enabled.
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.getByText("This account signs in with passkeys only.")).toBeTruthy();
  });
});
