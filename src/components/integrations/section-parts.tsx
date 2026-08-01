"use client";

import { useTranslations } from "next-intl";

import { reportOutcomeIn, statusBadgeIn, type Translate } from "@/components/section-kit";
import type { IntegrationsKey } from "@/lib/integrations/result";

/**
 * The `integrations` binding of `@/components/section-kit`.
 *
 * **One binding per feature**, the same arrangement `attemptIn()` has in
 * `@/lib/integrations/result` -- the feature module stays the import point, so a
 * namespace cannot be mistyped once per card, and `<YoutubeSection>` and
 * `<RedditSection>` keep the spelling they already had. Phase 7 writes the twin
 * of this file at `src/components/ai/section-parts.tsx`, against the same
 * factories and the `ai` namespace.
 *
 * It sits beside the cards rather than next to `attempt` in
 * `@/lib/integrations/result` for one reason: what is bound here is a React
 * component and a React hook. Binding them in `src/lib` would make a lib module
 * export JSX and would be the first `src/lib` -> `src/components` runtime import
 * in the repository, which is the dependency direction every `no-restricted-imports`
 * rule in `eslint.config.mjs` exists to keep pointing the other way. The
 * *type* half of the same protocol -- `SaveResult` -- stays in
 * `@/lib/integrations/result`, where the actions that produce it can reach it.
 *
 * The two namespace-free helpers a card also needs -- `submittedSecret()` and
 * `secretPlaceholder()` -- are imported from the kit directly and deliberately
 * not re-exported here: they have no namespace to bind, and a re-export would
 * hide that.
 */

/**
 * The `integrations` translator, narrowed to the keys the kit renders.
 *
 * A named `use`-prefixed function rather than an inline `() => useTranslations(…)`
 * so the hook rules still apply to it, and the declared return type is what lets
 * both factories below infer their key type without an explicit type argument --
 * and what checks, here where `"integrations"` is a literal, that
 * `NamespaceKey<"integrations">` really is what this `t` accepts.
 */
function useIntegrationsTranslate(): Translate<IntegrationsKey> {
  return useTranslations("integrations");
}

/** Enabled/disabled, from the flag a probe derived -- never from what is stored. */
export const StatusBadge = statusBadgeIn(useIntegrationsTranslate, {
  active: "active",
  inactive: "inactive",
});

/** Turn an action's outcome into exactly one toast. */
export const useReportOutcome = reportOutcomeIn(useIntegrationsTranslate, {
  saved: "saved",
  tested: "tested",
  removed: "removed",
  saveFailed: "saveFailed",
  testFailed: "testFailed",
  removeFailed: "removeFailed",
});
