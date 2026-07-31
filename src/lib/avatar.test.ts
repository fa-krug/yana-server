import { describe, expect, it } from "vitest";

import {
  avatarUrlFor,
  colourFor,
  contrastWithWhite,
  displayNameFor,
  initialsFor,
  safeAvatarSrc,
} from "./avatar";

describe("initialsFor", () => {
  it("uses both name initials", () => {
    expect(initialsFor({ firstName: "Ada", lastName: "Lovelace", email: "a@b.c" })).toBe("AL");
  });

  it("falls back to the email when names are empty", () => {
    // `firstName`/`lastName` are notNull with "" defaults, so this -- not null
    // -- is what "no name at all" looks like in a row.
    expect(initialsFor({ firstName: "", lastName: "", email: "ada@example.com" })).toBe("A");
  });

  it("ignores a name that is only whitespace", () => {
    expect(initialsFor({ firstName: "   ", lastName: "\t", email: "ada@example.com" })).toBe("A");
  });

  it("handles a first name alone", () => {
    expect(initialsFor({ firstName: "Ada", lastName: "", email: "a@b.c" })).toBe("A");
  });

  it("handles a last name alone", () => {
    expect(initialsFor({ firstName: "", lastName: "Lovelace", email: "a@b.c" })).toBe("L");
  });

  it("never renders an empty circle", () => {
    expect(initialsFor({ firstName: "", lastName: "", email: "" })).toBe("?");
  });
});

describe("displayNameFor", () => {
  it("joins the two name columns", () => {
    expect(displayNameFor({ firstName: "Ada", lastName: "Lovelace", email: "a@b.c" })).toBe(
      "Ada Lovelace",
    );
  });

  it("does not produce a dangling space for a half-named user", () => {
    // The accessible label interpolates this; "Avatar of Ada " reads badly and
    // "Avatar of " (both columns empty) reads as nothing at all.
    expect(displayNameFor({ firstName: "Ada", lastName: "", email: "a@b.c" })).toBe("Ada");
    expect(displayNameFor({ firstName: "", lastName: "", email: "a@b.c" })).toBe("a@b.c");
  });
});

/**
 * **The measuring stick, measured.**
 *
 * Every contrast assertion below calls `contrastWithWhite()` -- and so does the
 * solver inside `colourFor()`. A shared helper that agreed with itself would
 * satisfy all of them while being wrong about colour entirely: swap sRGB
 * gamma-expansion for a linear ratio, or the luminance coefficients for equal
 * thirds, and the solver would pick different lightnesses, the tests would
 * still pass, and half of all users would be back to unreadable initials.
 *
 * The two endpoints of WCAG's formula are constants nothing here can move:
 * black on white is exactly 21:1 and white on white exactly 1:1. Pinning them
 * anchors the function to the specification rather than to itself.
 */
describe("contrastWithWhite", () => {
  it("gives the two ratios WCAG fixes by definition", () => {
    // (1.0 + 0.05) / (0.0 + 0.05) = 21, and (1.05 / 1.05) = 1.
    expect(contrastWithWhite(0, 0, 0)).toBeCloseTo(21, 5);
    expect(contrastWithWhite(0, 0, 100)).toBeCloseTo(1, 5);
  });

  it("puts a mid grey where the sRGB transfer curve does, not where a linear ratio would", () => {
    // 50% lightness is sRGB #808080, whose *relative luminance* is 0.2140 --
    // not 0.5. A model that skipped gamma expansion would land near 2.0:1
    // instead, which is the single most likely way to get this wrong.
    expect(contrastWithWhite(0, 0, 50)).toBeCloseTo(3.977, 3);
  });

  it("weights the three channels the way sRGB does", () => {
    // Greys cannot show this: r = g = b, so *any* coefficients summing to 1 --
    // equal thirds included -- reproduce the assertions above exactly. The
    // three primaries can, and their ratios against white are published
    // constants: #FF0000 3.998:1, #00FF00 1.372:1, #0000FF 8.592:1. Green
    // carries 0.7152 of the luminance and blue 0.0722, which is also *why*
    // `colourFor()` has to solve per hue instead of pinning a lightness.
    expect(contrastWithWhite(0, 100, 50)).toBeCloseTo(3.998, 3);
    expect(contrastWithWhite(120, 100, 50)).toBeCloseTo(1.372, 3);
    expect(contrastWithWhite(240, 100, 50)).toBeCloseTo(8.592, 3);
  });

  it("is monotonic in lightness", () => {
    // Cheap, and it fails for any channel mix-up that happens to preserve the
    // endpoints above.
    for (let l = 1; l <= 100; l += 1) {
      expect(contrastWithWhite(210, 55, l)).toBeLessThan(contrastWithWhite(210, 55, l - 1));
    }
  });
});

