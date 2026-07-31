import {
  Bot,
  LayoutDashboard,
  Newspaper,
  Plug,
  Rss,
  Settings,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { CatalogKey } from "@/i18n/next-intl";

/**
 * A key under the `nav` namespace, not any string: these are handed straight to
 * t(), and a typo in one would render the raw key path ("nav.feds") into the
 * sidebar and the breadcrumbs. Derived from en.json via the AppConfig
 * augmentation in src/i18n/next-intl.d.ts, so adding a route without adding its
 * label is a typecheck failure rather than a visual one.
 */
export type NavLabelKey = Extract<CatalogKey, `nav.${string}`>;

export type NavItem = {
  href: string;
  labelKey: NavLabelKey;
  icon: LucideIcon;
  adminOnly: boolean;
};

/** The single source for both sidebar navigation and breadcrumb labels. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, adminOnly: false },
  { href: "/feeds", labelKey: "nav.feeds", icon: Rss, adminOnly: false },
  { href: "/articles", labelKey: "nav.articles", icon: Newspaper, adminOnly: false },
  { href: "/tags", labelKey: "nav.tags", icon: Tags, adminOnly: false },
  { href: "/users", labelKey: "nav.users", icon: Users, adminOnly: true },
  { href: "/integrations", labelKey: "nav.integrations", icon: Plug, adminOnly: false },
  { href: "/ai", labelKey: "nav.ai", icon: Bot, adminOnly: false },
  { href: "/settings", labelKey: "nav.settings", icon: Settings, adminOnly: false },
];

const LABELS = new Map<string, NavLabelKey>(NAV_ITEMS.map((item) => [item.href, item.labelKey]));

/**
 * One breadcrumb: either a known route, which carries a catalog key to
 * translate, or an unmatched segment (a record id), which is shown verbatim.
 *
 * Two shapes rather than one `labelKey: string`, because the caller has to tell
 * them apart before calling t() and the old "does it contain a dot?" heuristic
 * was both untypeable and wrong for a segment id that happens to contain one
 * (a slug, a filename, a version). The discriminant is now the field name.
 */
export type Crumb = { href: string; labelKey: NavLabelKey } | { href: string; label: string };

/**
 * Breadcrumbs from the URL alone.
 *
 * A new page gets correct breadcrumbs by living at the right path, with no
 * registration step -- which is why every view must be a real route.
 * An unmatched segment (a record id) is shown verbatim.
 */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ href: "/", labelKey: "nav.dashboard" }];

  let href = "";
  for (const segment of segments) {
    href += `/${segment}`;
    const labelKey = LABELS.get(href);
    crumbs.push(labelKey ? { href, labelKey } : { href, label: segment });
  }
  return crumbs;
}
