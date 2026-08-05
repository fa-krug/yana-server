import { connection } from "next/server";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { AboutSection } from "@/components/settings/about-section";
import { GeneralSection, GeneralSectionShell } from "@/components/settings/general-section";
import { LibrarySection, LibrarySectionShell } from "@/components/settings/library-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { getSettings } from "@/lib/settings/queries";

/**
 * The `<Suspense>` fallback for `<Sections>` below: the same two section
 * shells `<Sections>` itself renders once `getSettings()` resolves, with a
 * skeleton bar standing in for each control -- so the headings, field labels
 * and help text are never replaced by an anonymous skeleton block, only the
 * values nobody can know yet.
 */
function SectionsFallback() {
  return (
    <div className="space-y-8">
      <GeneralSectionShell
        themeControl={<Skeleton className="h-9 w-full sm:w-64" />}
        languageControl={<Skeleton className="h-9 w-full sm:w-64" />}
      />
      <Separator />
      <LibrarySectionShell
        retentionControl={<Skeleton className="h-9 w-24" />}
        intervalControl={<Skeleton className="h-9 w-24" />}
        saveControl={<Skeleton className="h-9 w-24" />}
      />
    </div>
  );
}

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
      <Suspense fallback={<SectionsFallback />}>
        <Sections />
      </Suspense>
      {/* Static, no data dependency at all -- rendered directly rather than
          through the Suspense boundary above, which exists only for the
          database read the other two sections need. */}
      <Separator />
      <AboutSection />
    </div>
  );
}
