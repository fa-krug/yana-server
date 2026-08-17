import { connection } from "next/server";

import { IntegrationsDescription } from "@/components/integrations/integrations-description";
import { RedditSection } from "@/components/integrations/reddit-section";
import { YoutubeSection } from "@/components/integrations/youtube-section";
import { getIntegrationStatus } from "@/lib/integrations/queries";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * `await getTranslations()` is gone, replaced by `<IntegrationsDescription>`
 * -- a client component reading `useTranslations("integrations")` off the
 * `NextIntlClientProvider` the root layout already renders, so nothing
 * crosses the RSC boundary for the description and nothing here suspends on
 * it. The page `<h1>` is gone entirely: the breadcrumb already names the
 * page, so the per-page heading was removed everywhere.
 */
export default function IntegrationsPage() {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage` does and for the same reason: `getIntegrationStatus()`
   * below is never awaited by this page body (it is handed straight to both
   * client sections), so there is no other awaited Dynamic API left here to
   * do this job. See CLAUDE.md's `connection()` bullet for why calling it,
   * unawaited, is enough today -- and the `cacheComponents` precondition
   * that fact rests on.
   */
  connection();

  // Not awaited: the promise is handed to both client components, which
  // render their real controls immediately and fill in the values when it
  // resolves. Awaiting here is what made the whole page suspend behind one
  // read. `getIntegrationStatus()` is backed by the same `cache()`d
  // `getSettings()` read the root layout already made, so passing the same
  // promise to both sections below is still exactly one read.
  const status = getIntegrationStatus();

  return (
    <div className="max-w-2xl space-y-6">
      <IntegrationsDescription />
      <div className="space-y-6">
        <YoutubeSection promise={status} />
        <RedditSection promise={status} />
      </div>
    </div>
  );
}
