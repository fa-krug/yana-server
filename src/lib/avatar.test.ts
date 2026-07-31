import { describe, expect, it } from "vitest";

import { avatarUrlFor, colourFor, displayNameFor, initialsFor } from "./avatar";

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
      const match = /^hsl\((\d+) 55% 45%\)$/.exec(colourFor(id));
      expect(match, `colourFor(${JSON.stringify(id)})`).not.toBe(null);
      expect(Number(match![1])).toBeLessThan(360);
    }
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
