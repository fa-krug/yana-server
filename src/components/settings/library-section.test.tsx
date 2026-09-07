import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { LibrarySection, LibrarySectionForm } from "./library-section";

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
  return renderWithProviders(<LibrarySectionForm articleRetentionDays={30} />, { locale });
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

  it("submits the retention field as a number", async () => {
    render();

    fireEvent.change(field("Aufbewahrung"), { target: { value: "90" } });
    save();

    await waitFor(() =>
      expect(updateLibrarySettings).toHaveBeenCalledWith({ articleRetentionDays: 90 }),
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
    // the half-edited field with it. `attempt()` turns it into a toast.
    updateLibrarySettings.mockRejectedValue(new Error("the container restarted"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render("en");
      fireEvent.change(field("Article retention"), { target: { value: "15" } });
      save("en");

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      // Still on the page, still holding what was typed.
      expect(field("Article retention").value).toBe("15");
    } finally {
      logged.mockRestore();
    }
  });

  it("renders the real input and save button while the value is still loading", () => {
    // The defect this whole migration exists to fix: a loading section used to be
    // a grey bar where the field was. The field itself needs no data -- only its
    // value does -- so it must be on screen, disabled, from the first frame.
    renderWithProviders(<LibrarySectionForm pending />);

    const input = screen.getByLabelText("Article retention") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    // The chrome the shell used to guarantee is still here, from the same component.
    expect(screen.getByText("Library")).toBeTruthy();
  });

  it("shows the resolved value once the promise settles", async () => {
    // A deferred promise, resolved under an explicit `act()` -- React 19's
    // `use()` registers its continuation as a bare promise `.then()`, which
    // lands outside any `act()` scope unless the resolution itself is wrapped.
    // Without this, the update that fills in "60" never commits and the test
    // hangs on `waitFor` instead of failing fast.
    let resolveSettings!: (value: { articleRetentionDays: number }) => void;
    const promise = new Promise<{ articleRetentionDays: number }>((resolve) => {
      resolveSettings = resolve;
    });

    await act(async () => {
      renderWithProviders(<LibrarySection promise={promise} />);
    });

    // Pending first: real control, no value.
    expect((screen.getByLabelText("Article retention") as HTMLInputElement).value).toBe("");

    await act(async () => {
      resolveSettings({ articleRetentionDays: 60 });
      await promise;
    });

    // Then the value fills in, with no skeleton in between.
    expect((screen.getByLabelText("Article retention") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Article retention") as HTMLInputElement).disabled).toBe(false);
  });
});
