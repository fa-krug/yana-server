"use client";

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
            <BreadcrumbItem key={crumb.href}>
              {isLast ? (
                <BreadcrumbPage>{label}</BreadcrumbPage>
              ) : (
                <>
                  {/* Base UI's render prop, not Radix's asChild -- see app-sidebar.tsx. */}
                  <BreadcrumbLink render={<Link href={crumb.href} />}>{label}</BreadcrumbLink>
                  <BreadcrumbSeparator />
                </>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
