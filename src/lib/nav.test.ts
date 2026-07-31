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
    // `label`, not `labelKey`: the field name is what tells the renderer not to
    // translate it (see Crumb in ./nav). The old shape put both through one
    // `labelKey: string` and distinguished them by looking for a dot, which
    // mislabels any id that contains one.
    const crumbs = breadcrumbsFor("/feeds/42");
    expect(crumbs).toHaveLength(3);
    expect(crumbs[2]).toEqual({ href: "/feeds/42", label: "42" });
  });

  it("does not treat a dot in a record id as a catalog key", () => {
    const crumbs = breadcrumbsFor("/feeds/some.slug.v2");
    expect(crumbs[2]).toEqual({ href: "/feeds/some.slug.v2", label: "some.slug.v2" });
  });

  it("ignores trailing slashes", () => {
    expect(breadcrumbsFor("/feeds/")).toEqual(breadcrumbsFor("/feeds"));
  });
});
