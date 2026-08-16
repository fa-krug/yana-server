import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AI_ADVANCED_BOUNDS, AI_ADVANCED_FIELDS } from "@/lib/ai/bounds";
import type { AiAdvanced } from "@/lib/ai/queries";
import { renderWithProviders } from "@/test/render";

import { AdvancedSectionForm } from "./advanced-section";

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
  return renderWithProviders(<AdvancedSectionForm advanced={ADVANCED} />, { locale });
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

  it("shows every stored value under its translated label", () => {
    render();

    // Asserted against de.json, where the label is nothing like the field name.
    expect(field("Temperatur").value).toBe("0.7");
    expect(field("Anfrage-Timeout (Sekunden)").value).toBe("60");
    // Nine fields, one Save: the pair rule (`monthlyLimit >= dailyLimit`) cannot
    // be checked by a field that saves itself.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(9);
    expect(screen.getAllByRole("button", { name: "Speichern" })).toHaveLength(1);
  });

  it("puts the server's own bounds on every input", () => {
    // Read from `AI_ADVANCED_BOUNDS` rather than restated, because restating
    // them is the defect this pins: `@/lib/ai/actions` builds its zod schema out
    // of the same table, so a hint the browser shows and the rule the server
    // applies cannot disagree. Asserting nine literals here would be a third
    // copy able to drift from both.
    render();

    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(inputs.map((input) => input.id)).toEqual(AI_ADVANCED_FIELDS.map((name) => `ai-${name}`));
    for (const name of AI_ADVANCED_FIELDS) {
      const input = document.querySelector<HTMLInputElement>(`#ai-${name}`)!;
      expect([name, input.min, input.max]).toEqual([
        name,
        String(AI_ADVANCED_BOUNDS[name].min),
        String(AI_ADVANCED_BOUNDS[name].max),
      ]);
      // Only `temperature` is a float column; the other eight are `.int()`
      // server-side and must not offer a fractional step.
      expect([name, input.step]).toEqual([name, AI_ADVANCED_BOUNDS[name].integer ? "1" : "0.1"]);
    }
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

  describe("pending", () => {
    it("renders all nine fields with their real bounds, disabled and empty", () => {
      renderWithProviders(<AdvancedSectionForm pending />);

      const fields = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      expect(fields).toHaveLength(9);
      expect(fields.every((f) => f.disabled)).toBe(true);
      expect(fields.every((f) => f.value === "")).toBe(true);
      // Bounds come from AI_ADVANCED_BOUNDS, which imports nothing -- so they
      // are already real, not a guess, before any row has loaded.
      expect(fields.every((f) => f.min !== "")).toBe(true);
      expect(fields.every((f) => f.max !== "")).toBe(true);
    });

    it("still shows the Save button, disabled", () => {
      renderWithProviders(<AdvancedSectionForm pending />);

      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    it("still shows the card heading and every field label", () => {
      renderWithProviders(<AdvancedSectionForm pending />);

      expect(screen.getByText("Advanced")).toBeTruthy();
      expect(screen.getByText("Temperature")).toBeTruthy();
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
    });
  });
});
