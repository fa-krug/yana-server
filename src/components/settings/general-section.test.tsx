import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { GeneralSection } from "./general-section";

const { updateGeneralSettings } = vi.hoisted(() => ({ updateGeneralSettings: vi.fn() }));
vi.mock("@/lib/settings/actions", () => ({ updateGeneralSettings }));

// The real stub module, never an inline factory: `attempt()` reaches
// `unstable_rethrow`, and a hand-written mock that forgot it kills the file.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

/**
 * The label the collapsed trigger displays.
 *
 * Scoped to the value slot rather than the whole trigger, because the trigger
 * also contains the chevron icon (whose glyph lands in textContent).
 */
function triggerText(container: HTMLElement, id: string) {
  return container.querySelector(`#${id} [data-slot="select-value"]`)?.textContent;
}

/**
 * Pick an option out of one of the two Selects.
 *
 * Base UI's items commit on a pointer *sequence*, not on a bare `click`: a lone
 * click on the option leaves `onValueChange` unfired and the test silently
 * proves nothing, so the three events are all required. Opening the popup is a
 * plain click on the trigger.
 */
async function pick(container: HTMLElement, id: string, option: string) {
  fireEvent.click(container.querySelector(`#${id}`) as HTMLElement);
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
  const item = screen.getByRole("option", { name: option });
  fireEvent.pointerDown(item, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(item, { pointerType: "mouse", button: 0 });
  fireEvent.click(item);
}

describe("GeneralSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateGeneralSettings.mockResolvedValue({ ok: true });
  });

  // The collapsed trigger is the first thing a user sees, and Base UI resolves
  // its text from the root's `items` map rather than from <Select.ItemText>:
  // without that map it printed the raw enum ("dark") while the popup items
  // were translated, so a test that only opens the popup would have missed it.
  // No interaction here at all -- the trigger's text is rendered eagerly.
  it("shows the translated theme label on the trigger, not the raw value", () => {
    const { container } = renderWithProviders(
      <GeneralSection theme="light" language="en" />,
      // next-themes has no stored value, so its defaultTheme is what applies.
      { theme: "dark" },
    );

    expect(triggerText(container, "theme")).toBe("Dark");
  });

  it("translates both triggers into the active locale", () => {
    // German makes the assertion unambiguous: "Dunkel" cannot be a stringified
    // "dark", whereas "Dark" differs from it only in case.
    const { container } = renderWithProviders(<GeneralSection theme="light" language="de" />, {
      locale: "de",
      theme: "dark",
    });

    expect(triggerText(container, "theme")).toBe("Dunkel");
    expect(triggerText(container, "language")).toBe("Deutsch");
  });

  it("displays the theme localStorage applies, not the one the server passed", () => {
    // The documented two-store rule (see the component's comment and
    // CLAUDE.md): localStorage decides what is *applied*, the database row is
    // only the portable preference and the pre-hydration fallback. A client
    // render is past hydration on its first pass, so the applied value is what
    // must show -- "Hell" here would mean the control is reporting a theme the
    // page is not wearing.
    localStorage.setItem("theme", "dark");
    const { container } = renderWithProviders(<GeneralSection theme="light" language="de" />, {
      locale: "de",
      theme: "light",
    });

    expect(triggerText(container, "theme")).toBe("Dunkel");
  });

  it("saves both values when one of them changes", async () => {
    // The action takes the whole pair, not the field that moved: it writes both
    // columns, so sending only the new language would blank the theme.
    const { container } = renderWithProviders(<GeneralSection theme="dark" language="en" />, {
      locale: "de",
      theme: "dark",
    });

    await pick(container, "language", "Deutsch");

    await waitFor(() =>
      expect(updateGeneralSettings).toHaveBeenCalledWith({ theme: "dark", language: "de" }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Einstellungen gespeichert");
  });

  it("survives a save that rejects instead of returning", async () => {
    // The regression this covers. Phase 3 awaited the action bare, so a
    // rejection -- a dropped connection, the container restarting mid-request,
    // or the proxy answering a cookie-less action POST with a 307 to /login --
    // went unhandled inside the transition scope and escalated to the (app)
    // group's error.tsx, replacing the whole page with "Something went wrong".
    // `attempt()` turns it into a toast and leaves the page standing.
    updateGeneralSettings.mockRejectedValue(new Error("the container restarted"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { container } = renderWithProviders(<GeneralSection theme="light" language="en" />, {
        theme: "light",
      });

      await pick(container, "language", "German");

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      // The control is still mounted, which is the half of this the toast does
      // not prove: an escalated rejection would have unmounted the whole page.
      expect(triggerText(container, "language")).toBe("German");
    } finally {
      logged.mockRestore();
    }
  });
});