describe("colourFor", () => {
  it("is stable for the same id", () => {
    expect(colourFor("user-1")).toBe(colourFor("user-1"));
  });

  it("differs across ids", () => {
    expect(colourFor("user-1")).not.toBe(colourFor("user-2"));
  });

  it("stays inside the hue range whatever the id", () => {
    // The modulo runs inside the loop, so no id can push the hue past 359 --
    // which is what keeps the string a valid colour rather than silently
    // rendering transparent.
    for (const id of ["", "a", "ÿÿÿ", "z".repeat(200)]) {
      const match = /^hsl\((\d+) 55% (\d+)%\)$/.exec(colourFor(id));
      expect(match, `colourFor(${JSON.stringify(id)})`).not.toBe(null);
      expect(Number(match![1])).toBeLessThan(360);
    }
  });

  /**
   * The regression this replaced: white on a fixed `hsl(h 55% 45%)` is below
   * AA 4.5:1 for 184 of 360 hues and bottoms out at 2.26:1 near hue 60. Ids are
   * random, so that was roughly half of all users, permanently, on their own
   * avatar. Asserted across the **whole hue range**, not for a couple of sample
   * ids -- sampling is exactly what let the first version ship.
   */
  it("clears WCAG AA against white for every hue it can produce", () => {
    const failures: string[] = [];
    for (let hue = 0; hue < 360; hue += 1) {
      const match = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(colourForHue(hue));
      const [, h, s, l] = match!.map(Number);
      const ratio = contrastWithWhite(h, s, l);
      if (ratio < 4.5) failures.push(`hue ${hue}: ${ratio.toFixed(2)}:1 at l=${l}%`);
    }

    expect(failures).toEqual([]);
  });

  it("varies lightness with hue rather than pinning it", () => {
    // The mechanism, not just the outcome: a fixed lightness cannot satisfy the
    // assertion above, because relative luminance is wildly non-uniform across
    // hue (green carries 0.7152 of it, blue 0.0722).
    const lightnesses = new Set<string>();
    for (let hue = 0; hue < 360; hue += 1) {
      lightnesses.add(/ (\d+)%\)$/.exec(colourForHue(hue))![1]);
    }

    expect(lightnesses.size).toBeGreaterThan(10);
  });

  it("keeps the palette in a narrow contrast band", () => {
    // Not merely "dark enough": a colour far above the target is needlessly
    // murky. Solving per hue is what keeps them all close to the same ratio.
    const ratios = [];
    for (let hue = 0; hue < 360; hue += 1) {
      const [, h, s, l] = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(colourForHue(hue))!.map(Number);
      ratios.push(contrastWithWhite(h, s, l));
    }

    expect(Math.max(...ratios)).toBeLessThan(6);
  });
});

/**
 * Drive `colourFor()` at a chosen hue.
 *
 * The hue is `id.charCodeAt()` folded with `*31 % 360`, so a one-character id
 * whose code point is the hue produces it exactly -- no search, and it still
 * goes through the real public function rather than a copy of its internals.
 */
function colourForHue(hue: number): string {
  return colourFor(String.fromCharCode(hue));
}

describe("safeAvatarSrc", () => {
  const ID = "Nu2fXJ3rQKp1sVdWyBz0aLcMhE7tG4iO";
  const OTHER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it("renders the column when it is exactly this user's avatar URL", () => {
    expect(safeAvatarSrc({ id: ID, image: avatarUrlFor(ID) })).toBe(`/media/avatars/${ID}`);
  });

  it("renders nothing when there is no avatar", () => {
    expect(safeAvatarSrc({ id: ID, image: null })).toBe(null);
  });

  /**
   * `users.image` is attacker-controlled. Anything but the one allowed value
   * falls back to initials rather than becoming a request from every viewer's
   * browser -- which for an external URL is an IP/user-agent/referrer beacon
   * that routes around the whole session-gated media route.
   */
  it.each([
    ["an external tracker", "https://evil.example.com/track.gif"],
    ["a protocol-relative host", "//evil.example.com/track.gif"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["another user's avatar", `/media/avatars/${OTHER}`],
    ["the right path with a query appended", `/media/avatars/${ID}?x=https://evil.example.com`],
    ["the right path with a fragment", `/media/avatars/${ID}#x`],
    ["a path that merely starts the same way", `/media/avatars/${ID}/../../../etc/passwd`],
    [
      "an absolute URL to our own path on another host",
      `https://evil.example.com/media/avatars/${ID}`,
    ],
    ["a whitespace-padded match", ` /media/avatars/${ID}`],
    ["the filesystem-style path the plan used to describe", `media/avatars/${ID}.webp`],
    ["the empty string", ""],
  ])("refuses %s", (_label, image) => {
    expect(safeAvatarSrc({ id: ID, image })).toBe(null);
  });
});

describe("avatarUrlFor", () => {
  it("is the path the route handler answers", () => {
    // Task 6 writes this string to users.image; src/app/media/avatars/[userId]
    // serves it. Both halves are pinned here so neither can move alone.
    expect(avatarUrlFor("Nu2fXJ3rQKp1sVdWyBz0aLcMhE7tG4iO")).toBe(
      "/media/avatars/Nu2fXJ3rQKp1sVdWyBz0aLcMhE7tG4iO",
    );
  });

  it("carries no file extension", () => {
    // The segment is a user id, never a filename: there is nothing for the
    // handler to strip, so nothing it can strip wrongly.
    expect(avatarUrlFor("x")).not.toContain(".");
  });
});
