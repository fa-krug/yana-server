import { getTranslations } from "next-intl/server";

import { RedditSectionShell } from "@/components/integrations/reddit-section";
import { YoutubeSectionShell } from "@/components/integrations/youtube-section";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. Without this file, an
 * initial navigation to `/integrations` shows that unrelated fallback for
 * however long `IntegrationsPage` takes to resolve, because the whole async
 * page function (including its own inline
 * `<Suspense fallback={<SectionsFallback />}>`) suspends as one unit until it
 * returns. This hoists `IntegrationsPage`'s own "nothing loaded yet" shell --
 * the same shape `ffa29204` introduced as `SectionsFallback` for later
 * re-fetches -- up to the route level so it is shown on the very first
 * navigation too.
 */
export default async function Loading() {
  const t = await getTranslations("integrations");
  const noopSubmit = (event: React.FormEvent<HTMLFormElement>) => event.preventDefault();

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
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
    </div>
  );
}
