import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { CardSkeleton } from "@/components/data-skeleton";
import { AboutSection } from "@/components/settings/about-section";
import { GeneralSection } from "@/components/settings/general-section";
import { LibrarySection } from "@/components/settings/library-section";
import { Separator } from "@/components/ui/separator";
import { getSettings } from "@/lib/settings/queries";

async function Sections() {
  const settings = await getSettings();
  return (
    <div className="space-y-8">
      <GeneralSection theme={settings.theme} language={settings.language} />
      <Separator />
      <LibrarySection
        articleRetentionDays={settings.articleRetentionDays}
        updateIntervalMinutes={settings.updateIntervalMinutes}
      />
      <Separator />
      <AboutSection />
    </div>
  );
}

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <Suspense fallback={<CardSkeleton />}>
        <Sections />
      </Suspense>
    </div>
  );
}
