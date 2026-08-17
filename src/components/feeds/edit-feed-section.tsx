"use client";

import { Suspense, use } from "react";
import { useTranslations } from "next-intl";

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
 * The `<h1>` here interpolates the feed's own name
 * (`t("editTitle", { name: feed.name })`), which is unknown until this
 * `use()` call resolves -- it is rendered from this same component rather
 * than guessed at in a fallback, per the instant-render-no-fallback plan.
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
  const t = useTranslations("feeds");

  if (!feed) {
    return <RecordNotFound />;
  }

  return (
    <>
      <SetBreadcrumbTitle title={feed.name} />
      <h1 className="text-2xl font-semibold">{t("editTitle", { name: feed.name })}</h1>
      <EditFeedForm
        feed={feed}
        capabilitiesPromise={capabilitiesPromise}
        allTagsPromise={allTagsPromise}
      />
    </>
  );
}

/**
 * What `/feeds/[id]/page.tsx` renders. Unlike `/tags/[id]`'s title, this
 * route's `<h1>` needs the feed's own name, so -- per the instant-render
 * plan -- no skeleton bar stands in for it while pending: the fallback is
 * just `<FeedForm pending />`, the real chassis with every field blank and
 * disabled, and the title appears together with the real data once
 * `EditFeedResolved` resolves rather than being guessed at. This replaces
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
