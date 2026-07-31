import { describe, expect, it } from "vitest";

import { breadcrumbsFor } from "./nav";

describe("breadcrumbsFor", () => {
  it("returns just the root for the dashboard", () => {
    expect(breadcrumbsFor("/")).toEqual([{ href: "/", labelKey: "nav.dashboard" }]);
  });

  it("accumulates hrefs down the path", () => {
    expect(breadcrumbsFor("/feeds")).toEqual([
      { href: "/", labelKey: "nav.dashboard" },
      { href: "/feeds", labelKey: "nav.feeds" },
    ]);
  });

  it("labels an unknown trailing segment as a record id", () => {
    // /feeds/42 -> Dashboard / Feeds / 42, with the id shown verbatim.
    const crumbs = breadcrumbsFor("/feeds/42");
    expect(crumbs).toHaveLength(3);
    expect(crumbs[2]).toEqual({ href: "/feeds/42", labelKey: "42" });
  });

  it("ignores trailing slashes", () => {
    expect(breadcrumbsFor("/feeds/")).toEqual(breadcrumbsFor("/feeds"));
  });
});
