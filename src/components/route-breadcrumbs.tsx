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
          // A labelKey containing a dot is a catalog path; anything else is a
          // literal record id and must not be translated.
          const label = crumb.labelKey.includes(".") ? t(crumb.labelKey) : crumb.labelKey;
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
