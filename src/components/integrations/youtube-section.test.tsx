import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KEEP_EXISTING } from "@/lib/secrets";
import { renderWithProviders } from "@/test/render";

import { YoutubeSectionForm } from "./youtube-section";

const { removeYoutube, saveYoutube, testYoutube } = vi.hoisted(() => ({
  removeYoutube: vi.fn(),
  saveYoutube: vi.fn(),
  testYoutube: vi.fn(),
}));
vi.mock("@/lib/integrations/actions", () => ({ removeYoutube, saveYoutube, testYoutube }));

// The real stub module, never an inline factory: `attempt()` reaches
// `unstable_rethrow`, and a hand-written mock that forgot it kills the file.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess, warning: toastWarning },
}));

/** What a configured integration looks like: eight bullets and a four-character tail. */
const MASK = "••••••••0001";

function apiKeyField(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function submit(): void {
  fireEvent.submit(screen.getByRole("button", { name: /Speichern|Save/ }).closest("form")!);
}

describe("<YoutubeSectionForm>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveYoutube.mockResolvedValue({ ok: true });
    testYoutube.mockResolvedValue({ ok: true });
    removeYoutube.mockResolvedValue({ ok: true });
  });

  it("shows the mask as a placeholder and never as a value", async () => {
    // The whole secret-handling contract, in the DOM: the stored key is not in
    // this component's props, so the strongest local statement is that the field
    // is empty and only the mask is visible -- and that the mask is a
    // placeholder, because a value would be submitted back on the next save.
    renderWithProviders(<YoutubeSectionForm enabled apiKeyMasked={MASK} />, { locale: "de" });

    const field = apiKeyField("API-Schlüssel");
    expect(field.value).toBe("");
    expect(field.placeholder).toBe(MASK);
    // A password field, so it is not readable over a shoulder, and no password
    // manager offers to fill or store it.
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");
    // Asserted against de.json: "Enabled"/"Active" is close enough to the raw
    // flag to prove nothing about the catalog being wired up at all.
    expect(screen.getByText("Aktiv")).toBeTruthy();
  });

  it("submits the keep-existing sentinel when the field was never touched", async () => {
    renderWithProviders(<YoutubeSectionForm enabled apiKeyMasked={MASK} />);

    submit();

    await waitFor(() => expect(saveYoutube).toHaveBeenCalledWith({ apiKey: KEEP_EXISTING }));
    expect(toastSuccess).toHaveBeenCalledWith("Credentials verified and saved.");
  });

  it("submits what was typed, and clears the field afterwards", async () => {
    renderWithProviders(<YoutubeSectionForm enabled={false} apiKeyMasked="" />);

    fireEvent.change(apiKeyField("API key"), { target: { value: "AIza-a-new-key" } });
    submit();

    await waitFor(() => expect(saveYoutube).toHaveBeenCalledWith({ apiKey: "AIza-a-new-key" }));
    // Cleared on success, so the refreshed placeholder is what shows and the
    // key is not sitting in the DOM waiting to be re-submitted.
    await waitFor(() => expect(apiKeyField("API key").value).toBe(""));
  });

  it("keeps the typed key when the provider rejected it", async () => {
    saveYoutube.mockResolvedValue({ ok: false, errorKey: "youtube.rejected" });
    renderWithProviders(<YoutubeSectionForm enabled={false} apiKeyMasked="" />, { locale: "de" });

    fireEvent.change(apiKeyField("API-Schlüssel"), { target: { value: "wrong" } });
    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("YouTube hat diesen API-Schlüssel abgelehnt"),
      ),
    );
    // A typo is corrected, not retyped.
    expect(apiKeyField("API-Schlüssel").value).toBe("wrong");
  });

  it("reports a quota answer as a warning, not as a success or a failure", async () => {
    // The key is valid and only today's budget is gone: the integration was
    // switched on, so a red toast would send the operator back to re-save
    // something that already worked -- and a green one would hide why the feeds
    // are empty.
    saveYoutube.mockResolvedValue({ ok: true, noticeKey: "youtube.quota" });
    renderWithProviders(<YoutubeSectionForm enabled apiKeyMasked={MASK} />, { locale: "de" });

    submit();

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        expect.stringContaining("Kontingent für heute ist aufgebraucht"),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("tests the submitted credentials without saving them", async () => {
    renderWithProviders(<YoutubeSectionForm enabled={false} apiKeyMasked={MASK} />, {
      locale: "de",
    });

    fireEvent.change(apiKeyField("API-Schlüssel"), { target: { value: "a-candidate" } });
    fireEvent.click(screen.getByRole("button", { name: "Testen" }));

    await waitFor(() => expect(testYoutube).toHaveBeenCalledWith({ apiKey: "a-candidate" }));
    expect(saveYoutube).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Diese Zugangsdaten funktionieren.");
  });

  /**
   * The fallback message names the action that failed.
   *
   * A `{ ok: false }` with no key of its own is reachable from every action here
   * (a malformed body, a missing settings row, a write that matched no row), and a
   * single fallback answered all of them with "Could not save these credentials."
   * -- told to an operator who pressed **Test**, about a call that never writes.
   */
  it.each([
    ["Testen", "Diese Zugangsdaten konnten nicht getestet werden."],
    ["Speichern und prüfen", "Diese Zugangsdaten konnten nicht gespeichert werden."],
  ])("blames the right action when %s fails with no key", async (button, message) => {
    saveYoutube.mockResolvedValue({ ok: false });
    testYoutube.mockResolvedValue({ ok: false });
    renderWithProviders(<YoutubeSectionForm enabled={false} apiKeyMasked={MASK} />, {
      locale: "de",
    });

    fireEvent.click(screen.getByRole("button", { name: button }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
  });

  it("offers no remove button until something is stored", () => {
    renderWithProviders(<YoutubeSectionForm enabled={false} apiKeyMasked="" />, { locale: "de" });

    expect(screen.queryByRole("button", { name: "Zugangsdaten entfernen" })).toBe(null);
  });

  it("removes the stored key behind a confirmation", async () => {
    renderWithProviders(<YoutubeSectionForm enabled apiKeyMasked={MASK} />, { locale: "de" });

    fireEvent.click(screen.getByRole("button", { name: "Zugangsdaten entfernen" }));
    expect(screen.getByText("YouTube-Zugangsdaten entfernen?")).toBeTruthy();
    // The popup's confirm, not the trigger.
    const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')!;
    fireEvent.click(within(popup).getByRole("button", { name: "Entfernen" }));

    await waitFor(() => expect(removeYoutube).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("Zugangsdaten entfernt.");
  });

  it("keeps the confirmation open when the removal is refused", async () => {
    // ConfirmDestructive closes only on `true`, so the error toast is read
    // against the thing it refers to instead of over a card that looks changed.
    removeYoutube.mockResolvedValue({ ok: false, errorKey: "removeFailed" });
    renderWithProviders(<YoutubeSectionForm enabled apiKeyMasked={MASK} />, { locale: "de" });

    fireEvent.click(screen.getByRole("button", { name: "Zugangsdaten entfernen" }));
    const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')!;
    fireEvent.click(within(popup).getByRole("button", { name: "Entfernen" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Die Zugangsdaten konnten nicht entfernt werden."),
    );
    expect(screen.getByText("YouTube-Zugangsdaten entfernen?")).toBeTruthy();
  });

  it("survives a save that rejects instead of returning", async () => {
    // Unhandled, this rejection escalates to the (app) error boundary and takes
    // the half-typed key with it. `attempt()` is what turns it into a toast.
    saveYoutube.mockRejectedValue(new Error("the container restarted"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderWithProviders(<YoutubeSectionForm enabled={false} apiKeyMasked="" />);
      fireEvent.change(apiKeyField("API key"), { target: { value: "AIza-a-new-key" } });
      submit();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      expect(apiKeyField("API key").value).toBe("AIza-a-new-key");
    } finally {
      logged.mockRestore();
    }
  });

  it("renders the real credential fields while the status is still loading", () => {
    // The defect this whole migration exists to fix: a loading section used to
    // be a skeleton block where the card was. The field and both buttons need
    // no data to exist -- only their values do -- so they must be on screen,
    // disabled, from the first frame.
    renderWithProviders(<YoutubeSectionForm pending />);

    const key = apiKeyField("API key");
    expect(key.disabled).toBe(true);
    expect(key.value).toBe("");
    // No mask is known yet, so no placeholder is asserted -- see the masked-secret
    // protocol in CLAUDE.md. What matters is that the field itself is here.
    expect(
      (screen.getByRole("button", { name: "Save and verify" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true);
    // The status badge is data-dependent (an unknown probe verdict), so it is
    // omitted entirely rather than shown with a neutral frame.
    expect(screen.queryByText("Active")).toBe(null);
    expect(screen.queryByText("Inactive")).toBe(null);
    // No remove button either: nothing is yet known to be stored.
    expect(screen.queryByRole("button", { name: "Remove credentials" })).toBe(null);
    // The chrome the shell used to guarantee is still here, from the same component.
    expect(screen.getByText("YouTube")).toBeTruthy();
  });
});
