import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserAvatar } from "@/components/user-avatar";
import { avatarUrlFor, colourFor } from "@/lib/avatar";
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

/**
 * Every URL the component would actually fetch, recorded.
 *
 * **Asserting on the DOM would prove nothing here**, and that is not a
 * hypothetical: Base UI's `AvatarImage` returns `null` until a load resolves,
 * and jsdom never loads images, so no `<img>` ever reaches the document
 * whatever `src` was passed. A test checking `document.body.innerHTML` for the
 * hostile host therefore stays green with the guard deleted -- verified by
 * deleting it.
 *
 * What the component *does* do is `new window.Image()` and assign `src` (see
 * `avatar/image/useImageLoadingStatus.js`), which in a browser is the request.
 * Recording that assignment is the closest a jsdom test gets to "did this leak
 * the viewer's IP to a third party", and it distinguishes the two cases: with
 * no `src` there is no `<AvatarImage>` at all, so nothing is constructed.
 */
let requested: string[] = [];

/**
 * The interception point is `HTMLImageElement.prototype.src`, not
 * `window.Image`. Replacing the constructor does not work: jsdom defines
 * `window.Image` as an accessor, so `window.Image = Spy` silently does nothing
 * and every assertion built on it passes vacuously. Patching the prototype
 * setter also covers a real `<img>` in the document, not only the detached
 * probe the hook constructs.
 */
const realSrc = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, "src")!;

beforeEach(() => {
  requested = [];
  Object.defineProperty(window.HTMLImageElement.prototype, "src", {
    configurable: true,
    get: realSrc.get,
    // Not forwarded: jsdom would only fire `error`, and the assertion is about
    // what was asked for, not about what came back.
    set(value: string) {
      requested.push(value);
    },
  });
});

afterEach(() => {
  Object.defineProperty(window.HTMLImageElement.prototype, "src", realSrc);
});

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

  /**
   * `users.image` is attacker-controlled and this component renders in *other
   * people's* browsers, so a hostile value must not become a request from any
   * of them. An external URL here is an IP/user-agent/referrer beacon that
   * routes around the entire session-gated media route.
   */
  it.each([
    ["an external tracker", "https://evil.example.com/track.gif"],
    ["a protocol-relative host", "//evil.example.com/track.gif"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["another user's avatar", "/media/avatars/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["the filesystem-style path", `media/avatars/${ADA.id}.webp`],
  ])("requests nothing and falls back to initials for %s", (_label, image) => {
    renderWithProviders(<UserAvatar user={{ ...ADA, image }} />);

    expect(requested).toEqual([]);
    expect(document.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("AL");
  });

  it("does request the avatar when the column holds the one allowed value", () => {
    // The control the table above needs: without it, a guard that refused
    // *everything* would pass every case and break every real avatar.
    renderWithProviders(<UserAvatar user={{ ...ADA, image: avatarUrlFor(ADA.id) }} />);

    expect(requested).toEqual([avatarUrlFor(ADA.id)]);
  });

  it("still paints the initials while an image is pending", () => {
    // Not a workaround for jsdom -- it is Base UI's actual behaviour, and worth
    // pinning. AvatarImage renders nothing until a `new window.Image()` load
    // resolves in the browser, so the server's first frame is always the
    // fallback. jsdom never loads images, which is why no <img> appears here at
    // all; a test asserting on the img element would be asserting on jsdom.
    renderWithProviders(<UserAvatar user={{ ...ADA, image: avatarUrlFor(ADA.id) }} />);

    expect(document.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("AL");
    expect(screen.getByRole("img", { name: "Avatar of Ada Lovelace" })).toBeDefined();
  });
});
