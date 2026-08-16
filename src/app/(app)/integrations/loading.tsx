import { getTranslations } from "next-intl/server";

import { RedditSectionForm } from "@/components/integrations/reddit-section";
import { YoutubeSectionForm } from "@/components/integrations/youtube-section";

/**
 * This route's own fallback -- shown by Next while the RSC payload for a
 * **client-side soft navigation** into `/integrations` (e.g. clicking
 * "Integrations" in the sidebar) is still in flight over the network. That is
 * real latency server-side streaming cannot remove: `IntegrationsPage`'s own
 * client components only help once the new route's payload has already
 * arrived, and `await getTranslations()` staying in the page body means the
 * page still suspends briefly on that per-request-cached read even
 * server-side.
 *
 * It renders the **real form chassis in its pending state** -- the same
 * `…SectionForm` components `IntegrationsPage`'s own `<Suspense fallback>`s
 * use, called with `pending` -- rather than `<Skeleton>` bars standing in for
 * each control. The heading, both card headings, every label, both credential
 * fields, the user agent field and every button are all on screen, disabled,
 * from the very first frame of the navigation; only the masks, the user
 * agent value, the status badges and the enabled state stream in afterward.
 */
export default async function Loading() {
  const t = await getTranslations("integrations");

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-6">
        <YoutubeSectionForm pending />
        <RedditSectionForm pending />
      </div>
    </div>
  );
}
