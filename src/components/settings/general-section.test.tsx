import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { GeneralSection } from "./general-section";

/**
 * The label the collapsed trigger displays.
 *
 * Scoped to the value slot rather than the whole trigger, because the trigger
 * also contains the chevron icon (whose glyph lands in textContent).
 */
function triggerText(container: HTMLElement, id: string) {
  return container.querySelector(`#${id} [data-slot="select-value"]`)?.textContent;
}

describe("GeneralSection", () => {
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
});
