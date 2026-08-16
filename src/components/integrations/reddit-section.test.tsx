import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KEEP_EXISTING } from "@/lib/secrets";
import { renderWithProviders } from "@/test/render";

import { RedditSectionForm } from "./reddit-section";

const { removeReddit, saveReddit, testReddit } = vi.hoisted(() => ({
  removeReddit: vi.fn(),
  saveReddit: vi.fn(),
  testReddit: vi.fn(),
}));
vi.mock("@/lib/integrations/actions", () => ({ removeReddit, saveReddit, testReddit }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess, warning: toastWarning },
}));

const CONFIGURED = {
  enabled: true,
  clientIdMasked: "••••••••0001",
  clientSecretMasked: "••••••••0002",
  userAgent: "Yana/1.0 (by u/tester)",
};

const UNCONFIGURED = {
  enabled: false,
  clientIdMasked: "",
  clientSecretMasked: "",
  userAgent: "Yana/1.0",
};

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function submit(): void {
  fireEvent.submit(screen.getByRole("button", { name: /Speichern|Save/ }).closest("form")!);
}

describe("<RedditSectionForm>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveReddit.mockResolvedValue({ ok: true });
    testReddit.mockResolvedValue({ ok: true });
    removeReddit.mockResolvedValue({ ok: true });
  });

  it("masks both secrets and shows the user agent in full", async () => {
    // The split this card exists to get right: two credentials that must never
    // reach the browser, and one identifier that must be readable and editable.
    renderWithProviders(<RedditSectionForm {...CONFIGURED} />, { locale: "de" });

    expect(field("Client-ID").value).toBe("");
    expect(field("Client-ID").placeholder).toBe(CONFIGURED.clientIdMasked);
    expect(field("Client-ID").type).toBe("password");
    expect(field("Client-Secret").value).toBe("");
    expect(field("Client-Secret").placeholder).toBe(CONFIGURED.clientSecretMasked);
    expect(field("Client-Secret").type).toBe("password");

    expect(field("User-Agent").type).toBe("text");
    expect(field("User-Agent").value).toBe("Yana/1.0 (by u/tester)");
    // Against de.json, so a hard-coded English label would fail here.
    expect(screen.getByText("Aktiv")).toBeTruthy();
  });

  it("keeps each stored secret independently of the other", async () => {
    // Rotating only the secret must not mean re-typing the client id, so the
    // untouched field carries the sentinel while the edited one carries a value.
    renderWithProviders(<RedditSectionForm {...CONFIGURED} />, { locale: "de" });

    fireEvent.change(field("Client-Secret"), { target: { value: "a-rotated-secret" } });
    submit();

    await waitFor(() =>
      expect(saveReddit).toHaveBeenCalledWith({
        clientId: KEEP_EXISTING,
        clientSecret: "a-rotated-secret",
        userAgent: "Yana/1.0 (by u/tester)",
      }),
    );
    await waitFor(() => expect(field("Client-Secret").value).toBe(""));
  });

  it("sends the edited user agent in full, never a sentinel", async () => {
    renderWithProviders(<RedditSectionForm {...CONFIGURED} />);

    fireEvent.change(field("User agent"), { target: { value: "Yana/1.0 (by u/someone)" } });
    submit();

    await waitFor(() =>
      expect(saveReddit).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: "Yana/1.0 (by u/someone)" }),
      ),
    );
    // It is not a secret, so it stays in the field after a save.
    expect(field("User agent").value).toBe("Yana/1.0 (by u/someone)");
  });

  it("reports a missing user agent with its own message", async () => {
    saveReddit.mockResolvedValue({ ok: false, errorKey: "reddit.userAgentRequired" });
    renderWithProviders(<RedditSectionForm {...CONFIGURED} />, { locale: "de" });

    fireEvent.change(field("User-Agent"), { target: { value: "  " } });
    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Ein User-Agent ist erforderlich."),
    );
  });

  it("reports Reddit's rate limit as a failure, because it verifies nothing", async () => {
    // Not a warning-over-success, unlike YouTube's spent quota: Reddit's 429 is
    // returned before the credentials are checked, so the save wrote nothing and
    // the operator has to try again. See `quotaMeansVerified` in the actions.
    saveReddit.mockResolvedValue({ ok: false, errorKey: "reddit.rateLimited" });
    renderWithProviders(<RedditSectionForm {...CONFIGURED} />, { locale: "de" });

    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("Reddit begrenzt gerade die Anfragen"),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("tests without saving", async () => {
    renderWithProviders(<RedditSectionForm {...UNCONFIGURED} />, { locale: "de" });

    fireEvent.change(field("Client-ID"), { target: { value: "an-id" } });
    fireEvent.change(field("Client-Secret"), { target: { value: "a-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Testen" }));

    await waitFor(() =>
      expect(testReddit).toHaveBeenCalledWith({
        clientId: "an-id",
        clientSecret: "a-secret",
        userAgent: "Yana/1.0",
      }),
    );
    expect(saveReddit).not.toHaveBeenCalled();
  });

  it("offers no remove button until something is stored", () => {
    renderWithProviders(<RedditSectionForm {...UNCONFIGURED} />, { locale: "de" });

    expect(screen.queryByRole("button", { name: "Zugangsdaten entfernen" })).toBe(null);
    expect(screen.getByText("Noch nicht eingerichtet.")).toBeTruthy();
  });

  it("survives a test that rejects instead of returning", async () => {
    testReddit.mockRejectedValue(new Error("Failed to fetch"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderWithProviders(<RedditSectionForm {...CONFIGURED} />, { locale: "de" });
      fireEvent.click(screen.getByRole("button", { name: "Testen" }));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "Der Server hat nicht geantwortet. Prüfe deine Verbindung und versuche es erneut.",
        ),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("renders the real credential fields while the status is still loading", () => {
    // The defect this whole migration exists to fix: a loading section used to
    // be a skeleton block where the card was. The fields and both buttons need
    // no data to exist -- only their values do -- so they must be on screen,
    // disabled, from the first frame.
    renderWithProviders(<RedditSectionForm pending />);

    expect(field("Client ID").disabled).toBe(true);
    expect(field("Client ID").value).toBe("");
    expect(field("Client secret").disabled).toBe(true);
    expect(field("Client secret").value).toBe("");
    // No mask is known yet, so no placeholder is asserted -- see the
    // masked-secret protocol in CLAUDE.md.
    expect(field("User agent").disabled).toBe(true);
    expect(field("User agent").value).toBe("");
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
    expect(screen.getByText("Reddit")).toBeTruthy();
  });
});
