import { describe, expect, it, vi } from "vitest";

import { setPathname } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { RouteBreadcrumbs } from "./route-breadcrumbs";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function itemTexts(container: HTMLElement) {
  return [...container.querySelectorAll('[data-slot="breadcrumb-item"]')].map(
    (item) => item.textContent,
  );
}

describe("RouteBreadcrumbs", () => {
  it("nests no list item inside another", () => {
    // BreadcrumbItem and BreadcrumbSeparator both render an <li>, and an
    // earlier version of this component nested the separator inside the item.
    // The browser silently reparents that, so it costs a hydration mismatch and
    // nothing else -- no warning, no lint error, no type error.
    setPathname("/articles/42");
    const { container } = renderWithProviders(<RouteBreadcrumbs />);

    expect(container.querySelectorAll("li li")).toHaveLength(0);
    // Guards the assertion above: with no separators rendered at all it would
    // pass vacuously. Two crumbs means one separator, three <li> in total.
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("translates known routes and shows an unknown segment verbatim", () => {
    // German, because the English labels are too close to the raw segments to
    // prove anything: "Articles" vs. "articles" differs only in case, while
    // "Artikel" cannot be produced by accident.
    setPathname("/articles/42");
    const { container } = renderWithProviders(<RouteBreadcrumbs />, { locale: "de" });

    expect(itemTexts(container)).toEqual(["Artikel", "42"]);
  });

  it("translates an action segment rather than echoing the URL", () => {
    // The rendered half of the /tags/new fix: breadcrumbsFor returning a
    // labelKey is only half the story, since the component still has to put it
    // through t(). German again -- "New" vs. "new" would prove nothing.
    setPathname("/tags/new");
    const { container } = renderWithProviders(<RouteBreadcrumbs />, { locale: "de" });

    expect(itemTexts(container)).toEqual(["Tags", "Neu"]);
  });
});
