import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiAdvanced } from "@/lib/ai/queries";
import { renderWithProviders } from "@/test/render";

import { AdvancedSection } from "./advanced-section";

const { saveAdvanced } = vi.hoisted(() => ({ saveAdvanced: vi.fn() }));
vi.mock("@/lib/ai/actions", () => ({ saveAdvanced }));

// The real stub module, never an inline factory: `attempt()` reaches
// `unstable_rethrow`, and a hand-written mock that forgot it kills the file.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const ADVANCED: AiAdvanced = {
  temperature: 0.7,
  maxTokens: 1000,
  dailyLimit: 100,
  monthlyLimit: 1000,
  maxPromptLength: 8000,
  requestTimeout: 60,
  maxRetries: 3,
  retryDelay: 5,
  requestDelay: 1,
};

function render(locale: "en" | "de" = "de") {
  return renderWithProviders(<AdvancedSection advanced={ADVANCED} />, { locale });
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function submit(): void {
  fireEvent.submit(document.querySelector<HTMLFormElement>("form")!);
}

describe("<AdvancedSection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveAdvanced.mockResolvedValue({ ok: true });
  });

  it("shows every stored value, with the server's bounds on the input", () => {
    render();

    // Asserted against de.json, where the label is nothing like the field name.
    expect(field("Temperatur").value).toBe("0.7");
    expect(field("Temperatur").min).toBe("0");
    expect(field("Temperatur").max).toBe("2");
    expect(field("Anfrage-Timeout (Sekunden)").value).toBe("60");
    expect(field("Anfrage-Timeout (Sekunden)").min).toBe("5");
    expect(field("Anfrage-Timeout (Sekunden)").max).toBe("600");
    // Nine fields, one Save: the pair rule (`monthlyLimit >= dailyLimit`) cannot
    // be checked by a field that saves itself.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(9);
    expect(screen.getAllByRole("button", { name: "Speichern" })).toHaveLength(1);
  });

  it("submits all nine values as numbers, including the ones untouched", async () => {
    render();

    fireEvent.change(field("Monatslimit für Anfragen"), { target: { value: "2500" } });
    submit();

    await waitFor(() =>
      expect(saveAdvanced).toHaveBeenCalledWith({ ...ADVANCED, monthlyLimit: 2500 }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("KI-Einstellungen gespeichert.");
  });

  it("sends an emptied field as NaN rather than as zero", async () => {
    // `Number("")` is `0`, and `0` is a temperature the server accepts -- so
    // coercing would silently store a value nobody typed. NaN is refused, and
    // the reply names the field and its range.
    render();

    fireEvent.change(field("Temperatur"), { target: { value: "" } });
    submit();

    await waitFor(() =>
      expect(saveAdvanced).toHaveBeenCalledWith({ ...ADVANCED, temperature: Number.NaN }),
    );
  });

  it("shows the refusal the server named, not a generic one", async () => {
    // The cross-field rule and an ordinary range failure both land on
    // `monthlyLimit` and want different advice; the server picks, and only its
    // catalog key crosses the wire.
    saveAdvanced.mockResolvedValue({ ok: false, errorKey: "advanced.monthlyBelowDaily" });
    render();

    fireEvent.change(field("Monatslimit für Anfragen"), { target: { value: "10" } });
    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("mindestens so groß sein wie das Tageslimit"),
      ),
    );
    // The typed values stay: nine numbers are not worth retyping over one.
    expect(field("Monatslimit für Anfragen").value).toBe("10");
  });

  it("falls back to the namespace's own message when the server names no key", async () => {
    saveAdvanced.mockResolvedValue({ ok: false });
    render();

    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Diese Einstellungen konnten nicht gespeichert werden.",
      ),
    );
  });

  it("survives a save that rejects instead of returning", async () => {
    // Unhandled, this rejection escalates to the (app) error boundary and
    // replaces the page along with the nine half-edited fields. `attempt()` is
    // what turns it into a toast.
    saveAdvanced.mockRejectedValue(new Error("the container restarted"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render("en");
      fireEvent.change(field("Retries"), { target: { value: "7" } });
      submit();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      expect(field("Retries").value).toBe("7");
    } finally {
      logged.mockRestore();
    }
  });
});
