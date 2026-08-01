import { describe, expect, it } from "vitest";

import { buildListHref, parseListParams, type ListParams } from "./params";

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

  it("takes its defaults from the module and nothing else", () => {
    // The `defaults: Partial<ListParams>` parameter this function used to
    // accept is deliberately gone (see the doc comment): a second set of
    // defaults reaches this half of the contract but not `buildListHref`'s
    // omission rule, so the two disagree silently. Pinned by arity, because a
    // reinstated parameter is exactly the change this test is here to notice.
    expect(parseListParams.length).toBe(1);
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

  it("merges changes.filters per key rather than replacing the record", () => {
    // The call site used to spread `current.filters` back in by hand. Three
    // phases inherit this function; a caller that forgot the spread silently
    // dropped every filter it did not mention.
    const current = { ...defaults, filters: { role: "admin", status: "active" } };
    expect(buildListHref("/users", current, { filters: { role: "standard" } })).toBe(
      "/users?role=standard&status=active",
    );
  });

  it("clears one filter with an empty value and leaves the rest standing", () => {
    // How the "all roles" option works: an empty value is omitted from the
    // query string, so the URL carries no `role` at all rather than `?role=`.
    const current = { ...defaults, page: 4, filters: { role: "admin", status: "active" } };
    expect(buildListHref("/users", current, { filters: { role: "" } })).toBe(
      "/users?status=active",
    );
  });

  it("round-trips: what it writes, parseListParams reads back", () => {
    // The invariant a per-page `defaults` object would break. This function
    // decides which values to *omit* against the same constants
    // `parseListParams` fills in, so the two must be inverses over every field.
    const current: ListParams = {
      q: "ada",
      page: 3,
      pageSize: 50,
      sort: "name",
      dir: "desc",
      filters: { role: "admin" },
    };
    const href = buildListHref("/users", current, {});
    const query = Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));

    expect(parseListParams(query)).toEqual(current);
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
