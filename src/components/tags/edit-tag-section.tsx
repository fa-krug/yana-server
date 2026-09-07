"use client";

import { Suspense, use } from "react";

import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { RecordNotFound } from "@/components/record-not-found";
import type { TagDetailRow } from "@/lib/tags/queries";
import { TagForm } from "./tag-form";

/**
 * Calls `use()` on the one promise `/tags/[id]/page.tsx` hands down; suspends
 * until it settles; renders either the real form or the not-found state.
 *
 * `tagPromise` resolves to `null` for a nonexistent id, a non-numeric id, or
 * a tag owned by someone else -- `getTag()` already scopes its `WHERE` to
 * `tags.userId = session.id`, so this component cannot tell those three
 * apart and does not try to: see `RecordNotFound`'s own comment on why that
 * is deliberate.
 */
function EditTagResolved({ tagPromise }: { tagPromise: Promise<TagDetailRow | null> }) {
  const tag = use(tagPromise);

  if (!tag) {
    return <RecordNotFound />;
  }

  return (
    <>
      <SetBreadcrumbTitle title={tag.name} />
      <TagForm tag={tag} />
    </>
  );
}

/**
 * What `/tags/[id]/page.tsx` renders. There is no page `<h1>` -- the
 * breadcrumb (fed by `SetBreadcrumbTitle` above) already names the record --
 * so the fallback below only needs the real `<TagForm pending />` chassis,
 * disabled. This replaces `/tags/[id]/loading.tsx`, deleted along with this
 * component: the page body that renders this awaits nothing, so that
 * route-level fallback is unreachable now (see
 * `src/app/(app)/settings/page.tsx`'s doc comment for the migration this
 * belongs to).
 */
export function EditTagSection({ tagPromise }: { tagPromise: Promise<TagDetailRow | null> }) {
  return (
    <Suspense fallback={<TagForm pending />}>
      <EditTagResolved tagPromise={tagPromise} />
    </Suspense>
  );
}
