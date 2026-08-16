"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type * as React from "react";

import { useListParams } from "@/components/crud/use-list-params";
import { Button, buttonVariants } from "@/components/ui/button";
import { buildListHref } from "@/lib/crud/params";

/**
 * Previous/next paging, plus the range the operator is looking at.
 *
 * The range is not decoration: after a search or a filter the total is the
 * only thing that says whether the result set is 3 rows or 3000, and the
 * two links alone cannot show that.
 *
 * Both links go through `buildListHref`, so paging carries the current search,
 * filters and sort along -- a pagination link that dropped the query would
 * page through a different list than the one on screen.
 */
export function Pagination({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}) {
  const t = useTranslations("crud");
  const { pathname, params } = useListParams();

  // Nothing to page through, and the table already says the list is empty.
  if (total === 0) return null;

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav aria-label={t("pagination")} className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">{t("range", { from, to, total })}</p>
      <div className="flex items-center gap-2">
        <PageLink
          href={buildListHref(pathname, params, { page: page - 1 })}
          disabled={page <= 1}
          label={t("previous")}
        >
          <ChevronLeft aria-hidden="true" />
        </PageLink>
        <PageLink
          href={buildListHref(pathname, params, { page: page + 1 })}
          disabled={page >= lastPage}
          label={t("next")}
        >
          <ChevronRight aria-hidden="true" />
        </PageLink>
      </div>
    </nav>
  );
}

/**
 * Reserves `<Pagination>`'s exact footprint before its own query (`total`) is
 * known -- used as both the page's `<Suspense fallback>` for it and the
 * segment's `loading.tsx`, so the row's height never changes when the real
 * control resolves. `aria-hidden`, because it offers nothing: both chevrons
 * are permanently disabled and the range line is a blank placeholder rather
 * than a translated string, so nothing here needs `useTranslations`. The
 * alternative -- rendering nothing, as the fallback used to -- trades this
 * placeholder's own brief appearance (real, but non-functional) for a second,
 * larger layout shift once the row itself pops in; reserving the space was
 * judged the smaller jump of the two.
 */
export function PaginationPlaceholder() {
  return (
    <nav aria-hidden="true" className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">&nbsp;</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon-sm" disabled>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" size="icon-sm" disabled>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

/**
 * One paging control.
 *
 * A disabled one is a real `<button disabled>` rather than a styled `<a>`: an
 * anchor has no disabled state, and `aria-disabled` alone leaves it focusable
 * and clickable -- which on page one would navigate to `?page=0`.
 */
function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button type="button" variant="outline" size="icon-sm" aria-label={label} disabled>
        {children}
      </Button>
    );
  }

  return (
    // buttonVariants on a <Link> rather than `<Button render={<Link/>}>`: the
    // Base UI button primitive expects to render a native <button> and would
    // need `nativeButton={false}` to be told otherwise. The class is the whole
    // contract here.
    <Link
      href={href}
      aria-label={label}
      className={buttonVariants({ variant: "outline", size: "icon-sm" })}
    >
      {children}
    </Link>
  );
}
