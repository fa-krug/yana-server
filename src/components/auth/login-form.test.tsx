import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../messages/de.json";
import { navigationCalls, resetNavigation } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

// The router: framework URL plumbing no unit test can boot. Explicitly outside
// the no-mocks convention, which is about the database (see CLAUDE.md).
vi.mock("next/navigation", () => import("@/test/next-navigation"));

// The Better Auth client, stubbed at the network boundary. It is an HTTP call
// to /api/auth/*, not a database read: the real one would need a running
// server, and its failure *codes* -- the thing this component branches on --
// are pinned against the library's own table in
// src/lib/auth/sign-in-errors.test.ts, so nothing here is inventing an error
// shape the library does not produce.
const { signInEmail, signInPasskey } = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInPasskey: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({
  signIn: { email: signInEmail, passkey: signInPasskey },
}));

// Sonner renders into a <Toaster> the root layout owns and this render tree
// does not, so the message is caught here instead. The *string* is still the
// real one: it comes out of the real de.json through the real provider.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { LoginForm } from "./login-form";

/** Everything toast.error() was handed, in order. */
function toasts(): string[] {
  return toastError.mock.calls.map((call) => String(call[0]));
}

/** Reveal the password fields, the way a user does. */
function revealPassword() {
  fireEvent.click(screen.getByRole("button", { name: de.auth.usePassword }));
}

function typeCredentials(email: string, password: string) {
  fireEvent.change(screen.getByLabelText(de.auth.email), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(de.auth.password), { target: { value: password } });
}

function submit() {
  fireEvent.submit(screen.getByLabelText(de.auth.password).closest("form")!);
}

function renderForm(next = "/") {
  // German throughout: "Passwort" cannot be mistaken for an untranslated
  // fallback the way "Password" can.
  return renderWithProviders(<LoginForm next={next} />, { locale: "de" });
}

beforeEach(() => {
  resetNavigation();
  signInEmail.mockReset();
  signInPasskey.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  // The feature-detection tests below add it; jsdom does not have it natively,
  // and leaving one behind would decide what the next test renders.
  Reflect.deleteProperty(window, "PublicKeyCredential");
});

describe("LoginForm", () => {
  it("offers the passkey first and keeps the password path one click away", () => {
    renderForm();

    expect(screen.getByRole("button", { name: de.auth.passkeySignIn })).toBeDefined();
    // Not merely hidden: not rendered, so nothing can autofill or submit it.
    expect(screen.queryByLabelText(de.auth.password)).toBe(null);

    revealPassword();

    expect(screen.getByLabelText(de.auth.email)).toBeDefined();
    expect(screen.getByLabelText(de.auth.password)).toBeDefined();
  });

  it("signs in with a password and lands on `next`", async () => {
    signInEmail.mockResolvedValue({ data: { user: {} }, error: null });
    renderForm("/settings");

    revealPassword();
    typeCredentials("admin@admin.com", "admin");
    submit();

    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
    expect(signInEmail).toHaveBeenCalledWith({ email: "admin@admin.com", password: "admin" });
    // replace, not push: /login behind the app means the back button returns a
    // signed-in user to a sign-in form.
    await waitFor(() =>
      expect(navigationCalls()).toEqual([{ method: "replace", href: "/settings" }]),
    );
    // The password path must not depend on passkey support in any way -- this
    // ran in a jsdom with no PublicKeyCredential at all.
    expect(signInPasskey).not.toHaveBeenCalled();
  });

  it("translates a wrong password instead of showing Better Auth's English", async () => {
    // The exact error the library sends: code on the wire, English message
    // attached. The message must not reach the UI (CLAUDE.md).
    signInEmail.mockResolvedValue({
      data: null,
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
        status: 401,
      },
    });
    renderForm("/settings");

    revealPassword();
    typeCredentials("admin@admin.com", "wrong");
    submit();

    await waitFor(() => expect(toasts()).toEqual([de.auth.invalidCredentials]));
    expect(toasts()[0]).not.toContain("Invalid email or password");
    // Still on the login page, and still able to try again.
    expect(navigationCalls()).toEqual([]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: de.auth.signIn }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
  });

  it("shows the generic failure when the server breaks, not a driver message", async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { message: "SqliteError: no such table: user", status: 500 },
    });
    renderForm();

    revealPassword();
    typeCredentials("admin@admin.com", "admin");
    submit();

    await waitFor(() => expect(toasts()).toEqual([de.auth.signInFailed]));
    expect(toasts()[0]).not.toContain("SqliteError");
  });

  it("does not strand a browser without passkeys", async () => {
    // jsdom has no PublicKeyCredential, which is exactly the environment being
    // described: an old browser or an embedded webview. The button must not
    // start a ceremony that cannot finish.
    expect("PublicKeyCredential" in window).toBe(false);
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: de.auth.passkeySignIn }));

    await waitFor(() => expect(toasts()).toEqual([de.auth.passkeyUnsupported]));
    expect(signInPasskey).not.toHaveBeenCalled();
    // The way out is on screen, not one more click away.
    expect(screen.getByLabelText(de.auth.password)).toBeDefined();
  });

  it("falls back to the password when the passkey ceremony produces nothing", async () => {
    // The *ceremony* is not exercised here and cannot be: WebAuthn needs an
    // authenticator, which neither jsdom nor any unit test has. What is
    // exercised is this component's handling of the result the passkey client
    // returns for a dismissed dialog or a device with no credential for this
    // site -- both of which arrive as this code.
    Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: class {} });
    signInPasskey.mockResolvedValue({
      data: null,
      error: { code: "AUTH_CANCELLED", message: "auth cancelled", status: 400 },
    });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: de.auth.passkeySignIn }));

    await waitFor(() => expect(toasts()).toEqual([de.auth.passkeyUnavailable]));
    expect(navigationCalls()).toEqual([]);
    expect(screen.getByLabelText(de.auth.password)).toBeDefined();
    // Re-enabled: a cancelled ceremony is not a dead end.
    expect(
      screen.getByRole("button", { name: de.auth.passkeySignIn }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("does not offer a way to register an account", () => {
    // Self-registration is closed by ruling: accounts come from the startup
    // bootstrap or, from phase 5, from an administrator. `signUp` is not even
    // exported by src/lib/auth/client.ts, so a link here would be a dead end.
    const { container } = renderForm();

    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});
