import { connection } from "next/server";
import { getTranslations } from "next-intl/server";

import { AdvancedSection } from "@/components/ai/advanced-section";
import { ProviderSection } from "@/components/ai/provider-section";
import { getAiStatus } from "@/lib/ai/queries";

export default async function AiPage() {
  /**
   * Opt this route out of prerendering, **before** the first line that can reach
   * SQLite -- exactly as `/integrations` does, and for the same reason. This
   * page is signed-in but not admin-only, so there is no `requireAdmin()` to
   * await and nothing else opts it out: without this call `getTranslations()`
   * below resolves the next-intl request config -> `getSettings()` -> `getDb()`
   * during `next build`, which creates an empty, unmigrated `data/yana.db` on
   * the build machine. The (app) layout's `requireUser()` does not cover it:
   * layout and page are sibling render scopes.
   */
  await connection();
  const t = await getTranslations("ai");

  // Not awaited: handed to both sections below, whose real controls render
  // immediately and fill in the values once it resolves -- awaiting here is
  // what used to make the whole page suspend behind one read.
  // `getAiStatus()` reads the same `cache()`d `getSettings()` row the root
  // layout already read for this request, so sharing this one promise between
  // both sections still costs exactly one query.
  const status = getAiStatus();

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-6">
        <ProviderSection promise={status} />
        <AdvancedSection promise={status} />
      </div>
    </div>
  );
}
