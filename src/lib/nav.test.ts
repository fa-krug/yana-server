import { describe, expect, it } from "vitest";

import { NAV_ITEMS, breadcrumbsFor } from "./nav";

describe("breadcrumbsFor", () => {
  it("returns nothing for the root, which only ever redirects", () => {
    expect(breadcrumbsFor("/")).toEqual([]);
  });

  it("starts from the top-level route itself, with no fixed root crumb", () => {
    expect(breadcrumbsFor("/feeds")).toEqual([{ href: "/feeds", labelKey: "nav.feeds" }]);
  });

  it("labels an unknown trailing segment as a record id", () => {
    // /feeds/42 -> Feeds / 42, with the id shown verbatim.
    // `label`, not `labelKey`: the field name is what tells the renderer not to
    // translate it (see Crumb in ./nav). The old shape put both through one
    // `labelKey: string` and distinguished them by looking for a dot, which
    // mislabels any id that contains one.
    const crumbs = breadcrumbsFor("/feeds/42");
    expect(crumbs).toHaveLength(2);
    expect(crumbs[1]).toEqual({ href: "/feeds/42", label: "42" });
  });

  it("translates an action segment instead of showing it raw", () => {
    // /tags/new is a real planned route, and `new` is a word the UI has to say,
    // not an id to echo -- so it carries a catalog key like any other label.
    const crumbs = breadcrumbsFor("/tags/new");
    expect(crumbs).toHaveLength(2);
    expect(crumbs[1]).toEqual({ href: "/tags/new", labelKey: "common.new" });
  });

  it("matches an action segment under any resource", () => {
    // Keyed by segment, not by full href: the alternative is one entry per
    // resource per action in NAV_ITEMS.
    for (const resource of ["tags", "users", "feeds"]) {
      expect(breadcrumbsFor(`/${resource}/new`)[1]).toEqual({
        href: `/${resource}/new`,
        labelKey: "common.new",
      });
    }
  });

  it("does not treat a dot in a record id as a catalog key", () => {
    const crumbs = breadcrumbsFor("/feeds/some.slug.v2");
    expect(crumbs[1]).toEqual({ href: "/feeds/some.slug.v2", label: "some.slug.v2" });
  });

  it("translates /account, which has a label but no sidebar entry", () => {
    // The footer's profile link is not in NAV_ITEMS -- it would print twice --
    // so without UNLISTED_ROUTES this falls through to the record-id branch
    // and the breadcrumb reads the raw segment "account" in every language.
    const crumbs = breadcrumbsFor("/account");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toEqual({ href: "/account", labelKey: "nav.account" });
  });

  it("keeps /account out of the navigation list itself", () => {
    // The other half: a label for it must not put a second entry in the
    // sidebar's own menu.
    expect(NAV_ITEMS.some((item) => item.href === "/account")).toBe(false);
  });

  it("ignores trailing slashes", () => {
    expect(breadcrumbsFor("/feeds/")).toEqual(breadcrumbsFor("/feeds"));
  });

  it("puts articles first, as the sidebar's landing entry", () => {
    expect(NAV_ITEMS[0]).toMatchObject({ href: "/articles", labelKey: "nav.articles" });
  });

  it("no longer has a dashboard entry", () => {
    expect(NAV_ITEMS.some((item) => item.href === "/")).toBe(false);
  });
});
