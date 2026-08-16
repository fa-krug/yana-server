import { getTranslations } from "next-intl/server";

import { AdvancedSectionForm } from "@/components/ai/advanced-section";
import { ProviderSectionForm } from "@/components/ai/provider-section";

/**
 * This route's own fallback -- shown by Next while the RSC payload for a
 * **client-side soft navigation** into `/ai` (e.g. clicking "AI" in the
 * sidebar) is still in flight over the network. That is real latency
 * server-side streaming cannot remove: `AiPage`'s own client components only
 * help once the new route's payload has already arrived, and
 * `await getTranslations()` staying in the page body means the page still
 * suspends briefly on that per-request-cached read even server-side.
 *
 * It renders the **real form chassis in its pending state** -- the same
 * `…SectionForm` components `AiPage`'s own `<Suspense>` fallbacks use, called
 * with `pending` -- rather than `<Skeleton>` bars standing in for each
 * control. The heading, both card headings, the provider picker (fully
 * populated, unselected) and every label/button are on screen, disabled, from
 * the very first frame of the navigation; only the mask, the active provider,
 * the status badge and the nine stored tuning values stream in afterward.
 *
 * There is deliberately no guessed selection here any more: the provider
 * picker used to render as if a provider were already chosen (model, API key
 * and Test all shown, as the common case once an instance is configured).
 * That guess is gone -- the real, fully populated picker renders unselected,
 * and only the model select (which cannot be known without a provider) and
 * the API key field stand in for it, both disabled and empty.
 */
export default async function Loading() {
  const t = await getTranslations("ai");

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-6">
        <ProviderSectionForm pending />
        <AdvancedSectionForm pending />
      </div>
    </div>
  );
}
