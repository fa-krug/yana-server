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

export type NavItem = {
  href: string;
  labelKey: string;
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

const LABELS = new Map(NAV_ITEMS.map((item) => [item.href, item.labelKey]));

/**
 * Breadcrumbs from the URL alone.
 *
 * A new page gets correct breadcrumbs by living at the right path, with no
 * registration step -- which is why every view must be a real route.
 * An unmatched segment (a record id) is shown verbatim.
 */
export function breadcrumbsFor(pathname: string): { href: string; labelKey: string }[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs = [{ href: "/", labelKey: "nav.dashboard" }];

  let href = "";
  for (const segment of segments) {
    href += `/${segment}`;
    crumbs.push({ href, labelKey: LABELS.get(href) ?? segment });
  }
  return crumbs;
}
