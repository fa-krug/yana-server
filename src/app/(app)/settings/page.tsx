import { connection } from "next/server";
import { getTranslations } from "next-intl/server";

import { AboutSection } from "@/components/settings/about-section";
import { GeneralSection } from "@/components/settings/general-section";
import { LibrarySection } from "@/components/settings/library-section";
import { Separator } from "@/components/ui/separator";
import { getSettings } from "@/lib/settings/queries";

/**
 * `<PageTitle>` was considered here (see the streaming-controls migration
 * plan, Task 1 Step 6) so this page would need no `await getTranslations()`
 * at all -- a client `useTranslations()` hook reads the provider the root
 * layout already renders, and nothing crosses the RSC boundary for it. It was
 * dropped: making its `namespace`/`titleKey` props generic and still
 * compiler-checked against `NamespaceKey<Namespace>` runs into the exact wall
 * documented on `src/components/section-kit.tsx` -- `useTranslations(namespace)`
 * with a still-generic `Namespace` produces a `t` typed
 * `NamespacedMessageKeys<Messages, Namespace>`, which TypeScript cannot reduce
 * to `NamespaceKey<Namespace>`, and closing that gap inside the component
 * needs a cast at the `t()` call site -- precisely what CLAUDE.md forbids.
 * Every later task therefore keeps this `await getTranslations()` too: the
 * page suspends only on this one per-request-`cache()`d read, not on the
 * settings query below, which is the one this migration removes from the
 * critical path.
 */
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

  // Not awaited: the promise is handed to the client components, which render
  // their real controls immediately and fill in the values when it resolves.
  // Awaiting here is what made the whole page suspend behind one read.
  // `getSettings()` is `cache()`d per request, so passing the same promise to
  // both sections below is still exactly one read.
  const settings = getSettings();

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="space-y-8">
        <GeneralSection promise={settings} />
        <Separator />
        <LibrarySection promise={settings} />
      </div>
      <Separator />
      <AboutSection />
    </div>
  );
}
