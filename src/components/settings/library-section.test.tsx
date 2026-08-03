import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { LibrarySection } from "./library-section";

const { updateLibrarySettings } = vi.hoisted(() => ({ updateLibrarySettings: vi.fn() }));
vi.mock("@/lib/settings/actions", () => ({ updateLibrarySettings }));

// The real stub module, never an inline factory: `attempt()` reaches
// `unstable_rethrow`, and a hand-written mock that forgot it kills the file.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

function render(locale: "en" | "de" = "de") {
  return renderWithProviders(
    <LibrarySection articleRetentionDays={30} updateIntervalMinutes={60} />,
    { locale },
  );
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function save(locale: "en" | "de" = "de"): void {
  fireEvent.click(screen.getByRole("button", { name: locale === "de" ? "Speichern" : "Save" }));
}

describe("<LibrarySection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateLibrarySettings.mockResolvedValue({ ok: true });
  });

  it("submits both fields as numbers", async () => {
    render();

    fireEvent.change(field("Aufbewahrung"), { target: { value: "90" } });
    save();

    await waitFor(() =>
      expect(updateLibrarySettings).toHaveBeenCalledWith({
        articleRetentionDays: 90,
        updateIntervalMinutes: 60,
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Einstellungen gespeichert");
  });

  it("shows the refusal the server named, not the generic one", async () => {
    // Only the catalog key crosses the wire; zod's English message never does.
    updateLibrarySettings.mockResolvedValue({ ok: false, errorKey: "library.retentionRange" });
    render();

    save();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Die Aufbewahrung muss zwischen 1 und 3650 Tagen liegen.",
      ),
    );
  });

  it("survives a save that rejects instead of returning", async () => {
    // The regression this file exists for. Phase 3 awaited the action bare, so a
    // rejection -- a dropped connection, the container restarting mid-request --
    // went unhandled inside the transition scope and escalated to the (app)
    // group's error.tsx: the whole page became "Something went wrong", taking
    // the two half-edited fields with it. `attempt()` turns it into a toast.
    updateLibrarySettings.mockRejectedValue(new Error("the container restarted"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render("en");
      fireEvent.change(field("Update interval"), { target: { value: "15" } });
      save("en");

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      // Still on the page, still holding what was typed.
      expect(field("Update interval").value).toBe("15");
    } finally {
      logged.mockRestore();
    }
  });
});
