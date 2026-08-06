import { connection } from "next/server";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { RedditSection, RedditSectionShell } from "@/components/integrations/reddit-section";
import { YoutubeSection, YoutubeSectionShell } from "@/components/integrations/youtube-section";
import { Skeleton } from "@/components/ui/skeleton";
import { getIntegrationStatus } from "@/lib/integrations/queries";

/**
 * The `<Suspense>` fallback for `<Sections>` below: the same two section
 * shells `<Sections>` itself renders once `getIntegrationStatus()` resolves,
 * with a skeleton standing in for each control -- so the card titles,
 * descriptions and field labels are never replaced by an anonymous skeleton
 * block, only the values nobody can know yet. Neither shell can submit
 * anything real here, so both get a no-op `onSubmit` and no remove button.
 */
function SectionsFallback() {
  const noopSubmit = (event: React.FormEvent<HTMLFormElement>) => event.preventDefault();
  return (
    <div className="space-y-6">
      <YoutubeSectionShell
        onSubmit={noopSubmit}
        statusControl={<Skeleton className="h-5 w-16" />}
        apiKeyControl={<Skeleton className="h-9 w-full" />}
        apiKeyHintControl={<Skeleton className="h-4 w-48" />}
        saveControl={<Skeleton className="h-9 w-full sm:w-24" />}
        testControl={<Skeleton className="h-9 w-full sm:w-24" />}
        removeControl={null}
      />
      <RedditSectionShell
        onSubmit={noopSubmit}
        statusControl={<Skeleton className="h-5 w-16" />}
        clientIdControl={<Skeleton className="h-9 w-full" />}
        clientSecretControl={<Skeleton className="h-9 w-full" />}
        secretsHintControl={<Skeleton className="h-4 w-48" />}
        userAgentControl={<Skeleton className="h-9 w-full" />}
        saveControl={<Skeleton className="h-9 w-full sm:w-24" />}
        testControl={<Skeleton className="h-9 w-full sm:w-24" />}
        removeControl={null}
      />
    </div>
  );
}

/**
 * The data region: one read, projected to masked credentials before it leaves the
 * server.
 *
 * Inside `<Suspense>` because an absent credential is an empty form rather than a
 * 404 -- nothing here decides the response *status*, so nothing here has to be
 * awaited in the page body (CLAUDE.md's streaming pattern). The error boundary
 * the pattern also requires is the (app) group's own `error.tsx`, one level up;
 * a second one here would only make the failure smaller than the page it breaks.
 */
async function Sections() {
  const status = await getIntegrationStatus();
  return (
    <div className="space-y-6">
      <YoutubeSection {...status.youtube} />
      <RedditSection {...status.reddit} />
    </div>
  );
}

export default async function IntegrationsPage() {
  /**
   * Opt this route out of prerendering, **before** the first line that can reach
   * SQLite -- exactly as `/settings` does, and for the same reason. This page has
   * no `requireAdmin()` to await, so nothing else opts it out: without this call
   * `getTranslations()` below resolves the next-intl request config ->
   * `getSettings()` -> `getDb()` during `next build`, which creates an empty,
   * unmigrated `data/yana.db` on the build machine. The (app) layout's
   * `requireUser()` does not cover it: layout and page are sibling render scopes.
   */
  await connection();
  const t = await getTranslations("integrations");
  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <Suspense fallback={<SectionsFallback />}>
        <Sections />
      </Suspense>
    </div>
  );
}
