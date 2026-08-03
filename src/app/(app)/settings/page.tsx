import { connection } from "next/server";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { CardSkeletonGroup } from "@/components/data-skeleton";
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
  /**
   * Opt this route out of prerendering, **before** the first line that can
   * reach SQLite. `connection()` in the root layout is not enough and never
   * was: the layout and this page are sibling render scopes, React starts this
   * one before the layout's interrupt lands, and `getTranslations()` below
   * resolves the next-intl request config -> `getSettings()` -> `getDb()`. That
   * is what created an empty, unmigrated `data/yana.db` on the build machine
   * (see the `connection()` bullet in CLAUDE.md). Every route that can reach
   * the database needs its own call, first thing.
   */
  await connection();
  const t = await getTranslations("settings");
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <Suspense fallback={<CardSkeletonGroup count={3} />}>
        <Sections />
      </Suspense>
    </div>
  );
}
