import { getTranslations } from "next-intl/server";

import { AboutSection } from "@/components/settings/about-section";
import { GeneralSectionForm } from "@/components/settings/general-section";
import { LibrarySectionForm } from "@/components/settings/library-section";
import { Separator } from "@/components/ui/separator";

/**
 * This route's own fallback -- shown by Next while the RSC payload for a
 * **client-side soft navigation** into `/settings` (e.g. clicking "Settings"
 * in the sidebar) is still in flight over the network. That is real latency
 * server-side streaming cannot remove: `SettingsPage`'s own `<Suspense>`
 * boundaries only help once the new route's payload has already arrived, and
 * `await getTranslations()` staying in the page body (see the fork recorded
 * in `SettingsPage`'s doc comment) means the page still suspends briefly on
 * that per-request-cached read even server-side.
 *
 * It renders the **real form chassis in its pending state** -- the same
 * `…Form` components `SettingsPage`'s own `<Suspense fallback>`s use, called
 * with `pending` -- rather than `<Skeleton>` bars standing in for each
 * control. That is the whole point of this migration: the heading, both
 * section headings, every label, both `<Select>` triggers, the retention
 * input and the Save button are all on screen, disabled, from the very first
 * frame of the navigation, and only the values stream in afterward -- no
 * grey bars, and no visual swap once the real controls mount.
 *
 * `<AboutSection>` has no data dependency at all, so it is rendered for real
 * here, exactly as `SettingsPage` renders it.
 */
export default async function Loading() {
  const t = await getTranslations("settings");

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="space-y-8">
        <GeneralSectionForm pending />
        <Separator />
        <LibrarySectionForm pending />
      </div>
      <Separator />
      <AboutSection />
    </div>
  );
}
