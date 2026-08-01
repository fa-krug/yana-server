import { describe, expect, it } from "vitest";

import { toggleAll, toggleRow } from "./selection";

describe("toggleAll", () => {
  const pageIds = ["a", "b", "c"];

  it("selects only the current page's rows", () => {
    // Rows from another page stay selected but are not added to blindly.
    expect(toggleAll(pageIds, ["z"])).toEqual(["z", "a", "b", "c"]);
  });

  it("clears only the current page's rows", () => {
    expect(toggleAll(pageIds, ["z", "a", "b", "c"])).toEqual(["z"]);
  });

  it("treats a partial selection as 'select all'", () => {
    expect(toggleAll(pageIds, ["a"])).toEqual(["a", "b", "c"]);
  });

  it("leaves the selection alone on an empty page", () => {
    // `every` is vacuously true for an empty list, so without the length guard
    // an empty result set would clear a selection made on a previous page.
    expect(toggleAll([], ["z"])).toEqual(["z"]);
  });
});

describe("toggleRow", () => {
  it("adds an unselected row", () => {
    expect(toggleRow("b", ["a"])).toEqual(["a", "b"]);
  });

  it("removes a selected row without disturbing the rest", () => {
    expect(toggleRow("b", ["a", "b", "c"])).toEqual(["a", "c"]);
  });
});
