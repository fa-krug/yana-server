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

/** Any catalog key a breadcrumb may carry: a route label or an action label. */
export type CrumbLabelKey = Extract<CatalogKey, `nav.${string}` | `common.${string}`>;

/**
 * Segments that name an action rather than a record, matched by segment instead
 * of by full href because they repeat under every resource (`/tags/new`,
 * `/users/new`, ...) and enumerating the crossproduct in NAV_ITEMS would mean a
 * new entry per resource per action.
 *
 * Only the segments that are really routes belong here. Editing is not one:
 * the CRUD phases put it at `/tags/[id]`, so there is no `/edit` segment to
 * label. Adding a key for a route that does not exist would be dead weight
 * nobody later can tell from a live one.
 *
 * A record whose id is literally "new" would be mislabelled, which is why this
 * stays an explicit short list rather than "translate anything that isn't
 * numeric" -- ids here are integers or Better Auth text ids, so the collision
 * is not reachable, and an unlisted segment keeps today's verbatim behaviour.
 */
const ACTION_LABELS = new Map<string, CrumbLabelKey>([["new", "common.new"]]);

/**
 * One breadcrumb: either a segment with a catalog key to translate (a known
 * route or a known action), or an unmatched segment (a record id), shown
 * verbatim.
 *
 * Two shapes rather than one `labelKey: string`, because the caller has to tell
 * them apart before calling t() and the old "does it contain a dot?" heuristic
 * was both untypeable and wrong for a segment id that happens to contain one
 * (a slug, a filename, a version). The discriminant is now the field name.
 */
export type Crumb = { href: string; labelKey: CrumbLabelKey } | { href: string; label: string };

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
    // Full href first: a route's own label wins over an action of the same name,
    // so a future top-level /new route would still get its NAV_ITEMS label.
    const labelKey = LABELS.get(href) ?? ACTION_LABELS.get(segment);
    crumbs.push(labelKey ? { href, labelKey } : { href, label: segment });
  }
  return crumbs;
}
