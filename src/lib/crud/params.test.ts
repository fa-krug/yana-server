import { describe, expect, it } from "vitest";

import { buildListHref, parseListParams } from "./params";

describe("parseListParams", () => {
  it("applies defaults for an empty query", () => {
    expect(parseListParams({})).toEqual({
      q: "",
      page: 1,
      pageSize: 25,
      sort: "",
      dir: "asc",
      filters: {},
    });
  });

  it("clamps a page below one", () => {
    expect(parseListParams({ page: "0" }).page).toBe(1);
    expect(parseListParams({ page: "-3" }).page).toBe(1);
    expect(parseListParams({ page: "abc" }).page).toBe(1);
  });

  it("caps pageSize so a crafted URL cannot request everything", () => {
    expect(parseListParams({ pageSize: "100000" }).pageSize).toBe(100);
  });

  it("collects unrecognized params as filters", () => {
    expect(parseListParams({ role: "admin", q: "ada" })).toMatchObject({
      q: "ada",
      filters: { role: "admin" },
    });
  });

  it("takes the first value of a repeated param", () => {
    expect(parseListParams({ q: ["a", "b"] }).q).toBe("a");
  });
});

describe("buildListHref", () => {
  // The default ListParams: what a bare "/users" visit parses to. Used below
  // as the `current` argument wherever a test wants to start from a clean slate.
  const defaults = parseListParams({});

  it("omits defaults to keep URLs clean", () => {
    expect(buildListHref("/users", defaults, {})).toBe("/users");
  });

  it("resets to page one when the query changes", () => {
    // Otherwise a search from page 5 lands on an empty page.
    expect(buildListHref("/users", defaults, { q: "ada", page: 5 })).toBe("/users?q=ada");
  });

  it("preserves the current query and filters when only paging changes", () => {
    // A pagination link must not silently drop the search or the filters that
    // produced the result set it is paging through.
    const current = { ...defaults, q: "ada", filters: { role: "admin" } };
    expect(buildListHref("/users", current, { page: 3 })).toBe("/users?q=ada&page=3&role=admin");
  });

  it("preserves the current query when only sorting changes", () => {
    // Clicking a sortable column header must not reset the search either.
    const current = { ...defaults, q: "ada" };
    expect(buildListHref("/users", current, { sort: "name", dir: "desc" })).toBe(
      "/users?q=ada&sort=name&dir=desc",
    );
  });

  it("resets page to one when a filter value changes", () => {
    const current = { ...defaults, page: 3, filters: { role: "admin" } };
    expect(buildListHref("/users", current, { filters: { role: "editor" } })).toBe(
      "/users?role=editor",
    );
  });

  it("does not reset the page when an explicit page change is the only change", () => {
    const current = { ...defaults, page: 2 };
    expect(buildListHref("/users", current, { page: 5 })).toBe("/users?page=5");
  });

  it("lets the reset win when both a filter and a page are supplied together", () => {
    // Merge-and-reset: the caller's requested page was computed against the
    // *old* filters, so it is meaningless against the new ones -- the reset
    // to page one wins even though `changes.page` was also given.
    const current = { ...defaults, page: 2, filters: {} };
    expect(buildListHref("/users", current, { page: 5, filters: { role: "admin" } })).toBe(
      "/users?role=admin",
    );
  });
});
