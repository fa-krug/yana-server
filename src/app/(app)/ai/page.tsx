import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { AdvancedSection, AdvancedSectionShell } from "@/components/ai/advanced-section";
import { ProviderSection, ProviderSectionShell } from "@/components/ai/provider-section";
import { Skeleton } from "@/components/ui/skeleton";
import { AI_ADVANCED_FIELDS, type AiAdvancedField } from "@/lib/ai/bounds";
import { getAiStatus } from "@/lib/ai/queries";

/**
 * The `<Suspense>` fallback for `<Sections>` below: the same two section
 * shells `<Sections>` itself renders once `getAiStatus()` resolves, with a
 * skeleton standing in for each control -- so the headings, field labels and
 * help text are never replaced by an anonymous skeleton block, only the
 * values nobody can know yet. Matches `SectionsFallback` in
 * `src/app/(app)/settings/page.tsx`.
 *
 * The provider card's fallback shape approximates a provider already being
 * selected -- model, API key and Test controls all render as skeletons --
 * because that is the common case once an instance is configured; the
 * base-URL field and the remove footer stay absent, since neither is
 * universal even among configured providers. Nothing here is submitted, so
 * both shells take their default no-op `onSubmit`. It is deliberately omitted
 * rather than passed as a function value: this is a Server Component, and a
 * closure it creates cannot cross into the Client Component shells below (it
 * isn't a Server Action) -- the shells default it themselves instead.
 */
function SectionsFallback() {
  const advancedControls = Object.fromEntries(
    AI_ADVANCED_FIELDS.map((name) => [name, <Skeleton key={name} className="h-9 w-full" />]),
  ) as Record<AiAdvancedField, ReactNode>;

  return (
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
  );
}

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
      <Suspense fallback={<SectionsFallback />}>
        <Sections />
      </Suspense>
    </div>
  );
}
