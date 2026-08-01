"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import type { IntegrationsKey, SaveResult } from "@/lib/integrations/result";
import { KEEP_EXISTING } from "@/lib/secrets";

/**
 * The three things `<YoutubeSection>` and `<RedditSection>` share.
 *
 * Shared rather than copied for the reason `@/lib/attempt` is: each of them
 * would otherwise carry two copies of the outcome-reporting block (a save and a
 * test), and phase 7 adds three more providers to the same page.
 */

/**
 * What a secret field submits.
 *
 * **An empty field means "keep what is stored", and this is where that is
 * spelled out.** A saved secret never reaches the browser -- the form shows
 * `mask()`ed text as a *placeholder* and the input's own value starts empty --
 * so there is nothing to round-trip, and `resolveSecret()` on the server puts
 * the stored value back. `KEEP_EXISTING` and `""` resolve identically; sending
 * the sentinel makes the intent explicit on the wire instead of relying on a
 * reader knowing that empty is special.
 *
 * The sentinel contains a NUL byte, which survives only because it is an
 * RSC-serialized *argument* and never an `<input value>` -- binding it to the
 * field would strip or mangle it. See `@/lib/secrets`.
 */
export function submittedSecret(value: string): string {
  return value === "" ? KEEP_EXISTING : value;
}

/**
 * A stored secret's mask as a field's placeholder -- or no placeholder at all.
 *
 * One spelling of it, in one place. The two cards had two
 * (`configured ? mask : undefined` and `mask || undefined`) for the same
 * decision, which is how the *next* provider gets a third. `mask()` returns `""`
 * for an unset secret and `placeholder=""` renders an empty attribute rather
 * than none, so the `undefined` matters.
 */
export function secretPlaceholder(masked: string): string | undefined {
  return masked === "" ? undefined : masked;
}

/** Enabled/disabled, from the flag a probe derived -- never from what is stored. */
export function StatusBadge({ enabled }: { enabled: boolean }) {
  const t = useTranslations("integrations");
  return (
    <Badge variant={enabled ? "default" : "outline"}>{t(enabled ? "active" : "inactive")}</Badge>
  );
}

/** Which success message an outcome deserves, when it is a success. */
type SuccessKey = "saved" | "tested" | "removed";

/**
 * What to say when an action failed and named no key of its own.
 *
 * **Per action, because "Could not save these credentials." was being shown on a
 * path that never tried to save.** A `{ ok: false }` with no `errorKey` is
 * reachable for every one of these (a malformed body, a missing settings row, a
 * write that touched no row), and a single fallback told an operator who pressed
 * **Test** that a save had failed -- pointing them at the wrong thing to worry
 * about. Keyed off the same argument that picks the success message, so the two
 * cannot describe different actions.
 */
const FALLBACK_KEYS: Record<SuccessKey, IntegrationsKey> = {
  saved: "saveFailed",
  tested: "testFailed",
  removed: "removeFailed",
};

/**
 * Turn an action's outcome into exactly one toast.
 *
 * Three arms, and the middle one is the one worth naming: a result can be
 * `ok: true` **and** carry a `noticeKey` -- YouTube's quota exhaustion, where the
 * credential is valid and only today's budget is gone (see `SaveResult` in
 * `@/lib/integrations/result`). That is a `toast.warning`, not a success: the
 * integration is on, but an operator watching an empty feed needs to know why.
 * Reddit's rate limit is deliberately *not* in this arm -- it is not a verdict on
 * the credential at all, so it arrives as a failure (`quotaMeansVerified` in
 * `@/lib/integrations/actions`).
 *
 * `errorKey` is a catalog key, never a provider's own message -- the server maps
 * a probe's `cause` before answering, so nothing here has to guess.
 */
export function useReportOutcome() {
  const t = useTranslations("integrations");

  return function report(result: SaveResult, successKey: SuccessKey): void {
    if (!result.ok) {
      toast.error(t(result.errorKey ?? FALLBACK_KEYS[successKey]));
      return;
    }
    if (result.noticeKey) {
      toast.warning(t(result.noticeKey));
      return;
    }
    toast.success(t(successKey));
  };
}
