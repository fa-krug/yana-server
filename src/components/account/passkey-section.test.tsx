import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PasskeySummary } from "@/lib/account/queries";
import { renderWithProviders } from "@/test/render";

import { PasskeySection } from "./passkey-section";

const { removePasskey } = vi.hoisted(() => ({ removePasskey: vi.fn() }));
vi.mock("@/lib/account/actions", () => ({ removePasskey }));

/**
 * The Better Auth browser client, stubbed.
 *
 * `addPasskey()` drives `navigator.credentials.create()`, which does not exist
 * in jsdom and cannot be made to exist -- **no test in this phase can perform a
 * WebAuthn ceremony**. What is covered here is everything around it: the
 * feature check, the two failure shapes, and the refresh on success. A
 * successful registration is verified by hand in a real browser; see the task
 * report.
 */
const { addPasskey } = vi.hoisted(() => ({ addPasskey: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authClient: { passkey: { addPasskey } } }));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const LAPTOP: PasskeySummary = {
  id: "pk-laptop",
  name: "MacBook Touch ID",
  createdAt: new Date("2026-03-14T09:00:00Z"),
};
const PHONE: PasskeySummary = { id: "pk-phone", name: null, createdAt: new Date("2026-05-02") };

/** jsdom has no WebAuthn, so the feature check has to be satisfied explicitly. */
function pretendWebAuthnExists(): void {
  Object.defineProperty(window, "PublicKeyCredential", {
    configurable: true,
    writable: true,
    value: class {},
  });
}

describe("<PasskeySection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removePasskey.mockResolvedValue({ ok: true });
    addPasskey.mockResolvedValue({ data: { id: "pk-new" }, error: null });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "PublicKeyCredential");
  });

  it("lists each passkey with a locale-formatted date", () => {
    // Both locales, because the point is that the date goes through
    // next-intl's formatter rather than through toLocaleDateString() or a
    // hand-rolled template: German writes 14.03.2026 and English Mar 14, 2026
    // for the same instant, so one assertion alone would not show it moved.
    const german = renderWithProviders(<PasskeySection passkeys={[LAPTOP]} hasPassword />, {
      locale: "de",
    });
    expect(german.container.textContent).toContain("MacBook Touch ID");
    expect(german.container.textContent).toContain("Hinzugefügt am 14.03.2026");
    german.unmount();

    const english = renderWithProviders(<PasskeySection passkeys={[LAPTOP]} hasPassword />);
    expect(english.container.textContent).toContain("Added Mar 14, 2026");
  });

  it("gives an unnamed passkey a translated label instead of an empty row", () => {
    // `passkeys.name` is nullable -- a browser need not supply one.
    const { container } = renderWithProviders(<PasskeySection passkeys={[PHONE]} hasPassword />, {
      locale: "de",
    });

    expect(container.textContent).toContain("Passkey");
  });

  it("says so when there are none", () => {
    const { container } = renderWithProviders(<PasskeySection passkeys={[]} hasPassword />);

    expect(container.textContent).toContain("No passkeys yet.");
  });

  /**
   * The last-passkey guard. The server action refuses this too -- and that is
   * the check that counts -- but a confirmation dialog that ends in an error
   * toast is a worse answer than an explanation.
   */
  it("explains rather than offers to delete the only way back in", () => {
    renderWithProviders(<PasskeySection passkeys={[LAPTOP]} hasPassword={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(removePasskey).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "This is your only way to sign in. Set a password before removing it.",
    );
  });

  it("does offer it when a password credential exists", () => {
    // The control: a guard that blocked every deletion would pass the test
    // above and break the feature.
    renderWithProviders(<PasskeySection passkeys={[LAPTOP]} hasPassword />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The trigger opens the confirmation instead of refusing outright.
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByText("Remove this passkey?")).toBeDefined();
  });

  it("does offer it for a passkey that is not the last one, with no password", () => {
    renderWithProviders(<PasskeySection passkeys={[LAPTOP, PHONE]} hasPassword={false} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    expect(toastError).not.toHaveBeenCalled();
  });

  it("refuses to start a ceremony a browser cannot finish", () => {
    // Without PublicKeyCredential, addPasskey() rejects somewhere inside the
    // ceremony and the button appears to do nothing at all.
    renderWithProviders(<PasskeySection passkeys={[]} hasPassword />);

    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));

    expect(addPasskey).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("This browser does not support passkeys.");
  });

  it("refreshes the list after a registration the device completed", async () => {
    pretendWebAuthnExists();
    renderWithProviders(<PasskeySection passkeys={[]} hasPassword />);

    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));

    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Passkey added"));
    // The list comes from a server component, so nothing re-renders without it.
    expect(refresh).toHaveBeenCalled();
  });

  it("tells a cancelled ceremony apart from a real failure", async () => {
    // Two different things to say: "you dismissed the dialog" and "something
    // broke". `passkeyErrorKey()` is the real mapper here, not a stub.
    pretendWebAuthnExists();
    addPasskey.mockResolvedValue({ data: null, error: { code: "ERROR_CEREMONY_ABORTED" } });
    renderWithProviders(<PasskeySection passkeys={[]} hasPassword />);

    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("No passkey was created."));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("survives a request that never reached the server", async () => {
    // @better-fetch/fetch leaves its own `await fetch(...)` unwrapped, so a
    // network-level failure *rejects* rather than resolving to `{ error }`.
    // Unhandled, that leaves the button stuck on "Waiting for your device".
    pretendWebAuthnExists();
    addPasskey.mockRejectedValue(new TypeError("fetch failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderWithProviders(<PasskeySection passkeys={[]} hasPassword />);
      fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));

      await vi.waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("The passkey was not added. Please try again."),
      );
      // The button is usable again, not stuck on its pending label.
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add a passkey" })));
    } finally {
      logged.mockRestore();
    }
  });
});
