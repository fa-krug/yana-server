"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { breadcrumbsFor } from "@/lib/nav";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export function RouteBreadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations();
  const crumbs = breadcrumbsFor(pathname);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          // A crumb carries either a catalog key (a known route) or a literal
          // record id that must not be translated -- see Crumb in lib/nav.ts.
          // Discriminating on the field name rather than on "does the string
          // contain a dot?" is both typecheckable and correct for an id that
          // happens to contain one.
          const label = "labelKey" in crumb ? t(crumb.labelKey) : crumb.label;
          return (
            // BreadcrumbSeparator is a sibling of BreadcrumbItem here, not a
            // child of it -- both render an <li>, and nesting one inside the
            // other is invalid HTML that the browser silently reparents,
            // producing a hydration mismatch (server tree vs. the DOM the
            // browser actually built).
            <React.Fragment key={crumb.href}>
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  // Base UI's render prop, not Radix's asChild -- see app-sidebar.tsx.
                  <BreadcrumbLink render={<Link href={crumb.href} />}>{label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
