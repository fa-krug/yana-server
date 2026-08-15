import { type ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { AdvancedSectionShell } from "@/components/ai/advanced-section";
import { ProviderSectionShell } from "@/components/ai/provider-section";
import { Skeleton } from "@/components/ui/skeleton";
import { AI_ADVANCED_FIELDS, type AiAdvancedField } from "@/lib/ai/bounds";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. Without this file, an
 * initial navigation to `/ai` shows that unrelated fallback for however long
 * `AiPage` takes to resolve, because the whole async page function (including
 * its own inline `<Suspense fallback={<SectionsFallback />}>`) suspends as
 * one unit until it returns. This hoists `AiPage`'s own "nothing loaded yet"
 * shell -- the same shape `ffa29204` introduced as `SectionsFallback` for
 * later re-fetches -- up to the route level so it is shown on the very first
 * navigation too.
 *
 * Both shells take their default no-op `onSubmit` rather than being handed
 * one: this is a Server Component, and a closure it creates cannot cross into
 * a Client Component. See the fallback's doc comment in `./page.tsx`.
 */
export default async function Loading() {
  const t = await getTranslations("ai");

  const advancedControls = Object.fromEntries(
    AI_ADVANCED_FIELDS.map((name) => [name, <Skeleton key={name} className="h-9 w-full" />]),
  ) as Record<AiAdvancedField, ReactNode>;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-6">
        <ProviderSectionShell
          statusBadge={<Skeleton className="h-5 w-16" />}
          providerControl={<Skeleton className="h-9 w-full sm:w-64" />}
          providerHint={<Skeleton className="h-4 w-48" />}
          modelControl={<Skeleton className="h-9 w-full sm:w-64" />}
          apiKeyControl={<Skeleton className="h-9 w-full" />}
          apiKeyHelp={<Skeleton className="h-4 w-32" />}
          apiUrlControl={null}
          saveControl={<Skeleton className="h-9 w-24" />}
          testControl={<Skeleton className="h-9 w-24" />}
          removeControl={null}
        />
        <AdvancedSectionShell
          controls={advancedControls}
          saveControl={<Skeleton className="h-9 w-24" />}
        />
      </div>
    </div>
  );
}
