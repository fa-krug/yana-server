"use client";

import { useTranslations } from "next-intl";

import { reportOutcomeIn, statusBadgeIn, type Translate } from "@/components/section-kit";
import type { AiKey } from "@/lib/ai/result";

/**
 * The `ai` binding of `@/components/section-kit`, and the twin of
 * `@/components/integrations/section-parts`.
 *
 * **One binding per feature, never a copy of the reporter.** Task R1 lifted the
 * badge and the outcome reporter out of `/integrations` precisely so that this
 * file could be four lines of configuration rather than a second implementation:
 * the reporter is the one piece where a copy that drifts means "the wrong
 * outcome, with no message" -- a red "could not save" over a Test that never
 * writes, or a green success over a rate limit that left the provider off.
 *
 * Read the integrations sibling for why the factories take a translator hook
 * instead of a namespace, and why the keys are spelled out here rather than
 * derived; only what differs is written below.
 */

/**
 * The `ai` translator, narrowed to the keys the kit renders.
 *
 * A named `use`-prefixed function rather than an inline arrow so the hook rules
 * still apply, and the declared return type is what checks -- here, where
 * `"ai"` is a literal -- that `NamespaceKey<"ai">` really is what this `t`
 * accepts.
 */
function useAiTranslate(): Translate<AiKey> {
  return useTranslations("ai");
}

/**
 * Whether this provider's stored key passed a live probe.
 *
 * **The labels are "Verified"/"Not verified", not "Active"/"Inactive", and the
 * difference is not cosmetic.** On `/integrations` a provider with a working
 * credential *is* active -- there is nothing else to decide. Here two facts are
 * independent: a provider's key can be verified while a different provider is
 * the one the AI features run on. The badge answers only the first, and
 * `active_ai_provider` -- shown as the hint under the picker in
 * `./provider-section` -- answers the second. Sharing the integrations wording
 * would have put "Active" on all six providers at once.
 */
export const StatusBadge = statusBadgeIn(useAiTranslate, {
  active: "verified",
  inactive: "unverified",
});

/**
 * Turn an action's outcome into exactly one toast.
 *
 * **The save fallback is `credentialsSaveFailed`, not the `saveFailed` the
 * actions return.** This namespace serves two cards with two subjects: a
 * credential probe, and five numbers. `saveFailed` is worded for the numbers
 * ("Could not save these settings.") because `saveAdvanced()` and
 * `setActiveProvider()` name it explicitly; a `{ ok: false }` with no key of its
 * own from a *credential* save wants "Could not save these credentials." The two
 * spellings exist so the fallback describes the thing that failed, which is the
 * same reason the three fallbacks are per action rather than one.
 */
export const useReportOutcome = reportOutcomeIn(useAiTranslate, {
  saved: "saved",
  tested: "tested",
  removed: "removed",
  saveFailed: "credentialsSaveFailed",
  testFailed: "testFailed",
  removeFailed: "removeFailed",
});
