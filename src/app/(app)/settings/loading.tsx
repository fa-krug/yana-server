import { getTranslations } from "next-intl/server";

import { AboutSection } from "@/components/settings/about-section";
import { GeneralSectionShell } from "@/components/settings/general-section";
import { LibrarySectionShell } from "@/components/settings/library-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. Without this file, an
 * initial navigation to `/settings` shows that unrelated fallback for however
 * long `SettingsPage` takes to resolve, because the whole async page function
 * (including its own inline `<Suspense fallback={<SectionsFallback />}>`)
 * suspends as one unit until it returns. This hoists `SettingsPage`'s own
 * "nothing loaded yet" shell -- the same shape `ffa29204` introduced as
 * `SectionsFallback` for later re-fetches -- up to the route level so it is
 * shown on the very first navigation too.
 *
 * `<AboutSection>` has no data dependency at all, so it is rendered for real
 * here, exactly as `SettingsPage` renders it outside its own `<Suspense>`.
 */
export default async function Loading() {
  const t = await getTranslations("settings");

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="space-y-8">
        <GeneralSectionShell
          themeControl={<Skeleton className="h-9 w-full sm:w-64" />}
          languageControl={<Skeleton className="h-9 w-full sm:w-64" />}
        />
        <Separator />
        <LibrarySectionShell
          retentionControl={<Skeleton className="h-9 w-24" />}
          saveControl={<Skeleton className="h-9 w-24" />}
        />
      </div>
      <Separator />
      <AboutSection />
    </div>
  );
}
