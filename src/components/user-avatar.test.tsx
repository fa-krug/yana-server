import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UserAvatar } from "@/components/user-avatar";
import { colourFor } from "@/lib/avatar";
import { renderWithProviders } from "@/test/render";

/**
 * `colourFor()` returns modern-syntax HSL; reading `style.backgroundColor` back
 * out of the DOM returns the browser's normalised `rgb(...)`. Round-tripping
 * the expected value through the same conversion compares like with like,
 * rather than pinning whichever spelling this jsdom happens to emit.
 */
function asRendered(colour: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = colour;
  return probe.style.backgroundColor;
}

const ADA = {
  id: "Nu2fXJ3rQKp1sVdWyBz0aLcMhE7tG4iO",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  image: null,
};

describe("<UserAvatar>", () => {
  it("falls back to initials on the id's colour", () => {
    renderWithProviders(<UserAvatar user={ADA} />);

    const fallback = document.querySelector("[data-slot=avatar-fallback]");
    expect(fallback?.textContent).toBe("AL");
    // Inline, because the colour is computed per user and cannot come from a
    // stylesheet. Read back through colourFor() so the assertion pins "the
    // component uses the helper", not a hue that could drift from it.
    expect((fallback as HTMLElement).style.backgroundColor).toBe(asRendered(colourFor(ADA.id)));
    // And it is a colour jsdom could actually parse -- an unparsed value would
    // leave both sides equal at "" and prove nothing.
    expect(asRendered(colourFor(ADA.id))).not.toBe("");
  });

  it("gives the same user the same colour on every render", () => {
    // The whole point of deriving it from the id: nothing is persisted, so two
    // devices and two sessions have to agree by construction.
    const { unmount } = renderWithProviders(<UserAvatar user={ADA} />);
    const first = (document.querySelector("[data-slot=avatar-fallback]") as HTMLElement).style
      .backgroundColor;
    unmount();

    renderWithProviders(<UserAvatar user={ADA} />);
    const second = (document.querySelector("[data-slot=avatar-fallback]") as HTMLElement).style
      .backgroundColor;

    expect(second).toBe(first);
  });

  it("has one translated accessible name, and the initials are not it", () => {
    // The initials would otherwise be announced as the text "AL". The label
    // lives on the root so it reads the same whether or not an image loaded.
    renderWithProviders(<UserAvatar user={ADA} />);

    expect(screen.getByRole("img", { name: "Avatar of Ada Lovelace" })).toBeDefined();
    expect(document.querySelector("[data-slot=avatar-fallback]")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("translates that label", () => {
    // Asserted against de.json: "Avatar" is the same word in both catalogs, so
    // English would prove nothing about whether the string is translated.
    renderWithProviders(<UserAvatar user={ADA} />, { locale: "de" });

    expect(screen.getByRole("img", { name: "Profilbild von Ada Lovelace" })).toBeDefined();
  });

  it("names an unnamed user by their address rather than leaving a gap", () => {
    // firstName/lastName are notNull with "" defaults, so this is what the
    // bootstrap administrator looks like. "Avatar of " is not a label.
    renderWithProviders(<UserAvatar user={{ ...ADA, firstName: "", lastName: "" }} />);

    expect(screen.getByRole("img", { name: "Avatar of ada@example.com" })).toBeDefined();
    expect(document.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("A");
  });

  it("still paints the initials while an image is pending", () => {
    // Not a workaround for jsdom -- it is Base UI's actual behaviour, and worth
    // pinning. AvatarImage renders nothing until a `new window.Image()` load
    // resolves in the browser, so the server's first frame is always the
    // fallback. jsdom never loads images, which is why no <img> appears here at
    // all; a test asserting on the img element would be asserting on jsdom.
    renderWithProviders(<UserAvatar user={{ ...ADA, image: "/media/avatars/whatever" }} />);

    expect(document.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("AL");
    expect(screen.getByRole("img", { name: "Avatar of Ada Lovelace" })).toBeDefined();
  });
});
