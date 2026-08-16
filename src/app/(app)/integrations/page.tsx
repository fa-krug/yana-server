import { connection } from "next/server";
import { getTranslations } from "next-intl/server";

import { RedditSection } from "@/components/integrations/reddit-section";
import { YoutubeSection } from "@/components/integrations/youtube-section";
import { getIntegrationStatus } from "@/lib/integrations/queries";

export default async function IntegrationsPage() {
  /**
   * Opt this route out of prerendering, **before** the first line that can reach
   * SQLite. This page has
   * no `requireAdmin()` to await, so nothing else opts it out: without this call
   * `getTranslations()` below resolves the next-intl request config ->
   * `getSettings()` -> `getDb()` during `next build`, which creates an empty,
   * unmigrated `data/yana.db` on the build machine. The (app) layout's
   * `requireUser()` does not cover it: layout and page are sibling render scopes.
   */
  await connection();
  const t = await getTranslations("integrations");

  // Not awaited: the promise is handed to both client components, which render
  // their real controls immediately and fill in the values when it resolves.
  // Awaiting here is what made the whole page suspend behind one read.
  // `getIntegrationStatus()` is backed by the same `cache()`d `getSettings()`
  // read the root layout already made, so passing the same promise to both
  // sections below is still exactly one read.
  const status = getIntegrationStatus();

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-6">
        <YoutubeSection promise={status} />
        <RedditSection promise={status} />
      </div>
    </div>
  );
}
