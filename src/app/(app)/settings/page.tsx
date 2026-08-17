import { connection } from "next/server";

import { AboutSection } from "@/components/settings/about-section";
import { GeneralSection } from "@/components/settings/general-section";
import { LibrarySection } from "@/components/settings/library-section";
import { SettingsTitle } from "@/components/settings/settings-title";
import { Separator } from "@/components/ui/separator";
import { getSettingsSummary } from "@/lib/settings/queries";

/**
 * The instant-render-no-fallback migration: this page body awaits nothing,
 * so it cannot suspend and Next never shows a route-level fallback for it --
 * `loading.tsx` was deleted along with this rewrite, because there is no
 * longer any suspension for it to cover.
 *
 * The `await getTranslations()` the streaming-controls migration kept here is
 * gone too, replaced by `<SettingsTitle>` -- a client component reading
 * `useTranslations("settings")` off the `NextIntlClientProvider` the root
 * layout already renders, so nothing crosses the RSC boundary for the title
 * and nothing here suspends on it. A shared generic `<PageTitle namespace
 * titleKey>` was tried and rejected for this same reason twice over (see
 * `src/components/section-kit.tsx`): making the namespace generic while
 * keeping catalog keys compiler-checked needs a cast at the `t()` call site,
 * which CLAUDE.md forbids. A literal namespace per page avoids the wall
 * instead of closing it.
 */
export default function SettingsPage() {
  /**
   * Opt this route out of prerendering -- **called, not awaited**. Calling
   * `connection()` is what interrupts static generation: during `next build`
   * it throws synchronously (see `throwToInterruptStaticGeneration` in
   * `next/dist/server/request/connection.js`) the moment it runs, whether or
   * not anything awaits its result: the exception propagates out of this
   * (now synchronous) page function exactly as it would if awaited, which
   * is what still makes `rm -rf data/ && npm run build` leave `data/`
   * unmigrated rather than baking a page against it. At real request time it
   * just resolves to `undefined` and is never observed -- there is nothing to
   * await here, so awaiting it would only reintroduce the one thing this
   * migration removes. `connection()` in the root layout still is not enough
   * on its own: the layout and this page are sibling render scopes, and
   * `getSettingsSummary()` below reaches `getDb()` through its own chain of
   * dynamic reads regardless of what the layout already resolved.
   *
   * **That "propagates exactly as it would if awaited" claim has a
   * precondition this comment does not restate: no `cacheComponents` and no
   * PPR configured.** Under `cacheComponents` the branch `connection()` takes
   * instead returns a hanging promise and never throws, so an unawaited call
   * would interrupt nothing. See CLAUDE.md's `connection()` bullet for the
   * full reasoning -- the pages that point back to "SettingsPage's identical
   * comment" mean this paragraph, and this paragraph means that bullet.
   */
  connection();

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
      <SettingsTitle />
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
