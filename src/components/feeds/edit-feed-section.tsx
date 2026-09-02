"use client";

import { Suspense, use } from "react";

import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { RecordNotFound } from "@/components/record-not-found";
import type { Capabilities } from "@/lib/aggregators/specs";
import type { Tag } from "@/lib/db/schema";
import { EditFeedForm, FeedForm, type FeedListRow } from "./feed-form";

/**
 * Calls `use()` on the feed promise `/feeds/[id]/page.tsx` hands down;
 * suspends until it settles; renders either the real form (behind its own,
 * already-nested `<EditFeedForm>` Suspense for capabilities/tags) or the
 * not-found state.
 *
 * `feedPromise` resolves to `null` for a nonexistent id, a non-numeric id, or
 * a feed owned by someone else -- `getFeed()` already scopes its `WHERE` to
 * `feeds.userId = currentUserId()`, so this component cannot tell those
 * apart and does not try to (see `RecordNotFound`'s own comment).
 *
 * There is no page `<h1>`: the breadcrumb (fed by `SetBreadcrumbTitle`
 * below) already names the record, and `<EditFeedForm>` displays the feed's
 * name in its own name field.
 */
function EditFeedResolved({
  feedPromise,
  capabilitiesPromise,
  allTagsPromise,
}: {
  feedPromise: Promise<FeedListRow | null>;
  capabilitiesPromise: Promise<Capabilities>;
  allTagsPromise: Promise<Tag[]>;
}) {
  const feed = use(feedPromise);

  if (!feed) {
    return <RecordNotFound />;
  }

  return (
    <>
      <SetBreadcrumbTitle title={feed.name} />
      <EditFeedForm
        feed={feed}
        capabilitiesPromise={capabilitiesPromise}
        allTagsPromise={allTagsPromise}
      />
    </>
  );
}

/**
 * What `/feeds/[id]/page.tsx` renders. There is no page `<h1>` -- the
 * breadcrumb already names the record -- so the fallback is just
 * `<FeedForm pending />`, the real chassis with every field blank and
 * disabled. This replaces
 * `/feeds/[id]/loading.tsx`, deleted along with this component: the page
 * body that renders this awaits nothing, so that route-level fallback is
 * unreachable now (see `src/app/(app)/settings/page.tsx`'s doc comment for
 * the migration this belongs to).
 */
export function EditFeedSection({
  feedPromise,
  capabilitiesPromise,
  allTagsPromise,
}: {
  feedPromise: Promise<FeedListRow | null>;
  capabilitiesPromise: Promise<Capabilities>;
  allTagsPromise: Promise<Tag[]>;
}) {
  return (
    <Suspense fallback={<FeedForm pending />}>
      <EditFeedResolved
        feedPromise={feedPromise}
        capabilitiesPromise={capabilitiesPromise}
        allTagsPromise={allTagsPromise}
      />
    </Suspense>
  );
}
