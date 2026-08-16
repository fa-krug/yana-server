import { connection } from "next/server";
import { getTranslations } from "next-intl/server";

import { AboutSection } from "@/components/settings/about-section";
import { GeneralSection } from "@/components/settings/general-section";
import { LibrarySection } from "@/components/settings/library-section";
import { Separator } from "@/components/ui/separator";
import { getSettingsSummary } from "@/lib/settings/queries";

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
  // `getSettingsSummary()` is backed by the same `cache()`d `getSettings()`
  // read the root layout already made, so sharing this one promise between
  // both sections below is still exactly one read.
  //
  // `getSettingsSummary()`, never a bare `getSettings()` passed straight down
  // or narrowed inline here. React serializes the *resolved value* of a
  // promise handed to a Client Component, not its declared TypeScript type:
  // a prop typed `Promise<{ theme; language; articleRetentionDays }>` is
  // structurally satisfied by a promise that resolves to the whole
  // `UserSettings` row, and the whole row -- including `youtubeApiKey`,
  // `redditClientSecret`, `openaiApiKey` and five more provider secrets --
  // would still be serialized into the page's flight payload, in plain text,
  // in a browser's network tab. Narrowing inside `GeneralSection`/
  // `LibrarySection`'s own `use(promise)` happens *after* serialization and
  // buys nothing; narrowing inline here, in a `.then()` local to this page,
  // was tried and rejected -- it left no shared symbol for a test to import,
  // so a test asserting on its own copy of the narrowing kept passing even
  // after a mutation that reverted this line to `getSettings()` itself (see
  // `settings.test.ts`). `getSettingsSummary()` in `@/lib/settings/queries` is
  // the one function both this page and that test call, so the test is
  // actually exercising what ships here.
  const settings = getSettingsSummary();

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
