import { connection } from "next/server";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { AdvancedSection } from "@/components/ai/advanced-section";
import { ProviderSection } from "@/components/ai/provider-section";
import { CardSkeletonGroup } from "@/components/data-skeleton";
import { getAiStatus } from "@/lib/ai/queries";

/**
 * The data region: one read, projected to masked credentials before it leaves
 * the server.
 *
 * Inside `<Suspense>` because an absent credential is an empty form rather than
 * a 404 -- nothing on this page decides the response *status*, so nothing has to
 * be awaited in the page body (CLAUDE.md's streaming pattern). The error
 * boundary the pattern also requires is the (app) group's own `error.tsx`, one
 * level up; a second one here would only make the failure smaller than the page
 * it breaks.
 *
 * `getAiStatus()` is the only thing that touches the row, and its projection is
 * the security boundary: every key crosses this line as eight bullets and four
 * characters, because these props are the page's RSC payload.
 */
async function Sections() {
  const status = await getAiStatus();
  return (
    <div className="space-y-6">
      <ProviderSection active={status.active} providers={status.providers} />
      <AdvancedSection advanced={status.advanced} />
    </div>
  );
}

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
  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <Suspense fallback={<CardSkeletonGroup count={2} />}>
        <Sections />
      </Suspense>
    </div>
  );
}
