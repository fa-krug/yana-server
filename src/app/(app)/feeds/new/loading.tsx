import { getTranslations } from "next-intl/server";

import { FeedForm } from "@/components/feeds/feed-form";

/**
 * This route's own fallback -- shown by Next while the RSC payload for a
 * **client-side soft navigation** into `/feeds/new` (e.g. clicking "Add feed"
 * in the sidebar or the feeds list) is still in flight over the network. That
 * is real latency server-side streaming cannot remove: `NewFeedPage`'s own
 * `<NewFeedForm>` only helps once the new route's payload has already
 * arrived, and `await getTranslations()` staying in the page body means the
 * page still suspends briefly on that per-request-cached read even
 * server-side.
 *
 * Without this file the route fell through to `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` -- a table shape on a page that is a form -- which is the
 * exact defect this migration exists to fix.
 *
 * It renders the **real form chassis in its pending state**: `<FeedForm
 * pending />`, the same component `NewFeedPage`'s own `<NewFeedForm>` uses as
 * its `<Suspense>` fallback. The aggregator picker (`AGGREGATOR_SPECS` needs
 * no query) and every other field are on screen, disabled, from the very
 * first frame; only the capability-based filtering and the tag list stream in
 * once the real page's promises resolve.
 */
export default async function Loading() {
  const t = await getTranslations("feeds");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <FeedForm pending />
    </div>
  );
}
