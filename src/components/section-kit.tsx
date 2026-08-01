"use client";

import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import type { NoticeResult } from "@/lib/attempt";
import { KEEP_EXISTING } from "@/lib/secrets";

/**
 * The parts a credential card is built from, with no catalog namespace of its
 * own.
 *
 * **It lives here, at the root of `src/components`, rather than in
 * `src/components/integrations/`, because it serves two feature folders**:
 * `/integrations`' YouTube and Reddit cards today, and phase 7's three AI
 * provider cards in `src/components/ai/` next. A kit that sits inside one of
 * the features it serves reads as that feature's private code, and the second
 * consumer copies it instead of importing it -- which is exactly what phase 6's
 * review predicted would happen to the toast reporter, the one piece where a
 * copy that drifts means "the wrong outcome, with no message". `data-skeleton.tsx`
 * and `user-avatar.tsx` are the precedent for a single cross-feature file here;
 * `crud/` is the precedent for a folder, and this is not yet big enough to be one.
 *
 * Shared rather than copied for the reason `@/lib/attempt` is: each section
 * would otherwise carry its own outcome-reporting block, and there are five
 * sections once phase 7 lands.
 *
 * ## Why the factories take a translator hook and not a namespace
 *
 * {@link reportOutcomeIn} and {@link statusBadgeIn} mirror `attemptIn()` in
 * `@/lib/attempt`: a factory bound once per feature, with the catalog keys
 * spelled out at the binding site so `NamespaceKey<…>` stays compiler-checked.
 * `attemptIn` can take the namespace itself because it only ever *returns* a
 * key; these two have to *render* one, and that is where the parallel stops.
 * `useTranslations(namespace)` with a still-generic `Namespace` produces a `t`
 * whose key type is `NamespacedMessageKeys<Messages, Namespace>`, which
 * TypeScript cannot reduce to `NamespaceKey<Namespace>`:
 *
 * ```
 * error TS2345: Argument of type 'NamespaceKey<Namespace>' is not assignable to
 * parameter of type 'NamespacedMessageKeys<{ … }, Namespace>'.
 * ```
 *
 * The only way to close that gap inside the factory is a cast, and a cast is
 * precisely what this convention exists to avoid. So the binding site -- where
 * the namespace is a literal and the two types *do* reduce -- hands in a
 * `use`-prefixed function returning a {@link Translate}, and the factory is
 * parameterised over the key type instead. The keys stay checked against the
 * real catalogs either way, which is the property that mattered.
 *
 * **`NoInfer` on each factory's `keys` argument is load-bearing, not
 * decoration.** Without it `Key` has two inference sites and TypeScript picks
 * the narrow one -- the literals passed in -- so the reporter's parameter
 * becomes `NoticeResult<"saved" | "tested" | …>` and `attempt()`'s
 * `{ ok: false, errorKey: "sessionEnded" }` stops being assignable to it. The
 * translator is the only honest source of the key type; `NoInfer` says so.
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

/**
 * One feature's `t`, narrowed to the keys this kit passes it.
 *
 * A single required argument, deliberately: everything rendered here is a badge
 * label or a toast, so a key that needs ICU values is a key that does not belong
 * in this kit, and the binding fails to typecheck rather than rendering a
 * placeholder to a user.
 */
export type Translate<Key extends string> = (key: Key) => string;

/**
 * Bind an enabled/disabled badge to one catalog namespace.
 *
 * The flag it renders comes from a probe's verdict -- never from "is something
 * stored".
 */
export function statusBadgeIn<Key extends string>(
  useTranslate: () => Translate<Key>,
  keys: NoInfer<{ active: Key; inactive: Key }>,
) {
  return function StatusBadge({ enabled }: { enabled: boolean }) {
    const t = useTranslate();
    return (
      <Badge variant={enabled ? "default" : "outline"}>
        {t(enabled ? keys.active : keys.inactive)}
      </Badge>
    );
  };
}

/** Which of a card's three actions produced the outcome being reported. */
export type Outcome = "saved" | "tested" | "removed";

/**
 * Bind the outcome reporter to one catalog namespace: one toast per action,
 * chosen by the outcome and the result together.
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
 *
 * **The three failure keys are per action, not one fallback**, because "Could
 * not save these credentials." was being shown on a path that never tried to
 * save. A `{ ok: false }` with no `errorKey` is reachable for every one of these
 * (a malformed body, a missing settings row, a write that touched no row), and a
 * single fallback told an operator who pressed **Test** that a save had failed --
 * pointing them at the wrong thing to worry about. They are keyed off the same
 * {@link Outcome} that picks the success message, so the two cannot describe
 * different actions.
 *
 * All six are spelled out at the binding site, for the reason `attemptIn()`
 * spells out its two: with the key type still a parameter here, deriving them
 * would need a cast, while at a binding site the compiler checks them against
 * the real catalogs for free.
 */
export function reportOutcomeIn<Key extends string>(
  useTranslate: () => Translate<Key>,
  keys: NoInfer<{
    /** Reported when a save succeeded and carried no caveat. */
    saved: Key;
    /** Reported when a test succeeded and carried no caveat. */
    tested: Key;
    /** Reported when a stored credential was removed. */
    removed: Key;
    /** Reported when a save failed and named no key of its own. */
    saveFailed: Key;
    /** Reported when a test failed and named no key of its own. */
    testFailed: Key;
    /** Reported when a removal failed and named no key of its own. */
    removeFailed: Key;
  }>,
) {
  const fallbackKeys: Record<Outcome, Key> = {
    saved: keys.saveFailed,
    tested: keys.testFailed,
    removed: keys.removeFailed,
  };

  return function useReportOutcome() {
    const t = useTranslate();

    return function report(result: NoticeResult<Key>, outcome: Outcome): void {
      if (!result.ok) {
        toast.error(t(result.errorKey ?? fallbackKeys[outcome]));
        return;
      }
      if (result.noticeKey) {
        toast.warning(t(result.noticeKey));
        return;
      }
      toast.success(t(keys[outcome]));
    };
  };
}
